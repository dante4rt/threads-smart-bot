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

  it('system prompt bans thinkfluencer diction', () => {
    expect(SYSTEM_PROMPT).toMatch(/literally/);
    expect(SYSTEM_PROMPT).toMatch(/supply konten/);
  });
});
