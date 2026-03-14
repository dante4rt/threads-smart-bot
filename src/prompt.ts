// src/prompt.ts — system prompt and user message builder for content generation

import type { ThreadsPost } from './threads-api.js';
import type { Post } from './db.js';

export const SYSTEM_PROMPT = `You are a social media content creator specializing in viral Bahasa Indonesia posts for Threads.

Your goal: craft ONE original post in Bahasa Indonesia that drives engagement using these X algorithm principles:

**Engagement Rules:**
- Ask a question OR take a strong stance to maximize replies
- Make it quotable and shareable — give readers a "wow, exactly!" moment
- Trigger profile curiosity: make readers want to see who wrote this
- Use scannable line breaks (2–3 short lines max)
- Keep it under 500 characters total

**Content Rules:**
- Write in natural, conversational Bahasa Indonesia — sound like a smart friend, not a brand
- Take inspiration from trending topics but produce ORIGINAL content — never copy or paraphrase source posts
- Avoid generic filler ("Setuju?", "Share ke teman!") — be specific and punchy
- No hashtags, no emojis unless they genuinely add meaning
- Avoid repeating topics from recent posts (provided below)

**Output format:** Return ONLY the post text. No preamble, no explanation, no quotes around it.`;

/**
 * Build the user message that contains crawled source posts and recent published posts.
 */
export function buildUserMessage(
  sourcePosts: ThreadsPost[],
  recentPosts: Post[],
  queries: string[],
): string {
  const sourceSection =
    sourcePosts.length > 0
      ? sourcePosts
          .slice(0, 30) // cap at 30 to stay within context
          .map((p, i) => `${i + 1}. "${p.text ?? '(no text)'}"`)
          .join('\n')
      : '(no source posts found)';

  const recentSection =
    recentPosts.length > 0
      ? recentPosts
          .map((p, i) => `${i + 1}. "${p.generated_text}"`)
          .join('\n')
      : '(none yet)';

  return `**Search queries used:** ${queries.join(', ')}

**Trending posts from Threads (for inspiration only — do NOT copy):**
${sourceSection}

**My recent posts (avoid repeating these topics):**
${recentSection}

Write one original Bahasa Indonesia post now.`;
}

/**
 * Returns [systemPrompt, userMessage] tuple ready for OpenRouter.
 */
export function buildMessages(
  sourcePosts: ThreadsPost[],
  recentPosts: Post[],
  queries: string[],
): [string, string] {
  return [SYSTEM_PROMPT, buildUserMessage(sourcePosts, recentPosts, queries)];
}
