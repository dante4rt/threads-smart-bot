// test/config.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig, resetConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

const REQUIRED = {
  THREADS_APP_ID: 'app-id',
  THREADS_APP_SECRET: 'app-secret',
  OPENROUTER_API_KEY: 'or-key',
};

const ORIGINAL = { ...process.env };

function withEnv(overrides: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('THREADS_') || key.startsWith('OPENROUTER_') || key.startsWith('LLM_') || key.startsWith('JEV_') || key === 'TYPESAFE_API_KEY') {
      delete process.env[key];
    }
  }
  for (const key of [
    'TIMEZONE', 'TOPIC_TAGS', 'DEFAULT_TOPIC_TAG', 'POST_TIMES',
    'SEARCH_QUERIES', 'CATEGORY_QUERIES', 'EXCLUDED_TOPICS',
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, REQUIRED, overrides);
  resetConfig();
}

beforeEach(() => resetConfig());

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL);
  resetConfig();
});

describe('TIMEZONE validation', () => {
  it('accepts a valid IANA zone', () => {
    withEnv({ TIMEZONE: 'Asia/Jakarta' });
    expect(getConfig().timezone).toBe('Asia/Jakarta');
  });

  it('rejects a non-zone before it can reach node-cron or Intl', () => {
    // The real-world shape: TIMEZONE and the next var collapsed onto one line.
    withEnv({ TIMEZONE: 'Asia/Jakarta, AUTHOR_CONTEXT=I build things' });
    expect(() => getConfig()).toThrow(ConfigError);
    expect(() => getConfig()).toThrow(/not a valid IANA time zone/);
  });
});

describe('JEV configuration', () => {
  it('uses the existing flow when the API key is absent', () => {
    withEnv({});
    expect(getConfig().jevEnabled).toBe(false);
    expect(getConfig().typesafeApiKey).toBeUndefined();
  });

  it('automatically enables the gate when the key is set', () => {
    withEnv({ TYPESAFE_API_KEY: 'typesafe-key' });
    expect(getConfig().jevEnabled).toBe(true);
  });

  it('requires an API key when the gate is explicitly enabled', () => {
    withEnv({ JEV_ENABLED: 'true' });
    expect(() => getConfig()).toThrow(/TYPESAFE_API_KEY is required/);
  });

  it('allows an explicit bypass without a TypeSafe key', () => {
    withEnv({ JEV_ENABLED: 'false', TYPESAFE_API_KEY: 'typesafe-key' });
    expect(getConfig().jevEnabled).toBe(false);
  });

  it('validates the threshold and enabled flag', () => {
    withEnv({ JEV_MIN_SCORE: '1.2' });
    expect(() => getConfig()).toThrow(/JEV_MIN_SCORE/);
    withEnv({ JEV_ENABLED: 'tru' });
    expect(() => getConfig()).toThrow(/JEV_ENABLED/);
  });
});

describe('TOPIC_TAGS validation', () => {
  it('parses a well-formed mapping', () => {
    withEnv({ TOPIC_TAGS: '{"tech":"Tech Threads","karir":"Karir"}' });
    expect(getConfig().topicTags).toEqual({ tech: 'Tech Threads', karir: 'Karir' });
  });

  it('defaults to an empty mapping when unset', () => {
    withEnv({});
    expect(getConfig().topicTags).toEqual({});
    expect(getConfig().defaultTopicTag).toBe('');
  });

  it('rejects malformed JSON', () => {
    withEnv({ TOPIC_TAGS: '{tech:' });
    expect(() => getConfig()).toThrow(/must be valid JSON/);
  });

  it('rejects a JSON array', () => {
    withEnv({ TOPIC_TAGS: '["tech"]' });
    expect(() => getConfig()).toThrow(/must be a JSON object/);
  });

  it('rejects a non-string tag value', () => {
    withEnv({ TOPIC_TAGS: '{"tech":42}' });
    expect(() => getConfig()).toThrow(/must be a string/);
  });

  it('rejects an empty tag', () => {
    withEnv({ TOPIC_TAGS: '{"tech":"   "}' });
    expect(() => getConfig()).toThrow(/must not be empty/);
  });

  it('rejects a tag over the API 50-character limit', () => {
    withEnv({ TOPIC_TAGS: `{"tech":"${'a'.repeat(51)}"}` });
    expect(() => getConfig()).toThrow(/1-50 characters/);
  });

  it('accepts a tag at exactly the 50-character limit', () => {
    withEnv({ TOPIC_TAGS: `{"tech":"${'a'.repeat(50)}"}` });
    expect(getConfig().topicTags['tech']).toHaveLength(50);
  });

  it.each(['Tech.Threads', 'Tech&Threads'])(
    'rejects the API-forbidden character in %s',
    (tag) => {
      withEnv({ TOPIC_TAGS: `{"tech":"${tag}"}` });
      expect(() => getConfig()).toThrow(/must not contain/);
    },
  );

  it('applies the same rules to DEFAULT_TOPIC_TAG', () => {
    withEnv({ DEFAULT_TOPIC_TAG: 'Indo.nesia' });
    expect(() => getConfig()).toThrow(/DEFAULT_TOPIC_TAG must not contain/);
  });
});
