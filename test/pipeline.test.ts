import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  buildBalancedSourcePosts,
  buildCrawlQueryPool,
  buildDailyQueryPool,
  collectSourcePosts,
  dayOfWeekInTimezone,
  fitPostToLimit,
  findExcludedTopic,
  runPipeline,
} from '../src/pipeline.js';
import { OpenRouterClient } from '../src/openrouter.js';
import { ThreadsClient } from '../src/threads-api.js';
import type { Config } from '../src/config.js';

describe('findExcludedTopic', () => {
  it('matches an account boundary regardless of text casing', () => {
    expect(findExcludedTopic('Update ArBiTrUm baru lagi', ['Arbitrum'])).toBe('Arbitrum');
  });

  it('does not reject unrelated content', () => {
    expect(findExcludedTopic('Kuliner Jakarta lagi ramai', ['Arbitrum'])).toBeUndefined();
  });
});

describe('buildCrawlQueryPool', () => {
  it('preserves configured queries and appends broader fallbacks without duplicates', () => {
    const queries = buildCrawlQueryPool(['tech', 'AI', 'viral']);

    expect(queries).toEqual(expect.arrayContaining(['tech', 'AI', 'viral', 'trending', 'startup']));
    expect(new Set(queries).size).toBe(queries.length);
  });

  it('defers AI-focused seeds behind broad trend queries', () => {
    const queries = buildCrawlQueryPool(['viral', 'tech', 'AI', 'trending']);

    expect(queries.indexOf('trending')).toBeLessThan(queries.indexOf('AI'));
    expect(queries.indexOf('Indonesia')).toBeLessThan(queries.indexOf('AI'));
    expect(queries.indexOf('bisnis')).toBeLessThan(queries.indexOf('AI'));
  });

  it('removes excluded hardcoded fallback queries', () => {
    const queries = buildCrawlQueryPool(['tech'], false, ['crypto', 'web3']);

    expect(queries).not.toContain('crypto');
    expect(queries).not.toContain('web3');
  });
});

