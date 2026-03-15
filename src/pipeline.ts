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
const TARGET_POST_CHARS = 460;
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
  searchFn: (query: string, limit: number) => Promise<ThreadsPost[]>,
): Promise<{ posts: ThreadsPost[]; usedQueries: string[] }> {
  const crawlQueries = buildCrawlQueryPool(searchQueries);
  const usedQueries: string[] = [];
  let allPosts: ThreadsPost[] = [];

  for (const query of crawlQueries) {
    if (allPosts.length >= minSourcePosts) {
      break;
    }

    const posts = await searchFn(query, POSTS_PER_QUERY);
    usedQueries.push(query);
    allPosts = dedupeBy(allPosts.concat(posts), 'id');

    logger.info('Crawl query complete', {
      query,
      fetchedPosts: posts.length,
      uniquePosts: allPosts.length,
      minSourcePosts,
    });
  }

  return { posts: allPosts, usedQueries };
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
    });

    const { posts: allPosts, usedQueries } = await collectSourcePosts(
      config.searchQueries,
      config.minSourcePosts,
      (query, limit) => withRetry(() => threadsClient.keywordSearch(query, limit)),
    );

    logger.info('Crawl complete', { totalPosts: allPosts.length, usedQueries });

    if (allPosts.length < config.minSourcePosts) {
      const message =
        `Insufficient source posts: found ${allPosts.length}, require at least ${config.minSourcePosts}. ` +
        'Broaden SEARCH_QUERIES or lower MIN_SOURCE_POSTS.';
      logger.warn('Skipping craft stage due to thin crawl', {
        totalPosts: allPosts.length,
        minSourcePosts: config.minSourcePosts,
        usedQueries,
      });
      completeRun(db, runId, 'failed', message);
      return { status: 'skipped', error: message };
    }

    // ── Stage 2: Craft ────────────────────────────────────────────────────
    const recentPosts = getRecentPosts(db, 5);
    const [systemPrompt, userMessage] = buildMessages(allPosts, recentPosts, usedQueries);

    logger.info('Craft stage', { sourcePosts: allPosts.length, recentPosts: recentPosts.length });

    const generatedText = await withRetry(() =>
      openRouterClient.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      ),
    );

    const safeText = await fitPostToLimit(
      generatedText,
      (text, targetChars) =>
        withRetry(() =>
          openRouterClient.chat(
            [
              {
                role: 'system',
                content:
                  `You are an expert social editor. Rewrite the Threads post below in natural Bahasa Indonesia. ` +
                  `Keep the same core idea, preserve scannable line breaks, stay punchy, and fit under ${targetChars} characters. ` +
                  'No hashtags, no emojis unless essential, no filler, and return ONLY the rewritten post text.',
              },
              { role: 'user', content: text },
            ],
            400,
          ),
        ),
    );
    logger.info('Post crafted', { length: safeText.length });

    // ── Stage 3: Publish ──────────────────────────────────────────────────
    if (effectiveDryRun) {
      logger.info('DRY RUN — would publish generated post', { length: safeText.length });
      savePost(db, {
        source_query: usedQueries.join(','),
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
      source_query: usedQueries.join(','),
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
