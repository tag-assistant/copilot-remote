import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { log } from './log.js';

const CONFIG_DIR = join(process.env.HOME ?? '.', '.copilot-remote');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export type PermKind = 'shell' | 'write' | 'mcp' | 'read' | 'url' | 'custom-tool';

export interface ChatConfig {
  showUsage: boolean;
  showThinking: boolean;
  showTools: boolean;
  showReactions: boolean;
  autopilot: boolean;
  mode: string;
  model: string;
  agent: string | null;
  reasoningEffort: string;
  messageMode: '' | 'enqueue' | 'immediate';
  infiniteSessions: boolean | undefined;
  autoApprove: Record<PermKind, boolean>;
}

/** Global config fields from config.json (not per-chat) */
export interface GlobalConfig {
  provider?: {
    type?: 'openai' | 'azure' | 'anthropic';
    baseUrl: string;
    apiKey?: string;
    model?: string;
  };
  mcpServers?: Record<string, unknown>;
  customAgents?: unknown[];
  skillDirectories?: string[];
  disabledSkills?: string[];
  systemInstructions?: string;
  availableTools?: string[];
  excludedTools?: string[];
  [key: string]: unknown;
}

export const DEFAULT_CONFIG: ChatConfig = {
  showUsage: false,
  showThinking: false,
  showTools: false,
  showReactions: true,
  autopilot: false,
  mode: 'interactive',
  model: 'claude-sonnet-4',
  agent: null,
  reasoningEffort: '',
  messageMode: '',
  infiniteSessions: undefined,
  autoApprove: {
    read: true,
    shell: false,
    write: false,
    mcp: false,
    url: false,
    'custom-tool': false,
  },
};

export class ConfigStore {
  private global: ChatConfig;
  private rawFile: GlobalConfig = {};
  private overrides = new Map<string, Partial<ChatConfig>>();

  constructor() {
    this.global = this.load();
  }

  /** Get the raw global config file (non-ChatConfig fields like provider, mcpServers, etc.) */
  raw(): GlobalConfig {
    return this.rawFile;
  }

  /** Get effective config for a session key (global + overrides merged) */
  get(key: string): ChatConfig {
    const overrides = this.overrides.get(key);
    if (!overrides) return { ...this.global, autoApprove: { ...this.global.autoApprove } };
    return {
      ...this.global,
      ...overrides,
      autoApprove: { ...this.global.autoApprove, ...(overrides.autoApprove ?? {}) },
    };
  }

  /** Update config for a key. If isGlobal, persists to disk. Otherwise, stores as thread override. */
  set(key: string, updates: Partial<ChatConfig>, isGlobal = false): ChatConfig {
    if (isGlobal) {
      Object.assign(this.global, updates);
      if (updates.autoApprove) {
        Object.assign(this.global.autoApprove, updates.autoApprove);
      }
      this.save();
    } else {
      const existing = this.overrides.get(key) ?? {};
      Object.assign(existing, updates);
      if (updates.autoApprove) {
        existing.autoApprove = { ...(existing.autoApprove ?? {}), ...updates.autoApprove };
      }
      this.overrides.set(key, existing);
    }
    return this.get(key);
  }

  /** Check if a key is a thread (has overrides) or global context (DM) */
  hasOverrides(key: string): boolean {
    return this.overrides.has(key);
  }

  /** Get just the global config */
  getGlobal(): ChatConfig {
    return { ...this.global, autoApprove: { ...this.global.autoApprove } };
  }

  /** Reset thread overrides */
  resetOverrides(key: string): void {
    this.overrides.delete(key);
  }

  private load(): ChatConfig {
    try {
      if (existsSync(CONFIG_FILE)) {
        const data = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
        log.info('[config] Loaded from', CONFIG_FILE);
        this.rawFile = data;
        return {
          ...DEFAULT_CONFIG,
          ...data,
          autoApprove: { ...DEFAULT_CONFIG.autoApprove, ...(data.autoApprove ?? {}) },
        };
      }
    } catch (e) {
      log.error('[config] Failed to load:', e);
    }
    return { ...DEFAULT_CONFIG, autoApprove: { ...DEFAULT_CONFIG.autoApprove } };
  }

  private save(): void {
    try {
      if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(CONFIG_FILE, JSON.stringify(this.global, null, 2));
      log.info('[config] Saved to', CONFIG_FILE);
    } catch (e) {
      log.error('[config] Failed to save:', e);
    }
  }
}