describe('buildDailyQueryPool', () => {
  // 4 themed buckets, no AI words so nothing gets deferred / dropped.
  const catalog = {
    tech: ['ngoding', 'developer'],
    bisnis: ['startup', 'UMKM'],
    kreator: ['creator', 'konten'],
    keuangan: ['investasi', 'gaji'],
  };
  const tz = 'Asia/Jakarta';
  // Known weekdays in Asia/Jakarta (UTC+7, no DST): Jun 22 2026 = Monday, Jun 23 = Tuesday.
  const monday = new Date('2026-06-22T05:00:00Z');
  const tuesday = new Date('2026-06-23T05:00:00Z');

  it('produces a non-empty pool drawn only from the catalog', () => {
    const allCatalogQueries = new Set(Object.values(catalog).flat());
    const pool = buildDailyQueryPool(catalog, monday, tz);

    expect(pool.length).toBeGreaterThan(0);
    const fromCatalog = pool.filter((q) => allCatalogQueries.has(q));
    // Every catalog query should survive (broad fallbacks are appended on top).
    expect(fromCatalog).toEqual(expect.arrayContaining([...allCatalogQueries]));
  });

  it('is deterministic for the same date + timezone', () => {
    // Both timestamps fall on the same Jakarta calendar day (12:00 and 21:00 WIB).
    const a = buildDailyQueryPool(catalog, monday, tz);
    const b = buildDailyQueryPool(catalog, new Date('2026-06-22T14:00:00Z'), tz);

    expect(a).toEqual(b);
  });

  it('rotates the leading categories for different weekdays', () => {
    const mon = buildDailyQueryPool(catalog, monday, tz);
    const tue = buildDailyQueryPool(catalog, tuesday, tz);

    // Same query set, different ordering — the leading query differs by day.
    expect(new Set(mon)).toEqual(new Set(tue));
    expect(mon[0]).not.toBe(tue[0]);
  });

  it('removes excluded topics from the crawl pool', () => {
    const pool = buildDailyQueryPool(
      { crypto: ['Arbitrum', 'Ethereum'], food: ['kuliner Jakarta'] },
      monday,
      tz,
      ['Arbitrum'],
    );

    expect(pool).not.toContain('Arbitrum');
    expect(pool).toContain('Ethereum');
    expect(pool).toContain('kuliner Jakarta');
  });

  const sevenWeekdayPools = (cat: Record<string, string[]>): string[] => {
    const baseSunday = new Date('2026-06-21T05:00:00Z'); // Sunday in WIB
    const pools: string[] = [];
    for (let day = 0; day < 7; day++) {
      const date = new Date(baseSunday.getTime() + day * 24 * 60 * 60 * 1000);
      pools.push(buildDailyQueryPool(cat, date, tz).join('|'));
    }
    return pools;
  };

  it('rotates the leading bucket through all bucket positions, capped by bucket count', () => {
    // Rotation now shifts BUCKET ORDER (not flattened list position) so a large
    // early-alphabet bucket (e.g. "blockchain") can't structurally dominate every
    // day's front-of-pool just because it holds more queries than its neighbors.
    // With 4 buckets, the leading bucket can only take 4 distinct positions across
    // the week (min(7, bucketCount)) — that's the real ceiling for bucket-order
    // rotation, not a regression. Buckets with ≥7 entries (the deriveCategoryQueries
    // default shape, tested below) still reach full 7-distinct orderings.
    expect(new Set(sevenWeekdayPools(catalog)).size).toBe(4);
  });

  it('gives every bucket an equal-length turn leading the pool, regardless of bucket size', () => {
    // Regression guard for the original bug: a flat-list shift let a large bucket
    // (many queries) dominate the front of the pool on most days, because shifting
    // list POSITION rarely clears a large bucket's span in one 0-6 hop. Bucket-order
    // rotation guarantees each bucket leads on exactly ceil(7/bucketCount) days.
    const skewed = {
      blockchain: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'],
      defi: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'],
      food: ['f1', 'f2'],
    };
    const leaders = new Set<string>();
    const baseSunday = new Date('2026-06-21T05:00:00Z');
    for (let day = 0; day < 7; day++) {
      const date = new Date(baseSunday.getTime() + day * 24 * 60 * 60 * 1000);
      const pool = buildDailyQueryPool(skewed, date, tz);
      if (pool[0]) leaders.add(pool[0]);
    }
    // All 3 buckets must appear as a leader at least once across the week —
    // "food" (2 queries) must lead just as often as "defi" (8 queries).
    expect(leaders).toEqual(new Set(['b1', 'd1', 'f1']));
  });

  it('stays 7-distinct on the uneven-bucket shape the default derive path produces', () => {
    // 8 flat queries round-robined into 7 buckets gives sizes [2,1,1,1,1,1,1].
    // The previous two-rotation scheme collapsed Mon≡Fri / Tue≡Sat on this shape.
    const unevenDerived = {
      'group-1': ['a', 'h'],
      'group-2': ['b'],
      'group-3': ['c'],
      'group-4': ['d'],
      'group-5': ['e'],
      'group-6': ['f'],
      'group-7': ['g'],
    };
    expect(new Set(sevenWeekdayPools(unevenDerived)).size).toBe(7);
  });

  it('returns an empty pool when the catalog is empty', () => {
    expect(buildDailyQueryPool({}, monday, tz)).toEqual([]);
  });
});

describe('dayOfWeekInTimezone', () => {
  it('maps a known date to the correct weekday index in the timezone', () => {
    // 2026-06-22 is a Monday in Asia/Jakarta.
    expect(dayOfWeekInTimezone(new Date('2026-06-22T05:00:00Z'), 'Asia/Jakarta')).toBe(1);
  });

  it('respects timezone boundaries (late UTC Sunday is already Monday in Jakarta)', () => {
    // 2026-06-21T20:00Z = 2026-06-22T03:00 in Jakarta → Monday (1), not Sunday (0).
    expect(dayOfWeekInTimezone(new Date('2026-06-21T20:00:00Z'), 'Asia/Jakarta')).toBe(1);
  });
});

