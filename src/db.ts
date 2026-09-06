// src/db.ts — SQLite setup and typed query helpers

import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

export interface Post {
  id: number;
  source_query: string | null;
  source_post_ids: string | null; // JSON array string
  generated_text: string;
  threads_post_id: string | null;
  published_at: string | null;
  /** Engagement, backfilled from /{media-id}/insights. Null until first fetch. */
  views: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  quotes: number | null;
  metrics_fetched_at: string | null;
}

export interface Token {
  id: number;
  access_token: string;
  refreshed_at: string;
  expires_at: string;
  user_id: string | null;
}

export interface Run {
  id: number;
  status: 'success' | 'failed';
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

let _db: Database.Database | undefined;

export function getDb(dbPath = 'data/state.db'): Database.Database {
  if (_db) return _db;
  const dbDir = dirname(dbPath);
  mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  chmodSync(dbDir, 0o700);
  _db = new Database(dbPath);
  if (existsSync(dbPath)) {
    chmodSync(dbPath, 0o600);
  }
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  return _db;
}

/** Reset DB (for tests) */
export function resetDb(): void {
  _db?.close();
  _db = undefined;
}

/** Idempotent schema setup. Exported so tests exercise the real migration. */
export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_query    TEXT,
      source_post_ids TEXT,
      generated_text  TEXT NOT NULL,
      threads_post_id TEXT,
      published_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS tokens (
      id           INTEGER PRIMARY KEY,
      access_token TEXT NOT NULL,
      refreshed_at TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      user_id      TEXT
    );

    CREATE TABLE IF NOT EXISTS runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      status        TEXT NOT NULL,
      error_message TEXT,
      started_at    TEXT NOT NULL,
      completed_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS used_images (
      image_id  TEXT PRIMARY KEY,
      image_url TEXT NOT NULL,
      used_at   TEXT NOT NULL
    );
  `);

  ensureColumn(db, 'tokens', 'user_id', 'TEXT');

  for (const metric of ['views', 'likes', 'replies', 'reposts', 'quotes']) {
    ensureColumn(db, 'posts', metric, 'INTEGER');
  }
  ensureColumn(db, 'posts', 'metrics_fetched_at', 'TEXT');
}

function ensureColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
  columnDefinition: string,
): void {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

// ── Token helpers ────────────────────────────────────────────────────────────

function deriveTokenKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function encryptToken(accessToken: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveTokenKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(accessToken, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptToken(payload: string, secret: string): string {
  if (!payload.startsWith('enc:v1:')) {
    return payload;
  }

  const [, , ivBase64, tagBase64, cipherBase64] = payload.split(':');
  if (!ivBase64 || !tagBase64 || !cipherBase64) {
    throw new Error('Stored token payload is malformed');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveTokenKey(secret),
    Buffer.from(ivBase64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagBase64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherBase64, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function saveToken(
  db: Database.Database,
  accessToken: string,
  expiresAt: Date,
  encryptionSecret: string,
  userId?: string,
): void {
  const existing = db
    .prepare('SELECT user_id FROM tokens WHERE id = 1')
    .get() as { user_id: string | null } | undefined;
  const persistedUserId = userId !== undefined ? String(userId) : existing?.user_id ?? null;

  db.prepare(`
    INSERT INTO tokens (id, access_token, refreshed_at, expires_at, user_id)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_token = excluded.access_token,
      refreshed_at = excluded.refreshed_at,
      expires_at   = excluded.expires_at,
      user_id      = excluded.user_id
  `).run(
    encryptToken(accessToken, encryptionSecret),
    new Date().toISOString(),
    expiresAt.toISOString(),
    persistedUserId,
  );
}

export function updateTokenUserId(
  db: Database.Database,
  userId: string,
): void {
  db.prepare('UPDATE tokens SET user_id = ? WHERE id = 1').run(String(userId));
}

export function loadToken(db: Database.Database, encryptionSecret: string): Token | undefined {
  const token = db
    .prepare('SELECT * FROM tokens WHERE id = 1')
    .get() as Token | undefined;
  if (!token) {
    return undefined;
  }

  return {
    ...token,
    access_token: decryptToken(token.access_token, encryptionSecret),
  };
}

// ── Post helpers ─────────────────────────────────────────────────────────────

/** Columns written at insert time. Engagement columns are backfilled later. */
export type NewPost = Pick<
  Post,
  'source_query' | 'source_post_ids' | 'generated_text' | 'threads_post_id' | 'published_at'
>;

export function savePost(
  db: Database.Database,
  post: NewPost,
): number {
  const result = db.prepare(`
    INSERT INTO posts (source_query, source_post_ids, generated_text, threads_post_id, published_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    post.source_query,
    post.source_post_ids,
    post.generated_text,
    post.threads_post_id,
    post.published_at,
  );
  return result.lastInsertRowid as number;
}

export function getRecentPosts(db: Database.Database, limit = 5): Post[] {
  return db
    .prepare('SELECT * FROM posts WHERE threads_post_id IS NOT NULL ORDER BY id DESC LIMIT ?')
    .all(limit) as Post[];
}

export interface PostMetrics {
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
}

export function updatePostMetrics(
  db: Database.Database,
  threadsPostId: string,
  metrics: PostMetrics,
): void {
  db.prepare(`
    UPDATE posts
       SET views = ?, likes = ?, replies = ?, reposts = ?, quotes = ?, metrics_fetched_at = ?
     WHERE threads_post_id = ?
  `).run(
    metrics.views,
    metrics.likes,
    metrics.replies,
    metrics.reposts,
    metrics.quotes,
    new Date().toISOString(),
    threadsPostId,
  );
}

/**
 * Published posts from the last `days` whose metrics are worth refreshing.
 * Engagement keeps accruing for a few days, so a post is refetched even when it
 * already has numbers — but not if it was fetched within `staleAfterHours`,
 * since these calls run immediately before the publish call and a 429 there
 * costs the run.
 */
export function getPostsNeedingMetrics(
  db: Database.Database,
  days = 7,
  limit = 20,
  staleAfterHours = 6,
): Post[] {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const staleBefore = new Date(Date.now() - staleAfterHours * 60 * 60 * 1000).toISOString();
  return db
    .prepare(`
      SELECT * FROM posts
       WHERE threads_post_id IS NOT NULL
         AND published_at IS NOT NULL
         AND published_at >= ?
         AND (metrics_fetched_at IS NULL OR metrics_fetched_at < ?)
       ORDER BY id DESC
       LIMIT ?
    `)
    .all(cutoff, staleBefore, limit) as Post[];
}

// ── Run helpers ──────────────────────────────────────────────────────────────

export function startRun(db: Database.Database): number {
  const result = db.prepare(`
    INSERT INTO runs (status, started_at)
    VALUES ('failed', ?)
  `).run(new Date().toISOString());
  return result.lastInsertRowid as number;
}

export function completeRun(
  db: Database.Database,
  runId: number,
  status: 'success' | 'failed',
  errorMessage?: string,
): void {
  db.prepare(`
    UPDATE runs SET status = ?, error_message = ?, completed_at = ? WHERE id = ?
  `).run(status, errorMessage ?? null, new Date().toISOString(), runId);
}

export function countRecentFailures(db: Database.Database, last = 3): number {
  const rows = db
    .prepare(`SELECT status FROM runs ORDER BY id DESC LIMIT ?`)
    .all(last) as Array<{ status: string }>;
  if (rows.length < last) return 0;
  return rows.every((r) => r.status === 'failed') ? last : 0;
}
