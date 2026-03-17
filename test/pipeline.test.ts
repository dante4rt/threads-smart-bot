import { describe, expect, it, vi } from 'vitest';
import {
  buildBalancedSourcePosts,
  buildCrawlQueryPool,
  collectSourcePosts,
  fitPostToLimit,
} from '../src/pipeline.js';

describe('buildCrawlQueryPool', () => {
  it('preserves configured queries and appends broader fallbacks without duplicates', () => {
    const queries = buildCrawlQueryPool(['tech', 'AI', 'viral']);

    expect(queries).toEqual(expect.arrayContaining(['tech', 'AI', 'viral', 'trending', 'startup']));
    expect(new Set(queries).size).toBe(queries.length);
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
