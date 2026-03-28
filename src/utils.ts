// src/utils.ts — general-purpose helpers

/**
 * Pick `count` random unique items from an array without mutating it.
 */
export function pickRandom<T>(arr: readonly T[], count: number): T[] {
  if (count >= arr.length) return [...arr];
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

/**
 * Deduplicate an array of objects by a string key.
 */
export function dedupeBy<T>(items: T[], key: keyof T): T[] {
  const seen = new Set<unknown>();
  return items.filter((item) => {
    const k = item[key];
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Parse a "HH:MM" string into { hour, minute } for cron.
 */
export function parseTime(hhmm: string): { hour: number; minute: number } {
  const parts = hhmm.split(':');
  const hour = parseInt(parts[0] ?? '0', 10);
  const minute = parseInt(parts[1] ?? '0', 10);
  if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid time format: "${hhmm}" — expected HH:MM`);
  }
  return { hour, minute };
}

/**
 * Build a cron expression for a given hour/minute.
 * e.g. { hour: 9, minute: 0 } → "0 9 * * *"
 */
export function toCronExpr(hour: number, minute: number): string {
  return `${minute} ${hour} * * *`;
}

/**
 * Extract the first word that looks like a meaningful keyword from text.
 * Used to query Unsplash when no explicit keyword is provided.
 */
export function extractKeyword(text: string): string {
  return extractKeywords(text, 1)[0] ?? 'technology';
}

/**
 * Extract multiple meaningful keywords from text for better image search variety.
 * Returns up to `count` unique keywords, skipping stopwords and short words.
 */
export function extractKeywords(text: string, count = 3): string[] {
  const stopwords = new Set([
    'yang', 'dan', 'di', 'ke', 'dari', 'adalah', 'dengan', 'untuk', 'pada',
    'ini', 'itu', 'the', 'a', 'an', 'in', 'of', 'to', 'and', 'is', 'it',
    'gue', 'lo', 'gak', 'aja', 'juga', 'bisa', 'udah', 'emang', 'cuma',
    'tapi', 'kalo', 'sama', 'banget', 'sih', 'kan', 'dong', 'nih', 'deh',
    'akan', 'bukan', 'tidak', 'ada', 'buat', 'lebih', 'punya', 'jadi',
    'kalau', 'masih', 'sudah', 'lagi', 'harus', 'mau', 'bisa', 'perlu',
  ]);
  const words = text
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopwords.has(w.toLowerCase()));

  const unique = [...new Set(words.map((w) => w.toLowerCase()))];
  return unique.slice(0, count).length > 0 ? unique.slice(0, count) : ['technology'];
}

/**
 * Sleep for ms milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Truncate at the last sentence boundary within maxLen.
 * Falls back to last word boundary if no sentence fits.
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  const chunk = text.slice(0, maxLen);

  // Try to cut at last sentence boundary (. ! ?)
  const sentenceEnd = Math.max(
    chunk.lastIndexOf('. '),
    chunk.lastIndexOf('.\n'),
    chunk.lastIndexOf('! '),
    chunk.lastIndexOf('!\n'),
    chunk.lastIndexOf('? '),
    chunk.lastIndexOf('?\n'),
  );
  if (sentenceEnd > maxLen * 0.5) {
    return text.slice(0, sentenceEnd + 1).trim();
  }

  // Fall back to last word boundary
  const lastSpace = chunk.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.5) {
    return text.slice(0, lastSpace).trim();
  }

  return chunk.trim();
}

/**
 * Strip AI-generated artifacts from post text.
 * Removes em dashes, normalizes whitespace.
 */
export function sanitizePost(text: string): string {
  return text
    .replace(/\u2014/g, ',')   // em dash → comma
    .replace(/\u2013/g, '-')   // en dash → hyphen
    .replace(/\u2026/g, '...') // ellipsis char → three dots
    .replace(/,\s*,/g, ',')    // double commas from replacement
    .replace(/ {2,}/g, ' ')    // collapse multiple spaces
    .trim();
}
