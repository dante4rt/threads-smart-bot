import { describe, expect, it, vi } from 'vitest';
import { buildCrawlQueryPool, collectSourcePosts, fitPostToLimit } from '../src/pipeline.js';

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

    const result = await collectSourcePosts(['tech'], 4, searchFn);

    expect(result.posts.map((post) => post.id)).toEqual(['1', '2', '3', '4']);
    expect(result.usedQueries).toEqual(['tech', 'trending']);
    expect(searchFn).toHaveBeenCalledTimes(2);
  });

  it('returns all gathered posts when the pool still cannot reach the threshold', async () => {
    const searchFn = vi.fn(async (query: string) => {
      if (query === 'tech') {
        return [{ id: '1', text: 'tech 1' }];
      }

      return [];
    });

    const result = await collectSourcePosts(['tech'], 3, searchFn);

    expect(result.posts.map((post) => post.id)).toEqual(['1']);
    expect(result.usedQueries).toContain('tech');
    expect(result.usedQueries).toContain('trending');
    expect(searchFn).toHaveBeenCalled();
  });
});

describe('fitPostToLimit', () => {
  it('returns the original text when already within the limit', async () => {
    const rewriteFn = vi.fn();
    const text = 'Singkat dan aman';

    const result = await fitPostToLimit(text, rewriteFn, 500, 460, 2);

    expect(result).toBe(text);
    expect(rewriteFn).not.toHaveBeenCalled();
  });

  it('rewrites oversized text before returning it', async () => {
    const rewriteFn = vi.fn(async () => 'Versi lebih pendek yang masih utuh.');
    const text = 'x'.repeat(520);

    const result = await fitPostToLimit(text, rewriteFn, 500, 460, 2);

    expect(result).toBe('Versi lebih pendek yang masih utuh.');
    expect(rewriteFn).toHaveBeenCalledOnce();
  });

  it('falls back to truncation if rewrites still exceed the limit', async () => {
    const rewriteFn = vi.fn(async () => 'y'.repeat(520));
    const text = 'x'.repeat(520);

    const result = await fitPostToLimit(text, rewriteFn, 500, 460, 2);

    expect(result).toHaveLength(500);
    expect(result.endsWith('…')).toBe(true);
    expect(rewriteFn).toHaveBeenCalledTimes(2);
  });
});
