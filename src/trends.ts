// src/trends.ts — detect what Indonesia is talking about right now.
//
// Threads has no hashtags and its Trending Topics API covers US/JP only, so
// trends come from outside: Indonesian news RSS + Google Trends RSS act as the
// trigger, and the crawl stage confirms each candidate on Threads itself via
// keyword_search (RECENT). Feeds verified live on 2026-11-21.

import { logger } from './logger.js';

/** A term must appear in at least this many distinct titles to count. */
const MIN_TITLE_HITS = 2;
/** Single words need more evidence than phrases — they are generic by nature. */
const MIN_UNIGRAM_HITS = 3;
const MIN_UNIGRAM_CHARS = 4;
/** Terms longer than this make bad search queries. */
const MAX_TERM_CHARS = 60;
const FEED_TIMEOUT_MS = 10_000;

// Headline glue words, not topics. Mixed Indonesian news-register + English.
const STOPWORDS = new Set([
  // Indonesian function words
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'pada', 'dengan', 'dalam', 'itu',
  'ini', 'ada', 'tak', 'tidak', 'bukan', 'akan', 'sudah', 'telah', 'masih',
  'juga', 'saat', 'usai', 'soal', 'bakal', 'karena', 'akibat', 'hingga',
  'sampai', 'antara', 'tanpa', 'bagi', 'oleh', 'para', 'per', 'bisa', 'jadi',
  'punya', 'buat', 'lagi', 'baru', 'lebih', 'paling', 'begini', 'begitu',
  // Headline verbs (Detik/CNN/Antara register)
  'sebut', 'kata', 'minta', 'ajak', 'duga', 'tuding', 'nilai', 'usul', 'ungkap',
  'jelaskan', 'tegaskan', 'bantah', 'akui', 'imbau', 'desak', 'dorong', 'pesan',
  'respons', 'tanggapi', 'gelar', 'resmi', 'siap', 'cek', 'simak', 'begini',
  'terkait', 'terbaru', 'terkini', 'hari', 'ini',
  // English glue (Google Trends / mixed titles)
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'vs', 'at',
  'is', 'are', 'with', 'from', 'by', 'news', 'update', 'live',
]);

// Words that recur in every news cycle without naming a topic. Blocked as
// standalone terms only — "ump jakarta" is a topic, bare "jakarta" is not.
// First live run extracted exactly this garbage: indonesia, ri, rp, detiknews.
const GENERIC_UNIGRAMS = new Set([
  'indonesia', 'jakarta', 'ri', 'rp', 'wib', 'warga', 'pemerintah', 'presiden',
  'menteri', 'polisi', 'dpr', 'video', 'foto', 'breaking', 'viral', 'trending',
  'kasus', 'dugaan', 'korban', 'pelaku', 'kronologi', 'penyebab', 'daftar',
  'detiknews', 'detikcom', 'detik', 'kompas', 'tempo', 'antara', 'cnn',
  'liputan6', 'tribunnews', 'berita', 'nasional', 'dunia', 'daerah', 'ekonomi',
]);

/**
 * Google News aggregates titles as "Actual Headline - Source Name"; without
 * stripping, every outlet's name becomes a top "trend" (observed live).
 */
function stripSourceSuffix(title: string): string {
  return title.replace(/\s+[-–—|]\s+[^-–—|]{2,40}$/, '').trim() || title;
}

/**
 * Extract <item><title> values from an RSS/Atom document without a parser dep.
 * Handles CDATA and the entities that actually appear in the verified feeds.
 */
export function parseRssTitles(xml: string): string[] {
  const titles: string[] = [];
  const itemBlocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  for (const block of itemBlocks) {
    const match = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!match?.[1]) continue;
    const raw = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    const decoded = raw
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .trim();
    if (decoded) titles.push(decoded);
  }
  return titles;
}

function tokenize(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !/^\d+$/.test(token));
}

export interface TrendingTopic {
  term: string;
  /** Number of distinct headlines the term appeared in — the heat measure. */
  titleHits: number;
  /** Sample headlines containing the term, for grounding the post on. */
  headlines: string[];
}

const MAX_HEADLINES_PER_TOPIC = 5;
/** A phrase replaces its own unigram when it covers this share of its titles. */
const PHRASE_PROMOTION_RATIO = 0.6;

/**
 * Rank 1-3 word terms that recur across distinct titles. Pure, so the scoring
 * is testable without network — same DI pattern as the rest of the pipeline.
 */
