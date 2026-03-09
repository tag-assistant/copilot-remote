import { unwatchFile, watchFile, type Stats } from 'node:fs';
import path from 'node:path';
import type { GlobalConfig } from './config-store.js';
import { CONFIG_FILE } from './config-store.js';

export type SupervisorKind = 'launchd' | 'systemd' | null;

export interface SelfDevelopmentSettings {
  enabled: boolean;
  autoRestart: boolean;
  debounceMs: number;
  watchConfig: boolean;
  watchMcp: boolean;
  watchAgents: boolean;
  watchSkills: boolean;
  watchPrompts: boolean;
}

export interface RestartSignalInfo {
  reason: string;
  changedPath?: string;
}

interface RestartManagerDeps {
  watchFile?: typeof watchFile;
  unwatchFile?: typeof unwatchFile;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export interface RestartManagerOptions extends RestartManagerDeps {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  workDirs?: string[];
  config?: GlobalConfig;
  settings?: Partial<SelfDevelopmentSettings>;
  onRestartRequired?: (info: RestartSignalInfo) => void;
  onRequestRestart?: (info: RestartSignalInfo) => void;
}

const DEFAULT_SETTINGS: SelfDevelopmentSettings = {
  enabled: true,
  autoRestart: true,
  debounceMs: 1500,
  watchConfig: true,
  watchMcp: true,
  watchAgents: true,
  watchSkills: true,
  watchPrompts: true,
};

const AGENT_DIRS = [
  ['.github', 'agents'],
  ['.copilot', 'agents'],
  ['.claude', 'agents'],
] as const;

const PROMPT_DIRS = [
  ['.github', 'prompts'],
] as const;

export function detectSupervisor(env: NodeJS.ProcessEnv = process.env): SupervisorKind {
  if (env.INVOCATION_ID || env.JOURNAL_STREAM || env.NOTIFY_SOCKET || env.SYSTEMD_EXEC_PID) return 'systemd';
  if (env.LAUNCH_JOB_NAME || env.__CFBundleIdentifier) return 'launchd';
  return null;
}

export function resolveSelfDevelopmentSettings(
  config?: GlobalConfig,
  overrides?: Partial<SelfDevelopmentSettings>,
): SelfDevelopmentSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(config?.selfDevelopment ?? {}),
    ...(overrides ?? {}),
  };
}

export function collectWatchTargets(opts: {
  homeDir?: string;
  workDirs?: Iterable<string>;
  config?: GlobalConfig;
  settings?: Partial<SelfDevelopmentSettings>;
}): string[] {
  const homeDir = opts.homeDir ?? process.env.HOME ?? '.';
  const settings = resolveSelfDevelopmentSettings(opts.config, opts.settings);
  const targets = new Set<string>();
  const add = (targetPath: string | undefined) => {
    if (!targetPath) return;
    targets.add(path.resolve(targetPath));
  };

  if (settings.watchConfig) add(CONFIG_FILE);
  if (settings.watchMcp) add(path.join(homeDir, '.copilot', 'mcp-config.json'));

  const workDirs = new Set([...(opts.workDirs ?? [])]);
  for (const workDir of workDirs) {
    if (settings.watchAgents) {
      for (const segments of AGENT_DIRS) add(path.join(workDir, ...segments));
    }
    if (settings.watchPrompts) {
      for (const segments of PROMPT_DIRS) add(path.join(workDir, ...segments));
    }
  }

  if (settings.watchAgents) add(path.join(homeDir, '.copilot', 'agents'));

  if (settings.watchSkills) {
    add(path.join(homeDir, '.copilot', 'skills'));
    add(path.join(homeDir, '.github', 'skills'));
    for (const skillDir of opts.config?.skillDirectories ?? []) {
      if (typeof skillDir === 'string' && skillDir.trim()) add(skillDir);
    }
  }

  return [...targets];
}

function statsChanged(curr: Stats, prev: Stats): boolean {
  return curr.mtimeMs !== prev.mtimeMs || curr.ctimeMs !== prev.ctimeMs || curr.size !== prev.size || curr.nlink !== prev.nlink;
}

