// src/shutdown.ts — process shutdown helpers

import { constants } from 'os';

const SIGNAL_EXIT_CODE_OFFSET = 128;

export function getSignalExitCode(signal: NodeJS.Signals): number {
  const signalNumbers = constants.signals as Record<string, number | undefined>;
  const signalNumber = signalNumbers[signal];

  return signalNumber ? SIGNAL_EXIT_CODE_OFFSET + signalNumber : 1;
}
