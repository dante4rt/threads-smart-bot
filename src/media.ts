// src/media.ts — Unsplash image search with deduplication

import type { Database } from 'better-sqlite3';
import { logger } from './logger.js';
import { extractKeywords } from './utils.js';

const UNSPLASH_BASE = 'https://api.unsplash.com';
const RESULTS_PER_PAGE = 10;

interface UnsplashPhoto {
  id: string;
  urls: {
    regular: string;
    full: string;
  };
  alt_description: string | null;
}

interface UnsplashSearchResult {
  results: UnsplashPhoto[];
  total: number;
}

function getUsedImageIds(db: Database): Set<string> {
  const rows = db
    .prepare('SELECT image_id FROM used_images ORDER BY used_at DESC LIMIT 200')
    .all() as Array<{ image_id: string }>;
  return new Set(rows.map((r) => r.image_id));
}

function markImageUsed(db: Database, imageId: string, imageUrl: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO used_images (image_id, image_url, used_at) VALUES (?, ?, ?)',
  ).run(imageId, imageUrl, new Date().toISOString());
}

/**
 * Search Unsplash for an image matching keywords from post text.
 * Fetches multiple results and picks one that hasn't been used before.
 * Tracks used images in DB to prevent repeats across posts.
 */
export async function findImage(
  postText: string,
  unsplashAccessKey: string | undefined,
  db?: Database,
): Promise<string | undefined> {
  if (!unsplashAccessKey) {
    logger.debug('Unsplash key not set, skipping image search');
    return undefined;
  }

  const keywords = extractKeywords(postText, 3);
  const query = keywords.join(' ');
  const usedIds = db ? getUsedImageIds(db) : new Set<string>();

  const url = `${UNSPLASH_BASE}/search/photos?query=${encodeURIComponent(query)}&per_page=${RESULTS_PER_PAGE}&orientation=landscape`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Client-ID ${unsplashAccessKey}`,
        'Accept-Version': 'v1',
      },
    });
  } catch (err) {
    logger.warn('Unsplash network error, posting text-only', {
      error: (err as Error).message,
    });
    return undefined;
  }

  if (!res.ok) {
    logger.warn('Unsplash search failed, posting text-only', { status: res.status });
    return undefined;
  }

  const data = (await res.json()) as UnsplashSearchResult;

  // Pick the first unused image
  const unusedPhoto = data.results.find((photo) => !usedIds.has(photo.id));

  if (!unusedPhoto) {
    // All results already used — try a different keyword combo
    const fallbackKeyword = keywords[keywords.length - 1] ?? 'abstract';
    logger.debug('All Unsplash results already used, trying fallback', { fallbackKeyword });

    const fallbackUrl = `${UNSPLASH_BASE}/search/photos?query=${encodeURIComponent(fallbackKeyword)}&per_page=${RESULTS_PER_PAGE}&orientation=landscape&page=2`;
    try {
      const fallbackRes = await fetch(fallbackUrl, {
        headers: {
          Authorization: `Client-ID ${unsplashAccessKey}`,
          'Accept-Version': 'v1',
        },
      });
      if (fallbackRes.ok) {
        const fallbackData = (await fallbackRes.json()) as UnsplashSearchResult;
        const fallbackPhoto = fallbackData.results.find((photo) => !usedIds.has(photo.id));
        if (fallbackPhoto) {
          if (db) markImageUsed(db, fallbackPhoto.id, fallbackPhoto.urls.regular);
          logger.info('Unsplash fallback image found', { keyword: fallbackKeyword, imageId: fallbackPhoto.id });
          return fallbackPhoto.urls.regular;
        }
      }
    } catch {
      // silent fallback failure
    }

    logger.debug('No unused Unsplash images available');
    return undefined;
  }

  if (db) markImageUsed(db, unusedPhoto.id, unusedPhoto.urls.regular);
  logger.info('Unsplash image found', { query, imageId: unusedPhoto.id });
  return unusedPhoto.urls.regular;
}
