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
  const stopwords = new Set([
    'yang', 'dan', 'di', 'ke', 'dari', 'adalah', 'dengan', 'untuk', 'pada',
    'ini', 'itu', 'the', 'a', 'an', 'in', 'of', 'to', 'and', 'is', 'it',
  ]);
  const words = text
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopwords.has(w.toLowerCase()));
  return words[0] ?? 'technology';
}

/**
 * Sleep for ms milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Safely truncate a string to maxLen characters, appending '…' if trimmed.
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}
