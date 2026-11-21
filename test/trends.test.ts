// test/trends.test.ts

import { describe, it, expect } from 'vitest';
import { parseRssTitles, extractTrendingTopics, fetchTrendingTopics } from '../src/trends.js';
import { mergeTrendQueries, buildHeadlineSourcePosts } from '../src/pipeline.js';

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

describe('extractTrendingTopics', () => {
  const terms = (titles: string[], max: number): string[] =>
    extractTrendingTopics(titles, max).map((t) => t.term);

  it('ranks multi-word terms repeated across distinct titles, with hit counts and headlines', () => {
    const titles = [
      'UU Perampasan Aset Disahkan DPR',
      'Polemik UU Perampasan Aset Berlanjut',
      'Demo Mahasiswa Tolak UU Perampasan Aset',
      'Harga Beras Naik di Pasar',
    ];

    const topics = extractTrendingTopics(titles, 3);

    expect(topics[0]!.term).toBe('uu perampasan aset');
    expect(topics[0]!.titleHits).toBe(3);
    expect(topics[0]!.headlines).toContain('UU Perampasan Aset Disahkan DPR');
  });

  it('drops terms seen in only one title and headline glue words', () => {
    const titles = [
      'Menteri Sebut Harga Beras Stabil',
      'Harga Beras Naik Lagi Kata Pedagang',
    ];

    const picked = terms(titles, 5);

    expect(picked).toContain('harga beras');
    expect(picked.join(' ')).not.toMatch(/\bsebut\b|\bkata\b/);
    expect(picked).not.toContain('stabil');
  });

  it('dedupes substrings of an already-picked stronger term', () => {
    const titles = [
      'Cek Bansos BPNT Sembako Cair',
      'Bansos BPNT Sembako Tahap Dua',
      'Jadwal Bansos BPNT Sembako',
    ];

    const picked = terms(titles, 5);

    expect(picked.filter((t) => t.includes('bpnt'))).toHaveLength(1);
  });

  it('promotes a phrase over its unigram when the phrase covers most of its headlines', () => {
    // Live miss 2026-11-21: "kebakaran" (4 hits) beat "kebakaran baduy" (3 hits)
    // while the Baduy fire was the actual story.
    const titles = [
      'Kebakaran Baduy Hanguskan Puluhan Rumah',
      'Korban Kebakaran Baduy Butuh Bantuan',
      'Donasi untuk Kebakaran Baduy Mengalir',
      'Kebakaran Pasar di Medan Padam',
      'Harga Beras Naik di Pasar',
    ];

    const topics = extractTrendingTopics(titles, 3);

    expect(topics[0]!.term).toBe('kebakaran baduy');
    expect(topics.map((t) => t.term)).not.toContain('kebakaran');
  });
});

describe('fetchTrendingTopics', () => {
  const okResponse = (body: string): Response =>
    ({ ok: true, status: 200, text: () => Promise.resolve(body) }) as unknown as Response;

  it('pools titles across feeds and survives a dead feed', async () => {
    const fetchFn = (url: string): Promise<Response> => {
      if (url.includes('dead')) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(okResponse(RSS_FIXTURE));
    };

    const topics = await fetchTrendingTopics(['https://dead.example/rss', 'https://ok.example/rss'], 3, fetchFn);

    expect(topics.map((t) => t.term)).toContain('uu perampasan aset');
  });

  it('returns empty on all-failing feeds instead of throwing', async () => {
    const fetchFn = (): Promise<Response> => Promise.reject(new Error('down'));

    await expect(fetchTrendingTopics(['https://a/rss', 'https://b/rss'], 3, fetchFn)).resolves.toEqual([]);
  });

  it('skips non-OK responses', async () => {
    const fetchFn = (): Promise<Response> =>
      Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') } as unknown as Response);

    await expect(fetchTrendingTopics(['https://a/rss'], 3, fetchFn)).resolves.toEqual([]);
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

describe('buildHeadlineSourcePosts', () => {
  it('turns headlines into labeled synthetic source posts', () => {
    const posts = buildHeadlineSourcePosts({
      term: 'kebakaran baduy',
      titleHits: 3,
      headlines: ['Kebakaran Baduy Hanguskan Puluhan Rumah', 'Donasi Mengalir'],
    });

    expect(posts).toHaveLength(2);
    expect(posts[0]!.id).toBe('news-1');
    expect(posts[0]!.text).toBe('[Berita hari ini] Kebakaran Baduy Hanguskan Puluhan Rumah');
    expect(posts[0]!.username).toBe('news-rss');
  });
});
