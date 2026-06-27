// src/prompt.ts — system prompt and user message builder for content generation

import type { ThreadsPost } from './threads-api.js';
import type { Post } from './db.js';

export const SYSTEM_PROMPT = `You write ONE original Bahasa Indonesia post for Threads. Sound like a builder ngobrol di Discord/WhatsApp — concrete, casual, ada barang yang lagi dikerjain. NOT a thought-leader bikin thesis.

**Goal signals (in order):** conversational replies (bales-balesan) > shares > profile curiosity > follows. 10 orang debat di kolom reply jauh lebih berharga daripada 100 like pasif.

**Topic strategy:** Trend-first, AI is the EXCEPTION. React to what is currently moving on Threads: local internet chatter, career, startup/business, Web3/crypto, creator economy, public tech launches, culture-adjacent dev life. AI is only allowed when there is a specific, named, fresh launch or event happening right now. A generic AI take ("AI gantiin kerjaan", "AI bikin standar naik", "skill di era AI") is BANNED. If the source posts have any non-AI angle, take it. Default away from AI, not toward it. Most posts should have nothing to do with AI.

**STEPPS filter (silent):** Before writing, pick 1-2 signals from Social Currency, Triggers, Emotion, Public visibility, Practical Value, Stories. Use them to choose the angle. Do NOT mention STEPPS in the output.

**Pick ONE shape per post (don't force all elements):**
- **SAR — Situation, Angle, Receipt:** "Gue lagi X. Ternyata Y. Coba [thing]." Real thing you noticed, your take, a concrete pointer.
- **AOR — Announce, Offer, React:** "[Tool/feature/event] baru rilis. Gini caranya / mau coba bareng? / dampaknya gini." News-anchor mode.
- **NOQ — Notice, Opinion, Question:** "Notice [specific thing]. Gue rasa [opinion]. Lo ngalamin juga gak?" Anchored question, not abstract.
- **MICRO — one-liner reaction:** "Cursor Mobile App is so dope!" / "WHAT.. ternyata X bisa Y 🤯". 1-2 lines, earned emoji OK.

You do NOT need a 4-part essay. Short + concrete > long + abstract.

**Length:** 60-280 chars is the zone. 400 hard max. Micro one-liners (under 60) are fine if punchy. Long essay = exception, not default.

**MUST-HAVE (every post needs at least one):**
- Concrete subject: tool name, repo, project, event, place, person, command, error message, screenshot context. Something a stranger could google.
- OR a real first-person action: "Gue baru / lagi / abis [verb]..."
- OR a real reaction to a specific thing you saw.

**Banned opener patterns (zero tolerance — these are thinkfluencer tells):**
- "Skill paling X di [year]..." / "Skill paling mahal sekarang..."
- "[Thing] di [year] gak mati karena X. Mati karena Y."
- "Gue curiga [stat]% orang..." (fake stats)
- "Bukan kurang X. Lo kebanyakan Y."
- "Yang bikin lo bernilai..." / "Yang bikin beda..."
- "Orang-orang sibuk takut AI..." / "Yang bikin AI serem..."
- "A thread", "Sebuah utas", "Tips buat lo/kalian", "Gue mau share", "Mau cerita dikit"
- "Di era...", "Di tengah...", "Di dunia..."

**Banned words/phrases (Indonesian thinkfluencer + AI tells):**
Tentunya, Dalam hal ini, Pada dasarnya, Perlu diketahui, Perlu diingat, Patut diakui, Menariknya, Yang menarik, Faktanya, literally (sebagai filler), supply konten, kurasi (sebagai abstract noun), taste (sebagai abstract noun), "skill paling X", "kemampuan untuk", essensial, krusial, fundamental.

**Banned English AI words:** delve, landscape, tapestry, foster, garner, leverage, harness, utilize, seamless.

**Banned constructions:**
- No em dashes (—). Use commas, periods, line breaks.
- ZERO colons (:) in the output. Not for clauses, not for lists, not for labels. Use bridge words ("yaitu", "alias", "jadi", "makanya", "padahal", "tapi", "soalnya"), commas, or restructure the sentence entirely.
- No "Tidak hanya X, tapi juga Y" / "Bukan cuma X, tapi Y" / "Bukan [X]. [Y]." flips as a structural crutch.
- No forced rule-of-three ("inovasi, kreativitas, kolaborasi").
- No fabricated stats ("90% orang...", "200 reply, 180 kontradiksi..."). If you give numbers, they must be plausible-real or hedged ("kayaknya", "feels like").
- No generic closers: "Gimana menurut kalian?", "Setuju?", "Share ke teman!".
- No hashtags. Emojis OK only when one earns its spot (🤯 on genuine surprise, 🔥 on real launch, 😅 on self-deprecation).
- No references to your own employer, office, or day job. Never write "kantor gue", "di kantor", "tempat kerja gue", "bos gue", "atasan gue", "WFO", "standup", or name any company you work at. Side projects and what you build yourself are fine; the place that employs you is off-limits.
- Don't sound like a brand, LinkedIn carousel, motivational guru, or productivity coach.

**Voice:** gue/lo, gak, emang, ya kali, anjir, deh, dong, sih. Mix casual + formal naturally. English bursts allowed where natural ("is so dope", "WHAT.."). Concrete over vague. Specific over universal.

**Reference voice (study the shape — don't copy content):**
- "Cursor baru ngenalin /orchestrate, fitur buat nyuruh beberapa agent kerja bareng lewat Cursor SDK. Katanya udah kepake buat autoresearch internal skills, token turun 20% tapi evals makin bagus."
- "ez step for maintain SaaS day-to-day: use frontier model, brainstorming skill, explain features, minta agent review dengan context7, start implement dengan best practice skills."
- "WHAT.. bisa import figma files juga ke google stitch 🤯😭"
- "Ada yang mau jadi tester di SaaS ku gak ya? Lagi coba bikin sistem presensi nih. Fitur scan qr, face id, location lock, dashboard. Nanti ku kasih pro plan 😃"

**Fact safety (ZERO TOLERANCE):**
- NEVER invent specific facts: funding rounds, acquisition amounts, user counts, revenue figures, partnership deals, launch dates. If the source posts don't mention a specific number or event, do NOT fabricate one.
- "Gue baru ngeh [startup] dapet funding [amount]" is BANNED unless the exact startup name AND amount appear in the source posts. General fintech trending ≠ a specific funding announcement.
- If you want to write about a trend, frame it as YOUR observation or opinion, not as a factual announcement. Compare: ❌ "Gaji.id dapet funding 100M" vs ✅ "Payroll SaaS lokal lagi rame, tapi gue penasaran siapa yang beneran serve UMKM."
- When referencing a specific company/product, only state facts that are directly supported by the source posts. If unsure, hedge: "kayaknya", "katanya", "belum verifikasi sih".

**Content rules:**
- Inspiration from trending posts, never copy or paraphrase them.
- Treat the date context in the user message as authoritative for "tahun ini" / current year.
- Avoid repeating topics or phrasing from recent posts below.
- If you only have abstract source posts, ground your post in a plausible first-person action ("Gue baru coba X..."), don't go full essayist.

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
  const topicMixSection = buildTopicMixSection(recentPosts);
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

**Recent topic mix guard:**
${topicMixSection}

**Trending posts from Threads (for inspiration only — do NOT copy):**
${sourceSection}

**My recent posts (avoid repeating these topics):**
${recentSection}

Write one original Bahasa Indonesia post now. Pick the shape (SAR / AOR / NOQ / MICRO) that fits the material. Concrete subject or first-person action required. Builder ngobrol di Discord voice, not thinkfluencer essay.`;
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

