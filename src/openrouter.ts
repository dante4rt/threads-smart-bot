// src/openrouter.ts — OpenRouter API client

import { TransientError } from './errors.js';
import { logger } from './logger.js';
import type { Config } from './config.js';

/**
 * Normalize a configured base URL to end in "/chat/completions", tolerating
 * both "http://host" and "http://host/v1" input (mirrors 9router client convention).
 */
function resolveChatCompletionsUrl(baseUrl: string): string {
  let base = baseUrl.replace(/\/+$/, '');
  base = base.replace(/\/v1$/, '');
  return `${base}/v1/chat/completions`;
}

/**
 * Extract the first balanced top-level {...} object from raw text, respecting
 * braces inside JSON strings. A greedy regex (first "{" to last "}") breaks when
 * trailing prose itself contains braces (reasoning models echo "{key: value}"
 * style examples constantly) — this walks brace depth instead.
 */
function extractLeadingJsonObject(raw: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"' && depth > 0) {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return raw.slice(start, i + 1);
      }
    }
  }

  return null;
}

/**
 * Some self-hosted endpoints (9router fronting reasoning models like deepseek,
 * claude-thinking) emit valid JSON followed by trailing prose instead of a clean
 * body — the built-in JSON parser throws "Unexpected non-whitespace character
 * after JSON" on that shape. Read as text once, try a direct parse, then fall
 * back to the leading balanced {...} object in the text.
 */
export function parseChatResponseBody(raw: string): ChatResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const candidate = extractLeadingJsonObject(raw);
    if (!candidate) {
      throw new Error(
        `OpenRouter response had no JSON object to parse: ${raw.slice(0, 200)}`,
      );
    }
    try {
      parsed = JSON.parse(candidate);
    } catch {
      throw new Error(
        `OpenRouter response's leading {...} block was not valid JSON: ${candidate.slice(0, 200)}`,
      );
    }
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { choices?: unknown }).choices)
  ) {
    const errorMessage = (parsed as { error?: { message?: string } })?.error?.message;
    throw new Error(
      errorMessage
        ? `OpenRouter response has no choices array (gateway error: ${errorMessage})`
        : `OpenRouter response has no choices array: ${JSON.stringify(parsed).slice(0, 200)}`,
    );
  }

  return parsed as ChatResponse;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** A reasoning model that burns its whole budget thinking returns empty content with this reason. */
export class TruncatedCompletionError extends Error {}

/** Extra budget attempts after the first, each doubling. Bounded so a model that never finishes fails fast. */
const MAX_BUDGET_ESCALATIONS = 2;
const MAX_TOKEN_BUDGET = 32000;

export class OpenRouterClient {
  constructor(private readonly config: Config) {}

  /**
   * Retries internally on finish_reason=length with a doubled budget — withRetry
   * would resend the identical budget and fail identically three times.
   */
  async chat(
    messages: ChatMessage[],
    maxTokens = this.config.llmMaxTokens,
    temperature = 0.85,
  ): Promise<string> {
    let budget = Math.min(maxTokens, MAX_TOKEN_BUDGET);

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.request(messages, budget, temperature);
      } catch (err) {
        const canEscalate =
          err instanceof TruncatedCompletionError &&
          attempt < MAX_BUDGET_ESCALATIONS &&
          budget < MAX_TOKEN_BUDGET;
        if (!canEscalate) throw err;

        const nextBudget = Math.min(budget * 2, MAX_TOKEN_BUDGET);
        logger.warn('Completion truncated before any output, raising token budget', {
          model: this.config.openrouterModel,
          fromMaxTokens: budget,
          toMaxTokens: nextBudget,
        });
        budget = nextBudget;
      }
    }
  }

  private async request(
    messages: ChatMessage[],
    maxTokens: number,
    temperature: number,
  ): Promise<string> {
    let res: Response;
    try {
      res = await fetch(resolveChatCompletionsUrl(this.config.llmBaseUrl), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.openrouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/dante4rt/threads-smart-bot',
          'X-Title': 'Threads Smart Bot',
        },
        body: JSON.stringify({
          model: this.config.openrouterModel,
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
      });
    } catch (err) {
      throw new TransientError(`OpenRouter network error: ${(err as Error).message}`);
    }

    if (res.status === 429) {
      throw new TransientError('OpenRouter rate limit hit', 429);
    }
    if (res.status >= 500) {
      throw new TransientError(`OpenRouter server error ${res.status}`, res.status);
    }
    if (!res.ok) {
      throw new Error(`OpenRouter API error ${res.status}`);
    }

    const rawBody = await res.text();
    const data = parseChatResponseBody(rawBody);
    if (!data.choices.length) {
      throw new Error('OpenRouter returned no choices');
    }

    const content = data.choices[0]?.message?.content;
    if (!content) {
      const finishReason = data.choices[0]?.finish_reason;
      if (finishReason === 'length') {
        throw new TruncatedCompletionError(
          `OpenRouter returned empty content (finish_reason=length at max_tokens=${maxTokens} — the model ran out of budget mid-reasoning)`,
        );
      }
      throw new Error(
        `OpenRouter returned empty content${finishReason ? ` (finish_reason=${finishReason})` : ''}`,
      );
    }

    logger.debug('OpenRouter response', {
      model: this.config.openrouterModel,
      tokens: data.usage?.total_tokens,
    });

    return content.trim();
  }
}