export function extractTrendingTopics(titles: string[], maxTerms: number): TrendingTopic[] {
  const termTitles = new Map<string, Set<number>>();
  const strippedTitles = titles.map(stripSourceSuffix);

  strippedTitles.forEach((title, titleIndex) => {
    const tokens = tokenize(title);
    const seen = new Set<string>();
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const gram = tokens.slice(i, i + n);
        // Edges must be content words; interior stopwords are fine ("uu di mata publik" won't form anyway).
        if (STOPWORDS.has(gram[0]!) || STOPWORDS.has(gram[n - 1]!)) continue;
        if (n === 1 && (GENERIC_UNIGRAMS.has(gram[0]!) || gram[0]!.length < MIN_UNIGRAM_CHARS)) continue;
        const term = gram.join(' ');
        if (term.length > MAX_TERM_CHARS || seen.has(term)) continue;
        seen.add(term);
        if (!termTitles.has(term)) termTitles.set(term, new Set());
        termTitles.get(term)!.add(titleIndex);
      }
    }
  });

  const ranked = [...termTitles.entries()]
    .filter(([term, titleSet]) =>
      titleSet.size >= (term.includes(' ') ? MIN_TITLE_HITS : MIN_UNIGRAM_HITS),
    )
    .sort((a, b) => {
      if (b[1].size !== a[1].size) return b[1].size - a[1].size;
      // Same spread: prefer the more specific (longer) term.
      return b[0].split(' ').length - a[0].split(' ').length;
    });

  // A bare unigram outranks its own phrase by raw count ("kebakaran" beat
  // "kebakaran baduy" while Baduy was the actual story — live miss, 2026-11-21).
  // When a phrase covers most of a unigram's headlines, the phrase IS the topic.
  const promote = (term: string, titleSet: Set<number>): [string, Set<number>] => {
    if (term.includes(' ')) return [term, titleSet];
    const phrase = ranked.find(
      ([candidate, candidateSet]) =>
        candidate.includes(' ') &&
        candidate.split(' ').includes(term) &&
        candidateSet.size >= Math.ceil(titleSet.size * PHRASE_PROMOTION_RATIO),
    );
    return phrase ? [phrase[0], phrase[1]] : [term, titleSet];
  };

  const picked: Array<[string, Set<number>]> = [];
  for (const entry of ranked) {
    if (picked.length >= maxTerms) break;
    const [term, titleSet] = promote(entry[0], entry[1]);
    // Skip terms contained in (or containing) an already-picked stronger term.
    if (picked.some(([p]) => p.includes(term) || term.includes(p))) continue;
    picked.push([term, titleSet]);
  }

  return picked.map(([term, titleSet]) => {
    const [focusedTerm, focusedSet] = focusOnDominantStory(term, titleSet, strippedTitles);
    return {
      term: focusedTerm,
      titleHits: focusedSet.size,
      headlines: [...focusedSet].slice(0, MAX_HEADLINES_PER_TOPIC).map((i) => strippedTitles[i]!),
    };
  });
}

/** Co-word must appear in this many of the unigram's titles to define its story. */
const MIN_STORY_CO_HITS = 3;
const MIN_STORY_CO_SHARE = 0.3;

/**
 * A bare unigram mixes unrelated stories ("kebakaran" = Baduy fire + a fire-
 * alarm prank + a Bogor house fire; live miss 2026-11-21, the mandate drafted
 * about the wrong fire). Narrow it to its most common co-word's headlines.
 */
function focusOnDominantStory(
  term: string,
  titleSet: Set<number>,
  titles: string[],
): [string, Set<number>] {
  if (term.includes(' ')) return [term, titleSet];

  const coCounts = new Map<string, Set<number>>();
  for (const i of titleSet) {
    for (const token of new Set(tokenize(titles[i]!))) {
      if (token === term || STOPWORDS.has(token) || GENERIC_UNIGRAMS.has(token)) continue;
      if (token.length < MIN_UNIGRAM_CHARS) continue;
      if (!coCounts.has(token)) coCounts.set(token, new Set());
      coCounts.get(token)!.add(i);
    }
  }

  let best: [string, Set<number>] | undefined;
  for (const entry of coCounts) {
    if (!best || entry[1].size > best[1].size) best = entry;
  }
  if (
    !best ||
    best[1].size < MIN_STORY_CO_HITS ||
    best[1].size < titleSet.size * MIN_STORY_CO_SHARE
  ) {
    return [term, titleSet];
  }
  return [`${term} ${best[0]}`, best[1]];
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Fetch all feeds, pool their titles, return the top trending terms.
 * Fail-soft everywhere: a dead feed is logged and skipped, zero feeds yield []
 * and the caller falls back to the static query pool. Trends must never be the
 * reason a run fails.
 */
export async function fetchTrendingTopics(
  feedUrls: string[],
  maxTerms: number,
  fetchFn: FetchFn = fetch,
): Promise<TrendingTopic[]> {
  const titles: string[] = [];

  for (const url of feedUrls) {
    try {
      const res = await fetchFn(url, {
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        // CNN Indonesia 403s the default Node UA (observed live); a browser UA passes.
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'application/rss+xml, application/xml, text/xml, */*',
        },
      });
      if (!res.ok) {
        logger.warn('Trend feed returned non-OK status', { url, status: res.status });
        continue;
      }
      const feedTitles = parseRssTitles(await res.text());
      logger.debug('Trend feed fetched', { url, titles: feedTitles.length });
      titles.push(...feedTitles);
    } catch (err) {
      logger.warn('Trend feed fetch failed', { url, error: (err as Error).message });
    }
  }

  const topics = extractTrendingTopics(titles, maxTerms);
  logger.info('Trending terms extracted', {
    feeds: feedUrls.length,
    titles: titles.length,
    terms: topics.map((t) => `${t.term} (${t.titleHits})`),
  });
  return topics;
}
