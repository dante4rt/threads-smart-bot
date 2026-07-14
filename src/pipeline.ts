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
import { generateGroundedPost } from './fact-check.js';
import { findImage } from './media.js';
import { pickRandom, dedupeBy, truncate, sanitizePost } from './utils.js';
import type { Config } from './config.js';
import type { ThreadsPost } from './threads-api.js';

const MAX_POST_CHARS = 450;
const TARGET_POST_CHARS = 350;
const POSTS_PER_QUERY = 25;
const MAX_COMPRESSION_ATTEMPTS = 2;
const TREND_FIRST_FALLBACK_SEARCH_QUERIES = [
  'trending',
  'viral',
  'lagi rame',
  'ramai',
  'Indonesia',
  'Jakarta',
  'startup',
  'bisnis',
  'career',
  'creator',
  'marketing',
  'web3',
  'crypto',
  'developer',
  'tech',
  'productivity',
] as const;
const AI_FALLBACK_SEARCH_QUERIES = [
  'AI',
  'ChatGPT',
  'OpenAI',
] as const;
const AI_QUERY_PATTERN = /\b(ai|artificial intelligence|chatgpt|openai|claude|gemini|llm|agent)\b/i;

/** Simple in-process run lock to prevent overlapping executions. */
let runInProgress = false;

export interface PipelineResult {
  status: 'success' | 'failed' | 'skipped';
  postId?: string;
  generatedText?: string;
  error?: string;
}

export interface QueryCrawlResult {
  query: string;
  fetchedPosts: number;
  uniqueAddedPosts: ThreadsPost[];
}

/** Match a configured account boundary without treating it as a regular expression. */
export function findExcludedTopic(text: string, excludedTopics: string[]): string | undefined {
  const normalizedText = text.toLowerCase();
  return excludedTopics.find((topic) => normalizedText.includes(topic.toLowerCase()));
}

/** Day index (0=Sunday … 6=Saturday) for a date in the given IANA timezone. */
export function dayOfWeekInTimezone(date: Date, timezone: string): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  }).format(date);
  const order = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const index = order.indexOf(weekday);
  return index === -1 ? 0 : index;
}

/**
 * Build the day's crawl pool by cyclically shifting the catalog's BUCKET ORDER
 * (not the flattened query list) by day-of-week, then flattening. Each of the 7
 * weekdays gets a distinct leading bucket whenever there are ≥7 distinct buckets
 * (a single cyclic shift by 0..6 over distinct elements is 7-distinct). Deterministic:
 * same date+timezone always yields the same order. The result is fed through
 * buildCrawlQueryPool so AI-deferral, dedup, and broad fallbacks still apply on top
 * of the rotation.
 *
 * Shifting bucket order (vs. the old flat-list shift) matters when bucket sizes are
 * uneven: alphabetically-early buckets with many queries (e.g. "blockchain", "defi")
 * would otherwise dominate the front of the pool on most days, since a flat-list shift
 * only moves the split point, not which topics cluster at the front. Shifting buckets
 * guarantees every topic gets a turn leading regardless of how many queries it holds.
 * (Only ONE rotation is applied — stacking a second, independent shift on top can
 * cancel out and re-collide weekdays for uneven bucket sizes.)
 */
export function buildDailyQueryPool(
  catalog: Record<string, string[]>,
  date: Date,
  timezone: string,
  excludedTopics: string[] = [],
): string[] {
  const bucketKeys = Object.keys(catalog).sort();
  if (bucketKeys.length === 0) return [];

  const dayOfWeek = dayOfWeekInTimezone(date, timezone);

  const shift = bucketKeys.length > 1 ? dayOfWeek % bucketKeys.length : 0;
  const rotatedKeys = [...bucketKeys.slice(shift), ...bucketKeys.slice(0, shift)];

  const flattened: string[] = [];
  for (const key of rotatedKeys) {
    for (const query of catalog[key] ?? []) {
      flattened.push(query);
    }
  }

  // shuffle=false: preserve the day-rotated bucket order so the leading
  // categories actually differ per weekday instead of being re-randomized away.
  return buildCrawlQueryPool(flattened, false, excludedTopics);
}

