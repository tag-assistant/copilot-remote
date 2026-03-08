// Copilot Remote — Debug Logger
let debugEnabled = process.env.COPILOT_REMOTE_DEBUG === '1';

export const log = {
  info: (...args: unknown[]) => console.log(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => {
    if (debugEnabled) console.log('[DEBUG]', ...args);
  },
  setDebug: (on: boolean) => { debugEnabled = on; },
  isDebug: () => debugEnabled,
};
