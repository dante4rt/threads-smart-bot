// test/insights.test.ts — engagement backfill: response parsing + fail-open contract

import Database from 'better-sqlite3';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { migrate, savePost, updatePostMetrics, getPostsNeedingMetrics } from '../src/db.js';
import { refreshRecentMetrics } from '../src/pipeline.js';
import { ThreadsClient } from '../src/threads-api.js';
import type { PostMetrics } from '../src/db.js';

function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function publishedPost(db: Database.Database, id: string, publishedAt: string): void {
  savePost(db, {
    source_query: 'tech',
    source_post_ids: null,
    generated_text: `post ${id}`,
    threads_post_id: id,
    published_at: publishedAt,
  });
}

const nowIso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const HOUR = 60 * 60 * 1000;

describe('refreshRecentMetrics', () => {
  it('persists metrics for recently published posts', async () => {
    const db = memoryDb();
    publishedPost(db, 'tp-1', nowIso(-2 * HOUR));

    const client = {
      getMediaInsights: vi.fn(
        async (): Promise<PostMetrics> => ({
          views: 267, likes: 4, replies: 6, reposts: 1, quotes: 2,
        }),
      ),
    };

    const updated = await refreshRecentMetrics(client, db);

    expect(updated).toBe(1);
    const row = db.prepare('SELECT * FROM posts WHERE threads_post_id = ?').get('tp-1') as {
      views: number; replies: number; metrics_fetched_at: string | null;
    };
    expect(row.views).toBe(267);
    expect(row.replies).toBe(6);
    expect(row.metrics_fetched_at).not.toBeNull();
  });

  it('does not fail the run when the insights call throws', async () => {
    // The 403 shape you get without the threads_manage_insights scope. The whole
    // point of this unit is that a metrics failure never costs a post.
    const db = memoryDb();
    publishedPost(db, 'tp-1', nowIso(-2 * HOUR));

    const client = {
      getMediaInsights: vi.fn(async () => {
        throw new Error('(#10) Application does not have permission for this action');
      }),
    };

    await expect(refreshRecentMetrics(client, db)).resolves.toBe(0);

    const row = db.prepare('SELECT * FROM posts WHERE threads_post_id = ?').get('tp-1') as {
      views: number | null;
    };
    expect(row.views).toBeNull();
  });

  it('keeps going after one post fails so a single bad id cannot block the rest', async () => {
    const db = memoryDb();
    publishedPost(db, 'tp-1', nowIso(-3 * HOUR));
    publishedPost(db, 'tp-2', nowIso(-2 * HOUR));

    const client = {
      getMediaInsights: vi.fn(async (id: string): Promise<PostMetrics> => {
        if (id === 'tp-2') throw new Error('deleted');
        return { views: 10, likes: 1, replies: 0, reposts: 0, quotes: 0 };
      }),
    };

    expect(await refreshRecentMetrics(client, db)).toBe(1);
    expect(client.getMediaInsights).toHaveBeenCalledTimes(2);
  });
});

describe('getPostsNeedingMetrics', () => {
  it('skips posts fetched within the staleness window', () => {
    const db = memoryDb();
    publishedPost(db, 'tp-fresh', nowIso(-2 * HOUR));
    updatePostMetrics(db, 'tp-fresh', {
      views: 5, likes: 0, replies: 0, reposts: 0, quotes: 0,
    });

    expect(getPostsNeedingMetrics(db)).toEqual([]);
  });

  it('returns posts whose metrics have gone stale', () => {
    const db = memoryDb();
    publishedPost(db, 'tp-stale', nowIso(-48 * HOUR));
    db.prepare('UPDATE posts SET metrics_fetched_at = ? WHERE threads_post_id = ?')
      .run(nowIso(-24 * HOUR), 'tp-stale');

    expect(getPostsNeedingMetrics(db).map((p) => p.threads_post_id)).toEqual(['tp-stale']);
  });

  it('ignores posts older than the lookback window', () => {
    const db = memoryDb();
    publishedPost(db, 'tp-old', nowIso(-30 * 24 * HOUR));
    expect(getPostsNeedingMetrics(db)).toEqual([]);
  });

  it('ignores unpublished dry-run rows', () => {
    const db = memoryDb();
    savePost(db, {
      source_query: 'tech',
      source_post_ids: null,
      generated_text: 'dry run draft',
      threads_post_id: null,
      published_at: null,
    });
    expect(getPostsNeedingMetrics(db)).toEqual([]);
  });
});

