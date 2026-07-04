// test/fact-check.test.ts

import { describe, expect, it, vi } from 'vitest';
import {
  FACT_CHECK_SYSTEM_PROMPT,
  buildRegenerationFeedback,
  generateGroundedPost,
  parseFactCheckResponse,
  verifyPostGrounding,
} from '../src/fact-check.js';
import type { ThreadsPost } from '../src/threads-api.js';
import type { ChatMessage } from '../src/openrouter.js';

const sourcePosts: ThreadsPost[] = [
  { id: '1', text: 'Kopi lokal lagi rame dibahas di Threads' },
  { id: '2', text: 'Harga kopi naik terus tahun ini' },
];

describe('parseFactCheckResponse', () => {
  it('parses a clean grounded verdict', () => {
    expect(parseFactCheckResponse('{"grounded": true, "violations": []}')).toEqual({
      grounded: true,
      violations: [],
    });
  });

  it('parses a violation verdict', () => {
    const result = parseFactCheckResponse(
      '{"grounded": false, "violations": ["Fore bottled coffee at Indomaret not in sources"]}',
    );
    expect(result).toEqual({
      grounded: false,
      violations: ['Fore bottled coffee at Indomaret not in sources'],
    });
  });

  it('tolerates code fences and surrounding prose', () => {
    const raw = 'Here is my verdict:\n```json\n{"grounded": true, "violations": []}\n```';
    expect(parseFactCheckResponse(raw)).toEqual({ grounded: true, violations: [] });
  });

  it('fails closed on inconsistent verdicts (grounded true but violations listed)', () => {
    const result = parseFactCheckResponse(
      '{"grounded": true, "violations": ["invented price"]}',
    );
    expect(result?.grounded).toBe(false);
  });

  it('picks the verdict when the judge emits a reasoning object before it', () => {
    const raw = '{"thought": "checking claims"} {"grounded": true, "violations": []}';
    expect(parseFactCheckResponse(raw)).toEqual({ grounded: true, violations: [] });
  });

  it('takes the last valid verdict when multiple verdicts appear', () => {
    const raw =
      '{"grounded": true, "violations": []} final answer: {"grounded": false, "violations": ["price invented"]}';
    expect(parseFactCheckResponse(raw)).toEqual({
      grounded: false,
      violations: ['price invented'],
    });
  });

  it('handles braces inside JSON string values', () => {
    const raw = '{"grounded": false, "violations": ["claim uses {weird} braces"]}';
    expect(parseFactCheckResponse(raw)).toEqual({
      grounded: false,
      violations: ['claim uses {weird} braces'],
    });
  });

  it('returns null for garbage, wrong shapes, and missing fields', () => {
    expect(parseFactCheckResponse('not json at all')).toBeNull();
    expect(parseFactCheckResponse('{"grounded": "yes", "violations": []}')).toBeNull();
    expect(parseFactCheckResponse('{"grounded": true}')).toBeNull();
    expect(parseFactCheckResponse('{"grounded": true, "violations": [1, 2]}')).toBeNull();
  });
});

describe('verifyPostGrounding', () => {
  it('passes source posts and draft to the judge and returns its verdict', async () => {
    const chatFn = vi.fn(
      async (_messages: ChatMessage[], _maxTokens?: number, _temperature?: number) =>
        '{"grounded": true, "violations": []}',
    );

    const result = await verifyPostGrounding('Kopi lokal emang lagi rame ya', sourcePosts, chatFn);

    expect(result.grounded).toBe(true);
    const [messages, , temperature] = chatFn.mock.calls[0]!;
    expect(messages[0]?.content).toBe(FACT_CHECK_SYSTEM_PROMPT);
    expect(messages[1]?.content).toContain('Kopi lokal lagi rame dibahas');
    expect(messages[1]?.content).toContain('Kopi lokal emang lagi rame ya');
    expect(temperature).toBe(0);
  });

  it('fails closed when the judge response is unparseable', async () => {
    const chatFn = vi.fn(async () => 'sorry, I cannot help with that');

    const result = await verifyPostGrounding('Draft apapun', sourcePosts, chatFn);

    expect(result.grounded).toBe(false);
    expect(result.violations).toHaveLength(1);
  });
});

describe('generateGroundedPost', () => {
  const messages = [
    { role: 'system' as const, content: 'system' },
    { role: 'user' as const, content: 'user' },
  ];

  it('returns the first draft when it passes the grounding check', async () => {
    const chatFn = vi
      .fn()
      .mockResolvedValueOnce('Draft aman soal kopi lokal')
      .mockResolvedValueOnce('{"grounded": true, "violations": []}');

    const result = await generateGroundedPost(messages, sourcePosts, chatFn);

    expect(result.text).toBe('Draft aman soal kopi lokal');
    expect(result.attempts).toBe(1);
    expect(chatFn).toHaveBeenCalledTimes(2);
  });

  it('feeds violations back and returns the regenerated draft when it passes', async () => {
    const chatFn = vi
      .fn()
      .mockResolvedValueOnce('Fore botolan dijual di Indomaret 15rb')
      .mockResolvedValueOnce('{"grounded": false, "violations": ["Fore retail claim not in sources"]}')
      .mockResolvedValueOnce('Harga kopi naik terus, lo ngerasain juga gak?')
      .mockResolvedValueOnce('{"grounded": true, "violations": []}');

    const result = await generateGroundedPost(messages, sourcePosts, chatFn);

    expect(result.text).toBe('Harga kopi naik terus, lo ngerasain juga gak?');
    expect(result.attempts).toBe(2);

    // Regeneration call must carry the rejected draft + the violation feedback.
    const regenMessages = chatFn.mock.calls[2]![0];
    expect(regenMessages).toHaveLength(4);
    expect(regenMessages[2]?.content).toBe('Fore botolan dijual di Indomaret 15rb');
    expect(regenMessages[3]?.content).toContain('Fore retail claim not in sources');
    expect(regenMessages[3]?.content).toContain('REJECTED');
  });

  it('returns null text with violations when every attempt fails', async () => {
    const chatFn = vi
      .fn()
      .mockResolvedValueOnce('Hoax draft 1')
      .mockResolvedValueOnce('{"grounded": false, "violations": ["claim A"]}')
      .mockResolvedValueOnce('Hoax draft 2')
      .mockResolvedValueOnce('{"grounded": false, "violations": ["claim B"]}');

    const result = await generateGroundedPost(messages, sourcePosts, chatFn);

    expect(result.text).toBeNull();
    expect(result.attempts).toBe(2);
    expect(result.violations).toEqual(['claim B']);
  });
});

describe('buildRegenerationFeedback', () => {
  it('lists every violation and forbids restating them', () => {
    const feedback = buildRegenerationFeedback(['claim A', 'claim B']);
    expect(feedback).toContain('- claim A');
    expect(feedback).toContain('- claim B');
    expect(feedback).toMatch(/do not restate/i);
  });
});
