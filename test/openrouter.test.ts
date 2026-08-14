// test/openrouter.test.ts

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClient, TruncatedCompletionError, parseChatResponseBody } from '../src/openrouter.js';
import type { Config } from '../src/config.js';

const cleanBody = JSON.stringify({
  id: 'gen-1',
  choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
});

describe('parseChatResponseBody', () => {
  it('parses a clean JSON body', () => {
    expect(parseChatResponseBody(cleanBody).choices[0]?.message.content).toBe('hi');
  });

  it('parses JSON followed by brace-free trailing prose', () => {
    const raw = `${cleanBody}\n\nHope that helps!`;
    expect(parseChatResponseBody(raw).choices[0]?.message.content).toBe('hi');
  });

  it('parses JSON followed by trailing prose that itself contains braces', () => {
    // Regression case: a greedy "first { to last }" regex grabs through the
    // brace in the trailing note and produces an unparseable span. A reasoning
    // model echoing a formatting example in its trailing chatter triggers this.
    const raw = `${cleanBody}\n\nNote: I formatted it as {key: value}.`;
    expect(parseChatResponseBody(raw).choices[0]?.message.content).toBe('hi');
  });

  it('preserves braces and escaped quotes inside string values, and handles nested objects', () => {
    const trickyBody = JSON.stringify({
      id: 'gen-2',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'use {this} format, she said \\"like {so}\\"',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    const raw = `${trickyBody}\n\nNote: another {example} here.`;
    const result = parseChatResponseBody(raw);
    expect(result.choices[0]?.message.content).toBe(
      'use {this} format, she said \\"like {so}\\"',
    );
    expect(result.usage?.total_tokens).toBe(3);
  });

  it('throws with the gateway error message when choices is missing', () => {
    const raw = JSON.stringify({ error: { message: 'model overloaded' } });
    expect(() => parseChatResponseBody(raw)).toThrow(/model overloaded/);
  });

  it('throws when the body has no JSON object at all', () => {
    expect(() => parseChatResponseBody('<html>502 Bad Gateway</html>')).toThrow(
      /no JSON object to parse/,
    );
  });
});

const testConfig = {
  openrouterApiKey: 'k',
  openrouterModel: 'test/reasoner',
  llmBaseUrl: 'http://localhost:1234/v1',
  llmMaxTokens: 1000,
} as Config;

function respond(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
}

const truncated = respond({
  id: 'gen-1',
  choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
});

function requestedMaxTokens(call: unknown[]): number {
  return JSON.parse((call[1] as { body: string }).body).max_tokens;
}

describe('OpenRouterClient.chat budget escalation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries with a doubled budget when the model is truncated before any output', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(truncated)
      .mockResolvedValueOnce(
        respond({
          id: 'gen-2',
          choices: [{ message: { role: 'assistant', content: 'final post' }, finish_reason: 'stop' }],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(new OpenRouterClient(testConfig).chat([{ role: 'user', content: 'hi' }])).resolves.toBe(
      'final post',
    );
    expect(requestedMaxTokens(fetchMock.mock.calls[0])).toBe(1000);
    expect(requestedMaxTokens(fetchMock.mock.calls[1])).toBe(2000);
  });

  it('gives up after bounded escalations instead of looping', async () => {
    const fetchMock = vi.fn().mockResolvedValue(truncated);
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new OpenRouterClient(testConfig).chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(TruncatedCompletionError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not escalate when the failure is not a budget truncation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      respond({
        id: 'gen-3',
        choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new OpenRouterClient(testConfig).chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/content_filter/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
