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

export class OpenRouterClient {
  constructor(private readonly config: Config) {}

  async chat(messages: ChatMessage[], maxTokens = 600, temperature = 0.85): Promise<string> {
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

    const data = (await res.json()) as ChatResponse;
    if (!data.choices.length) {
      throw new Error('OpenRouter returned no choices');
    }

    const content = data.choices[0]?.message?.content;
    if (!content) {
      throw new Error('OpenRouter returned empty content');
    }

    logger.debug('OpenRouter response', {
      model: this.config.openrouterModel,
      tokens: data.usage?.total_tokens,
    });

    return content.trim();
  }
}
