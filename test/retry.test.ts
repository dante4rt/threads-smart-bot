// test/retry.test.ts

import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../src/retry.js';
import { AuthError, RateLimitError, TransientError } from '../src/errors.js';

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on TransientError and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TransientError('server error'))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new TransientError('always fails'));
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('never retries AuthError', async () => {
    const fn = vi.fn().mockRejectedValue(new AuthError('bad token'));
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toBeInstanceOf(AuthError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never retries RateLimitError', async () => {
    const fn = vi.fn().mockRejectedValue(new RateLimitError());
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toBeInstanceOf(RateLimitError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
