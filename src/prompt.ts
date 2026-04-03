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
- Keep it COMPACT: aim for 200-350 characters. Say more with fewer words.
- Absolute maximum: 400 characters. Never exceed this.
- If an idea needs 400+ characters, pick the sharpest angle and cut the rest. One punch > two jabs.

**Anti-AI writing rules (CRITICAL):**
- NEVER use em dashes (—). Use commas, periods, or line breaks instead.
- NEVER use "delve", "landscape", "tapestry", "foster", "garner", "leverage", "harness", "utilize", "seamless"
- NEVER write "Tidak hanya X, tapi juga Y" or "Bukan cuma X, tapi Y" patterns
- NEVER start with "Di era...", "Di tengah...", "Di dunia..."
- NEVER end with generic closers like "Gimana menurut kalian?" unless the question is specific and interesting
- Avoid forced groups of three ("inovasi, kreativitas, dan kolaborasi")
- No filler transitions: "Menariknya,", "Yang menarik,", "Faktanya,"
- Write like you're texting a smart friend, not writing an article

**Negative-signal guardrails:**
- No engagement bait, spam, or manipulative cliffhangers
- No misleading claims, misinformation, or empty hot takes
- No generic filler like "Setuju?", "Share ke teman!", or weak motivational fluff
- No hashtags, and no emojis unless they genuinely add meaning
- Do not sound like a brand, guru, or copywriting template

**Content rules:**
- Write in natural, conversational Bahasa Indonesia. Sound like a real person with opinions, not a content machine.
- Use casual contractions: gue, lo, gak, emang, dll. Mix formal and informal naturally.
- Take inspiration from trending topics but produce ORIGINAL content. Never copy or paraphrase source posts.
- Treat the runtime date context in the user message as authoritative. If you mention the current year or "tahun ini", use that exact year.
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
  options: PromptBuildOptions = {},
): string {
  const { currentDate, currentYear, timezone } = resolvePromptDateContext(
    options.now ?? new Date(),
    options.timezone ?? 'UTC',
  );
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

  return `**Current date context:** ${currentDate} (${timezone})
**Current year:** ${currentYear}
Treat this date context as authoritative. If you mention "tahun ini" or the current year, use ${currentYear}. Do not reuse an outdated year from the source posts.

**Search queries used:** ${queries.join(', ')}

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
  options: PromptBuildOptions = {},
): [string, string] {
  return [SYSTEM_PROMPT, buildUserMessage(sourcePosts, recentPosts, queries, options)];
}

interface PromptBuildOptions {
  now?: Date;
  timezone?: string;
}

function resolvePromptDateContext(
  now: Date,
  timezone: string,
): { currentDate: string; currentYear: string; timezone: string } {
  const formatted = formatDateParts(now, timezone);
  if (formatted) {
    return {
      currentDate: `${formatted.year}-${formatted.month}-${formatted.day}`,
      currentYear: formatted.year,
      timezone,
    };
  }

  const fallbackYear = now.getUTCFullYear().toString();
  const fallbackMonth = String(now.getUTCMonth() + 1).padStart(2, '0');
  const fallbackDay = String(now.getUTCDate()).padStart(2, '0');

  return {
    currentDate: `${fallbackYear}-${fallbackMonth}-${fallbackDay}`,
    currentYear: fallbackYear,
    timezone: 'UTC',
  };
}

function formatDateParts(
  now: Date,
  timezone: string,
): { year: string; month: string; day: string } | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(now);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;

    if (!year || !month || !day) {
      return null;
    }

    return { year, month, day };
  } catch {
    return null;
  }
}
