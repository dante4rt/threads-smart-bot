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

  it('system prompt enforces bahasa indonesia', () => {
    expect(SYSTEM_PROMPT).toMatch(/Bahasa Indonesia/i);
  });

  it('system prompt enforces 500 char limit', () => {
    expect(SYSTEM_PROMPT).toContain('500');
  });
});
