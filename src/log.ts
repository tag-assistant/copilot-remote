// Copilot Remote — leveled logger
export const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  verbose: 3,
  debug: 4,
  silent: 99,
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;

const DEFAULT_LEVEL: LogLevel = 'info';
const DEBUG_LEVEL: LogLevel = 'debug';

function ts(): string {
  const d = new Date();
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function normalizeLogLevel(value: unknown): LogLevel | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'trace') return 'debug';
  if (normalized === 'notice') return 'info';
  if (normalized === 'none' || normalized === 'off') return 'silent';
  return normalized in LOG_LEVELS ? normalized as LogLevel : null;
}

function resolveInitialLevel(): LogLevel {
  const envLevel = normalizeLogLevel(process.env.COPILOT_REMOTE_LOG_LEVEL);
  if (envLevel) return envLevel;
  if (process.env.COPILOT_REMOTE_DEBUG === '1') return DEBUG_LEVEL;
  return DEFAULT_LEVEL;
}

let currentLevel: LogLevel = resolveInitialLevel();

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] <= LOG_LEVELS[currentLevel];
}

function emit(level: Exclude<LogLevel, 'silent'>, args: unknown[]): void {
  if (!shouldLog(level)) return;
  const tag = `[${level.toUpperCase()}]`;
  if (level === 'error') {
    console.error(ts(), tag, ...args);
    return;
  }
  if (level === 'warn') {
    console.warn(ts(), tag, ...args);
    return;
  }
  console.log(ts(), tag, ...args);
}

export const log = {
  error: (...args: unknown[]) => emit('error', args),
  warn: (...args: unknown[]) => emit('warn', args),
  info: (...args: unknown[]) => emit('info', args),
  verbose: (...args: unknown[]) => emit('verbose', args),
  debug: (...args: unknown[]) => emit('debug', args),
  setLevel: (level: unknown): LogLevel => {
    const normalized = normalizeLogLevel(level);
    if (normalized) currentLevel = normalized;
    return currentLevel;
  },
  getLevel: (): LogLevel => currentLevel,
  shouldLog: (level: LogLevel): boolean => shouldLog(level),
  setDebug: (on: boolean): LogLevel => {
    currentLevel = on ? DEBUG_LEVEL : DEFAULT_LEVEL;
    return currentLevel;
  },
  isDebug: (): boolean => shouldLog('debug'),
};

export { normalizeLogLevel };