describe('collectSourcePosts', () => {
  it('keeps crawling until the minimum unique post count is reached', async () => {
    const searchFn = vi.fn(async (query: string) => {
      if (query === 'tech') {
        return [
          { id: '1', text: 'tech 1' },
          { id: '2', text: 'tech 2' },
        ];
      }

      if (query === 'trending') {
        return [
          { id: '2', text: 'tech 2' },
          { id: '3', text: 'trend 3' },
          { id: '4', text: 'trend 4' },
        ];
      }

      return [];
    });

    const result = await collectSourcePosts(['tech'], 4, 2, searchFn);

    expect(result.posts.map((post) => post.id)).toEqual(['1', '2', '3', '4']);
    expect(result.usedQueries).toEqual(['tech', 'trending']);
    expect(result.successfulQueries).toEqual(['tech', 'trending']);
    expect(searchFn).toHaveBeenCalledTimes(2);
  });

  it('continues crawling until both post and query thresholds are met', async () => {
    const searchFn = vi.fn(async (query: string) => {
      if (query === 'tech') {
        return [
          { id: '1', text: 'tech 1' },
          { id: '2', text: 'tech 2' },
          { id: '3', text: 'tech 3' },
          { id: '4', text: 'tech 4' },
        ];
      }

      if (query === 'trending') {
        return [{ id: '5', text: 'trend 5' }];
      }

      if (query === 'viral') {
        return [{ id: '6', text: 'viral 6' }];
      }

      return [];
    });

    const result = await collectSourcePosts(['tech'], 4, 3, searchFn);

    expect(result.posts.map((post) => post.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(result.successfulQueries).toEqual(['tech', 'trending', 'viral']);
    expect(searchFn).toHaveBeenCalledTimes(3);
  });

  it('returns all gathered posts when the pool still cannot reach the thresholds', async () => {
    const searchFn = vi.fn(async (query: string) => {
      if (query === 'tech') {
        return [{ id: '1', text: 'tech 1' }];
      }

      return [];
    });

    const result = await collectSourcePosts(['tech'], 3, 2, searchFn);

    expect(result.posts.map((post) => post.id)).toEqual(['1']);
    expect(result.usedQueries).toContain('tech');
    expect(result.usedQueries).toContain('trending');
    expect(result.successfulQueries).toEqual(['tech']);
    expect(searchFn).toHaveBeenCalled();
  });

  it('excludes matching source posts before they can reach the prompt', async () => {
    const searchFn = vi.fn(async () => [
      { id: 'arbitrum', text: 'Arbitrum lagi ramai' },
      { id: 'food', text: 'Makan siang dekat kantor lagi viral' },
    ]);

    const result = await collectSourcePosts(['trending'], 1, 1, searchFn, ['trending'], ['Arbitrum']);

    expect(result.posts).toEqual([{ id: 'food', text: 'Makan siang dekat kantor lagi viral' }]);
    expect(result.successfulQueries).toEqual(['trending']);
  });

  it('continues crawling when an early query only returns excluded posts', async () => {
    const searchFn = vi.fn(async (query: string) => {
      if (query === 'trending') return [{ id: 'arbitrum', text: 'Arbitrum lagi ramai' }];
      return [{ id: 'food', text: 'Makan siang dekat kantor lagi viral' }];
    });

    const result = await collectSourcePosts(
      ['trending', 'viral'],
      1,
      1,
      searchFn,
      ['trending', 'viral'],
      ['Arbitrum'],
    );

    expect(result.usedQueries).toEqual(['trending', 'viral']);
    expect(result.successfulQueries).toEqual(['viral']);
    expect(result.posts.map((post) => post.id)).toEqual(['food']);
  });
});

describe('buildBalancedSourcePosts', () => {
  it('caps prompt sources per query and interleaves them', () => {
    const result = buildBalancedSourcePosts(
      [
        {
          query: 'AI',
          fetchedPosts: 5,
          uniqueAddedPosts: [
            { id: 'a1', text: 'AI 1' },
            { id: 'a2', text: 'AI 2' },
            { id: 'a3', text: 'AI 3' },
          ],
        },
        {
          query: 'tech',
          fetchedPosts: 2,
          uniqueAddedPosts: [
            { id: 't1', text: 'Tech 1' },
            { id: 't2', text: 'Tech 2' },
          ],
        },
        {
          query: 'viral',
          fetchedPosts: 2,
          uniqueAddedPosts: [
            { id: 'v1', text: 'Viral 1' },
            { id: 'v2', text: 'Viral 2' },
          ],
        },
      ],
      2,
    );

    expect(result.map((post) => post.id)).toEqual(['a1', 't1', 'v1', 'a2', 't2', 'v2']);
  });
});

describe('fitPostToLimit', () => {
  it('returns the original text when already within the limit', async () => {
    const rewriteFn = vi.fn();
    const text = 'Singkat dan aman';

    const result = await fitPostToLimit(text, rewriteFn, 450, 350, 2);

    expect(result).toBe(text);
    expect(rewriteFn).not.toHaveBeenCalled();
  });

  it('rewrites oversized text before returning it', async () => {
    const rewriteFn = vi.fn(async () => 'Versi lebih pendek yang masih utuh.');
    const text = 'x'.repeat(460);

    const result = await fitPostToLimit(text, rewriteFn, 450, 350, 2);

    expect(result).toBe('Versi lebih pendek yang masih utuh.');
    expect(rewriteFn).toHaveBeenCalledOnce();
  });

  it('falls back to truncation if rewrites still exceed the limit', async () => {
    const longSentence = 'Kata yang panjang sekali. '.repeat(25);
    const rewriteFn = vi.fn(async () => longSentence);
    const text = 'x'.repeat(460);

    const result = await fitPostToLimit(text, rewriteFn, 450, 350, 2);

    expect(result.length).toBeLessThanOrEqual(450);
    expect(rewriteFn).toHaveBeenCalledTimes(2);
  });
});

describe('runPipeline account topic boundary', () => {
  it('skips publishing when shortening changes a safe draft into an excluded topic', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, source_query TEXT, source_post_ids TEXT, generated_text TEXT NOT NULL, threads_post_id TEXT, published_at TEXT);
      CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, error_message TEXT, started_at TEXT NOT NULL, completed_at TEXT);
    `);

    const config: Config = {
      threadsAppId: 'app-id',
      threadsAppSecret: 'app-secret',
      threadsUserId: '123',
      threadsAccessToken: 'access-token',
      threadsRedirectUri: 'https://localhost/callback',
      dbPath: ':memory:',
      openrouterApiKey: 'or-key',
      openrouterModel: 'test-model',
      searchQueries: ['trending'],
      categoryQueries: { general: ['trending'] },
      minSourcePosts: 1,
      minSourceQueries: 1,
      maxSourcePostsPerQuery: 1,
      postTimes: ['12:15'],
      timezone: 'Asia/Jakarta',
      unsplashAccessKey: undefined,
      authorContext: '',
      excludedTopics: ['Arbitrum'],
      dryRun: false,
    };

    vi.spyOn(ThreadsClient.prototype, 'maybeRefreshToken').mockResolvedValue(undefined);
    vi.spyOn(ThreadsClient.prototype, 'keywordSearch').mockResolvedValue([
      { id: 'source-1', text: 'Kuliner Jakarta lagi ramai' },
    ]);
    const createMediaContainer = vi.spyOn(ThreadsClient.prototype, 'createMediaContainer');
    const publishMediaContainer = vi.spyOn(ThreadsClient.prototype, 'publishMediaContainer');
    vi.spyOn(OpenRouterClient.prototype, 'chat')
      .mockResolvedValueOnce('Aman '.repeat(100))
      .mockResolvedValueOnce('{"grounded":true,"violations":[]}')
      .mockResolvedValueOnce('Arbitrum update');

    try {
      const result = await runPipeline(config, db);

      expect(result).toMatchObject({ status: 'skipped', error: expect.stringContaining('Arbitrum') });
      expect(createMediaContainer).not.toHaveBeenCalled();
      expect(publishMediaContainer).not.toHaveBeenCalled();
      expect(db.prepare('SELECT status FROM runs').get()).toEqual({ status: 'failed' });
    } finally {
      vi.restoreAllMocks();
      db.close();
    }
  });
});
