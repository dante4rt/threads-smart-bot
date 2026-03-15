// src/index.ts — Entry point: CLI arg dispatch + cron scheduler

import { createInterface } from 'readline';
import { randomBytes } from 'crypto';
import cron from 'node-cron';
import { getAuthConfig, getConfig } from './config.js';
import { getDb, savePost } from './db.js';
import { ThreadsClient } from './threads-api.js';
import { runPipeline } from './pipeline.js';
import { logger } from './logger.js';
import { parseTime, toCronExpr, truncate } from './utils.js';
import { RunLockError } from './errors.js';

// Load .env if present (dev convenience — production uses actual env vars)
try {
  const { readFileSync } = await import('fs');
  const envFile = readFileSync('.env', 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
} catch {
  // No .env file — that's fine in production
}

// ── CLI dispatch ─────────────────────────────────────────────────────────────

const [, , command, ...args] = process.argv;

if (command === 'auth') {
  await runAuth();
} else if (command === 'post-test') {
  const dryRun = args.includes('--dry');
  await runDirectPost(args, dryRun);
} else if (command === 'run') {
  const dryRun = args.includes('--dry');
  await runOnce(dryRun);
} else {
  // Default: scheduler mode
  await startScheduler();
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function runAuth(): Promise<void> {
  const config = getAuthConfig();
  const db = getDb(config.dbPath);
  const client = new ThreadsClient(config, db);

  const expectedState = randomBytes(24).toString('hex');
  const authUrl = client.buildAuthUrl(expectedState);
  console.log('\n── Threads OAuth ──────────────────────────────────────────');
  console.log('1. Open this URL in your browser:\n');
  console.log(`   ${authUrl}\n`);
  console.log('2. Approve the app permissions.');
  console.log('3. You will be redirected to your redirect URI.');
  console.log('   Copy and paste the FULL redirect URL here:\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const redirectUrl = await new Promise<string>((resolve) => {
    rl.question('Redirect URL: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  let code: string;
  try {
    const parsed = new URL(redirectUrl);
    const rawCode = parsed.searchParams.get('code');
    const returnedState = parsed.searchParams.get('state');
    if (!rawCode) throw new Error('No "code" param in redirect URL');
    if (returnedState !== expectedState) throw new Error('OAuth state mismatch');
    code = rawCode;
  } catch (err) {
    logger.error('Failed to parse redirect URL', { error: (err as Error).message });
    process.exit(1);
  }

  logger.info('Exchanging code for token…');
  const shortLived = await client.exchangeCode(code);
  const longLived = await client.getLongLivedToken(shortLived.access_token, shortLived.user_id);

  console.log('\n✓ Authentication successful!');
  console.log(`  Threads user ID: ${shortLived.user_id}`);
  console.log(`  Token stored in SQLite (${config.dbPath})`);
  console.log(`  Expires in ~${Math.round(longLived.expires_in / 86400)} days`);
  if (!config.threadsUserId) {
    console.log('  THREADS_USER_ID was auto-discovered and stored with the token');
  }
  console.log('\nYou can now start the bot with: npm start\n');
}

async function runOnce(dryRun: boolean): Promise<void> {
  const config = getConfig();
  const db = getDb(config.dbPath);

  const result = await runPipeline(config, db, dryRun);

  if (result.status === 'success') {
    console.log(`\n✓ Pipeline ${dryRun ? '(dry run) ' : ''}completed`);
    if (result.postId) console.log(`  Post ID: ${result.postId}`);
    if (result.generatedText) console.log(`  Text: ${result.generatedText}`);
  } else if (result.status === 'skipped') {
    console.warn(`\n⚠ Pipeline skipped: ${result.error}`);
  } else {
    console.error(`\n✗ Pipeline failed: ${result.error}`);
    process.exit(1);
  }
}

async function runDirectPost(args: string[], dryRun: boolean): Promise<void> {
  const config = getAuthConfig();
  const db = getDb(config.dbPath);
  const client = new ThreadsClient(config, db);

  await client.maybeRefreshToken();

  const defaultText = `Test post from threads-smart-bot • ${new Date().toISOString()}`;
  const providedText = getArgValue(args, '--text');
  const rawText = providedText ?? await promptWithDefault('Post text', defaultText);
  const safeText = truncate(rawText.trim() || defaultText, 500);

  if (dryRun) {
    savePost(db, {
      source_query: 'manual_test',
      source_post_ids: null,
      generated_text: safeText,
      threads_post_id: null,
      published_at: null,
    });

    console.log('\n✓ Direct post dry run completed');
    console.log(`  Text: ${safeText}`);
    return;
  }

  const containerId = await client.createMediaContainer(safeText);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const postId = await client.publishMediaContainer(containerId);

  savePost(db, {
    source_query: 'manual_test',
    source_post_ids: null,
    generated_text: safeText,
    threads_post_id: postId,
    published_at: new Date().toISOString(),
  });

  console.log('\n✓ Direct test post published');
  console.log(`  Post ID: ${postId}`);
  console.log(`  Text: ${safeText}`);
}

async function startScheduler(): Promise<void> {
  const config = getConfig();
  const db = getDb(config.dbPath);

  logger.info('Scheduler starting', {
    postTimes: config.postTimes,
    timezone: config.timezone,
    searchQueries: config.searchQueries,
    model: config.openrouterModel,
    dryRun: config.dryRun,
  });

  const scheduledTasks: cron.ScheduledTask[] = [];

  for (const timeStr of config.postTimes) {
    const { hour, minute } = parseTime(timeStr);
    const expr = toCronExpr(hour, minute);

    logger.info(`Scheduling run at ${timeStr} (${config.timezone})`, { cronExpr: expr });

    const task = cron.schedule(
      expr,
      async () => {
        logger.info('Cron triggered', { time: timeStr });
        try {
          await runPipeline(config, db);
        } catch (err) {
          if (err instanceof RunLockError) {
            logger.warn('Skipping overlapping scheduled run', { time: timeStr });
            return;
          }
          logger.error('Cron pipeline error', { error: (err as Error).message });
        }
      },
      { timezone: config.timezone, scheduled: true },
    );

    scheduledTasks.push(task);
  }

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info(`${signal} received, stopping scheduler`);
    for (const task of scheduledTasks) task.stop();
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info(`Bot running — ${scheduledTasks.length} schedule(s) active. Press Ctrl+C to stop.`);
}

function getArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function promptWithDefault(question: string, defaultValue: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [${defaultValue}]: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}
