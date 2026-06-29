// test/prompt.test.ts

import { describe, it, expect } from 'vitest';
import { buildMessages, SYSTEM_PROMPT } from '../src/prompt.js';
import type { ThreadsPost } from '../src/threads-api.js';
import type { Post } from '../src/db.js';

describe('buildMessages', () => {
  const sourcePosts: ThreadsPost[] = [
    { id: '1', text: 'Trending tech post' },
    { id: '2', text: 'Another viral post' },
  ];

  const recentPosts: Post[] = [
    {
      id: 1,
      source_query: 'tech',
      source_post_ids: null,
      generated_text: 'My previous post about AI',
      threads_post_id: 'tp-1',
      published_at: '2024-01-01T09:00:00Z',
    },
  ];

  it('returns [systemPrompt, userMessage] tuple', () => {
    const [system, user] = buildMessages(sourcePosts, recentPosts, ['tech', 'AI']);
    expect(system).toBe(SYSTEM_PROMPT);
    expect(typeof user).toBe('string');
  });

  it('includes search queries in user message', () => {
    const [, user] = buildMessages(sourcePosts, recentPosts, ['tech', 'AI']);
    expect(user).toContain('tech');
    expect(user).toContain('AI');
  });

  it('includes source post texts', () => {
    const [, user] = buildMessages(sourcePosts, recentPosts, ['tech']);
    expect(user).toContain('Trending tech post');
    expect(user).toContain('Another viral post');
  });

  it('includes recent post text for dedup context', () => {
    const [, user] = buildMessages(sourcePosts, recentPosts, ['tech']);
    expect(user).toContain('My previous post about AI');
  });

  it('handles empty source posts gracefully', () => {
    const [, user] = buildMessages([], [], ['tech']);
    expect(user).toContain('no source posts found');
    expect(user).toContain('none yet');
  });

  it('includes explicit current date context for the model', () => {
    const [, user] = buildMessages(sourcePosts, recentPosts, ['tech'], {
      now: new Date('2026-04-03T10:00:00Z'),
      timezone: 'Asia/Jakarta',
    });

    expect(user).toContain('Current date context');
    expect(user).toContain('2026-04-03');
    expect(user).toContain('**Current year:** 2026');
    expect(user).toContain('Do not reuse an outdated year');
  });

  it('uses the configured timezone when resolving the current year', () => {
    const [, user] = buildMessages(sourcePosts, recentPosts, ['tech'], {
      now: new Date('2025-12-31T17:30:00Z'),
      timezone: 'Asia/Jakarta',
    });

    expect(user).toContain('2026-01-01');
    expect(user).toContain('**Current year:** 2026');
  });

  it('system prompt enforces bahasa indonesia', () => {
    expect(SYSTEM_PROMPT).toMatch(/Bahasa Indonesia/i);
  });

  it('system prompt enforces compact character targets', () => {
    expect(SYSTEM_PROMPT).toContain('400');
    expect(SYSTEM_PROMPT).toContain('60-280');
  });

  it('system prompt includes shareability and reply-engagement goals', () => {
    expect(SYSTEM_PROMPT).toMatch(/bales-balesan/i);
    expect(SYSTEM_PROMPT).toMatch(/share/i);
  });

  it('system prompt enforces trend-first topic strategy and silent STEPPS filtering', () => {
    expect(SYSTEM_PROMPT).toMatch(/Trend-first, AI is the EXCEPTION/i);
    expect(SYSTEM_PROMPT).toMatch(/STEPPS filter/i);
    expect(SYSTEM_PROMPT).toMatch(/Social Currency/i);
  });

  it('system prompt offers flexible post shapes (not forced HCPI)', () => {
    expect(SYSTEM_PROMPT).toMatch(/SAR/);
    expect(SYSTEM_PROMPT).toMatch(/AOR/);
    expect(SYSTEM_PROMPT).toMatch(/NOQ/);
    expect(SYSTEM_PROMPT).toMatch(/MICRO/);
  });

  it('system prompt anchors tone to builder voice with bales-balesan goal', () => {
    expect(SYSTEM_PROMPT).toMatch(/builder/i);
    expect(SYSTEM_PROMPT).toMatch(/bales-balesan/i);
  });

  it('system prompt bans stiff Indonesian AI-tell words', () => {
    expect(SYSTEM_PROMPT).toMatch(/Tentunya/);
    expect(SYSTEM_PROMPT).toMatch(/Dalam hal ini/);
    expect(SYSTEM_PROMPT).toMatch(/Pada dasarnya/);
  });

  it('system prompt bans thinkfluencer opener patterns', () => {
    expect(SYSTEM_PROMPT).toMatch(/Skill paling/);
    expect(SYSTEM_PROMPT).toMatch(/Gue curiga/);
    expect(SYSTEM_PROMPT).toMatch(/Bukan kurang/);
    expect(SYSTEM_PROMPT).toMatch(/Orang-orang sibuk takut AI/);
  });

  it('system prompt bans low-effort hook openers', () => {
    expect(SYSTEM_PROMPT).toMatch(/A thread/);
    expect(SYSTEM_PROMPT).toMatch(/Tips buat/);
  });

  it('system prompt requires a concrete subject or first-person action', () => {
    expect(SYSTEM_PROMPT).toMatch(/Concrete subject/i);
    expect(SYSTEM_PROMPT).toMatch(/first-person action/i);
  });

  it('system prompt bans fabricated stats', () => {
    expect(SYSTEM_PROMPT).toMatch(/fabricated stats/i);
  });

  it('system prompt bans inventing locations and FnB settings', () => {
    expect(SYSTEM_PROMPT).toMatch(/NEVER name a city/i);
    expect(SYSTEM_PROMPT).toMatch(/FnB/);
    expect(SYSTEM_PROMPT).toMatch(/warung kopi/i);
  });

  it('system prompt bans colon clause connectors and mandates bridge words', () => {
    expect(SYSTEM_PROMPT).toMatch(/yaitu/);
    expect(SYSTEM_PROMPT).toMatch(/bridge words/i);
  });

  it('system prompt bans thinkfluencer diction', () => {
    expect(SYSTEM_PROMPT).toMatch(/literally/);
    expect(SYSTEM_PROMPT).toMatch(/supply konten/);
  });

  it('system prompt bans employer and day-job references', () => {
    expect(SYSTEM_PROMPT).toMatch(/kantor gue/);
    expect(SYSTEM_PROMPT).toMatch(/employer/i);
  });

  it('system prompt frames AI as the exception, not the default', () => {
    expect(SYSTEM_PROMPT).toMatch(/AI is the EXCEPTION/);
  });

  it('adds a recent-topic guard and hard topic-slot command when AI/tooling posts are overused', () => {
    const aiHeavyRecentPosts: Post[] = [
      {
        id: 1,
        source_query: 'AI',
        source_post_ids: null,
        generated_text: 'AI bikin standar kerja naik lagi.',
        threads_post_id: 'tp-1',
        published_at: '2026-01-01T09:00:00Z',
      },
      {
        id: 2,
        source_query: 'tech',
        source_post_ids: null,
        generated_text: 'ChatGPT dipakai buat ngerjain riset konten.',
        threads_post_id: 'tp-2',
        published_at: '2026-01-02T09:00:00Z',
      },
      {
        id: 3,
        source_query: 'viral',
        source_post_ids: null,
        generated_text: 'Cursor agent makin enak buat refactor.',
        threads_post_id: 'tp-3',
        published_at: '2026-01-03T09:00:00Z',
      },
      {
        id: 4,
        source_query: 'trending',
        source_post_ids: null,
        generated_text: 'OpenAI ngumumin model baru lagi.',
        threads_post_id: 'tp-4',
        published_at: '2026-01-04T09:00:00Z',
      },
    ];

    const [, user] = buildMessages(sourcePosts, aiHeavyRecentPosts, ['trending']);

    expect(user).toContain('AI is overused right now');
    expect(user).toContain('Prefer a non-AI trend');
    expect(user).toContain('TOPIC SLOT THIS ROUND');
    expect(user).toContain('posted too much AI content lately');
    expect(user).toContain('specific fresh launch or event');
  });

  it('does not inject topic-slot command when AI posts are below the threshold', () => {
    const mixedRecentPosts: Post[] = [
      {
        id: 1,
        source_query: 'karir',
        source_post_ids: null,
        generated_text: 'Gaji junior dev di Jakarta naik lumayan.',
        threads_post_id: 'tp-1',
        published_at: '2026-01-01T09:00:00Z',
      },
      {
        id: 2,
        source_query: 'AI',
        source_post_ids: null,
        generated_text: 'ChatGPT dipakai buat ngerjain riset konten.',
        threads_post_id: 'tp-2',
        published_at: '2026-01-02T09:00:00Z',
      },
      {
        id: 3,
        source_query: 'viral',
        source_post_ids: null,
        generated_text: 'Side project gue akhirnya dapat user pertama.',
        threads_post_id: 'tp-3',
        published_at: '2026-01-03T09:00:00Z',
      },
    ];

    const [, user] = buildMessages(sourcePosts, mixedRecentPosts, ['trending']);

    expect(user).not.toContain('TOPIC SLOT THIS ROUND');
    expect(user).not.toContain('AI is banned this round');
  });
});
