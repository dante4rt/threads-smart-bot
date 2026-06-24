import { describe, expect, it, vi } from 'vitest';
import {
  buildBalancedSourcePosts,
  buildCrawlQueryPool,
  buildDailyQueryPool,
  collectSourcePosts,
  dayOfWeekInTimezone,
  fitPostToLimit,
} from '../src/pipeline.js';

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

  const sevenWeekdayPools = (cat: Record<string, string[]>): string[] => {
    const baseSunday = new Date('2026-06-21T05:00:00Z'); // Sunday in WIB
    const pools: string[] = [];
    for (let day = 0; day < 7; day++) {
      const date = new Date(baseSunday.getTime() + day * 24 * 60 * 60 * 1000);
      pools.push(buildDailyQueryPool(cat, date, tz).join('|'));
    }
    return pools;
  };

  it('produces 7 distinct orderings across the week even when buckets < 7', () => {
    // 4 buckets / 8 queries. A single flat-list cyclic shift must make all 7
    // weekdays distinct regardless of bucket count.
    expect(new Set(sevenWeekdayPools(catalog)).size).toBe(7);
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
