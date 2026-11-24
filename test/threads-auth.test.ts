import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, loadToken, saveToken } from '../src/db.js';
import { TransientError } from '../src/errors.js';
import { ThreadsClient } from '../src/threads-api.js';
import type { AuthConfig } from '../src/config.js';

const config: AuthConfig = {
  threadsAppId: 'app-id',
  threadsAppSecret: 'app-secret',
  threadsUserId: '123',
  threadsAccessToken: undefined,
  threadsRedirectUri: 'https://localhost/callback',
  dbPath: ':memory:',
};

function setupExpiredToken(): { db: Database.Database; client: ThreadsClient } {
  const db = new Database(':memory:');
  migrate(db);
  saveToken(db, 'stored-token', new Date(Date.now() - 24 * 60 * 60 * 1000), config.threadsAppSecret);
  return { db, client: new ThreadsClient(config, db) };
}

function setupNearExpiryToken(): { db: Database.Database; client: ThreadsClient } {
  const db = new Database(':memory:');
  migrate(db);
  saveToken(db, 'stored-token', new Date(Date.now() + 24 * 60 * 60 * 1000), config.threadsAppSecret);
  return { db, client: new ThreadsClient(config, db) };
}

afterEach(() => vi.unstubAllGlobals());

describe('Threads token preflight', () => {
  it('checks Meta before declaring stored expiry and refreshes a valid token', async () => {
    const { db, client } = setupExpiredToken();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '123', username: 'ramadhvni' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'refreshed-token', expires_in: 5184000 }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(client.maybeRefreshToken()).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(client.getAccessToken()).toBe('refreshed-token');
      expect(new Date(loadToken(db, config.threadsAppSecret)!.expires_at).getTime()).toBeGreaterThan(Date.now());
    } finally {
      db.close();
    }
  });

  it('continues with an API-validated token when refresh is unavailable', async () => {
    const { db, client } = setupExpiredToken();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '123' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 4, message: 'temporarily unavailable' } }), { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(client.maybeRefreshToken()).resolves.toBeUndefined();
      expect(client.getAccessToken()).toBe('stored-token');
    } finally {
      db.close();
    }
  });

  it('requires re-auth only after Meta rejects the stored token', async () => {
    const { db, client } = setupExpiredToken();
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 190, message: 'expired token' } }), { status: 400 }),
    );
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(client.maybeRefreshToken()).rejects.toThrow(/run `auth` in the bot environment/);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it('does not mistake a Threads outage for an expired token', async () => {
    const { db, client } = setupExpiredToken();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    try {
      await expect(client.maybeRefreshToken()).rejects.toThrow(TransientError);
    } finally {
      db.close();
    }
  });

  it('accepts a near-expiry token when refresh fails but profile access works', async () => {
    const { db, client } = setupNearExpiryToken();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '123' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(client.maybeRefreshToken()).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(client.getAccessToken()).toBe('stored-token');
    } finally {
      db.close();
    }
  });

  it('still rejects a near-expiry token when Threads rejects both refresh and profile', async () => {
    const { db, client } = setupNearExpiryToken();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 190 } }), { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(client.maybeRefreshToken()).rejects.toThrow(/run `auth` in the bot environment/);
    } finally {
      db.close();
    }
  });
});

describe('Threads keyword search', () => {
  it('requests explicit fields and TOP by default', async () => {
    const { db, client } = setupNearExpiryToken();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: '1', text: 'hi' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await client.keywordSearch('resign', 5);

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get('fields')).toBe('id,text,timestamp,username');
    expect(url.searchParams.get('search_type')).toBe('TOP');
    expect(url.searchParams.get('since')).toBeNull();
    // A stalled Graph API connection must time out, not hang the run lock.
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    db.close();
  });

  it('switches to RECENT when the trend path asks for it', async () => {
    const { db, client } = setupNearExpiryToken();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await client.keywordSearch('kebakaran', 5, { searchType: 'RECENT' });

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get('search_type')).toBe('RECENT');
    db.close();
  });
});
