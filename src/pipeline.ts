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
  getPostsNeedingMetrics,
  updatePostMetrics,
  countRecentFailures,
} from './db.js';
import { ThreadsClient } from './threads-api.js';
import { OpenRouterClient } from './openrouter.js';
import { buildMessages } from './prompt.js';
import { generateGroundedPost, verifyPostGrounding } from './fact-check.js';
import { evaluateCaption } from './jev.js';
import { findImage } from './media.js';
import { fetchTrendingTerms } from './trends.js';
import { pickRandom, dedupeBy, truncate, sanitizePost } from './utils.js';
import type { Config } from './config.js';
import type { Post } from './db.js';
import type { ThreadsPost } from './threads-api.js';

const MAX_POST_CHARS = 450;
const TARGET_POST_CHARS = 350;
const POSTS_PER_QUERY = 25;
const MAX_COMPRESSION_ATTEMPTS = 2;
const CAPTION_RETRY_DELAY_CAP_MS = 5 * 60 * 1000;
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

async function waitBeforeCaptionRetry(attempt: number): Promise<void> {
  if (attempt < 3) return;
  const delayMs = Math.min(CAPTION_RETRY_DELAY_CAP_MS, 5_000 * 2 ** Math.min(attempt - 3, 6));
  logger.warn('Waiting before another caption attempt', { attempt, delayMs });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

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

/**
 * Backfill engagement for recently published posts. Metrics are a nice-to-have
 * input to the next draft, never a reason to abandon a run, so a failure here
 * is logged and swallowed — including the 403 you get without the
 * threads_manage_insights scope.
 */
export async function refreshRecentMetrics(
  threadsClient: Pick<ThreadsClient, 'getMediaInsights'>,
  db: Database,
): Promise<number> {
  let posts: Post[];
  try {
    posts = getPostsNeedingMetrics(db);
  } catch (err) {
    // e.g. a DB predating the engagement columns. Never worth failing a run over.
    logger.warn('Could not list posts needing metrics', { error: (err as Error).message });
    return 0;
  }

  let updated = 0;

  for (const post of posts) {
    if (!post.threads_post_id) continue;
    try {
      const metrics = await threadsClient.getMediaInsights(post.threads_post_id);
      updatePostMetrics(db, post.threads_post_id, metrics);
      updated++;
    } catch (err) {
      logger.warn('Metrics refresh failed for post', {
        threadsPostId: post.threads_post_id,
        error: (err as Error).message,
      });
    }
  }

  logger.info('Metrics refreshed', { candidates: posts.length, updated });
  return updated;
}

/**
 * Pick the topic tag for a post from the category that contributed most of the
 * successful crawl queries. Ties break on category name so the same crawl always
 * yields the same tag. Returns '' when nothing matches and no default is set.
 */
export function resolveTopicTag(
  categoryQueries: Record<string, string[]>,
  successfulQueries: string[],
  topicTags: Record<string, string>,
  defaultTopicTag = '',
): string {
  const normalized = new Set(successfulQueries.map((q) => q.trim().toLowerCase()));

  let bestCategory = '';
  let bestHits = 0;
  for (const category of Object.keys(categoryQueries).sort()) {
    if (!topicTags[category]) continue;
    const hits = (categoryQueries[category] ?? []).filter((q) =>
      normalized.has(q.trim().toLowerCase()),
    ).length;
    if (hits > bestHits) {
      bestHits = hits;
      bestCategory = category;
    }
  }

  if (bestCategory) return topicTags[bestCategory] ?? defaultTopicTag;
  return defaultTopicTag;
}

/**
 * Prepend today's trending terms to the rotated query pool. Trend terms lead so
 * the crawl's early-exit (minSourcePosts/minSourceQueries) samples them first;
 * excluded topics and duplicates are dropped. Pure for testability.
 */
export function mergeTrendQueries(
  trendTerms: string[],
  dailyQueryPool: string[],
  excludedTopics: string[],
  maxTrendQueries: number,
): { crawlQueries: string[]; trendQuerySet: Set<string> } {
  const poolLower = new Set(dailyQueryPool.map((q) => q.trim().toLowerCase()));
  const accepted: string[] = [];
  for (const term of trendTerms) {
    if (accepted.length >= maxTrendQueries) break;
    const normalized = term.trim();
    if (!normalized) continue;
    if (poolLower.has(normalized.toLowerCase())) continue;
    if (findExcludedTopic(normalized, excludedTopics)) continue;
    accepted.push(normalized);
  }
  return {
    crawlQueries: [...accepted, ...dailyQueryPool],
    trendQuerySet: new Set(accepted.map((q) => q.toLowerCase())),
  };
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

  logger.info('Pipeline started', {
    runId,
    dryRun: effectiveDryRun,
    jevEnabled: config.jevEnabled,
  });

  try {
    const threadsClient = new ThreadsClient(config, db);
    const openRouterClient = new OpenRouterClient(config);

    // ── Pre-flight: check/refresh token ───────────────────────────────────
    logger.info('Token preflight started', { runId });
    await withRetry(() => threadsClient.maybeRefreshToken());
    logger.info('Token preflight completed', { runId });

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

    // Trend trigger: what is Indonesia talking about right now. Fail-soft — a
    // dead feed or a failing trend query must never cost the run.
    let trendTerms: string[] = [];
    if (config.trendFeeds.length > 0) {
      try {
        trendTerms = await fetchTrendingTerms(config.trendFeeds, config.maxTrendQueries * 2);
      } catch (err) {
        logger.warn('Trend detection failed; crawling static pool only', {
          error: (err as Error).message,
        });
      }
    }
    const { crawlQueries, trendQuerySet } = mergeTrendQueries(
      trendTerms,
      dailyQueryPool,
      config.excludedTopics,
      config.maxTrendQueries,
    );

    const searchWithTrendMode = async (query: string, limit: number): Promise<ThreadsPost[]> => {
      if (!trendQuerySet.has(query.toLowerCase())) {
        return withRetry(() => threadsClient.keywordSearch(query, limit));
      }
      try {
        // RECENT confirms the topic is moving on Threads *now*; TOP would
        // surface last month's posts for the same words. `since` is NOT used:
        // probed live 2026-11-21, it thins results to near-zero (48h window
        // returned 1 post for a term where plain RECENT returned a full page).
        return await withRetry(() =>
          threadsClient.keywordSearch(query, limit, { searchType: 'RECENT' }),
        );
      } catch (err) {
        logger.warn('Trend query failed; continuing with static queries', {
          query,
          error: (err as Error).message,
        });
        return [];
      }
    };

    const { posts: allPosts, usedQueries, successfulQueries, queryResults } = await collectSourcePosts(
      config.searchQueries,
      config.minSourcePosts,
      config.minSourceQueries,
      searchWithTrendMode,
      crawlQueries,
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
    // Refresh engagement first so the prompt sees which recent posts actually
    // landed, not just what they said.
    await refreshRecentMetrics(threadsClient, db);

    // 20, not 10: at 2 posts/day a 10-post window is 5 days, and the live feed
    // repeated whole subjects (Netflix watchlist, Google Maps menu photos,
    // remote-job hours) 6-12 days apart — inside a month, outside the window.
    const recentPosts = getRecentPosts(db, 20);
    const promptSourcePosts = buildBalancedSourcePosts(
      queryResults,
      config.maxSourcePostsPerQuery,
    );
    const confirmedTrendQueries = successfulQueries.filter((q) =>
      trendQuerySet.has(q.toLowerCase()),
    );
    const [systemPrompt, userMessage] = buildMessages(promptSourcePosts, recentPosts, successfulQueries, {
      timezone: config.timezone,
      authorContext: config.authorContext || undefined,
      excludedTopics: config.excludedTopics,
      trendingQueries: confirmedTrendQueries,
    });

    logger.info('Craft stage', {
      sourcePosts: promptSourcePosts.length,
      totalSourcePosts: allPosts.length,
      recentPosts: recentPosts.length,
      successfulQueries,
    });

    let safeText = '';
    let jevFeedback = '';
    if (!config.jevEnabled) {
      logger.info('JEV gate disabled; using existing craft flow', { runId });
    }
    // Keep this run active until a caption passes. Later scheduled runs wait on
    // runInProgress, so only one caption can be in the approval loop at a time.
    for (let captionAttempt = 1; ; captionAttempt++) {
      const grounded = await generateGroundedPost(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
          ...(jevFeedback ? [{ role: 'user' as const, content: jevFeedback }] : []),
        ],
        promptSourcePosts,
        (messages, maxTokens, temperature) =>
          withRetry(() => openRouterClient.chat(messages, maxTokens, temperature)),
      );

      if (grounded.text === null) {
        const message =
          `Generated drafts failed fact grounding after ${grounded.attempts} attempts. ` +
          `Unsupported claims: ${grounded.violations.join('; ')}`;
        logger.warn('Craft stage rejected by grounding gate', {
          attempts: grounded.attempts,
          violations: grounded.violations,
        });
        if (config.jevEnabled) {
          jevFeedback = `${message} Choose a different, source-supported angle.`;
          await waitBeforeCaptionRetry(captionAttempt);
          continue;
        }
        completeRun(db, runId, 'failed', message);
        return { status: 'skipped', error: message };
      }

      const fittedText = await fitPostToLimit(
        grounded.text,
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
              config.llmMaxTokens,
            ),
          ),
      );
      const candidate = sanitizePost(fittedText);
      const excludedTopic = findExcludedTopic(candidate, config.excludedTopics);
      if (excludedTopic) {
        const message = `Generated post violates the account topic boundary (${excludedTopic}).`;
        logger.warn('Craft stage rejected by account topic boundary', { excludedTopic });
        if (config.jevEnabled) {
          jevFeedback = `${message} Choose a completely different allowed topic. ` +
            `Previous rejected caption: ${JSON.stringify(candidate)}.`;
          await waitBeforeCaptionRetry(captionAttempt);
          continue;
        }
        completeRun(db, runId, 'failed', message);
        return { status: 'skipped', error: message };
      }

      if (candidate !== grounded.text) {
        const finalVerdict = await verifyPostGrounding(
          candidate,
          promptSourcePosts,
          (messages, maxTokens, temperature) =>
            withRetry(() => openRouterClient.chat(messages, maxTokens, temperature)),
        );
        if (!finalVerdict.grounded) {
          logger.warn('Final caption failed fact grounding', { violations: finalVerdict.violations });
          if (config.jevEnabled) {
            jevFeedback = `The final caption was rejected after editing because these claims are unsupported: ` +
              `${finalVerdict.violations.join('; ')}. Write a different source-supported caption.`;
            await waitBeforeCaptionRetry(captionAttempt);
            continue;
          }
          const message = `Skipping publish: final caption failed fact grounding: ${finalVerdict.violations.join('; ')}`;
          completeRun(db, runId, 'failed', message);
          return { status: 'skipped', error: message };
        }
      }

      if (config.jevEnabled) {
        logger.info('JEV evaluation started', {
          runId,
          captionAttempt,
          length: candidate.length,
        });
        const assessment = await evaluateCaption(
          candidate, recentPosts, successfulQueries, config.typesafeApiKey!, config.jevMinScore,
        );
        logger.info('JEV caption assessment', {
          runId,
          captionAttempt,
          approved: assessment.approved,
          score: assessment.score,
          minScore: config.jevMinScore,
          dimensions: assessment.dimensions,
        });
        if (!assessment.approved) {
          logger.warn('JEV rejected caption; regenerating', {
            runId,
            captionAttempt,
            score: assessment.score,
            minScore: config.jevMinScore,
            weakDimensions: assessment.weakDimensions,
          });
          jevFeedback = `The previous caption was rejected by an editorial quality check. ` +
            `Write a substantially different angle, not a paraphrase. Improve these aspects: ` +
            `${assessment.weakDimensions.join(', ') || 'overall attention and conversation value'}. ` +
            `Previous rejected caption: ${JSON.stringify(candidate)}. ` +
            `Keep all source-grounding, account-boundary, voice, and length rules.`;
          await waitBeforeCaptionRetry(captionAttempt);
          continue;
        }
      }

      safeText = candidate;
      break;
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

    const topicTag = resolveTopicTag(
      config.categoryQueries,
      successfulQueries,
      config.topicTags,
      config.defaultTopicTag,
    );
    logger.info('Publish stage', { runId, topicTag: topicTag || null, hasImage: Boolean(imageUrl) });

    // Two-step publish
    const containerId = await withRetry(() =>
      threadsClient.createMediaContainer(safeText, imageUrl, topicTag || undefined),
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

    logger.info('Pipeline completed successfully', { runId, postId: publishedId });
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
