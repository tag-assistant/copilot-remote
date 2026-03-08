// Copilot Remote — Debug Logger
const DEBUG = process.env.COPILOT_REMOTE_DEBUG === '1';

export const log = {
  info: (...args: unknown[]) => console.log(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => {
    if (DEBUG) console.log('[DEBUG]', ...args);
  },
};
