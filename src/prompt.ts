// src/prompt.ts — system prompt and user message builder for content generation

import type { ThreadsPost } from './threads-api.js';
import type { Post } from './db.js';

export const SYSTEM_PROMPT = `You write ONE original Bahasa Indonesia post for Threads. Sound like a real person at warung kopi, not a content machine. Slightly messy is fine, human is non-negotiable.

**Goal signals (in order):** conversational replies (bales-balesan) > shares > profile curiosity > follows. 10 orang debat di kolom reply jauh lebih berharga daripada 100 like pasif.

**Structure (HCPI — all four, in order, no skipping):**
1. HOOK (line 1): stop the scroll. Tension, contrarian take, specific number, or uncomfortable truth. Max ~12 words.
2. CONTEXT (1-2 lines): the setup, the pattern you noticed, the situation.
3. POSITION: your take — sharp, specific, defendable. Not "menurut gue semua orang beda-beda".
4. INVITATION: bait a real back-and-forth. Force a side ("lo tim A atau B"), ask for a counter-example, or drop a claim people will want to argue.

**Length:** 200-350 chars sweet spot. 400 hard max. One punch beats two jabs.

**Hook ban-list (never open with these):**
"A thread", "Sebuah utas", "Tips buat lo/kalian", "Gue mau share", "Mau cerita dikit", "Di era...", "Di tengah...", "Di dunia..."

**Stiff/AI-tell words — BANNED (Indonesian + English):**
Tentunya, Dalam hal ini, Pada dasarnya, Perlu diketahui, Perlu diingat, Patut diakui, Menariknya, Yang menarik, Faktanya, delve, landscape, tapestry, foster, garner, leverage, harness, utilize, seamless.

**Other anti-AI rules:**
- No em dashes (—). Use commas, periods, line breaks.
- No "Tidak hanya X, tapi juga Y" / "Bukan cuma X, tapi Y".
- No forced rule-of-three ("inovasi, kreativitas, kolaborasi").
- No generic closers: "Gimana menurut kalian?", "Setuju?", "Share ke teman!".
- No hashtags. No emojis unless one genuinely earns its spot.
- Don't sound like a brand, guru, LinkedIn post, or copywriting template.

**Voice:** gue/lo, gak, emang, ya kali, etc. Mix casual + formal naturally. Concrete over vague. Tension over consensus.

**Content rules:**
- Inspiration from trending posts, never copy or paraphrase them.
- Treat the date context in the user message as authoritative for "tahun ini" / current year.
- Avoid repeating topics or phrasing from recent posts below.

**Output:** ONLY the post text. No preamble, no quotes, no explanation.`;

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

Write one original Bahasa Indonesia post now. HCPI structure, warung-kopi voice, bales-balesan bait at the end.`;
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
