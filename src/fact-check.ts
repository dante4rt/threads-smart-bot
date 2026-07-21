// src/fact-check.ts — grounding gate: rejects drafts with claims unsupported by source posts

import { logger } from "./logger.js";
import type { ChatMessage } from "./openrouter.js";
import type { ThreadsPost } from "./threads-api.js";

/** Matches OpenRouterClient.chat — injectable so tests mock only the I/O boundary. */
export type ChatFn = (
	messages: ChatMessage[],
	maxTokens?: number,
	temperature?: number,
) => Promise<string>;

export interface FactCheckResult {
	grounded: boolean;
	violations: string[];
}

export interface GroundedPostResult {
	/** null when every attempt failed the grounding check — caller must skip publishing. */
	text: string | null;
	attempts: number;
	violations: string[];
}

const MAX_GROUNDING_ATTEMPTS = 3;

export const FACT_CHECK_SYSTEM_PROMPT = `You are a strict fact-checking gate for a social media bot. You receive SOURCE POSTS and one DRAFT post in Bahasa Indonesia.

Flag every claim in the DRAFT that asserts a specific, externally verifiable real-world fact that is NOT directly supported by the SOURCE POSTS. Verifiable facts include:
- A named brand/company/product doing anything: launching a product, selling somewhere (Indomaret, Alfamart, marketplaces), setting a price, running a promo, partnership, funding, acquisition, expansion, event.
- A personal sighting or purchase of a named brand's product ("nemu di rak", "kemarin beli", "liat di toko").
- Any specific number, price, date, or location tied to a named real-world entity.

NOT violations:
- Pure opinion or questions.
- Speculation clearly hedged as unverified ("kayaknya", "katanya", "denger-denger", "belum verifikasi").
- General trends with no specific claim.
- The author's own side projects, code, or digital actions that involve no named third-party brand claim.

A claim counts as supported only if a SOURCE POST states substantially the same fact about the same entity. "The brand exists" or "the topic is trending" does NOT support a specific claim about what the brand did.

Respond with ONLY a JSON object, no code fences, no commentary:
{"grounded": true, "violations": []}
or
{"grounded": false, "violations": ["short description of each unsupported claim"]}
"grounded" must be false when there is at least one violation.`;

/**
 * Parse the judge's raw response into a FactCheckResult.
 * Tolerates code fences, surrounding prose, and preamble objects (reasoning-then-verdict
 * output): every balanced top-level {...} is tried and the last valid verdict wins.
 * Returns null when no candidate validates.
 */
export function parseFactCheckResponse(raw: string): FactCheckResult | null {
	const candidates = extractJsonObjects(raw);
	for (let i = candidates.length - 1; i >= 0; i -= 1) {
		const result = validateVerdict(candidates[i] ?? "");
		if (result) return result;
	}
	return null;
}

/** Collect balanced top-level {...} substrings, respecting braces inside JSON strings. */
function extractJsonObjects(raw: string): string[] {
	const objects: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < raw.length; i += 1) {
		const char = raw[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"' && depth > 0) {
			inString = true;
		} else if (char === "{") {
			if (depth === 0) start = i;
			depth += 1;
		} else if (char === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && start !== -1) {
				objects.push(raw.slice(start, i + 1));
				start = -1;
			}
		}
	}

	return objects;
}

function validateVerdict(candidate: string): FactCheckResult | null {
	candidate = candidate.replace(/^[^{]*/, "").replace(/[^}]*$/, ""); // ponytail: strip preamble/trailing from reasoning models
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) return null;
	const verdict = parsed as Record<string, unknown>;
	if (typeof verdict.grounded !== "boolean") return null;
	if (!Array.isArray(verdict.violations)) return null;
	if (!verdict.violations.every((v) => typeof v === "string")) return null;

	const violations = verdict.violations as string[];
	// Inconsistent verdicts fail closed: violations present means not grounded.
	return {
		grounded: verdict.grounded && violations.length === 0,
		violations,
	};
}

/**
 * Ask the judge model whether the draft only states facts supported by the sources.
 * Fails closed: an unparseable judge response is treated as not grounded.
 */