export function buildCrawlQueryPool(
  searchQueries: string[],
  shuffle = true,
  excludedTopics: string[] = [],
): string[] {
  const uniqueQueries = new Set<string>();
  const uniqueDeferredAiQueries = new Set<string>();
  const crawlQueries: string[] = [];
  const deferredAiQueries: string[] = [];

  const addQuery = (query: string, target: string[]): void => {
    const normalized = query.trim();
    const key = normalized.toLowerCase();
    if (!normalized || uniqueQueries.has(key) || findExcludedTopic(normalized, excludedTopics)) return;
    uniqueQueries.add(key);
    target.push(normalized);
  };

  const deferAiQuery = (query: string): void => {
    const normalized = query.trim();
    const key = normalized.toLowerCase();
    if (
      !normalized ||
      uniqueQueries.has(key) ||
      uniqueDeferredAiQueries.has(key) ||
      findExcludedTopic(normalized, excludedTopics)
    ) return;
    uniqueDeferredAiQueries.add(key);
    deferredAiQueries.push(normalized);
  };

  const orderedQueries = shuffle ? pickRandom(searchQueries, searchQueries.length) : searchQueries;
  for (const query of [
    ...orderedQueries,
    ...TREND_FIRST_FALLBACK_SEARCH_QUERIES,
  ]) {
    const normalized = query.trim();
    if (!normalized) continue;

    if (AI_QUERY_PATTERN.test(normalized)) {
      deferAiQuery(normalized);
      continue;
    }

    addQuery(normalized, crawlQueries);
  }

  // AI is the exception. Only user-configured AI queries get deferred to the back of the pool.
  // The hardcoded AI fallbacks are appended ONLY if the non-AI pool came back empty, so the
  // crawler never manufactures AI source material the user didn't ask for.
  for (const query of deferredAiQueries) {
    addQuery(query, crawlQueries);
  }

  if (crawlQueries.length === 0) {
    for (const query of AI_FALLBACK_SEARCH_QUERIES) {
      addQuery(query, crawlQueries);
    }
  }

  return crawlQueries;
}

export async function collectSourcePosts(
  searchQueries: string[],
  minSourcePosts: number,
  minSourceQueries: number,
  searchFn: (query: string, limit: number) => Promise<ThreadsPost[]>,
  /** Pre-built crawl pool (e.g. day-rotated). When omitted, derived from searchQueries. */
  crawlQueries: string[] = buildCrawlQueryPool(searchQueries),
  excludedTopics: string[] = [],
): Promise<{
  posts: ThreadsPost[];
  usedQueries: string[];
  successfulQueries: string[];
  queryResults: QueryCrawlResult[];
}> {
  const usedQueries: string[] = [];
  const successfulQueries: string[] = [];
  const queryResults: QueryCrawlResult[] = [];
  let allPosts: ThreadsPost[] = [];

  for (const query of crawlQueries) {
    if (findExcludedTopic(query, excludedTopics)) continue;

    if (allPosts.length >= minSourcePosts && successfulQueries.length >= minSourceQueries) {
      break;
    }

    const posts = (await searchFn(query, POSTS_PER_QUERY)).filter(
      (post) => !findExcludedTopic(post.text ?? '', excludedTopics),
    );
    usedQueries.push(query);
    const existingIds = new Set(allPosts.map((post) => post.id));
    const uniqueAddedPosts = posts.filter((post) => !existingIds.has(post.id));
    allPosts = dedupeBy(allPosts.concat(posts), 'id');
    if (uniqueAddedPosts.length > 0) {
      successfulQueries.push(query);
    }

    queryResults.push({
      query,
      fetchedPosts: posts.length,
      uniqueAddedPosts,
    });

    logger.info('Crawl query complete', {
      query,
      fetchedPosts: posts.length,
      uniqueAddedPosts: uniqueAddedPosts.length,
      uniquePosts: allPosts.length,
      minSourcePosts,
      successfulQueries: successfulQueries.length,
      minSourceQueries,
    });
  }

  return { posts: allPosts, usedQueries, successfulQueries, queryResults };
}

export function buildBalancedSourcePosts(
  queryResults: QueryCrawlResult[],
  maxSourcePostsPerQuery: number,
  maxTotalPosts = 30,
): ThreadsPost[] {
  const perQueryQueues = queryResults
    .map((result) => result.uniqueAddedPosts.slice(0, maxSourcePostsPerQuery))
    .filter((posts) => posts.length > 0)
    .map((posts) => [...posts]);

  const balancedPosts: ThreadsPost[] = [];
  while (balancedPosts.length < maxTotalPosts) {
    let pushedInRound = false;

    for (const queue of perQueryQueues) {
      const nextPost = queue.shift();
      if (!nextPost) continue;
      balancedPosts.push(nextPost);
      pushedInRound = true;

      if (balancedPosts.length >= maxTotalPosts) {
        break;
      }
    }

    if (!pushedInRound) {
      break;
    }
  }

  return balancedPosts;
}

