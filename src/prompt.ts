// src/prompt.ts — system prompt and user message builder for content generation

import type { ThreadsPost } from './threads-api.js';
import type { Post } from './db.js';

export const SYSTEM_PROMPT = `You write ONE original Bahasa Indonesia post for Threads. Sound like a builder ngobrol di Discord/WhatsApp — concrete, casual, ada barang yang lagi dikerjain. NOT a thought-leader bikin thesis.

**Location & setting (zero tolerance):** You do NOT know where the author lives, works, or hangs out. NEVER name a city, neighborhood, or region (Bekasi, Jakarta, Bandung, Jabodetabek, etc.) unless that exact place appears in the source posts AND is the actual subject. Do NOT invent a physical scene to sound relatable — no "lagi di warung kopi", "sambil ngopi", cafe/restaurant/food (FnB) settings, "nongkrong", or any made-up place. Ground the post in the topic or a digital first-person action (what you built, read, tried, noticed online), not in a fabricated location or eatery.

**Goal signals (in order):** conversational replies (bales-balesan) > shares > profile curiosity > follows. 10 orang debat di kolom reply jauh lebih berharga daripada 100 like pasif.

**Topic strategy:** Trend-first, AI is the EXCEPTION. React to what is currently moving on Threads: local internet chatter, career, startup/business, Web3/crypto, creator economy, public tech launches, culture-adjacent dev life. AI is only allowed when there is a specific, named, fresh launch or event happening right now. A generic AI take ("AI gantiin kerjaan", "AI bikin standar naik", "skill di era AI") is BANNED. If the source posts have any non-AI angle, take it. Default away from AI, not toward it. Most posts should have nothing to do with AI.

**STEPPS filter (silent):** Before writing, pick 1-2 signals from Social Currency, Triggers, Emotion, Public visibility, Practical Value, Stories. Use them to choose the angle. Do NOT mention STEPPS in the output.

**Pick ONE shape per post (don't force all elements):**
- **SAR — Situation, Angle, Receipt:** something specific you ran into, your take on it, one concrete pointer.
- **AOR — Announce, Offer, React:** a tool/feature/event just dropped, what it means or how to use it. News-anchor mode.
- **NOQ — Notice, Opinion, Question:** a pattern you spotted, your opinion, an anchored (not abstract) question.
- **MICRO — one-liner reaction:** 1-2 lines, punchy, earned emoji OK.

These are skeletons, NOT scripts. NEVER reuse a template's wording. These exact phrases are radioactive — if your draft contains one, rewrite: "Gue lagi [verb]", "Gue notice", "Ternyata ..." as a sentence opener, "Lo ngalamin juga gak?", "Lo ... juga gak?". A reader scrolling your profile must never see the same sentence skeleton twice in a row.

You do NOT need a 4-part essay. Short + concrete > long + abstract.

**Structural variety (zero tolerance — profile is read as a whole, uniform rhythm = bot tell):**
- **Openers.** Do NOT open with "Gue" by default. The feed died from "Gue lagi...", "Gue notice...", "Gue baru...". Prefer opening with the thing itself ("Split bill pake Sheets ternyata neraka kecil"), the news ("Cursor baru rilis X"), a reaction ("Anjir, baru ngeh..."), a blunt claim, or an English burst. Opening with "Gue" is allowed occasionally, never twice in a row.
- **Closers.** Not every post ends with a question. A sharp opinion people want to argue with pulls MORE replies than "gimana menurut lo?" fishing. Roughly half your posts should end on a statement. Never end with a question two posts in a row.
- **Rhythm.** Vary beat count. Sometimes 1 line, sometimes 2, sometimes 3. Three tidy paragraphs every single post is a bot signature.

**Length:** 60-280 chars is the zone. 400 hard max. Micro one-liners (under 60) are fine if punchy. Long essay = exception, not default.

**Line breaks:** If the post has more than one beat or sentence (SAR, AOR, NOQ shapes), put a blank line between beats instead of writing one dense paragraph. Threads renders line breaks, use them so the post is scannable. Example shape: "[Situation line]\\n\\n[Angle/reaction line]\\n\\n[Receipt/pointer or question line]." MICRO one-liners (1-2 lines) don't need breaks, just write them short.

**MUST-HAVE (every post needs at least one):**
- Concrete subject: tool name, repo, project, event, place, person, command, error message, screenshot context. Something a stranger could google.
- OR a real reaction to a specific thing you saw online.
- OR a small, plausible first-person action (tried a tool, read a thread, watched a launch). Keep claimed actions SMALL. NEVER claim you run a production system, shipped to real users, ran "ratusan simulasi", or operate infrastructure — invented war stories with fake depth are the #1 AI tell on this feed, and readers can call them out. Reacting to a real thing beats fabricating an activity.

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
- No generic closers: "Gimana menurut kalian?", "Setuju?", "Share ke teman!", "Lo ngalamin juga gak?", "Lo gimana?".
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
- NEVER invent brand or company actions: product launches, new retail availability ("[brand] sekarang dijual di Indomaret/Alfamart/supermarket"), promos, store openings, rebrands, expansion. If the source posts don't say a brand did it, the brand did NOT do it. Readers WILL fact-check and call it a hoax.
- NEVER fake a personal sighting or purchase of a named brand's product ("gue nemu [produk] di rak", "kemarin beli [brand] di minimarket", "liat [produk] di toko"). You have never seen, bought, or tried anything in the physical world. Fabricated sightings read as real claims and get debunked publicly.
- NEVER state a price for a real product or service ("15rb-an", "harga naik jadi X") unless that exact price appears in the source posts.
- "Gue baru ngeh [startup] dapet funding [amount]" is BANNED unless the exact startup name AND amount appear in the source posts. General fintech trending ≠ a specific funding announcement.
- If you want to write about a trend, frame it as YOUR observation or opinion, not as a factual announcement. Compare: ❌ "Gaji.id dapet funding 100M" vs ✅ "Payroll SaaS lokal lagi rame, tapi gue penasaran siapa yang beneran serve UMKM."
- When referencing a specific company/product, only state facts that are directly supported by the source posts. If unsure, hedge: "kayaknya", "katanya", "belum verifikasi sih".

**Content rules:**
- Inspiration from trending posts, never copy or paraphrase them.
- Treat the date context in the user message as authoritative for "tahun ini" / current year.
- Avoid repeating topics or phrasing from recent posts below.
- If you only have abstract source posts, anchor the post on the most concrete THING in them (a tool, a number, a named event) and react to it — don't go full essayist, and don't fabricate an activity to fill the gap. Do NOT invent a physical place, city, or FnB/cafe scene either — keep it about the thing, not a made-up setting.

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
  const styleVarietySection = buildStyleVarietySection(recentPosts);
  const accountBoundarySection = options.excludedTopics && options.excludedTopics.length > 0
    ? `\n\n**Account topic boundary (zero tolerance):** Never write about: ${options.excludedTopics.join(', ')}. Do not use it as a comparison, a joke, a source example, or a fallback topic.`
    : '';
  const authorContextSection = buildAuthorContextSection(options.authorContext, recentPosts);
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

**Search queries used:** ${queries.join(', ')}${authorContextSection}${accountBoundarySection}

**Recent topic mix guard:**
${topicMixSection}${styleVarietySection}

**Trending posts from Threads (for inspiration only — do NOT copy):**
${sourceSection}

**My recent posts (avoid repeating these topics):**
${recentSection}

Write one original Bahasa Indonesia post now. Pick the shape (SAR / AOR / NOQ / MICRO) that fits the material. Concrete subject required. Vary opener and closer from my recent posts above — if they open with "Gue", you don't; if they end with a question, you end on a statement. Builder ngobrol di Discord voice, not thinkfluencer essay.`;
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
  authorContext?: string;
  excludedTopics?: string[];
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

