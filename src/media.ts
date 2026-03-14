// src/media.ts — Unsplash image search helper

import { logger } from './logger.js';
import { extractKeyword } from './utils.js';

const UNSPLASH_BASE = 'https://api.unsplash.com';

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

/**
 * Search Unsplash for an image matching a keyword derived from the post text.
 * Returns a JPEG URL (regular size, ≤1440px wide) or undefined if not found.
 *
 * No-ops silently when UNSPLASH_ACCESS_KEY is not set.
 */
export async function findImage(
  postText: string,
  unsplashAccessKey: string | undefined,
): Promise<string | undefined> {
  if (!unsplashAccessKey) {
    logger.debug('Unsplash key not set, skipping image search');
    return undefined;
  }

  const keyword = extractKeyword(postText);
  const url = `${UNSPLASH_BASE}/search/photos?query=${encodeURIComponent(keyword)}&per_page=1&orientation=landscape`;

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
  const photo = data.results[0];
  if (!photo) {
    logger.debug('No Unsplash result found', { keyword });
    return undefined;
  }

  // regular size is typically ≤1080px; within Threads 1440px limit
  const imageUrl = photo.urls.regular;
  logger.info('Unsplash image found', { keyword, imageUrl });
  return imageUrl;
}
