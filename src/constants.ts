// Copilot Remote — Shared constants
import type { PermKind } from './config-store.js';

/** Tool execution event emitted by the session */
export interface ToolEvent {
  toolCallId?: string;
  toolName: string;
  arguments?: Record<string, string>;
  success?: boolean;
  detailedContent?: string;
  images?: string[];
}

/** User input request from the agent */
export interface UserInputRequest {
  question: string;
  choices?: string[];
}

/** Passthrough commands: just prompt Copilot with context */
export const PROMPT_COMMANDS: Record<string, { usage?: string; prompt: (args: string) => string }> = {
  '/research': {
    usage: '`/research <topic>`',
    prompt: (a) => a,
  },
  '/diff': { prompt: () => 'Review all uncommitted changes. Show a summary and any issues.' },
  '/review': { prompt: () => 'Thorough code review of recent changes. Check bugs, security, style.' },
  '/share': { prompt: () => 'Share this conversation as a markdown summary.' },
  '/init': { prompt: () => 'Initialize copilot-instructions.md with sensible defaults for this codebase.' },
  '/tasks': { prompt: () => 'List all active background tasks and subagents.' },
  '/instructions': { prompt: () => 'Show which custom instruction files are active in this repository.' },
  '/skills': { prompt: () => 'List all available skills and their status.' },
  '/mcp': { prompt: () => 'Show configured MCP servers and their status.' },
};

export const TOOL_LABELS: Record<string, string> = {
  read_file: '📖 Read',
  edit_file: '✏️ Edit',
  create_file: '📝 Create',
  bash: '▶️ Run',
  run_bash: '▶️ Run',
  read_bash: '👁 Waiting',
  write_bash: '⌨️ Input',
  stop_bash: '⏹ Stop',
  view: '👁 View',
  list_dir: '📂 List',
  search: '🔍 Search',
  grep_search: '🔍 Search',
  think: '💡 Think',
  glob: '📂 Glob',
  delete_file: '🗑 Delete',
  write_file: '📝 Write',
  web_fetch: '🌐 Fetch',
  web_search: '🔎 Search',
  send_notification: '📨 Notify',
  ask_user: '❓ Ask',
};

export const LIFECYCLE_REACTIONS: Record<string, string> = {
  received: '👀',
  thinking: '🤔',
  tool_call: '🔨',
  writing: '✍️',
  web: '🌐',
  file_edit: '✏️',
  command: '▶️',
  search: '🔍',
  complete: '✅',
  error: '💥',
  steering: '⚡',
};

export const PERM_ICONS: Record<string, string> = {
  shell: '⚡',
  write: '✏️',
  url: '🌐',
  mcp: '🔌',
  read: '📖',
};

export const PERM_KIND_LABELS: Record<PermKind, string> = {
  read: '📖 Read files',
  write: '✏️ Write files',
  shell: '⚡ Run commands',
  url: '🌐 Fetch URLs',
  mcp: '🔌 MCP tools',
  'custom-tool': '🔧 Custom tools',
};

export const MODE_ICONS: Record<string, string> = {
  interactive: '⚡',
  plan: '📋',
  autopilot: '🚀',
};
