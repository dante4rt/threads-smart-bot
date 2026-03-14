// src/pipeline.ts — Crawl → Craft → Publish orchestration

import type { Database } from 'better-sqlite3';
import { AuthError, RateLimitError, RunLockError } from './errors.js';
import { logger } from './logger.js';
import { withRetry } from './retry.js';
import {
  startRun,
  completeRun,
  savePost,
  getRecentPosts,
  countRecentFailures,
} from './db.js';
import { ThreadsClient } from './threads-api.js';
import { OpenRouterClient } from './openrouter.js';
import { buildMessages } from './prompt.js';
import { findImage } from './media.js';
import { pickRandom, dedupeBy, truncate } from './utils.js';
import type { Config } from './config.js';
import type { ThreadsPost } from './threads-api.js';

const MAX_POST_CHARS = 500;

/** Simple in-process run lock to prevent overlapping executions. */
let runInProgress = false;

export interface PipelineResult {
  status: 'success' | 'failed' | 'skipped';
  postId?: string;
  generatedText?: string;
  error?: string;
}

export async function runPipeline(
  config: Config,
  db: Database,
  dryRun = false,
): Promise<PipelineResult> {
  if (runInProgress) {
    logger.warn('Pipeline already running, skipping');
    throw new RunLockError();
  }

  runInProgress = true;
  const runId = startRun(db);
  const effectiveDryRun = dryRun || config.dryRun;

  logger.info('Pipeline started', { runId, dryRun: effectiveDryRun });

  try {
    const threadsClient = new ThreadsClient(config, db);
    const openRouterClient = new OpenRouterClient(config);

    // ── Pre-flight: check/refresh token ───────────────────────────────────
    await withRetry(() => threadsClient.maybeRefreshToken());

    // ── Stage 1: Crawl ────────────────────────────────────────────────────
    const queryCount = Math.floor(Math.random() * 2) + 2; // 2 or 3
    const selectedQueries = pickRandom(config.searchQueries, queryCount);

    logger.info('Crawl stage', { queries: selectedQueries });

    let allPosts: ThreadsPost[] = [];

    for (const query of selectedQueries) {
      const posts = await withRetry(() => threadsClient.keywordSearch(query, 25));
      allPosts = allPosts.concat(posts);
    }

    allPosts = dedupeBy(allPosts, 'id');
    logger.info('Crawl complete', { totalPosts: allPosts.length });

    // ── Stage 2: Craft ────────────────────────────────────────────────────
    const recentPosts = getRecentPosts(db, 5);
    const [systemPrompt, userMessage] = buildMessages(allPosts, recentPosts, selectedQueries);

    logger.info('Craft stage', { sourcePosts: allPosts.length, recentPosts: recentPosts.length });

    const generatedText = await withRetry(() =>
      openRouterClient.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      ),
    );

    const safeText = truncate(generatedText, MAX_POST_CHARS);
    logger.info('Post crafted', { length: safeText.length });

    // ── Stage 3: Publish ──────────────────────────────────────────────────
    if (effectiveDryRun) {
      logger.info('DRY RUN — would publish generated post', { length: safeText.length });
      savePost(db, {
        source_query: selectedQueries.join(','),
        source_post_ids: JSON.stringify(allPosts.slice(0, 10).map((p) => p.id)),
        generated_text: safeText,
        threads_post_id: null, // not published
        published_at: null,
      });
      completeRun(db, runId, 'success');
      return { status: 'success', generatedText: safeText };
    }

    // Find optional Unsplash image
    const imageUrl = await findImage(safeText, config.unsplashAccessKey);

    // Two-step publish
    const containerId = await withRetry(() =>
      threadsClient.createMediaContainer(safeText, imageUrl),
    );

    // Small delay recommended by Threads API before publishing
    await new Promise((r) => setTimeout(r, 1500));

    const publishedId = await withRetry(() =>
      threadsClient.publishMediaContainer(containerId),
    );

    savePost(db, {
      source_query: selectedQueries.join(','),
      source_post_ids: JSON.stringify(allPosts.slice(0, 10).map((p) => p.id)),
      generated_text: safeText,
      threads_post_id: publishedId,
      published_at: new Date().toISOString(),
    });

    completeRun(db, runId, 'success');

    const consecutiveFailures = countRecentFailures(db, 3);
    if (consecutiveFailures >= 3) {
      logger.warn('3 consecutive failed runs detected');
    }

    logger.info('Pipeline completed successfully', { postId: publishedId });
    return { status: 'success', postId: publishedId, generatedText: safeText };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof RateLimitError) {
      logger.warn('Rate limited — skipping run', { error: message });
      completeRun(db, runId, 'failed', message);
      return { status: 'skipped', error: message };
    }

    if (err instanceof AuthError) {
      logger.error('Auth error in pipeline — token refresh failed', { error: message });
      completeRun(db, runId, 'failed', message);
      return { status: 'failed', error: message };
    }

    logger.error('Pipeline failed', { error: message });
    completeRun(db, runId, 'failed', message);

    const consecutiveFailures = countRecentFailures(db, 3);
    if (consecutiveFailures >= 3) {
      logger.warn('3 consecutive failed runs — check logs', { consecutiveFailures });
    }

    return { status: 'failed', error: message };
  } finally {
    runInProgress = false;
  }
}
