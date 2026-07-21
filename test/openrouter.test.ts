// test/openrouter.test.ts

import { describe, expect, it } from 'vitest';
import { parseChatResponseBody } from '../src/openrouter.js';

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
