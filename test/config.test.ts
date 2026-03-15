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
  'SEARCH_QUERIES',
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
    expect(config.searchQueries).toEqual(['viral', 'tech', 'AI', 'trending']);
  });
});
