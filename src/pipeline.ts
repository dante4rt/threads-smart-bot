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
import { pickRandom, dedupeBy, truncate, sanitizePost } from './utils.js';
import type { Config } from './config.js';
import type { ThreadsPost } from './threads-api.js';

const MAX_POST_CHARS = 450;
const TARGET_POST_CHARS = 350;
const POSTS_PER_QUERY = 25;
const MAX_COMPRESSION_ATTEMPTS = 2;
const FALLBACK_SEARCH_QUERIES = [
  'trending',
  'viral',
  'tech',
  'AI',
  'startup',
  'bisnis',
  'productivity',
  'career',
  'creator',
  'marketing',
] as const;

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

export function buildCrawlQueryPool(searchQueries: string[]): string[] {
  const uniqueQueries = new Set<string>();
  const crawlQueries: string[] = [];

  for (const query of [...pickRandom(searchQueries, searchQueries.length), ...FALLBACK_SEARCH_QUERIES]) {
    const normalized = query.trim();
    const key = normalized.toLowerCase();
    if (!normalized || uniqueQueries.has(key)) continue;
    uniqueQueries.add(key);
    crawlQueries.push(normalized);
  }

  return crawlQueries;
}

export async function collectSourcePosts(
  searchQueries: string[],
  minSourcePosts: number,
  minSourceQueries: number,
  searchFn: (query: string, limit: number) => Promise<ThreadsPost[]>,
): Promise<{
  posts: ThreadsPost[];
  usedQueries: string[];
  successfulQueries: string[];
  queryResults: QueryCrawlResult[];
}> {
  const crawlQueries = buildCrawlQueryPool(searchQueries);
  const usedQueries: string[] = [];
  const successfulQueries: string[] = [];
  const queryResults: QueryCrawlResult[] = [];
  let allPosts: ThreadsPost[] = [];

  for (const query of crawlQueries) {
    if (allPosts.length >= minSourcePosts && successfulQueries.length >= minSourceQueries) {
      break;
    }

    const posts = await searchFn(query, POSTS_PER_QUERY);
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
      minSourcePosts: config.minSourcePosts,
      minSourceQueries: config.minSourceQueries,
      maxSourcePostsPerQuery: config.maxSourcePostsPerQuery,
    });

    const { posts: allPosts, usedQueries, successfulQueries, queryResults } = await collectSourcePosts(
      config.searchQueries,
      config.minSourcePosts,
      config.minSourceQueries,
      (query, limit) => withRetry(() => threadsClient.keywordSearch(query, limit)),
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
    const recentPosts = getRecentPosts(db, 5);
    const promptSourcePosts = buildBalancedSourcePosts(
      queryResults,
      config.maxSourcePostsPerQuery,
    );
    const [systemPrompt, userMessage] = buildMessages(promptSourcePosts, recentPosts, successfulQueries, {
      timezone: config.timezone,
    });

    logger.info('Craft stage', {
      sourcePosts: promptSourcePosts.length,
      totalSourcePosts: allPosts.length,
      recentPosts: recentPosts.length,
      successfulQueries,
    });

    const generatedText = await withRetry(() =>
      openRouterClient.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      ),
    );

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
                  `No em dashes, no hashtags, no emojis unless essential, no filler. ` +
                  'Return ONLY the rewritten post text.',
              },
              { role: 'user', content: text },
            ],
            400,
          ),
        ),
    );
    const safeText = sanitizePost(fittedText);
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