export class RestartManager {
  private readonly watchFileImpl: typeof watchFile;
  private readonly unwatchFileImpl: typeof unwatchFile;
  private readonly setTimeoutImpl: typeof globalThis.setTimeout;
  private readonly clearTimeoutImpl: typeof globalThis.clearTimeout;
  private readonly onRestartRequired?: (info: RestartSignalInfo) => void;
  private readonly onRequestRestart?: (info: RestartSignalInfo) => void;
  private readonly homeDir: string;

  private config?: GlobalConfig;
  private settings: SelfDevelopmentSettings;
  private supervisor: SupervisorKind;
  private workDirs = new Set<string>();
  private watchedPaths = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingInfo: RestartSignalInfo | null = null;

  constructor(opts: RestartManagerOptions = {}) {
    this.watchFileImpl = opts.watchFile ?? watchFile;
    this.unwatchFileImpl = opts.unwatchFile ?? unwatchFile;
    this.setTimeoutImpl = opts.setTimeout ?? globalThis.setTimeout;
    this.clearTimeoutImpl = opts.clearTimeout ?? globalThis.clearTimeout;
    this.onRestartRequired = opts.onRestartRequired;
    this.onRequestRestart = opts.onRequestRestart;
    this.homeDir = opts.homeDir ?? process.env.HOME ?? '.';
    this.supervisor = detectSupervisor(opts.env);
    this.config = opts.config;
    this.settings = resolveSelfDevelopmentSettings(opts.config, opts.settings);
    for (const workDir of opts.workDirs ?? []) this.workDirs.add(path.resolve(workDir));
    this.refresh();
  }

  refresh(config?: GlobalConfig): void {
    if (config) {
      this.config = config;
      this.settings = resolveSelfDevelopmentSettings(config, this.settings);
    }

    const nextTargets = new Set(
      this.settings.enabled
        ? collectWatchTargets({ homeDir: this.homeDir, workDirs: this.workDirs, config: this.config, settings: this.settings })
        : [],
    );

    for (const target of this.watchedPaths) {
      if (!nextTargets.has(target)) {
        this.unwatchFileImpl(target);
        this.watchedPaths.delete(target);
      }
    }

    for (const target of nextTargets) {
      if (this.watchedPaths.has(target)) continue;
      this.watchFileImpl(target, { interval: 1250, persistent: false }, (curr, prev) => {
        if (!statsChanged(curr, prev)) return;
        this.handleObservedChange(target);
      });
      this.watchedPaths.add(target);
    }
  }

  addWorkDir(workDir: string): void {
    this.workDirs.add(path.resolve(workDir));
    this.refresh();
  }

  stop(): void {
    if (this.debounceTimer) {
      this.clearTimeoutImpl(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const target of this.watchedPaths) this.unwatchFileImpl(target);
    this.watchedPaths.clear();
  }

  requestManualRestart(reason = 'Manual restart requested'): void {
    this.onRequestRestart?.({ reason });
  }

  handleObservedChange(changedPath: string): void {
    const info: RestartSignalInfo = {
      reason: `Capability change detected in ${changedPath}`,
      changedPath,
    };
    this.pendingInfo = info;
    if (this.debounceTimer) this.clearTimeoutImpl(this.debounceTimer);
    this.debounceTimer = this.setTimeoutImpl(() => {
      this.debounceTimer = null;
      const pending = this.pendingInfo;
      if (!pending) return;
      this.onRestartRequired?.(pending);
      if (this.settings.autoRestart && this.supervisor) this.onRequestRestart?.(pending);
    }, this.settings.debounceMs);
  }

  getStatus(): {
    enabled: boolean;
    autoRestart: boolean;
    supervisor: SupervisorKind;
    pending: RestartSignalInfo | null;
    watchedPaths: string[];
  } {
    return {
      enabled: this.settings.enabled,
      autoRestart: this.settings.autoRestart,
      supervisor: this.supervisor,
      pending: this.pendingInfo,
      watchedPaths: [...this.watchedPaths],
    };
  }
}