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
}

export interface Token {
  id: number;
  access_token: string;
  refreshed_at: string;
  expires_at: string;
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

function migrate(db: Database.Database): void {
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
      expires_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      status        TEXT NOT NULL,
      error_message TEXT,
      started_at    TEXT NOT NULL,
      completed_at  TEXT
    );
  `);
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
): void {
  db.prepare(`
    INSERT INTO tokens (id, access_token, refreshed_at, expires_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_token = excluded.access_token,
      refreshed_at = excluded.refreshed_at,
      expires_at   = excluded.expires_at
  `).run(encryptToken(accessToken, encryptionSecret), new Date().toISOString(), expiresAt.toISOString());
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

export function savePost(
  db: Database.Database,
  post: Omit<Post, 'id'>,
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
