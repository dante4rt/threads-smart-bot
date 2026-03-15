// src/threads-api.ts — Threads Graph API client

import { AuthError, RateLimitError, TransientError } from './errors.js';
import { logger } from './logger.js';
import type { AuthConfig } from './config.js';
import type { Database } from 'better-sqlite3';
import { loadToken, saveToken, updateTokenUserId } from './db.js';

const BASE_URL = 'https://graph.threads.net/v1.0';
const AUTH_BASE = 'https://threads.net/oauth';
const OAUTH_API_BASE = 'https://graph.threads.net/oauth';
const TOKEN_BASE = 'https://graph.threads.net';
const USER_ID_PATTERN = /^\d+$/;

export interface ThreadsPost {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
}

export interface SearchResult {
  data: ThreadsPost[];
}

export interface MediaContainerResult {
  id: string;
}

export interface ShortLivedTokenResponse {
  access_token: string;
  user_id: string;
  token_type?: string;
  expires_in?: number;
}

export interface LongLivedTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in: number;
}

export interface ThreadsProfile {
  id: string;
  username?: string;
  name?: string;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function apiFetch<T>(
  url: string,
  opts: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw new TransientError(`Network error: ${(err as Error).message}`);
  }

  if (res.status === 401) throw new AuthError();
  if (res.status === 429) throw new RateLimitError();
  if (res.status >= 500) {
    throw new TransientError(`Threads API server error ${res.status}`, res.status);
  }
  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(errorBody ? `Threads API error ${res.status}: ${errorBody}` : `Threads API error ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// ── ThreadsClient ────────────────────────────────────────────────────────────

export class ThreadsClient {
  private resolvedThreadsUserId?: string;

  constructor(
    private readonly config: AuthConfig,
    private readonly db: Database,
  ) {}

  /** Get the current access token from DB, falling back to env var. */
  getAccessToken(): string {
    const token = loadToken(this.db, this.config.threadsAppSecret);
    if (token) return token.access_token;
    if (this.config.threadsAccessToken) return this.config.threadsAccessToken;
    throw new AuthError('No access token found — run `auth` first');
  }

  private async resolveThreadsUserId(): Promise<string> {
    if (this.config.threadsUserId && USER_ID_PATTERN.test(this.config.threadsUserId)) {
      return this.config.threadsUserId;
    }

    if (this.resolvedThreadsUserId) {
      return this.resolvedThreadsUserId;
    }

    const token = loadToken(this.db, this.config.threadsAppSecret);
    const profile = await this.getCurrentUserProfile();
    this.resolvedThreadsUserId = profile.id;

    if (token && token.user_id !== profile.id) {
      updateTokenUserId(this.db, profile.id);
      logger.info('Repaired stored Threads user ID', { userId: profile.id });
    }

    return profile.id;
  }

  private async withAuthRetry<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof AuthError)) {
        throw error;
      }

      logger.warn('Threads token rejected, attempting refresh');
      await this.refreshToken();
      return request();
    }
  }

  // ── Auth flow ────────────────────────────────────────────────────────────

  /** Build the OAuth authorization URL to send the user to. */
  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.threadsAppId,
      redirect_uri: this.config.threadsRedirectUri,
      scope: 'threads_basic,threads_content_publish,threads_keyword_search',
      response_type: 'code',
      state,
    });
    return `${AUTH_BASE}/authorize?${params}`;
  }

  /** Exchange authorization code → short-lived token. */
  async exchangeCode(code: string): Promise<ShortLivedTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.config.threadsAppId,
      client_secret: this.config.threadsAppSecret,
      grant_type: 'authorization_code',
      redirect_uri: this.config.threadsRedirectUri,
      code,
    });

    const result = await apiFetch<Partial<ShortLivedTokenResponse> & Pick<ShortLivedTokenResponse, 'access_token'>>(`${OAUTH_API_BASE}/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const userId = (await this.getCurrentUserProfile(result.access_token)).id;

    logger.info('Exchanged code for short-lived token', { userId });
    return {
      access_token: result.access_token,
      user_id: userId,
      token_type: result.token_type,
      expires_in: result.expires_in,
    };
  }