export async function verifyPostGrounding(
	postText: string,
	sourcePosts: ThreadsPost[],
	chatFn: ChatFn,
): Promise<FactCheckResult> {
	const sourceSection =
		sourcePosts.length > 0
			? sourcePosts
					.map((p, i) => `${i + 1}. "${p.text ?? "(no text)"}"`)
					.join("\n")
			: "(no source posts)";

	const raw = await chatFn(
		[
			{ role: "system", content: FACT_CHECK_SYSTEM_PROMPT },
			{
				role: "user",
				content: `SOURCE POSTS:\n${sourceSection}\n\nDRAFT:\n"${postText}"`,
			},
		],
		// 1200: reasoning models spend tokens thinking before the JSON verdict; 500 was
		// enough for non-reasoning models but cut reasoning models off before any output.
		1200,
		0,
	);

	const result = parseFactCheckResponse(raw);
	if (!result) {
		logger.warn("Fact-check response unparseable, failing closed", {
			responsePreview: raw.slice(0, 200),
		});
		return {
			grounded: false,
			violations: ["fact-check response was unparseable"],
		};
	}

	return result;
}

/** Correction message appended to the generation conversation after a rejected draft. */
export function buildRegenerationFeedback(violations: string[]): string {
	const list = violations.map((v) => `- ${v}`).join("\n");
	return `Your draft was REJECTED by a fact check. These claims are not supported by the source posts and may be false:\n${list}\n\nWrite a NEW post. Do not restate any of the rejected claims, even hedged. Either pick a different angle from the source posts, or frame the topic purely as your own opinion or question with zero specific factual claims about named brands, products, prices, or events.`;
}

/**
 * Feedback for the FINAL attempt: constraints under which a draft cannot contain
 * an ungroundable claim, so the slot still gets a post instead of being skipped.
 */
export function buildSafeModeFeedback(violations: string[]): string {
	const list = violations.map((v) => `- ${v}`).join("\n");
	return `Your draft was REJECTED again by the fact check:\n${list}\n\nFINAL ATTEMPT — write in SAFE MODE. Hard constraints:\n- ZERO numbers of any kind. No prices, percentages, rates, fees, counts, or dates.\n- ZERO claims about what any company, product, or service did, offers, charges, launched, or changed.\n- No comparisons between named services ("X is cheaper than Y").\n- Frame everything as your own feeling, question, or observation about the general topic ("gue ngerasa", "gue penasaran", "kayaknya", "kok makin...").\n- A named brand may appear ONLY as the subject of an open question or opinion that asserts no fact about it.\nAll voice and format rules from the system prompt still apply.`;
}

/**
 * Generate a post and gate it through the grounding check.
 * On rejection, feeds the violations back and regenerates; the last retry runs in
 * safe mode (no numbers, no brand claims) so a skipped slot is the rare exception.
 * Returns text: null when all attempts fail — better no post than a fabricated one.
 */
export async function generateGroundedPost(
	messages: ChatMessage[],
	sourcePosts: ThreadsPost[],
	chatFn: ChatFn,
	maxAttempts = MAX_GROUNDING_ATTEMPTS,
): Promise<GroundedPostResult> {
	const conversation = [...messages];
	let lastViolations: string[] = [];

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		// Snapshot per call — callers must not observe later mutations of the conversation.
		const draft = await chatFn([...conversation]);
		const verdict = await verifyPostGrounding(draft, sourcePosts, chatFn);

		if (verdict.grounded) {
			logger.info("Draft passed fact grounding check", { attempt });
			return { text: draft, attempts: attempt, violations: [] };
		}

		lastViolations = verdict.violations;
		logger.warn("Draft failed fact grounding check", {
			attempt,
			maxAttempts,
			violations: verdict.violations,
		});

		const nextAttemptIsLast = attempt === maxAttempts - 1;
		conversation.push({ role: "assistant", content: draft });
		conversation.push({
			role: "user",
			content: nextAttemptIsLast
				? buildSafeModeFeedback(verdict.violations)
				: buildRegenerationFeedback(verdict.violations),
		});
	}

	return { text: null, attempts: maxAttempts, violations: lastViolations };
}
