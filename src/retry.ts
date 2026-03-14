// src/retry.ts — exponential backoff retry with typed error classification

import { AuthError, RateLimitError, TransientError } from './errors.js';
import { logger } from './logger.js';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  /** Do not retry these error types (re-throw immediately) */
  noRetry?: Array<new (...args: never[]) => Error>;
}

const DEFAULT_OPTS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  noRetry: [AuthError, RateLimitError],
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNoRetry(err: unknown, noRetry: Array<new (...args: never[]) => Error>): boolean {
  return noRetry.some((Cls) => err instanceof Cls);
}

/**
 * Retry fn up to maxAttempts times on TransientError (or any generic Error
 * not in the noRetry list).  AuthError and RateLimitError are never retried.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const { maxAttempts, baseDelayMs, noRetry = [] } = { ...DEFAULT_OPTS, ...opts };
  const skipList = [...(DEFAULT_OPTS.noRetry ?? []), ...noRetry];

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (isNoRetry(err, skipList)) {
        throw err;
      }

      // Only retry on TransientError or generic network-ish errors
      const isTransient =
        err instanceof TransientError ||
        (err instanceof Error && !(err instanceof AuthError) && !(err instanceof RateLimitError));

      if (!isTransient || attempt === maxAttempts) {
        throw err;
      }

      const backoff = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn('Transient error, retrying', {
        attempt,
        maxAttempts,
        backoffMs: backoff,
        error: err instanceof Error ? err.message : String(err),
      });

      await delay(backoff);
    }
  }

  throw lastError;
}