describe('migrate', () => {
  it('is idempotent and preserves existing rows', () => {
    const db = memoryDb();
    publishedPost(db, 'tp-1', nowIso(-2 * HOUR));
    updatePostMetrics(db, 'tp-1', { views: 42, likes: 3, replies: 1, reposts: 0, quotes: 0 });

    migrate(db);
    migrate(db);

    const row = db.prepare('SELECT * FROM posts WHERE threads_post_id = ?').get('tp-1') as {
      views: number; generated_text: string;
    };
    expect(row.views).toBe(42);
    expect(row.generated_text).toBe('post tp-1');
  });

  it('backfills engagement columns onto a pre-existing posts table', () => {
    // The shape a deployed DB has before this change: posts exists, no metrics.
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_query TEXT,
        source_post_ids TEXT,
        generated_text TEXT NOT NULL,
        threads_post_id TEXT,
        published_at TEXT
      );
    `);
    db.prepare(
      'INSERT INTO posts (generated_text, threads_post_id, published_at) VALUES (?, ?, ?)',
    ).run('legacy post', 'tp-legacy', nowIso(-2 * HOUR));

    migrate(db);

    const row = db.prepare('SELECT * FROM posts WHERE threads_post_id = ?').get('tp-legacy') as {
      generated_text: string; views: number | null; metrics_fetched_at: string | null;
    };
    expect(row.generated_text).toBe('legacy post');
    expect(row.views).toBeNull();
    expect(row.metrics_fetched_at).toBeNull();
    // And the backfilled row is immediately eligible for a metrics fetch.
    expect(getPostsNeedingMetrics(db).map((p) => p.threads_post_id)).toEqual(['tp-legacy']);
  });
});

describe('getMediaInsights response parsing', () => {
  const client = (payload: unknown): ThreadsClient => {
    const db = memoryDb();
    db.prepare(
      'INSERT INTO tokens (id, access_token, refreshed_at, expires_at) VALUES (1, ?, ?, ?)',
    ).run('tok', nowIso(), nowIso(30 * 24 * HOUR));

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
    );

    return new ThreadsClient(
      {
        threadsAppId: 'id',
        threadsAppSecret: 'secret',
        threadsUserId: '1234567890',
        threadsAccessToken: 'tok',
        threadsRedirectUri: 'https://localhost/callback',
        dbPath: ':memory:',
      },
      db,
    );
  };

  afterEach(() => vi.unstubAllGlobals());

  it('maps every documented metric from total_value', async () => {
    const c = client({
      data: [
        { name: 'views', total_value: { value: 267 } },
        { name: 'likes', total_value: { value: 4 } },
        { name: 'replies', total_value: { value: 6 } },
        { name: 'reposts', total_value: { value: 1 } },
        { name: 'quotes', total_value: { value: 2 } },
      ],
    });

    expect(await c.getMediaInsights('tp-1')).toEqual({
      views: 267, likes: 4, replies: 6, reposts: 1, quotes: 2,
    });
  });

  it('treats a metric with an omitted value as zero', async () => {
    // The API drops total_value entirely when a count is zero.
    const c = client({
      data: [
        { name: 'views', total_value: { value: 9 } },
        { name: 'likes' },
        { name: 'replies', total_value: {} },
        { name: 'reposts', total_value: { value: 0 } },
        { name: 'quotes', total_value: { value: 0 } },
      ],
    });

    expect(await c.getMediaInsights('tp-1')).toEqual({
      views: 9, likes: 0, replies: 0, reposts: 0, quotes: 0,
    });
  });

  it('returns all zeros for an empty payload rather than throwing', async () => {
    const c = client({ data: [] });
    expect(await c.getMediaInsights('tp-1')).toEqual({
      views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0,
    });
  });

  it('ignores unknown metric names and cannot be steered onto a prototype key', async () => {
    const c = client({
      data: [
        { name: 'views', total_value: { value: 5 } },
        { name: 'shares', total_value: { value: 99 } },
        { name: 'constructor', total_value: { value: 99 } },
        { name: '__proto__', total_value: { value: 99 } },
      ],
    });

    const metrics = await c.getMediaInsights('tp-1');
    expect(metrics).toEqual({ views: 5, likes: 0, replies: 0, reposts: 0, quotes: 0 });
    expect(Object.keys(metrics).sort()).toEqual(
      ['likes', 'quotes', 'replies', 'reposts', 'views'],
    );
  });
});

describe('refreshRecentMetrics on a DB predating the engagement columns', () => {
  it('returns 0 instead of throwing, so an unmigrated DB cannot fail a run', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_query TEXT,
        source_post_ids TEXT,
        generated_text TEXT NOT NULL,
        threads_post_id TEXT,
        published_at TEXT
      );
    `);
    const client = { getMediaInsights: vi.fn() };

    await expect(refreshRecentMetrics(client, db)).resolves.toBe(0);
    expect(client.getMediaInsights).not.toHaveBeenCalled();
  });
});