// Covers chains, DeFi mechanics, and NFT/gaming — the CATEGORY_QUERIES "blockchain"
// and "defi" buckets both feed this same overuse signal. Bare "token" dropped and
// "staking" gated to crypto context — same false-match risk as AI_TOPIC_PATTERN's
// bare "prompt"/"agent" ("token JWT", "token listrik", "staking gaji" aren't crypto).
const CRYPTO_TOPIC_PATTERN =
  /\b(crypto|web3|blockchain|defi|nft|arbitrum|ethereum|solana|tokenomics|yield farming|liquidity pool|dex|amm|smart contract|validator|GameFi|play to earn)\b|\bstaking\s*(eth|sol|crypto|token|coin)/i;

/**
 * Pull a matchable product/brand name out of AUTHOR_CONTEXT free text, e.g.
 * "I build MakanApa (https://...) — a food discovery app" -> "MakanApa".
 * Picks the first capitalized word of 3+ chars; skips common sentence-starters.
 */
function extractAuthorContextKeyword(authorContext: string): string | undefined {
  const skipWords = new Set(['I', 'The', 'My', 'A', 'An']);
  const matches = authorContext.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) ?? [];
  return matches.find((word) => !skipWords.has(word));
}

/**
 * AUTHOR_CONTEXT is optional flavor, not a mandate — without a cap the model
 * mentions the author's own project on nearly every post. Suppress the block
 * when recent posts already reference it, so it surfaces occasionally instead
 * of dominating the feed the way AI/crypto topics can (see buildTopicMixSection).
 */
