import { describe, expect, it } from 'vitest';
import { getSignalExitCode } from '../src/shutdown.js';

describe('getSignalExitCode', () => {
  it('returns the conventional exit code when SIGTERM stops the bot', () => {
    expect(getSignalExitCode('SIGTERM')).toBe(143);
  });

  it('returns the conventional exit code when SIGINT stops the bot', () => {
    expect(getSignalExitCode('SIGINT')).toBe(130);
  });
});
