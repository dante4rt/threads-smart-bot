// test/trends.test.ts

import { describe, it, expect } from 'vitest';
import { parseRssTitles, parseRssItems, parseDetikPopular, extractTrendingTopics, fetchTrendingTopics, POPULAR_TITLE_WEIGHT } from '../src/trends.js';
import { mergeTrendQueries, buildHeadlineSourcePosts, pickMandateTopic } from '../src/pipeline.js';

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

  it('bumps weight for a most-read article already seen in RSS, not a duplicate headline', async () => {
    const rss = `<rss><channel>
      <item><title>Kader PSI Ditangkap Polda Metro</title><description>Cakra diperiksa lalu dibebaskan.</description></item>
      <item><title>Nasib Kader PSI Jadi Sorotan</title></item>
    </channel></rss>`;
    const popular = '<h3 class="media__title"><a href="/x">Kader PSI Ditangkap Polda Metro</a></h3>';
    const fetchFn = (url: string): Promise<Response> =>
      Promise.resolve(okResponse(url.includes('popular') ? popular : rss));

    const topics = await fetchTrendingTopics(
      ['https://a/rss'],
      5,
      fetchFn,
      ['https://a/popular'],
    );
    const psi = topics.find((t) => t.term.includes('kader psi'))!;

    // 2 distinct headlines (not 3 — the shared article wasn't re-added), heat 3
    // (shared article bumped to weight 2, plus the RSS-only one at 1).
    expect(psi.titleCount).toBe(2);
    expect(psi.titleHits).toBe(3);
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
      titleCount: 3,
      headlines: ['Kebakaran Baduy Hanguskan Puluhan Rumah', 'Donasi Mengalir'],
    });

    expect(posts).toHaveLength(2);
    expect(posts[0]!.id).toBe('news-1');
    expect(posts[0]!.text).toBe('[Berita hari ini] Kebakaran Baduy Hanguskan Puluhan Rumah');
    expect(posts[0]!.username).toBe('news-rss');
  });
});

describe('story focus for single-word topics', () => {
  it('narrows an ambiguous unigram to its dominant story', () => {
    // Live miss 2026-11-21: "kebakaran" mixed the Baduy fire with unrelated fires.
    const titles = [
      'Kebakaran Hanguskan Kampung Baduy Luar',
      'Warga Baduy Mengungsi Usai Kebakaran',
      'Kebakaran di Baduy, Lumbung Pangan Habis',
      'Kebakaran Baduy Rusak Puluhan Rumah Adat',
      'Peringatan Kebakaran Dikira Prank',
      'Kebakaran Rumah di Bogor Tewaskan Dua',
    ];

    const topics = extractTrendingTopics(titles, 3);
    const fire = topics.find((t) => t.term.startsWith('kebakaran'))!;

    expect(fire.term).toBe('kebakaran baduy');
    expect(fire.headlines.every((h) => /baduy/i.test(h))).toBe(true);
    expect(fire.headlines.join(' ')).not.toMatch(/prank|bogor/i);
  });

  it('leaves a unigram alone when no co-word defines a story', () => {
    const titles = [
      'Makar Disidang Pekan Depan',
      'Saksi Kasus Makar Dipanggil',
      'Pengacara Makar Ajukan Banding',
    ];

    const topics = extractTrendingTopics(titles, 3);

    expect(topics.map((t) => t.term)).toContain('makar');
  });
});

describe('pickMandateTopic', () => {
  const topic = (term: string, titleCount: number) => ({ term, titleHits: titleCount, titleCount, headlines: [] });
  const accepted = new Set(['wapres dasco', 'kebakaran baduy', 'makar']);

  it('skips a story a recent post already covered and takes the next hot one', () => {
    const picked = pickMandateTopic(
      [topic('wapres dasco', 15), topic('kebakaran baduy', 9)],
      accepted,
      4,
      ['Dasco dijagokan jadi wapres, gue mau lihat rekam kerjanya.'],
    );

    expect(picked?.term).toBe('kebakaran baduy');
  });

  it('respects the title threshold and the disable switch', () => {
    const topics = [topic('makar', 3)];

    expect(pickMandateTopic(topics, accepted, 4, [])).toBeUndefined();
    expect(pickMandateTopic([topic('makar', 9)], accepted, 0, [])).toBeUndefined();
  });

  it('ignores topics that were filtered out of the crawl', () => {
    expect(pickMandateTopic([topic('arbitrum airdrop', 20)], accepted, 4, [])).toBeUndefined();
  });
});

describe('RSS descriptions as grounding detail', () => {
  it('parses item descriptions, stripping CDATA, tags and double-encoded entities', () => {
    const xml = `<rss><channel>
      <item><title>Eks Kader PSI Ditangkap</title>
        <description><![CDATA[<p>Polda Metro Jaya menangkap Cakra, mantan kader PSI.</p>]]></description></item>
      <item><title>UMP Jakarta 2027</title><description>Rp 6,1 Juta &amp;nbsp;&amp;nbsp; detikNews</description></item>
      <item><title>No Summary Here</title></item>
    </channel></rss>`;

    const items = parseRssItems(xml);

    expect(items[0]).toEqual({
      title: 'Eks Kader PSI Ditangkap',
      description: 'Polda Metro Jaya menangkap Cakra, mantan kader PSI.',
    });
    expect(items[1]!.description).toBe('Rp 6,1 Juta detikNews');
    expect(items[2]!.description).toBe('');
  });

  it('appends summaries to topic headlines but skips ones that only repeat the title', () => {
    const titles = ['Dasco Dijagokan Wapres', 'Dasco Wapres Pilihan', 'Wapres Dasco Disorot'];
    const descriptions = [
      'Pengamat Voxpol menilai loyalitas 35 tahun jadi nilai tambah.',
      'Dasco Wapres Pilihan - detikNews',
      '',
    ];

    const [topic] = extractTrendingTopics(titles, 1, descriptions);

    expect(topic!.headlines).toContain(
      'Dasco Dijagokan Wapres. Pengamat Voxpol menilai loyalitas 35 tahun jadi nilai tambah.',
    );
    expect(topic!.headlines).toContain('Dasco Wapres Pilihan');
    expect(topic!.headlines).toContain('Wapres Dasco Disorot');
  });
});

describe('parseDetikPopular + most-read weighting', () => {
  it('extracts titles from the terpopuler HTML list', () => {
    const html = `
      <h3 class="media__title"><a href="/x">Eks Kader PSI Ditangkap Polda Metro</a></h3>
      <h3 class="media__title"><a href="/y">Gempa M 7,2 di Maluku</a></h3>
      <h3 class="media__title"><a href="/x">Eks Kader PSI Ditangkap Polda Metro</a></h3>`;
    const titles = parseDetikPopular(html);
    expect(titles).toEqual(['Eks Kader PSI Ditangkap Polda Metro', 'Gempa M 7,2 di Maluku']);
  });

  it('counts a most-read title extra in a qualifying term heat', () => {
    // "kader psi" spans 2 titles; the second is a most-read page (weight 2),
    // so heat is 1 + 2 = 3, above a plain 2-title count.
    const titles = ['Eks Kader PSI Ditangkap', 'Nasib Kader PSI Dibahas', 'Banjir NTT Meluas'];
    const weighted = extractTrendingTopics(titles, 5, [], [1, POPULAR_TITLE_WEIGHT, 1]);
    const psi = weighted.find((t) => t.term.includes('kader psi'));
    expect(psi?.titleHits).toBe(3);
  });
});
