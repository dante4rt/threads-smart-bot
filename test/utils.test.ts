// test/utils.test.ts

import { describe, it, expect } from 'vitest';
import { pickRandom, dedupeBy, parseTime, toCronExpr, extractKeyword, truncate } from '../src/utils.js';

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
    expect(kw).toBe('Teknologi');
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

describe('truncate', () => {
  it('returns original string when under limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates and adds ellipsis', () => {
    const result = truncate('hello world', 8);
    expect(result).toHaveLength(8);
    expect(result.endsWith('…')).toBe(true);
  });
});
