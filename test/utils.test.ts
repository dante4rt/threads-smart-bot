// test/utils.test.ts

import { describe, it, expect } from 'vitest';
import { pickRandom, dedupeBy, parseTime, toCronExpr, extractKeyword, extractKeywords, truncate, sanitizePost } from '../src/utils.js';

describe('pickRandom', () => {
  it('returns requested count when array is larger', () => {
    const arr = [1, 2, 3, 4, 5];
    const result = pickRandom(arr, 3);
    expect(result).toHaveLength(3);
    result.forEach((item) => expect(arr).toContain(item));
  });

  it('returns all items when count >= length', () => {
    const arr = [1, 2, 3];
    expect(pickRandom(arr, 5)).toHaveLength(3);
  });

  it('does not mutate original array', () => {
    const arr = [1, 2, 3, 4];
    const copy = [...arr];
    pickRandom(arr, 2);
    expect(arr).toEqual(copy);
  });
});

describe('dedupeBy', () => {
  it('removes duplicates by key', () => {
    const items = [
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' },
      { id: 'a', text: 'duplicate' },
    ];
    const result = dedupeBy(items, 'id');
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('returns empty array for empty input', () => {
    expect(dedupeBy([], 'id')).toEqual([]);
  });
});

describe('parseTime', () => {
  it('parses valid HH:MM', () => {
    expect(parseTime('09:00')).toEqual({ hour: 9, minute: 0 });
    expect(parseTime('17:30')).toEqual({ hour: 17, minute: 30 });
  });

  it('throws on invalid format', () => {
    expect(() => parseTime('25:00')).toThrow();
    expect(() => parseTime('09:60')).toThrow();
  });
});

describe('toCronExpr', () => {
  it('generates correct cron expression', () => {
    expect(toCronExpr(9, 0)).toBe('0 9 * * *');
    expect(toCronExpr(17, 30)).toBe('30 17 * * *');
  });
});

describe('extractKeyword', () => {
  it('extracts first meaningful word', () => {
    const kw = extractKeyword('Teknologi masa depan sangat menarik');
    expect(kw).toBe('teknologi');
  });

  it('skips stopwords', () => {
    const kw = extractKeyword('the best technology for everyone');
    expect(kw).toBe('best');
  });

  it('returns fallback for empty string', () => {
    const kw = extractKeyword('');
    expect(kw).toBe('technology');
  });
});

describe('extractKeywords', () => {
  it('extracts multiple keywords', () => {
    const kws = extractKeywords('Teknologi blockchain sangat membantu developer', 3);
    expect(kws.length).toBeGreaterThanOrEqual(2);
    expect(kws.length).toBeLessThanOrEqual(3);
  });

  it('skips Bahasa stopwords', () => {
    const kws = extractKeywords('gue juga bisa punya teknologi bagus', 3);
    expect(kws).not.toContain('gue');
    expect(kws).not.toContain('juga');
    expect(kws).not.toContain('bisa');
  });

  it('returns fallback for empty input', () => {
    expect(extractKeywords('', 3)).toEqual(['technology']);
  });

  it('deduplicates keywords', () => {
    const kws = extractKeywords('crypto crypto crypto blockchain blockchain', 3);
    expect(new Set(kws).size).toBe(kws.length);
  });
});

describe('truncate', () => {
  it('returns original string when under limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates at sentence boundary when possible', () => {
    const text = 'First sentence here. Second sentence here. Third sentence is long.';
    const result = truncate(text, 45);
    expect(result).toBe('First sentence here. Second sentence here.');
  });

  it('truncates at word boundary when no sentence end found', () => {
    const text = 'one two three four five six seven eight nine ten';
    const result = truncate(text, 25);
    expect(result).toBe('one two three four five');
    expect(result.length).toBeLessThanOrEqual(25);
  });
});

describe('sanitizePost', () => {
  it('replaces em dashes with commas', () => {
    expect(sanitizePost('hello \u2014 world')).toBe('hello , world');
  });

  it('replaces en dashes with hyphens', () => {
    expect(sanitizePost('2024\u20132025')).toBe('2024-2025');
  });

  it('replaces unicode ellipsis with three dots', () => {
    expect(sanitizePost('wait\u2026')).toBe('wait...');
  });

  it('cleans up double commas from em dash replacement', () => {
    expect(sanitizePost('a,\u2014b')).toBe('a,b');
  });
});