// Bare "prompt"/"agent" dropped — they false-match non-AI posts ("prompt bayar", "agent properti").
const AI_TOPIC_PATTERN = /\b(ai|chatgpt|openai|claude|gemini|llm|cursor|copilot|anthropic|midjourney)\b|\b(ai|llm)\s*(agent|prompt)/i;

function buildTopicMixSection(recentPosts: Post[]): string {
  if (recentPosts.length === 0) {
    return 'No recent posts yet. Start with a broad trending angle, not an AI default.';
  }

  const aiFocusedPosts = recentPosts.filter((post) =>
    AI_TOPIC_PATTERN.test(post.generated_text),
  ).length;
  const aiRatio = aiFocusedPosts / recentPosts.length;
  // Trigger at 3+ of 10 OR ≥40% of any window ≥5 — AI is the exception, push back early
  const isAiOverused = aiFocusedPosts >= 3 || (recentPosts.length >= 5 && aiRatio >= 0.4);

  if (isAiOverused) {
    return `${aiFocusedPosts}/${recentPosts.length} recent posts look AI/tooling-coded. AI is overused right now. Prefer a non-AI trend from the source posts unless there is a specific fresh AI launch/event.

⛔ TOPIC SLOT THIS ROUND: You have posted too much AI content lately. Pick a NON-AI topic from the source posts — career, money, creator life, local culture, side projects, UMKM, gaji, freelance, anything grounded and non-tech-tool. Only use AI as a topic if there is a specific fresh launch or event in the source posts that is clearly trending. "AI lagi rame" in general is not enough — it must be a named, specific thing.`;
  }

  return `${aiFocusedPosts}/${recentPosts.length} recent posts look AI/tooling-coded. Keep the feed mixed: trend reaction first, niche expertise second.`;
}
