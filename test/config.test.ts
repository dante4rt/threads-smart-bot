import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearConfig, getAuthConfig, getConfig } from '../src/config.js';

const ENV_KEYS = [
  'THREADS_APP_ID',
  'THREADS_APP_SECRET',
  'THREADS_USER_ID',
  'THREADS_ACCESS_TOKEN',
  'THREADS_REDIRECT_URI',
  'DB_PATH',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'SEARCH_QUERIES',
  'CATEGORY_QUERIES',
  'EXCLUDED_TOPICS',
  'MIN_SOURCE_POSTS',
  'MIN_SOURCE_QUERIES',
  'MAX_SOURCE_POSTS_PER_QUERY',
  'POST_TIMES',
  'TIMEZONE',
  'UNSPLASH_ACCESS_KEY',
  'DRY_RUN',
] as const;

const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function resetRelevantEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

beforeEach(() => {
  resetRelevantEnv();
  clearConfig();
});

afterEach(() => {
  resetRelevantEnv();
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
  clearConfig();
});

describe('getAuthConfig', () => {
  it('does not require runtime-only env vars', () => {
    process.env.THREADS_APP_ID = 'app-id';
    process.env.THREADS_APP_SECRET = 'app-secret';
    process.env.THREADS_REDIRECT_URI = 'https://localhost/callback';

    const config = getAuthConfig();

    expect(config.threadsAppId).toBe('app-id');
    expect(config.threadsAppSecret).toBe('app-secret');
    expect(config.threadsUserId).toBeUndefined();
    expect(config.dbPath).toBe('data/state.db');
  });
});

describe('getConfig', () => {
  it('allows THREADS_USER_ID to be omitted after auth bootstrap', () => {
    process.env.THREADS_APP_ID = 'app-id';
    process.env.THREADS_APP_SECRET = 'app-secret';
    process.env.OPENROUTER_API_KEY = 'or-key';

    const config = getConfig();

    expect(config.threadsUserId).toBeUndefined();
    expect(config.openrouterApiKey).toBe('or-key');
    expect(config.searchQueries).toEqual([
      'trending',
      'viral',
      'lagi rame',
      'Indonesia',
      'startup',
      'bisnis',
      'career',
      'creator',
      'web3',
      'tech',
      'DeFi',
      'hackathon',
      'solidity',
      'gaming blockchain',
      'freelance developer',
      'remote work',
      'gaji developer',
      'open source',
      'AI tools',
      'crypto trading',
      'kuliner Jakarta',
      'makanan viral',
      'food recommendation',
    ]);
    expect(config.minSourcePosts).toBe(10);
    expect(config.minSourceQueries).toBe(3);
    expect(config.maxSourcePostsPerQuery).toBe(4);
    expect(config.excludedTopics).toEqual(['Arbitrum']);
  });

  it('parses account-level excluded topics', () => {
    process.env.THREADS_APP_ID = 'app-id';
    process.env.THREADS_APP_SECRET = 'app-secret';
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.EXCLUDED_TOPICS = 'Arbitrum, crypto trading, arbitrum';

    expect(getConfig().excludedTopics).toEqual(['Arbitrum', 'crypto trading']);
  });

  it('derives category buckets from SEARCH_QUERIES when CATEGORY_QUERIES is unset', () => {
    process.env.THREADS_APP_ID = 'app-id';
    process.env.THREADS_APP_SECRET = 'app-secret';
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.SEARCH_QUERIES = 'a,b,c,d,e,f,g,h';

    const config = getConfig();
    const buckets = Object.values(config.categoryQueries);

    // 8 queries spread across the default 7 buckets, round-robin, no query lost.
    expect(Object.keys(config.categoryQueries).length).toBe(7);
    expect(buckets.flat().sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  it('uses CATEGORY_QUERIES verbatim when provided', () => {
    process.env.THREADS_APP_ID = 'app-id';
    process.env.THREADS_APP_SECRET = 'app-secret';
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.CATEGORY_QUERIES = JSON.stringify({
      tech: ['ngoding', 'developer'],
      bisnis: ['startup'],
    });

    const config = getConfig();

    expect(config.categoryQueries).toEqual({
      tech: ['ngoding', 'developer'],
      bisnis: ['startup'],
    });
  });

  it('rejects malformed CATEGORY_QUERIES JSON', () => {
    process.env.THREADS_APP_ID = 'app-id';
    process.env.THREADS_APP_SECRET = 'app-secret';
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.CATEGORY_QUERIES = '{not json}';

    expect(() => getConfig()).toThrow(/CATEGORY_QUERIES must be valid JSON/);
  });

  it('defaults llmBaseUrl to OpenRouter when LLM_BASE_URL is unset', () => {
    process.env.THREADS_APP_ID = 'app-id';
    process.env.THREADS_APP_SECRET = 'app-secret';
    process.env.OPENROUTER_API_KEY = 'or-key';

    expect(getConfig().llmBaseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('uses LLM_BASE_URL/LLM_API_KEY/LLM_MODEL to point at a self-hosted endpoint', () => {
    process.env.THREADS_APP_ID = 'app-id';
    process.env.THREADS_APP_SECRET = 'app-secret';
    process.env.LLM_BASE_URL = 'http://bablalbal/v1';
    process.env.LLM_API_KEY = 'nine-router-key';
    process.env.LLM_MODEL = 'nine-router-model';

    const config = getConfig();

    expect(config.llmBaseUrl).toBe('http://bablalbal/v1');
    expect(config.openrouterApiKey).toBe('nine-router-key');
    expect(config.openrouterModel).toBe('nine-router-model');
  });

  it('does not require OPENROUTER_API_KEY when LLM_API_KEY is set', () => {
    process.env.THREADS_APP_ID = 'app-id';
    process.env.THREADS_APP_SECRET = 'app-secret';
    process.env.LLM_API_KEY = 'nine-router-key';
    process.env.LLM_MODEL = 'nine-router-model';

    expect(() => getConfig()).not.toThrow();
  });

  it('requires LLM_MODEL when LLM_BASE_URL is set, to avoid an opaque model-not-found at request time', () => {
    process.env.THREADS_APP_ID = 'app-id';
    process.env.THREADS_APP_SECRET = 'app-secret';
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.LLM_BASE_URL = 'http://bablalbal/v1';

    expect(() => getConfig()).toThrow(/LLM_MODEL is required when LLM_BASE_URL is set/);
  });

  it('parses crawl thresholds when provided', () => {
    process.env.THREADS_APP_ID = 'app-id';
    process.env.THREADS_APP_SECRET = 'app-secret';
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.MIN_SOURCE_POSTS = '12';
    process.env.MIN_SOURCE_QUERIES = '4';
    process.env.MAX_SOURCE_POSTS_PER_QUERY = '2';

    const config = getConfig();

    expect(config.minSourcePosts).toBe(12);
    expect(config.minSourceQueries).toBe(4);
    expect(config.maxSourcePostsPerQuery).toBe(2);
  });
});
