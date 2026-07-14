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

function parseTopicList(value: string): string[] {
  const seen = new Set<string>();

  return value
    .split(',')
    .map((topic) => topic.trim())
    .filter((topic) => {
      const key = topic.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function parsePositiveInt(val: string, key: string): number {
  const parsed = Number.parseInt(val, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConfigError(`${key} must be a positive integer`);
  }
  return parsed;
}

// 7 = one lead bucket per weekday, so day-of-week rotation gives a distinct
// leading theme every day when enough queries exist.
const DEFAULT_BUCKET_COUNT = 7;

/**
 * Split a flat query list into N themed buckets by round-robin. Deterministic:
 * same input always yields the same buckets. Used as the fallback catalog when
 * CATEGORY_QUERIES is not provided, so flat SEARCH_QUERIES deployments still rotate.
 */
function deriveCategoryQueries(
  searchQueries: string[],
  bucketCount = DEFAULT_BUCKET_COUNT,
): Record<string, string[]> {
  const count = Math.min(bucketCount, searchQueries.length) || 1;
  const buckets: Record<string, string[]> = {};
  // Zero-pad the index so lexical key sorting (used during rotation) stays
  // numerically correct past 9 buckets (group-02 < group-10).
  const pad = String(count).length;
  for (let i = 0; i < count; i++) {
    buckets[`group-${String(i + 1).padStart(pad, '0')}`] = [];
  }
  const keys = Object.keys(buckets);
  searchQueries.forEach((query, index) => {
    const key = keys[index % count];
    if (key) buckets[key]!.push(query);
  });
  return buckets;
}

/**
 * Parse the optional CATEGORY_QUERIES env. Expected JSON shape:
 * {"tech":["ngoding","developer"],"bisnis":["startup","UMKM"]}.
 * Throws ConfigError on malformed JSON or wrong shape so config fails fast at startup.
 */
function parseCategoryQueries(raw: string): Record<string, string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      'CATEGORY_QUERIES must be valid JSON, e.g. {"tech":["ngoding"],"bisnis":["startup"]}',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('CATEGORY_QUERIES must be a JSON object mapping bucket names to query arrays');
  }

  const result: Record<string, string[]> = {};
  for (const [bucket, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      throw new ConfigError(`CATEGORY_QUERIES bucket "${bucket}" must be an array of strings`);
    }
    const queries = value
      .map((q) => (typeof q === 'string' ? q.trim() : ''))
      .filter(Boolean);
    if (queries.length > 0) result[bucket] = queries;
  }

  if (Object.keys(result).length === 0) {
    throw new ConfigError('CATEGORY_QUERIES must contain at least one bucket with at least one query');
  }
  return result;
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
  /** Chat-completions base URL. Defaults to OpenRouter; set LLM_BASE_URL to point at a self-hosted/OpenAI-compatible endpoint (e.g. 9router). */
  llmBaseUrl: string;

  searchQueries: string[];
  /**
   * Themed query buckets used for day-of-week rotation. When CATEGORY_QUERIES is
   * unset, this is derived from searchQueries so existing flat-config deployments
   * keep working and gain rotation for free.
   */
  categoryQueries: Record<string, string[]>;
  minSourcePosts: number;
  minSourceQueries: number;
  maxSourcePostsPerQuery: number;
  postTimes: string[]; // e.g. ['12:15', '19:30']
  timezone: string;

  unsplashAccessKey: string | undefined;
  authorContext: string;
  /** Topics this personal account must never source or publish. */
  excludedTopics: string[];
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

  // LLM_BASE_URL declares a self-hosted endpoint — silently falling back to an
  // OpenRouter-namespaced model ID there fails opaquely at request time instead
  // of at config load, so require the pairing explicitly.
  if (process.env['LLM_BASE_URL'] && !process.env['LLM_MODEL']) {
    throw new ConfigError('LLM_MODEL is required when LLM_BASE_URL is set (the OpenRouter default model will not exist on a self-hosted endpoint)');
  }

  _config = {
    ...authConfig,

    openrouterApiKey:  process.env['LLM_API_KEY'] || requireEnv('OPENROUTER_API_KEY'),
    openrouterModel:   process.env['LLM_MODEL'] || optionalEnv('OPENROUTER_MODEL', 'anthropic/claude-opus-4-6'),
    llmBaseUrl:        optionalEnv('LLM_BASE_URL', 'https://openrouter.ai/api/v1'),

    searchQueries: optionalEnv(
      'SEARCH_QUERIES',
      'trending,viral,lagi rame,Indonesia,startup,bisnis,career,creator,web3,tech,DeFi,hackathon,solidity,gaming blockchain,freelance developer,remote work,gaji developer,open source,AI tools,crypto trading,kuliner Jakarta,makanan viral,food recommendation',
    )
      .split(',')
      .map((q) => q.trim())
      .filter(Boolean),

    categoryQueries: {}, // populated after searchQueries validation below

    minSourcePosts: parsePositiveInt(optionalEnv('MIN_SOURCE_POSTS', '10'), 'MIN_SOURCE_POSTS'),
    minSourceQueries: parsePositiveInt(optionalEnv('MIN_SOURCE_QUERIES', '3'), 'MIN_SOURCE_QUERIES'),
    maxSourcePostsPerQuery: parsePositiveInt(
      optionalEnv('MAX_SOURCE_POSTS_PER_QUERY', '4'),
      'MAX_SOURCE_POSTS_PER_QUERY',
    ),

    postTimes: optionalEnv('POST_TIMES', '12:15,19:30')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),

    timezone: optionalEnv('TIMEZONE', 'Asia/Jakarta'),

    unsplashAccessKey: process.env['UNSPLASH_ACCESS_KEY'] || undefined,
    authorContext: optionalEnv('AUTHOR_CONTEXT', ''),
    excludedTopics: parseTopicList(optionalEnv('EXCLUDED_TOPICS', 'Arbitrum')),
    dryRun: parseBool(optionalEnv('DRY_RUN', 'false')),
  };

  if (_config.searchQueries.length === 0) {
    throw new ConfigError('SEARCH_QUERIES must contain at least one term');
  }

  const rawCategoryQueries = process.env['CATEGORY_QUERIES'];
  _config.categoryQueries = rawCategoryQueries
    ? parseCategoryQueries(rawCategoryQueries)
    : deriveCategoryQueries(_config.searchQueries);

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