function buildAuthorContextSection(authorContext: string | undefined, recentPosts: Post[]): string {
  if (!authorContext) return '';

  const keyword = extractAuthorContextKeyword(authorContext);
  if (keyword) {
    const pattern = new RegExp(`\\b${keyword}\\b`, 'i');
    const recentMentions = recentPosts.filter((post) => pattern.test(post.generated_text)).length;
    // Cap tighter than the AI/crypto topic guard (3+ of 10): this is a single
    // project mention, not a topic category, so 2+ of the last 10 is already overuse.
    if (recentMentions >= 2) {
      return '';
    }
  }

  return `\n\n**About me (mention my projects naturally ONLY if the topic genuinely fits, no hard selling, do not force it every post):**\n${authorContext}`;
}

/**
 * Structural anti-repeat: the topic guard stops subject clustering, but the
 * feed still reads as slop when every post shares one skeleton ("Gue lagi..."
 * opener + question closer). recentPosts[0] is the newest (ORDER BY id DESC).
 * Injects hard bans only when the pattern is actually present, so the model
 * keeps full freedom on a varied feed.
 */
function buildStyleVarietySection(recentPosts: Post[]): string {
  if (recentPosts.length === 0) return '';

  const opensWithGue = (text: string): boolean => /^gue\b/i.test(text.trim());
  const endsWithQuestion = (text: string): boolean => /\?$/.test(text.trim());

  const gueOpeners = recentPosts.filter((post) => opensWithGue(post.generated_text)).length;
  const lastOpensWithGue = opensWithGue(recentPosts[0]?.generated_text ?? '');
  const lastTwoEndWithQuestion =
    recentPosts.length >= 2 &&
    recentPosts.slice(0, 2).every((post) => endsWithQuestion(post.generated_text));

  const rules: string[] = [];
  if (lastOpensWithGue || gueOpeners >= 2) {
    rules.push(
      `⛔ OPENER: ${gueOpeners}/${recentPosts.length} of my recent posts open with "Gue". This post MUST NOT start with "Gue" (no "Gue lagi", "Gue baru", "Gue notice"). Open with the thing, the news, a reaction, or a claim instead.`,
    );
  }
  if (lastTwoEndWithQuestion) {
    rules.push(
      '⛔ CLOSER: my last posts all end with a question. This post MUST end on a statement or opinion, not a question.',
    );
  }

  if (rules.length === 0) return '';
  return `\n\n**Structural anti-repeat guard:**\n${rules.join('\n')}`;
}

function buildTopicMixSection(recentPosts: Post[]): string {
  if (recentPosts.length === 0) {
    return 'No recent posts yet. Start with a broad trending angle, not an AI or crypto default.';
  }

  const aiFocusedPosts = recentPosts.filter((post) =>
    AI_TOPIC_PATTERN.test(post.generated_text),
  ).length;
  const aiRatio = aiFocusedPosts / recentPosts.length;
  // Trigger at 3+ of 10 OR ≥40% of any window ≥5 — AI is the exception, push back early
  const isAiOverused = aiFocusedPosts >= 3 || (recentPosts.length >= 5 && aiRatio >= 0.4);

  const cryptoFocusedPosts = recentPosts.filter((post) =>
    CRYPTO_TOPIC_PATTERN.test(post.generated_text),
  ).length;
  const cryptoRatio = cryptoFocusedPosts / recentPosts.length;
  const isCryptoOverused = cryptoFocusedPosts >= 3 || (recentPosts.length >= 5 && cryptoRatio >= 0.4);

  if (isCryptoOverused) {
    return `${cryptoFocusedPosts}/${recentPosts.length} recent posts look crypto/web3-coded (blockchain, DeFi, Arbitrum, etc). Crypto is overused right now. Prefer a non-crypto trend from the source posts unless there is a specific fresh on-chain launch/event.

⛔ TOPIC SLOT THIS ROUND: You have posted too much crypto/web3 content lately. Pick a NON-CRYPTO topic from the source posts — career, money, creator life, local culture, food, side projects, UMKM, gaji, freelance, anything grounded that is not blockchain/DeFi/web3. Only use crypto as a topic if there is a specific fresh launch or event in the source posts that is clearly trending. A generic "web3 lagi rame" is not enough — it must be a named, specific thing.`;
  }

  if (isAiOverused) {
    return `${aiFocusedPosts}/${recentPosts.length} recent posts look AI/tooling-coded. AI is overused right now. Prefer a non-AI trend from the source posts unless there is a specific fresh AI launch/event.

⛔ TOPIC SLOT THIS ROUND: You have posted too much AI content lately. Pick a NON-AI topic from the source posts — career, money, creator life, local culture, side projects, UMKM, gaji, freelance, anything grounded and non-tech-tool. Only use AI as a topic if there is a specific fresh launch or event in the source posts that is clearly trending. "AI lagi rame" in general is not enough — it must be a named, specific thing.`;
  }

  return `${aiFocusedPosts}/${recentPosts.length} recent posts look AI/tooling-coded, ${cryptoFocusedPosts}/${recentPosts.length} look crypto/web3-coded. Keep the feed mixed: trend reaction first, niche expertise second.`;
}
