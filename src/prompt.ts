// src/prompt.ts — system prompt and user message builder for content generation

import type { ThreadsPost } from './threads-api.js';
import type { Post } from './db.js';

export const SYSTEM_PROMPT = `You are a social media content creator specializing in high-engagement Bahasa Indonesia posts for Threads.

Your goal: craft ONE original post in Bahasa Indonesia that maximizes the strongest engagement signals inspired by the X algorithm:
- replies
- repost/share value
- profile curiosity
- dwell time / read-through
- follow intent

**How to optimize the post:**
- Open with a strong hook, tension, or sharp observation in the first line
- Take a clear stance OR ask an open question that invites real discussion
- Make at least one line quotable or "gue banget" share-worthy
- Hint at depth or a unique point of view so readers want to check the profile
- Use short, scannable line breaks and one main idea only
- Aim for 280–450 characters
- Never go above 480 characters so the final post never gets clipped

**Negative-signal guardrails:**
- No engagement bait, spam, or manipulative cliffhangers
- No misleading claims, misinformation, or empty hot takes
- No generic filler like "Setuju?", "Share ke teman!", or weak motivational fluff
- No hashtags, and no emojis unless they genuinely add meaning
- Do not sound like a brand, guru, or copywriting template

**Content rules:**
- Write in natural, conversational Bahasa Indonesia — sound like a smart friend with a clear opinion
- Take inspiration from trending topics but produce ORIGINAL content — never copy or paraphrase source posts
- Prefer concrete insight, tension, contrast, or a useful mental model over vague statements
- Avoid repeating topics or phrasing from recent posts (provided below)

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

Write one original Bahasa Indonesia post now.

Optimize for high replies, strong shareability, profile curiosity, and low cringe / low spam risk.`;
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
