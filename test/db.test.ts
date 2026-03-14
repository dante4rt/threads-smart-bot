// test/db.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { saveToken, loadToken, savePost, getRecentPosts, startRun, completeRun, countRecentFailures } from '../src/db.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_query TEXT,
      source_post_ids TEXT,
      generated_text TEXT NOT NULL,
      threads_post_id TEXT,
      published_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY,
      access_token TEXT NOT NULL,
      refreshed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,
      error_message TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
  return db;
}

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

describe('token helpers', () => {
  it('saves and loads a token', () => {
    const expiresAt = new Date('2025-01-01T00:00:00Z');
    saveToken(db, 'test-token-123', expiresAt);
    const token = loadToken(db);
    expect(token).toBeDefined();
    expect(token!.access_token).toBe('test-token-123');
    expect(token!.expires_at).toBe('2025-01-01T00:00:00.000Z');
  });

  it('overwrites existing token', () => {
    saveToken(db, 'old-token', new Date('2025-01-01T00:00:00Z'));
    saveToken(db, 'new-token', new Date('2025-06-01T00:00:00Z'));
    const token = loadToken(db);
    expect(token!.access_token).toBe('new-token');
  });

  it('returns undefined when no token', () => {
    expect(loadToken(db)).toBeUndefined();
  });
});

describe('post helpers', () => {
  it('saves a post and retrieves it', () => {
    savePost(db, {
      source_query: 'tech',
      source_post_ids: '["id1","id2"]',
      generated_text: 'Test post content',
      threads_post_id: 'thread-123',
      published_at: '2024-01-01T09:00:00Z',
    });

    const posts = getRecentPosts(db, 5);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.generated_text).toBe('Test post content');
    expect(posts[0]!.threads_post_id).toBe('thread-123');
  });

  it('only returns published posts', () => {
    // Dry-run post (no threads_post_id)
    savePost(db, {
      source_query: 'viral',
      source_post_ids: null,
      generated_text: 'Dry run post',
      threads_post_id: null,
      published_at: null,
    });

    const posts = getRecentPosts(db, 5);
    expect(posts).toHaveLength(0);
  });

  it('returns most recent posts first, up to limit', () => {
    for (let i = 1; i <= 7; i++) {
      savePost(db, {
        source_query: 'query',
        source_post_ids: null,
        generated_text: `Post ${i}`,
        threads_post_id: `thread-${i}`,
        published_at: new Date().toISOString(),
      });
    }

    const posts = getRecentPosts(db, 5);
    expect(posts).toHaveLength(5);
    expect(posts[0]!.generated_text).toBe('Post 7');
  });
});

describe('run helpers', () => {
  it('starts and completes a run', () => {
    const runId = startRun(db);
    expect(runId).toBeGreaterThan(0);
    completeRun(db, runId, 'success');

    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as { status: string };
    expect(run.status).toBe('success');
  });

  it('counts consecutive failures', () => {
    const r1 = startRun(db); completeRun(db, r1, 'failed', 'err1');
    const r2 = startRun(db); completeRun(db, r2, 'failed', 'err2');
    const r3 = startRun(db); completeRun(db, r3, 'failed', 'err3');

    expect(countRecentFailures(db, 3)).toBe(3);
  });

  it('returns 0 when last run succeeded', () => {
    const r1 = startRun(db); completeRun(db, r1, 'failed');
    const r2 = startRun(db); completeRun(db, r2, 'failed');
    const r3 = startRun(db); completeRun(db, r3, 'success');

    expect(countRecentFailures(db, 3)).toBe(0);
  });
});