  /** Exchange short-lived token → long-lived token (60 days). */
  async getLongLivedToken(
    shortLivedToken: string,
    userId?: string,
  ): Promise<LongLivedTokenResponse> {
    const params = new URLSearchParams({
      grant_type: 'th_exchange_token',
      client_secret: this.config.threadsAppSecret,
      access_token: shortLivedToken,
    });

    const result = await apiFetch<LongLivedTokenResponse>(`${TOKEN_BASE}/access_token?${params}`, {
      method: 'GET',
    });

    const expiresAt = new Date(Date.now() + result.expires_in * 1000);
    saveToken(this.db, result.access_token, expiresAt, this.config.threadsAppSecret, userId);
    logger.info('Long-lived token obtained', { expiresAt: expiresAt.toISOString() });
    return result;
  }

  /** Refresh long-lived token before expiry. */
  async refreshToken(): Promise<void> {
    const currentToken = this.getAccessToken();
    const params = new URLSearchParams({
      grant_type: 'th_refresh_token',
      access_token: currentToken,
    });

    const result = await apiFetch<LongLivedTokenResponse>(`${TOKEN_BASE}/refresh_access_token?${params}`, {
      method: 'GET',
    });

    const expiresAt = new Date(Date.now() + result.expires_in * 1000);
    saveToken(this.db, result.access_token, expiresAt, this.config.threadsAppSecret);
    logger.info('Token refreshed', { expiresAt: expiresAt.toISOString() });
  }

  async getCurrentUserProfile(accessToken = this.getAccessToken()): Promise<ThreadsProfile> {
    const params = new URLSearchParams({
      fields: 'id,username,name',
    });

    return apiFetch<ThreadsProfile>(`${BASE_URL}/me?${params}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  }

  /** Check if the stored token is nearing expiry (within 10 days) and refresh. */
  async maybeRefreshToken(): Promise<void> {
    const token = loadToken(this.db, this.config.threadsAppSecret);
    if (!token) return;

    const expiresAt = new Date(token.expires_at);
    const daysUntilExpiry = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

    if (daysUntilExpiry < 0) {
      // Already expired
      logger.error('Token expired', { expiresAt: token.expires_at });
      throw new AuthError('Token expired — run `auth` to re-authenticate');
    }

    if (daysUntilExpiry <= 10) {
      logger.info('Token nearing expiry, refreshing', { daysLeft: Math.round(daysUntilExpiry) });
      await this.refreshToken();
    }
  }

  // ── Search ───────────────────────────────────────────────────────────────

  async keywordSearch(query: string, limit = 25): Promise<ThreadsPost[]> {
    const params = new URLSearchParams({
      q: query,
      search_type: 'TOP',
      limit: String(limit),
    });

    const result = await this.withAuthRetry<SearchResult>(() =>
      apiFetch<SearchResult>(`${BASE_URL}/keyword_search?${params}`, {
        headers: {
          Authorization: `Bearer ${this.getAccessToken()}`,
        },
      }),
    );

    logger.debug('Keyword search', { query, count: result.data.length });
    return result.data;
  }

  // ── Publishing ───────────────────────────────────────────────────────────

  /** Step 1: Create a media container. Returns container ID. */
  async createMediaContainer(
    text: string,
    imageUrl?: string,
  ): Promise<string> {
    const threadsUserId = await this.resolveThreadsUserId();
    const params = new URLSearchParams({
      text,
    });

    if (imageUrl) {
      params.set('image_url', imageUrl);
      params.set('media_type', 'IMAGE');
    } else {
      params.set('media_type', 'TEXT');
    }

    const result = await this.withAuthRetry<MediaContainerResult>(() =>
      apiFetch<MediaContainerResult>(`${BASE_URL}/${threadsUserId}/threads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${this.getAccessToken()}`,
        },
        body: params.toString(),
      }),
    );

    logger.debug('Media container created', { containerId: result.id });
    return result.id;
  }

  /** Step 2: Publish a media container. Returns published post ID. */
  async publishMediaContainer(containerId: string): Promise<string> {
    const threadsUserId = await this.resolveThreadsUserId();
    const params = new URLSearchParams({
      creation_id: containerId,
    });

    const result = await this.withAuthRetry<MediaContainerResult>(() =>
      apiFetch<MediaContainerResult>(`${BASE_URL}/${threadsUserId}/threads_publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${this.getAccessToken()}`,
        },
        body: params.toString(),
      }),
    );

    logger.info('Post published', { postId: result.id });
    return result.id;
  }
}