export async function fitPostToLimit(
  text: string,
  rewriteFn: (text: string, targetChars: number) => Promise<string>,
  maxChars = MAX_POST_CHARS,
  targetChars = TARGET_POST_CHARS,
  maxAttempts = MAX_COMPRESSION_ATTEMPTS,
): Promise<string> {
  let candidate = text.trim();
  if (candidate.length <= maxChars) {
    return candidate;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    logger.warn('Generated post exceeded length limit, rewriting', {
      attempt,
      currentLength: candidate.length,
      maxChars,
      targetChars,
    });

    candidate = (await rewriteFn(candidate, targetChars)).trim();
    if (candidate.length <= maxChars) {
      return candidate;
    }
  }

  logger.warn('Falling back to truncation after rewrite attempts', {
    finalLength: candidate.length,
    maxChars,
  });
  return truncate(candidate, maxChars);
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
    logger.info('Crawl stage', {
      configuredQueries: config.searchQueries,
      categoryBuckets: Object.keys(config.categoryQueries),
      dayOfWeek: dayOfWeekInTimezone(new Date(), config.timezone),
      minSourcePosts: config.minSourcePosts,
      minSourceQueries: config.minSourceQueries,
      maxSourcePostsPerQuery: config.maxSourcePostsPerQuery,
    });

    const dailyQueryPool = buildDailyQueryPool(
      config.categoryQueries,
      new Date(),
      config.timezone,
      config.excludedTopics,
    );
    const { posts: allPosts, usedQueries, successfulQueries, queryResults } = await collectSourcePosts(
      config.searchQueries,
      config.minSourcePosts,
      config.minSourceQueries,
      (query, limit) => withRetry(() => threadsClient.keywordSearch(query, limit)),
      dailyQueryPool,
      config.excludedTopics,
    );

    logger.info('Crawl complete', {
      totalPosts: allPosts.length,
      usedQueries,
      successfulQueries,
    });

    if (allPosts.length < config.minSourcePosts || successfulQueries.length < config.minSourceQueries) {
      const message =
        `Insufficient source coverage: found ${allPosts.length}/${config.minSourcePosts} posts ` +
        `across ${successfulQueries.length}/${config.minSourceQueries} successful queries. ` +
        'Broaden SEARCH_QUERIES or lower MIN_SOURCE_POSTS / MIN_SOURCE_QUERIES.';
      logger.warn('Skipping craft stage due to thin crawl', {
        totalPosts: allPosts.length,
        minSourcePosts: config.minSourcePosts,
        successfulQueries: successfulQueries.length,
        minSourceQueries: config.minSourceQueries,
        usedQueries,
      });
      completeRun(db, runId, 'failed', message);
      return { status: 'skipped', error: message };
    }

    // ── Stage 2: Craft ────────────────────────────────────────────────────
    const recentPosts = getRecentPosts(db, 10);
    const promptSourcePosts = buildBalancedSourcePosts(
      queryResults,
      config.maxSourcePostsPerQuery,
    );
    const [systemPrompt, userMessage] = buildMessages(promptSourcePosts, recentPosts, successfulQueries, {
      timezone: config.timezone,
      authorContext: config.authorContext || undefined,
      excludedTopics: config.excludedTopics,
    });

    logger.info('Craft stage', {
      sourcePosts: promptSourcePosts.length,
      totalSourcePosts: allPosts.length,
      recentPosts: recentPosts.length,
      successfulQueries,
    });

    const grounded = await generateGroundedPost(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      promptSourcePosts,
      (messages, maxTokens, temperature) =>
        withRetry(() => openRouterClient.chat(messages, maxTokens, temperature)),
    );

    if (grounded.text === null) {
      const message =
        `Skipping publish: generated drafts failed fact grounding after ${grounded.attempts} attempts. ` +
        `Unsupported claims: ${grounded.violations.join('; ')}`;
      logger.warn('Craft stage rejected by grounding gate', {
        attempts: grounded.attempts,
        violations: grounded.violations,
      });
      completeRun(db, runId, 'failed', message);
      return { status: 'skipped', error: message };
    }

    const generatedText = grounded.text;

    const fittedText = await fitPostToLimit(
      generatedText,
      (text, targetChars) =>
        withRetry(() =>
          openRouterClient.chat(
            [
              {
                role: 'system',
                content:
                  `You are an expert social editor. Rewrite the Threads post below in natural Bahasa Indonesia. ` +
                  `Make it SHORTER and PUNCHIER, fit under ${targetChars} characters. ` +
                  `Pick the single strongest angle and cut everything else. ` +
                  `No em dashes, no colons, no hashtags, no emojis unless essential, no filler. ` +
                  `Keep line breaks between beats if the original has them, don't flatten into one paragraph. ` +
                  'Return ONLY the rewritten post text.',
              },
              { role: 'user', content: text },
            ],
            // 1000: reasoning models spend tokens thinking before the rewrite; 400 was
            // enough for non-reasoning models but cut reasoning models off before any output.
            1000,
          ),
        ),
    );
    const safeText = sanitizePost(fittedText);
    const excludedTopic = findExcludedTopic(safeText, config.excludedTopics);
    if (excludedTopic) {
      const message = `Skipping publish: generated post violates the account topic boundary (${excludedTopic}).`;
      logger.warn('Craft stage rejected by account topic boundary', { excludedTopic });
      completeRun(db, runId, 'failed', message);
      return { status: 'skipped', error: message };
    }
    logger.info('Post crafted', { length: safeText.length });

    // ── Stage 3: Publish ──────────────────────────────────────────────────
    if (effectiveDryRun) {
      logger.info('DRY RUN — would publish generated post', { length: safeText.length });
      savePost(db, {
        source_query: successfulQueries.join(','),
        source_post_ids: JSON.stringify(allPosts.slice(0, 10).map((p) => p.id)),
        generated_text: safeText,
        threads_post_id: null, // not published
        published_at: null,
      });
      completeRun(db, runId, 'success');
      return { status: 'success', generatedText: safeText };
    }

    // Find optional Unsplash image (deduped against DB)
    const imageUrl = await findImage(safeText, config.unsplashAccessKey, db);

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
      source_query: successfulQueries.join(','),
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