describe('getMediaInsights against the real API response shape', () => {
  const stub = (payload: unknown): ThreadsClient => {
    const db = memoryDb();
    db.prepare(
      'INSERT INTO tokens (id, access_token, refreshed_at, expires_at) VALUES (1, ?, ?, ?)',
    ).run('tok', nowIso(), nowIso(30 * 24 * HOUR));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
    );
    return new ThreadsClient(
      {
        threadsAppId: 'id',
        threadsAppSecret: 'secret',
        threadsUserId: '1234567890',
        threadsAccessToken: 'tok',
        threadsRedirectUri: 'https://localhost/callback',
        dbPath: ':memory:',
      },
      db,
    );
  };

  afterEach(() => vi.unstubAllGlobals());

  it('reads the lifetime values[] shape the live API actually returns', async () => {
    // Captured verbatim from GET /18120525521489407/insights on 2026-09-06.
    // The post has 15 views; a total_value-only parser reported 0.
    const c = stub({
      data: [
        { id: 'x/insights/views/lifetime', name: 'views', period: 'lifetime', values: [{ value: 15 }] },
        { id: 'x/insights/likes/lifetime', name: 'likes', period: 'lifetime', values: [{ value: 0 }] },
        { id: 'x/insights/thread_replies/lifetime', name: 'replies', period: 'lifetime', values: [{ value: 2 }] },
        { id: 'x/insights/reposts/lifetime', name: 'reposts', period: 'lifetime', values: [{ value: 0 }] },
        { id: 'x/insights/quotes/lifetime', name: 'quotes', period: 'lifetime', values: [{ value: 1 }] },
      ],
    });

    expect(await c.getMediaInsights('18120525521489407')).toEqual({
      views: 15, likes: 0, replies: 2, reposts: 0, quotes: 1,
    });
  });

  it('still reads the total_value shape', async () => {
    const c = stub({ data: [{ name: 'views', total_value: { value: 267 } }] });
    expect((await c.getMediaInsights('tp-1')).views).toBe(267);
  });

  it('prefers values[] when a payload somehow carries both', async () => {
    const c = stub({
      data: [{ name: 'views', values: [{ value: 15 }], total_value: { value: 0 } }],
    });
    expect((await c.getMediaInsights('tp-1')).views).toBe(15);
  });

  it('treats a present-but-empty shape as a real zero', async () => {
    const c = stub({ data: [{ name: 'views', values: [{}] }, { name: 'likes', total_value: {} }] });
    const m = await c.getMediaInsights('tp-1');
    expect(m.views).toBe(0);
    expect(m.likes).toBe(0);
  });
});
