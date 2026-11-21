// test/trends.test.ts

import { describe, it, expect } from 'vitest';
import { parseRssTitles, extractTrendingTerms, fetchTrendingTerms } from '../src/trends.js';
import { mergeTrendQueries } from '../src/pipeline.js';

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Feed Title Itself</title>
<item><title>UU Perampasan Aset Disahkan DPR Hari Ini</title><link>a</link></item>
<item><title><![CDATA[Pramono Tetapkan UMP Jakarta 2027 &amp; Rinciannya]]></title></item>
<item><title>Polemik UU Perampasan Aset Berlanjut di Senayan</title></item>
</channel></rss>`;

describe('parseRssTitles', () => {
  it('extracts item titles, decoding CDATA and entities, skipping the channel title', () => {
    const titles = parseRssTitles(RSS_FIXTURE);

    expect(titles).toHaveLength(3);
    expect(titles[0]).toBe('UU Perampasan Aset Disahkan DPR Hari Ini');
    expect(titles[1]).toBe('Pramono Tetapkan UMP Jakarta 2027 & Rinciannya');
    expect(titles).not.toContain('Feed Title Itself');
  });

  it('returns empty array on non-XML garbage', () => {
    expect(parseRssTitles('<html>not a feed</html>')).toEqual([]);
  });
});

describe('extractTrendingTerms', () => {
  it('ranks multi-word terms repeated across distinct titles', () => {
    const titles = [
      'UU Perampasan Aset Disahkan DPR',
      'Polemik UU Perampasan Aset Berlanjut',
      'Demo Mahasiswa Tolak UU Perampasan Aset',
      'Harga Beras Naik di Pasar',
    ];

    const terms = extractTrendingTerms(titles, 3);

    expect(terms[0]).toBe('uu perampasan aset');
  });

  it('drops terms seen in only one title and headline glue words', () => {
    const titles = [
      'Menteri Sebut Harga Beras Stabil',
      'Harga Beras Naik Lagi Kata Pedagang',
    ];

    const terms = extractTrendingTerms(titles, 5);

    expect(terms).toContain('harga beras');
    // "sebut"/"kata" are headline verbs, not topics.
    expect(terms.join(' ')).not.toMatch(/\bsebut\b|\bkata\b/);
    // "stabil" appears once only.
    expect(terms).not.toContain('stabil');
  });

  it('dedupes substrings of an already-picked stronger term', () => {
    const titles = [
      'Cek Bansos BPNT Sembako Cair',
      'Bansos BPNT Sembako Tahap Dua',
      'Jadwal Bansos BPNT Sembako',
    ];

    const terms = extractTrendingTerms(titles, 5);

    const bpnt = terms.filter((t) => t.includes('bpnt'));
    expect(bpnt).toHaveLength(1);
  });
});

describe('fetchTrendingTerms', () => {
  const okResponse = (body: string): Response =>
    ({ ok: true, status: 200, text: () => Promise.resolve(body) }) as unknown as Response;

  it('pools titles across feeds and survives a dead feed', async () => {
    const fetchFn = (url: string): Promise<Response> => {
      if (url.includes('dead')) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(okResponse(RSS_FIXTURE));
    };

    const terms = await fetchTrendingTerms(['https://dead.example/rss', 'https://ok.example/rss'], 3, fetchFn);

    expect(terms).toContain('uu perampasan aset');
  });

  it('returns empty on all-failing feeds instead of throwing', async () => {
    const fetchFn = (): Promise<Response> => Promise.reject(new Error('down'));

    await expect(fetchTrendingTerms(['https://a/rss', 'https://b/rss'], 3, fetchFn)).resolves.toEqual([]);
  });

  it('skips non-OK responses', async () => {
    const fetchFn = (): Promise<Response> =>
      Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') } as unknown as Response);

    await expect(fetchTrendingTerms(['https://a/rss'], 3, fetchFn)).resolves.toEqual([]);
  });
});

describe('mergeTrendQueries', () => {
  it('prepends trend terms, capped, deduped against the pool, excluding banned topics', () => {
    const { crawlQueries, trendQuerySet } = mergeTrendQueries(
      ['ump jakarta', 'Trending', 'arbitrum airdrop', 'bansos bpnt', 'pemilu'],
      ['trending', 'startup'],
      ['Arbitrum'],
      2,
    );

    expect(crawlQueries).toEqual(['ump jakarta', 'bansos bpnt', 'trending', 'startup']);
    expect(trendQuerySet.has('ump jakarta')).toBe(true);
    expect(trendQuerySet.has('arbitrum airdrop')).toBe(false);
    expect(trendQuerySet.has('trending')).toBe(false);
  });

  it('returns the pool unchanged when there are no trend terms', () => {
    const { crawlQueries, trendQuerySet } = mergeTrendQueries([], ['a', 'b'], [], 3);

    expect(crawlQueries).toEqual(['a', 'b']);
    expect(trendQuerySet.size).toBe(0);
  });
});
