// src/config.ts — env loading and validation

import { ConfigError } from './errors.js';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new ConfigError(`Missing required environment variable: ${key}`);
  return val;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function parseBool(val: string): boolean {
  return val.toLowerCase() === 'true' || val === '1';
}

export interface Config {
  threadsAppId: string;
  threadsAppSecret: string;
  threadsUserId?: string;
  threadsAccessToken: string | undefined; // only needed on very first run before auth
  threadsRedirectUri: string;
  dbPath: string;

  openrouterApiKey: string;
  openrouterModel: string;

  searchQueries: string[];
  postTimes: string[]; // e.g. ['09:00', '17:00']
  timezone: string;

  unsplashAccessKey: string | undefined;
  dryRun: boolean;
}

export interface AuthConfig {
  threadsAppId: string;
  threadsAppSecret: string;
  threadsUserId?: string;
  threadsAccessToken: string | undefined;
  threadsRedirectUri: string;
  dbPath: string;
}

let _config: Config | undefined;
let _authConfig: AuthConfig | undefined;

/**
 * Load only the env needed for Threads auth/bootstrap.
 */
export function getAuthConfig(): AuthConfig {
  if (_authConfig) return _authConfig;

  _authConfig = {
    threadsAppId:       requireEnv('THREADS_APP_ID'),
    threadsAppSecret:   requireEnv('THREADS_APP_SECRET'),
    threadsUserId:      process.env['THREADS_USER_ID'],
    threadsAccessToken: process.env['THREADS_ACCESS_TOKEN'],
    threadsRedirectUri: optionalEnv('THREADS_REDIRECT_URI', 'https://localhost/callback'),
    dbPath:             optionalEnv('DB_PATH', 'data/state.db'),
  };

  return _authConfig;
}

/**
 * Load and validate config from environment variables.
 * Cached after first call.
 */
export function getConfig(): Config {
  if (_config) return _config;

  const authConfig = getAuthConfig();

  _config = {
    ...authConfig,

    openrouterApiKey:  requireEnv('OPENROUTER_API_KEY'),
    openrouterModel:   optionalEnv('OPENROUTER_MODEL', 'anthropic/claude-opus-4-6'),

    searchQueries: optionalEnv('SEARCH_QUERIES', 'viral,tech,AI,trending')
      .split(',')
      .map((q) => q.trim())
      .filter(Boolean),

    postTimes: optionalEnv('POST_TIMES', '09:00,17:00')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),

    timezone: optionalEnv('TIMEZONE', 'Asia/Jakarta'),

    unsplashAccessKey: process.env['UNSPLASH_ACCESS_KEY'] || undefined,
    dryRun: parseBool(optionalEnv('DRY_RUN', 'false')),
  };

  if (_config.searchQueries.length === 0) {
    throw new ConfigError('SEARCH_QUERIES must contain at least one term');
  }

  return _config;
}

/**
 * Override config (used in tests).
 */
export function setConfig(cfg: Config): void {
  _authConfig = {
    threadsAppId: cfg.threadsAppId,
    threadsAppSecret: cfg.threadsAppSecret,
    threadsUserId: cfg.threadsUserId,
    threadsAccessToken: cfg.threadsAccessToken,
    threadsRedirectUri: cfg.threadsRedirectUri,
    dbPath: cfg.dbPath,
  };
  _config = cfg;
}

export function clearConfig(): void {
  _authConfig = undefined;
  _config = undefined;
}
