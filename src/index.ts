// Copilot Remote — Telegram ↔ Copilot SDK bridge
import { Session } from './session.js';
import type {
  ToolInfo,
  FileAttachment,
} from './session.js';
import type { Client, MessageOptions, Button } from './client.js';
import type { ModelInfo, PermissionRequest } from '@github/copilot-sdk';
import { TelegramClient } from './telegram.js';
import { SessionStore } from './store.js';
import { ConfigStore, type ChatConfig, type PermKind } from './config-store.js';
import { discoverAgents } from './agent-discovery.js';
import { log } from './log.js';
import { ReasoningLaneCoordinator } from './reasoning-lane.js';
import { markdownToTelegramHtml } from './format.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import * as readline from 'readline';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

/** Tool execution event emitted by the session */
interface ToolEvent {
  toolName: string;
  arguments?: Record<string, string>;
  success?: boolean;
  detailedContent?: string;
  images?: string[]; // base64 image data from tool results
}

/** User input request from the agent */
interface UserInputRequest {
  question: string;
  choices?: string[];
}

/** ChatConfig boolean keys for dynamic toggle */

/** Reasoning effort level (including 'none' for disabled) */

function findBin(name: string): string {
  try {
    return execSync('which ' + name, { encoding: 'utf-8' }).trim();
  } catch {
    return name;
  }
}

function loadConfig() {
  // Load from ~/.copilot-remote/config.json or .copilot-remote.json in cwd
  const homeCfg = path.join(process.env.HOME ?? '.', '.copilot-remote', 'config.json');
  const cwdCfg = path.join(process.cwd(), '.copilot-remote.json');
  const cfgPath = fs.existsSync(homeCfg) ? homeCfg : fs.existsSync(cwdCfg) ? cwdCfg : null;
  const file = cfgPath ? JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) : {};

  // CLI args override config: --bot-token xxx
  const args = process.argv.slice(2);
  const botTokenIdx = args.indexOf('--bot-token');
  const botTokenArg = botTokenIdx >= 0 ? args[botTokenIdx + 1] : undefined;

  const botToken = botTokenArg ?? file.botToken ?? process.env.COPILOT_REMOTE_BOT_TOKEN;
  return {
    botToken,
    allowedUsers: file.allowedUsers ?? process.env.COPILOT_REMOTE_ALLOWED_USERS?.split(',').filter(Boolean) ?? [],
    workDir: file.workDir ?? process.env.COPILOT_REMOTE_WORKDIR ?? process.cwd(),
    copilotBinary: file.copilotBinary ?? process.env.COPILOT_REMOTE_BINARY,
    githubToken: file.githubToken ?? process.env.GITHUB_TOKEN ?? resolveGhToken(),
    profilePhoto: file.profilePhoto,
    _cfgPath: cfgPath ?? homeCfg,
    _file: file,
  };
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    }),
  );
}

async function ensureBotToken(config: ReturnType<typeof loadConfig>): Promise<string> {
  if (config.botToken) return config.botToken;

  // Interactive first-run setup
  console.log('\n🤖 copilot-remote — first-time setup\n');
  console.log('You need a Telegram bot token. Get one from @BotFather: https://t.me/BotFather\n');
  const token = await prompt('Paste your bot token: ');
  if (!token) {
    console.error('No token provided. Exiting.');
    process.exit(1);
  }

  // Save to config
  const cfgDir = path.dirname(config._cfgPath);
  fs.mkdirSync(cfgDir, { recursive: true });
  const newFile = { ...config._file, botToken: token };
  fs.writeFileSync(config._cfgPath, JSON.stringify(newFile, null, 2) + '\n', { mode: 0o600 });
  console.log(`\n✅ Saved to ${config._cfgPath}\n`);
  return token;
}

function resolveGhToken(): string | undefined {
  try {
    return execSync('gh auth token 2>/dev/null', { encoding: 'utf-8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

// ── Passthrough commands: just prompt Copilot with context ──
const PROMPT_COMMANDS: Record<string, { usage?: string; prompt: (args: string) => string }> = {
  '/research': {
    usage: '`/research <topic>`',
    prompt: (a) => a, // agent selection handles research mode
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

// ── Shared constants ──
const TOOL_LABELS: Record<string, string> = {
  read_file: '📖 Read',
  edit_file: '✏️ Edit',
  create_file: '📝 Create',
  bash: '▶️ Run',
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
};

// Reactions for different lifecycle events
const LIFECYCLE_REACTIONS: Record<string, string> = {
  received: '👀',        // 👀 message received, starting to think
  thinking: '🤔',        // 🤔 reasoning/thinking
  tool_call: '🔨',       // 🔨 executing tools
  writing: '✍️',       // ✍️ generating response
  web: '🌐',             // 🌐 fetching from web
  file_edit: '✏️',     // ✏️ editing files
  command: '▶️',       // ▶️ running commands
  search: '🔍',          // 🔍 searching
  complete: '✅',            // ✅ done
  error: '💥',           // 💥 error
  steering: '⚡',            // ⚡ steering/immediate
};

const PERM_ICONS: Record<string, string> = {
  shell: '⚡',
  write: '✏️',
  url: '🌐',
  mcp: '🔌',
  read: '📖',
};

const PERM_KIND_LABELS: Record<PermKind, string> = {
  read: '📖 Read files',
  write: '✏️ Write files',
  shell: '⚡ Run commands',
  url: '🌐 Fetch URLs',
  mcp: '🔌 MCP tools',
  'custom-tool': '🔧 Custom tools',
};

const MODE_LABELS: Record<string, string> = {
  interactive: '⚡ Interactive',
  plan: '📋 Plan',
  autopilot: '🚀 Autopilot',
};

const MODE_ICONS: Record<string, string> = {
  interactive: '⚡',
  plan: '📋',
  autopilot: '🚀',
};

async function main(): Promise<void> {
  const config = loadConfig();
  if (config._file?.debug) log.setDebug(true);
  const botToken = await ensureBotToken(config);
  const bin = config.copilotBinary ?? findBin('copilot');

  log.info('⚡ Copilot Remote v' + version + ' | dir: ' + config.workDir);

  const client: Client = new TelegramClient({
    botToken,
    allowedUsers: config.allowedUsers,
    profilePhoto: config.profilePhoto,
  });

  // ── Per-chat state ──
  // ── Config ──
  const configStore = new ConfigStore();

  // Is this key a "global" context (DM, not a thread)?
  const isGlobalKey = (key: string) => !key.includes(':');

  const cfg = (key: string) => configStore.get(key);
  const setCfg = (key: string, updates: Partial<ChatConfig>) => configStore.set(key, updates, isGlobalKey(key));

  const sessions = new Map<string, Session>();
  const workDirs = new Map<string, string>();
  const pendingPerms = new Map<number, string>();
  const sessionStore = new SessionStore();
  const threadMap = new Map<string, number>(); // sessionKey → threadId
  let cachedModels: ModelInfo[] = [];
  // Per-session usage tracking (keyed by session key)
  const lastUsageMap = new Map<string, any>();
  const contextInfoMap = new Map<string, { tokenLimit: number; currentTokens: number; messagesLength: number }>();

  // Session key: "chatId" or "chatId:threadId" for forum topics
  const sessionKey = (chatId: string, threadId?: number) => (threadId ? chatId + ':' + threadId : chatId);

  // Wrap client methods to auto-resolve session keys (chatId:threadId → chatId + threadId param)
  const origSendMessage = client.sendMessage.bind(client);
  const origSendButtons = client.sendButtons.bind(client);
  const origEditMessage = client.editMessage.bind(client);
  const origEditButtons = client.editButtons.bind(client);
  const origSendTyping = client.sendTyping.bind(client);
  const origSetReaction = client.setReaction.bind(client);
  const origRemoveReaction = client.removeReaction.bind(client);

  const resolveKey = (key: string): [string, number | undefined] => {
    const tid = threadMap.get(key);
    const cid = key.includes(':') ? key.split(':')[0] : key;
    return [cid, tid];
  };

  client.sendMessage = (key: string, text: string, opts?: MessageOptions) => {
    const [cid, tid] = resolveKey(key);
    return origSendMessage(cid, text, { ...opts, threadId: tid });
  };
  client.sendButtons = (key: string, text: string, buttons: Button[][]) => {
    const [cid, tid] = resolveKey(key);
    return origSendButtons(cid, text, buttons, tid);
  };
  client.editMessage = (key: string, msgId: number, text: string) => {
    const [cid] = resolveKey(key);
    return origEditMessage(cid, msgId, text);
  };
  client.editButtons = (key: string, msgId: number, text: string, buttons: Button[][]) => {
    const [cid] = resolveKey(key);
    return origEditButtons(cid, msgId, text, buttons);
  };
  client.sendTyping = (key: string) => {
    const [cid, tid] = resolveKey(key);
    return origSendTyping(cid, tid);
  };
  client.setReaction = (key: string, msgId: number, emoji: string) => {
    const [cid] = resolveKey(key);
    return origSetReaction(cid, msgId, emoji);
  };
  client.removeReaction = (key: string, msgId: number) => {
    const [cid] = resolveKey(key);
    return origRemoveReaction(cid, msgId);
  };

  if (client.sendDraft) {
    const origSendDraft = client.sendDraft.bind(client);
    client.sendDraft = (key: string, draftId: number, text: string) => {
      const [cid, tid] = resolveKey(key);
      return origSendDraft(cid, draftId, text, tid);
    };
  }

  if (client.sendPhoto) {
    const origSendPhoto = client.sendPhoto.bind(client);
    client.sendPhoto = (key: string, fileOrUrl: string, caption?: string) => {
      const [cid, tid] = resolveKey(key);
      return origSendPhoto(cid, fileOrUrl, caption, tid);
    };
  }

  const workDir = (id: string) => workDirs.get(id) ?? config.workDir;

  // Get or create session
  // Register persistent listeners on a session (called once per session, not per message)
  function registerSessionListeners(session: Session, chatId: string) {
    session.on('usage', (u: Record<string, unknown>) => {
      const lastUsage = {
        model: u.model as string,
        inputTokens: u.inputTokens as number,
        outputTokens: u.outputTokens as number,
        cacheReadTokens: u.cacheReadTokens as number,
        duration: u.duration as number,
      };
      lastUsageMap.set(chatId, lastUsage);
    });
    session.on('context_info', (info: { tokenLimit: number; currentTokens: number; messagesLength: number }) => {
      contextInfoMap.set(chatId, info);
    });
    session.on('turn_start', () => {});
    session.on('permission_timeout', () => {
      for (const [id, cid] of pendingPerms) {
        if (cid === chatId) {
          pendingPerms.delete(id);
          client.editButtons(chatId, id, '⏰ Expired (denied)', []).catch(() => {});
        }
      }
    });
    session.on('notification', async (text: string) => {
      await client.sendMessage(chatId, '🔔 ' + text);
    });
    session.on('hook:error', async (info: { error?: unknown; message?: string }) => {
      const msg = info.message ?? (info.error instanceof Error ? info.error.message : String(info.error ?? 'Unknown error'));
      await client.sendMessage(chatId, '⚠️ *SDK Error:* ' + msg);
    });
    session.on('hook:session_start', () => log.debug('[hook] Session started for chat', chatId));
    session.on('hook:session_end', () => log.debug('[hook] Session ended for chat', chatId));
  }

  async function getSession(chatId: string): Promise<Session> {
    let s = sessions.get(chatId);
    if (s?.alive) return s;

    s = new Session();
    const c = cfg(chatId);
    const globalCfg = configStore.raw();
    const opts = {
      cwd: workDir(chatId),
      binary: bin,
      model: c.model,
      autopilot: c.autopilot,
      reasoningEffort: c.reasoningEffort ? (c.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh') : undefined,
      agent: c.agent ?? undefined,
      topicContext: client.getTopicName?.(chatId),
      githubToken: config.githubToken,
      infiniteSessions: c.infiniteSessions,
      messageMode: c.messageMode || undefined,
      // Global config passthrough
      provider: globalCfg.provider,
      mcpServers: globalCfg.mcpServers,
      // Merge discovered agents from standard locations with config agents
      customAgents: (() => {
        const discovered = discoverAgents(workDir(chatId));
        const configAgents = (globalCfg.customAgents ?? []) as Array<{ name: string }>;
        const configNames = new Set(configAgents.map(a => a.name));
        const merged = [...configAgents, ...discovered.filter(a => !configNames.has(a.name))];
        if (discovered.length) log.info(`Discovered ${discovered.length} agent(s): ${discovered.map(a => a.name).join(', ')}`);
        return merged.length ? merged : undefined;
      })(),
      skillDirectories: globalCfg.skillDirectories,
      disabledSkills: globalCfg.disabledSkills,
      systemInstructions: globalCfg.systemInstructions,
      availableTools: globalCfg.availableTools,
      excludedTools: [...new Set([...(globalCfg.excludedTools ?? []), ...(c.excludedTools ?? [])])].length
        ? [...new Set([...(globalCfg.excludedTools ?? []), ...(c.excludedTools ?? [])])]
        : undefined,
    };

    // Try to resume a saved session
    const saved = sessionStore.get(chatId);
    if (saved?.sessionId) {
      try {
        await s.resume(saved.sessionId, opts);
        sessionStore.touch(chatId);
        sessions.set(chatId, s);
        registerSessionListeners(s, chatId);
        log.info('Resumed session', saved.sessionId, 'for', chatId);
        return s;
      } catch (e) {
        log.debug('Resume failed, creating new:', e);
        sessionStore.delete(chatId);
      }
    }

    // Create new session
    await s.start(opts);
    if (s.sessionId) {
      sessionStore.set(chatId, {
        sessionId: s.sessionId,
        cwd: workDir(chatId),
        model: c.model,
        createdAt: Date.now(),
        lastUsed: Date.now(),
      });
    }
    registerSessionListeners(s, chatId);
    sessions.set(chatId, s);
    return s;
  }

  // ── Prompt handler (streaming + reactions) ──
  async function handlePrompt(chatId: string, msgId: number, prompt: string, attachments?: FileAttachment[]): Promise<void> {
    let session: Session;
    try {
      session = await getSession(chatId);
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? String(err);
      // If reasoning effort not supported, retry without it
      if (msg.includes('reasoning effort')) {
        const c = cfg(chatId);
        c.reasoningEffort = '';
        setCfg(chatId, c);
        try {
          session = await getSession(chatId);
        } catch (err2: unknown) {
          await client.sendMessage(chatId, '❌ Session failed: ' + ((err2 as Error)?.message ?? String(err2)));
          return;
        }
      } else {
        await client.sendMessage(chatId, '❌ Session failed: ' + msg);
        return;
      }
    }
    const c = cfg(chatId);
    // Steering: if session is busy (mid-turn), send as immediate to steer the agent
    if (session.busy && c.messageMode !== 'enqueue') {
      const react = c.showReactions ? (e: string) => { client.setReaction(chatId, msgId, e).catch(() => {}); } : () => {};
      react('⚡');
      try {
        await session.sendImmediate(prompt, attachments);
        react('✅');
      } catch (e) {
        react('❌');
        log.debug('Immediate send failed:', e);
      }
      return;
    }
    client.sendTyping(chatId);
    const react = c.showReactions ? (e: string) => { client.setReaction(chatId, msgId, e).then(() => client.sendTyping(chatId)).catch(() => {}); } : () => {};
    react(LIFECYCLE_REACTIONS.received);
    // Keep typing indicator alive every 4s while processing
    const typingInterval = setInterval(() => client.sendTyping(chatId), 4000);

    let streamMsgId: number | null = null;
    let draftId: number | null = null;
    let useDraft = !!client.sendDraft; // try draft mode if client supports it
    let thinkingText = '',
      responseText = '';
    let intentText = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastUsage: any = null;
    const toolLines: string[] = [];
    let activeToolStatus = ''; // current tool being executed (always shown)
    let lastEdit = 0,
      timer: NodeJS.Timeout | null = null;
    const THROTTLE = useDraft ? 400 : 500; // drafts can update faster, edits throttled to avoid rate limits

    const display = () => {
      const p: string[] = [];
      if (intentText) p.push('🎯 *' + intentText + '*');
      if (thinkingText && c.showThinking) {
        const s = thinkingText;
        // Light escaping: only escape what breaks Telegram markdown italic
        p.push('💭 ' + s);
      }
      if (toolLines.length) p.push(toolLines.join('\n'));
      if (activeToolStatus && !responseText) p.push('⏳ ' + activeToolStatus);
      if (responseText) p.push(responseText);
      return p.join('\n\n');
    };

    let streamGeneration = 0;
    const staleMessageIds: number[] = []; // messages from old generations, cleaned up at finalize

    // Minimum chars before sending first streaming message.
    // Prevents premature push notifications (user sees "I" before the full sentence).
    // Pattern adapted from OpenClaw's DRAFT_MIN_INITIAL_CHARS (MIT, github.com/AustenStone/openclaw)
    const MIN_INITIAL_CHARS = 1;

    const flush = async () => {
      const gen = streamGeneration;
      timer = null;
      lastEdit = Date.now();
      const text = display();
      if (!text.trim()) return;

      // Try native draft streaming first
      if (useDraft && client.sendDraft) {
        if (!draftId) draftId = client.allocateDraftId!();
        const ok = await client.sendDraft(chatId, draftId, text);
        if (ok) return; // draft sent successfully
        useDraft = false; // fall back to edit-in-place
      }

      // Fallback: send then edit
      if (!streamMsgId) {
        // Debounce first send — wait for enough content for a meaningful push notification
        // (OpenClaw pattern: minInitialChars gate on first message send)
        if (text.length < MIN_INITIAL_CHARS) return;
        const newMsgId = await client.sendMessage(chatId, text, { disableLinkPreview: true });
        if (gen !== streamGeneration) {
          // Stale — generation advanced while send was in-flight. Track for cleanup at finalize.
          if (newMsgId) staleMessageIds.push(newMsgId);
          return;
        }
        streamMsgId = newMsgId;
        log.debug('Stream: new message', streamMsgId);
      } else {
        log.debug('Stream: edit message', streamMsgId);
        // Fire-and-forget edit — don't block the flush loop waiting for Telegram's response
        client.editMessage(chatId, streamMsgId, text).then(() => {
          client.sendTyping(chatId); // re-send typing after edit
        }).catch(() => {});
      }
    };

    const schedEdit = () => {
      if (!timer) timer = setTimeout(() => { flush().catch(() => {}); }, Math.max(0, THROTTLE - (Date.now() - lastEdit)));
    };

    const onThink = (t: string) => {
      if (!c.showThinking) return;
      if (!thinkingText) react(LIFECYCLE_REACTIONS.thinking);
      thinkingText += t;
      schedEdit(); // thinking shows inline in the main streaming message
    };
    let thinkingDone = false; // true once assistant.reasoning (final) fires
    let pendingResponseText = ''; // buffer response deltas until thinking finishes streaming

    const flushThinkingTransition = () => {
      if (streamMsgId) {
        client.deleteMessage?.(chatId, streamMsgId).catch(() => {});
        streamMsgId = null;
        streamGeneration++;
      }
      thinkingText = '';
      react(LIFECYCLE_REACTIONS.writing);
      // Flush any buffered response text
      if (pendingResponseText) {
        responseText += pendingResponseText;
        pendingResponseText = '';
        schedEdit();
      }
    };

    const onThinkingDone = () => {
      thinkingDone = true;
      // If response deltas already arrived, flush the transition now
      if (pendingResponseText) flushThinkingTransition();
    };

    const onDelta = (t: string) => {
      // If still streaming thinking, buffer response until thinking_done
      if (thinkingText && !thinkingDone) {
        pendingResponseText += t;
        return;
      }
      // Thinking finished — transition if needed
      if (thinkingText) {
        flushThinkingTransition();
      }
      if (!responseText) react(LIFECYCLE_REACTIONS.writing);
      responseText += t;
      schedEdit();
    };
    const onToolStart = (t: ToolEvent) => {
      client.sendTyping(chatId);
      // React based on tool type
      const toolReaction = t.toolName === 'web_fetch' || t.toolName === 'web_search' ? LIFECYCLE_REACTIONS.web
        : t.toolName === 'bash' ? LIFECYCLE_REACTIONS.command
        : t.toolName === 'edit_file' || t.toolName === 'write_file' || t.toolName === 'create_file' ? LIFECYCLE_REACTIONS.file_edit
        : t.toolName === 'grep_search' || t.toolName === 'search' || t.toolName === 'glob' ? LIFECYCLE_REACTIONS.search
        : LIFECYCLE_REACTIONS.tool_call;
      react(toolReaction);
      // report_intent: show as headline, not a tool line
      if (t.toolName === 'report_intent') {
        const intent = t.arguments?.intent ?? t.arguments?.message ?? '';
        if (intent) { intentText = String(intent); schedEdit(); }
        return;
      }
      // Always set active tool status (visible even with showTools off)
      const toolLabel = TOOL_LABELS[t.toolName] ?? '🔧 ' + t.toolName;
      let statusDetail = '';
      if (t.arguments?.command) statusDetail = ' `' + String(t.arguments.command).slice(0, 80) + '`';
      else if (t.arguments?.url) statusDetail = ' `' + String(t.arguments.url).slice(0, 80) + '`';
      else if (t.arguments?.file_path) statusDetail = ' `' + String(t.arguments.file_path) + '`';
      else if (t.arguments?.pattern) statusDetail = ' `' + String(t.arguments.pattern).slice(0, 60) + '`';
      activeToolStatus = toolLabel + statusDetail;
      schedEdit();

      if (!c.showTools) return;
      const label = TOOL_LABELS[t.toolName] ?? '🔧 ' + t.toolName;
      let detail = '';
      if (t.arguments?.command) detail = ' `' + t.arguments.command.slice(0, 60) + '`';
      else if (t.arguments?.file_path) detail = ' `' + t.arguments.file_path + '`';
      toolLines.push(label + detail);
      schedEdit();
    };
    const onToolEnd = (t: ToolEvent) => {
      activeToolStatus = ''; // clear active tool status
      client.sendTyping(chatId); // re-send typing (Telegram cancels on edit)
      if (t.toolName === 'report_intent') return; // already handled
      if (!c.showTools || !toolLines.length) return;
      toolLines[toolLines.length - 1] += t.success !== false ? ' ✓' : ' ✗';
      schedEdit();

      // Send any generated images as Telegram photos
      if (t.images?.length && client.sendPhoto) {
        for (const base64 of t.images) {
          const buffer = Buffer.from(base64, 'base64');
          const tmpPath = '/tmp/copilot-remote/tool-image-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.png';
          fs.mkdirSync('/tmp/copilot-remote', { recursive: true });
          fs.writeFileSync(tmpPath, buffer);
          client.sendPhoto(chatId, tmpPath).catch(() => {});
        }
      }
    };
    const onPerm = async (req: PermissionRequest) => {
      log.debug('onPerm called:', JSON.stringify(req).slice(0, 200));
      const p = (req as PermissionRequest & { permissionRequest?: PermissionRequest }).permissionRequest ?? req;
      const kind = p.kind as PermKind;
      log.debug('Permission kind:', kind, 'autoApprove:', c.autoApprove[kind]);

      // Auto-approve if this kind is allowed
      if (c.autoApprove[kind]) {
        session.approve();
        return;
      }

      const icon = PERM_ICONS[kind] ?? '🔐';
      const title =
        p.kind === 'shell'
          ? 'Run command'
          : p.kind === 'url'
            ? 'Fetch URL'
            : p.kind === 'write'
              ? 'Write file'
              : p.kind;
      let detail =
        p.kind === 'shell'
          ? '```\n' + String(p.fullCommandText ?? '').slice(0, 300) + '\n```'
          : p.kind === 'url'
            ? '`' + String(p.url ?? '').slice(0, 200) + '`'
            : (p.intention ?? '');
      if (p.intention && p.kind !== detail) detail += '\n_' + p.intention + '_';
      const id = await client.sendButtons(chatId, icon + ' *' + title + '*\n' + detail, [
        [
          { text: '✅ Approve', data: 'perm:yes', style: 'constructive' },
          { text: '❌ Deny', data: 'perm:no', style: 'destructive' },
          { text: '✅ All', data: 'perm:all' },
        ],
      ]);
      if (id) pendingPerms.set(id, chatId);
    };

    const pendingInputs = new Map<number, string>(); // msgId → chatId for user input answers
    const onUserInput = async (req: UserInputRequest) => {
      const question = req.question ?? (typeof req === 'string' ? req : JSON.stringify(req));
      const choices = req.choices as string[] | undefined;
      if (choices?.length) {
        const buttons = choices.map((c: string) => [{ text: c, data: 'input:' + c }]);
        const id = await client.sendButtons(chatId, '❓ ' + question, buttons);
        if (id) pendingInputs.set(id, chatId);
      } else {
        const id = await client.sendMessage(chatId, '❓ ' + question + '\n\n_Reply to this message to answer_');
        if (id) pendingInputs.set(id, chatId);
      }
    };

    session.on('thinking', onThink);
    session.on('delta', onDelta);
    session.on('thinking_done', onThinkingDone);
    session.on('tool_start', onToolStart);
    session.on('tool_complete', onToolEnd);
    session.on('permission_request', onPerm);
    session.on('user_input_request', onUserInput);
    session.on('context_info', (info: { tokenLimit: number; currentTokens: number; messagesLength: number }) => {
      contextInfoMap.set(chatId, info);
    });
    // Persistent listeners (usage, hooks, notifications) registered once in registerSessionListeners()

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      session.off('thinking', onThink);
      session.off('delta', onDelta);
      session.off('thinking_done', onThinkingDone);
      session.off('tool_start', onToolStart);
      session.off('tool_complete', onToolEnd);
      session.off('permission_request', onPerm);
      session.off('user_input_request', onUserInput);
    };

    let res: { content: string };
    try {
      res = await session.send(prompt, attachments);
    } catch (sendErr) {
      cleanup();
      clearInterval(typingInterval);
      // Kill the broken session so it doesn't linger
      try { session.kill(); } catch { /* ignore */ }
      sessions.delete(chatId);
      sessionStore.delete(chatId);
      react(LIFECYCLE_REACTIONS.error);
      await client.sendMessage(chatId, '❌ Session error: ' + String(sendErr) + '\n\nUse /new to start a fresh session.');
      return;
    }
    try {
      cleanup();
      clearInterval(typingInterval);

      let final = res.content;

      // Finalize: send the complete response
      // If thinking message is still showing (transition never happened), delete it
      if (thinkingText && streamMsgId) {
        client.deleteMessage?.(chatId, streamMsgId).catch(() => {});
        streamMsgId = null;
      }
      // Clean up any stale messages from old generations
      for (const id of staleMessageIds) {
        client.deleteMessage?.(chatId, id).catch(() => {});
      }
      // Materialize: convert streaming message into final response in-place when possible.
      // This avoids the visible delete+send flash that breaks reading flow.
      const chunks = final ? (await import('./format.js')).markdownToTelegramChunks(final, 4096) : [];
      if (streamMsgId && chunks.length <= 1) {
        // Single chunk — edit the existing stream message in-place (materialize)
        await client.editMessage(chatId, streamMsgId, final);
      } else if (streamMsgId) {
        // Multi-chunk — must delete stream msg and send fresh (can't edit into multiple messages)
        await client.deleteMessage?.(chatId, streamMsgId).catch(() => {});
        await client.sendMessage(chatId, final, { disableLinkPreview: true });
      } else {
        await client.sendMessage(chatId, final, { disableLinkPreview: true });
      }
      react(LIFECYCLE_REACTIONS.complete);
    } catch (err) {
      cleanup();
      clearInterval(typingInterval);
      react(LIFECYCLE_REACTIONS.error);
      await client.sendMessage(chatId, '❌ ' + String(err));
    }
  }

  // ── Message handler ──
  client.onMessage = async (text, chatId, messageId, replyText, replyToMsgId, threadId) => {
    const key = sessionKey(chatId, threadId);
    if (threadId) threadMap.set(key, threadId);

    // Reply to permission message
    if (replyToMsgId && pendingPerms.has(replyToMsgId)) {
      const lower = text.toLowerCase().trim();
      const s = sessions.get(key);
      if (s?.alive) {
        if (['yes', 'y', 'approve', '👍'].includes(lower)) {
          s.approve();
          pendingPerms.delete(replyToMsgId);
          await client.editButtons(chatId, replyToMsgId, '✅ Approved', []);
          return;
        }
        if (['no', 'n', 'deny', '👎'].includes(lower)) {
          s.deny();
          pendingPerms.delete(replyToMsgId);
          await client.editButtons(chatId, replyToMsgId, '❌ Denied', []);
          return;
        }
        // Check if it's an answer to a user input question
        s.answerInput(text);
        return;
      }
    }

    if (text.startsWith('/')) return handleCommand(text, key, messageId);

    let prompt = text;
    if (replyText) prompt = 'Context (replying to):\n"""\n' + replyText + '\n"""\n\nMy message: ' + text;
    await handlePrompt(key, messageId, prompt);
  };

  // ── Command handler ──
  async function handleCommand(text: string, chatId: string, msgId: number): Promise<void> {
    const [rawCmd, ...args] = text.split(' ');
    const cmd = rawCmd.replace(/@\w+$/, ''); // strip @botname suffix
    const argStr = args.join(' ');

    // Passthrough prompt commands
    const pc = PROMPT_COMMANDS[cmd];
    if (pc) {
      if (pc.usage && !argStr) {
        await client.sendMessage(chatId, 'Usage: ' + pc.usage);
        return;
      }
      let s = sessions.get(chatId);
      if (!s?.alive) {
        s = await getSession(chatId);
      }
      // For /research, activate the research agent before sending the prompt
      if (cmd === '/research' && s?.alive) {
        try {
          await s.selectAgent('research');
        } catch (e) {
          log.debug('Failed to select research agent:', e);
        }
      }
      return handlePrompt(chatId, msgId, pc.prompt(argStr));
    }

    switch (cmd) {
      case '/start':
      case '/new': {
        if (args[0] && cmd === '/start') {
          const dir = args[0].replace(/^~/, process.env.HOME ?? '~');
          workDirs.set(chatId, dir);
        }
        const old = sessions.get(chatId);
        if (old?.alive) old.kill();
        sessions.delete(chatId);
        sessionStore.delete(chatId); // Don't resume old session
        await getSession(chatId);
        await client.sendMessage(chatId, cmd === '/new' ? '🆕 New session.' : '✅ Ready in `' + workDir(chatId) + '`');
        break;
      }
      case '/stop':
      case '/clear': {
        const s = sessions.get(chatId);
        if (s?.alive) {
          // Disconnect preserves session on disk for resume
          await s.disconnect();
        }
        sessions.delete(chatId);
        await client.sendMessage(chatId, '🛑 Session paused. Send a message to resume.');
        break;
      }
      case '/resume': {
        const saved = sessionStore.list();
        if (!saved.length) {
          await client.sendMessage(chatId, 'No saved sessions.');
          break;
        }
        const lines = saved.slice(0, 10).map(([id, e]) => {
          const age = Math.round((Date.now() - e.lastUsed) / 60000);
          const ageStr = age < 60 ? age + 'm ago' : Math.round(age / 60) + 'h ago';
          return (
            '• `' + e.cwd.replace(process.env.HOME ?? '', '~') + '` — ' + ageStr + (id === chatId ? ' *(current)*' : '')
          );
        });
        await client.sendMessage(
          chatId,
          '📋 *Sessions*\n' + lines.join('\n') + '\n\nSend a message to auto-resume your session.',
        );
        break;
      }
      case '/cd': {
        if (!args[0]) {
          await client.sendMessage(chatId, '📂 ' + workDir(chatId));
          break;
        }
        const newDir = args[0].startsWith('~') ? args[0].replace('~', process.env.HOME ?? '/') : args[0];
        if (!fs.existsSync(newDir)) {
          await client.sendMessage(chatId, '❌ Directory not found: `' + newDir + '`');
          break;
        }
        workDirs.set(chatId, newDir);
        const oldSession = sessions.get(chatId);
        if (oldSession?.alive) {
          oldSession.kill();
          sessions.delete(chatId);
          await client.sendMessage(chatId, '📂 `' + newDir + '`\nRestarting session...');
          await getSession(chatId);
          await client.sendMessage(chatId, '✅ Ready in `' + newDir + '`');
        } else {
          await client.sendMessage(chatId, '📂 `' + newDir + '` — next session will start here.');
        }
        break;
      }
      case '/status': {
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await client.sendMessage(chatId, '⚪ No session. Send a message to start.');
          break;
        }
        const dir = workDir(chatId);
        const lines: string[] = [];

        // Session ID + resume command
        if (s.sessionId) {
          lines.push('🆔 `' + s.sessionId + '`');
          lines.push('`copilot --resume ' + s.sessionId + '`');
        }

        // Git branch
        try {
          const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, timeout: 3000 }).toString().trim();
          lines.push('📂 `' + dir + '` [⎇ ' + branch + ']');
        } catch {
          lines.push('📂 `' + dir + '`');
        }

        try {
          const [model, mode, agent] = await Promise.all([
            s.getCurrentModel().catch(() => null),
            s.getMode().catch(() => null),
            s.getCurrentAgent().catch(() => null),
          ]);
          if (model?.modelId) lines.push('🤖 `' + model.modelId + '`');
          if (mode) lines.push((MODE_ICONS[mode] ?? '⚙️') + ' ' + mode);
          if (agent?.agent?.name) lines.push('🎭 `' + agent.agent.name + '`');
        } catch {
          /* ignore */
        }

        // Context usage (like Copilot CLI)
        const ci = contextInfoMap.get(chatId);
        if (ci) {
          const pct = ci.tokenLimit ? Math.round((ci.currentTokens / ci.tokenLimit) * 100) : 0;
          const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
          lines.push('');
          lines.push('**Context Usage**');
          lines.push('`' + fmt(ci.currentTokens) + '/' + fmt(ci.tokenLimit) + ' tokens (' + pct + '%)` · ' + ci.messagesLength + ' messages');
        }

        // Last turn usage
        const lu = lastUsageMap.get(chatId);
        if (lu) {
          const parts: string[] = [];
          if (lu.inputTokens || lu.outputTokens) parts.push(`${lu.inputTokens ?? 0}→${lu.outputTokens ?? 0} tokens`);
          if (lu.cacheReadTokens) parts.push(`${lu.cacheReadTokens} cached`);
          if (lu.duration) parts.push(`${(lu.duration / 1000).toFixed(1)}s`);
          if (parts.length) {
            lines.push('');
            lines.push('**Last Turn**');
            lines.push('`' + parts.join(' · ') + '`');
          }
        }

        // Quota
        try {
          const q = await s.getQuota();
          const snap = q?.quotaSnapshots;
          if (snap) {
            const chat = (snap as any).chat;
            const completions = (snap as any).completions;
            if (chat || completions) {
              lines.push('');
              lines.push('**Quota**');
              if (chat) lines.push('💬 Chat: `' + chat.used + '/' + chat.limit + '` (' + chat.remaining_percentage + '% left)');
              if (completions) lines.push('⚡ Completions: `' + completions.used + '/' + completions.limit + '` (' + completions.remaining_percentage + '% left)');
            }
          }
        } catch {
          /* ignore */
        }

        await client.sendMessage(chatId, lines.join('\n'));
        break;
      }
      case '/yes':
      case '/y': {
        sessions.get(chatId)?.approve();
        break;
      }
      case '/no':
      case '/n': {
        sessions.get(chatId)?.deny();
        break;
      }
      case '/abort': {
        const s = sessions.get(chatId);
        if (s?.alive) {
          await s.abort();
          await client.sendMessage(chatId, '🛑 Aborted.');
        }
        break;
      }
      case '/debug':
      case '/autopilot':
      case '/allowall': {
        await client.sendMessage(chatId, 'Use /config to change settings.');
        break;
      }
      case '/agent': {
        const s = sessions.get(chatId);
        if (!args[0]) {
          // List available agents with buttons
          if (s?.alive) {
            try {
              const r = await s.listAgents();
              const agents = r?.agents ?? [];
              const agentPfx = (d: string) => `@${chatId}|${d}`;
              // Also show current agent
              let currentName = '';
              try {
                const cur = await s.getCurrentAgent();
                currentName = cur?.agent?.name ?? '';
              } catch { /* ignore */ }
              if (!agents.length) {
                await client.sendMessage(chatId, '🤖 No agents found.');
                break;
              }
              const buttons: Button[][] = [];
              for (let i = 0; i < agents.length; i += 2) {
                const row: Button[] = [];
                for (let j = i; j < Math.min(i + 2, agents.length); j++) {
                  const a = agents[j];
                  const name = a.name ?? String(a);
                  const label = name === currentName ? '✅ ' + name : name;
                  row.push({ text: label, data: agentPfx('agent:' + name) });
                }
                buttons.push(row);
              }
              if (currentName) {
                buttons.push([{ text: '❌ Deselect agent', data: agentPfx('agent:__deselect__') }]);
              }
              await client.sendButtons(chatId, '🤖 *Agents*' + (currentName ? ' (current: `' + currentName + '`)' : ''), buttons);
            } catch (e) {
              await client.sendMessage(chatId, '❌ ' + e);
            }
          } else {
            // No active session — show configured custom agents from config
            const g = configStore.raw();
            const custom = g.customAgents ?? [];
            if (custom.length) {
              const lines = custom.map((a: unknown) => {
                const agent = a as { name?: string };
                return '• `' + (agent.name ?? String(a)) + '`';
              });
              await client.sendMessage(chatId, '🤖 *Custom Agents*\n' + lines.join('\n') + '\n\nStart a session first to list all agents.');
            } else {
              await client.sendMessage(chatId, '🤖 No agents configured. Start a session first to list available agents.');
            }
          }
          break;
        }
        if (args[0] && s?.alive) {
          try {
            await s.selectAgent(args[0]);
            await client.sendMessage(chatId, '🤖 Agent: `' + args[0] + '`');
          } catch (e) {
            await client.sendMessage(chatId, '❌ ' + e);
          }
        } else if (args[0]) {
          const c = cfg(chatId);
          c.agent = args[0];
          setCfg(chatId, c);
          await client.sendMessage(chatId, '🤖 Agent `' + args[0] + '` set for next session.');
        }
        break;
      }
      case '/plan': {
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await getSession(chatId);
          return handleCommand(text, chatId, msgId);
        }
        try {
          if (args[0] === 'show') {
            const p = await s.readPlan();
            await client.sendMessage(chatId, p?.content ? '📋 ' + p.content.slice(0, 3800) : '📋 No plan.');
          } else if (args[0] === 'delete') {
            await s.deletePlan();
            await client.sendMessage(chatId, '🗑 Plan deleted.');
          } else if (argStr) {
            await s.setMode('plan');
            await handlePrompt(chatId, msgId, argStr);
          } else {
            const cur = await s.getMode();
            const next = cur === 'plan' ? 'interactive' : 'plan';
            await s.setMode(next);
            await client.sendMessage(chatId, next === 'plan' ? '📋 Plan mode ON' : '⚡ Interactive');
          }
        } catch (e) {
          await client.sendMessage(chatId, '❌ ' + e);
        }
        break;
      }
      case '/fleet': {
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await client.sendMessage(chatId, 'No session.');
          break;
        }
        try {
          const r = await s.startFleet(argStr || undefined);
          await client.sendMessage(chatId, '🚀 Fleet: ' + JSON.stringify(r));
        } catch (e) {
          await client.sendMessage(chatId, '❌ ' + e);
        }
        break;
      }
      case '/compact': {
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await client.sendMessage(chatId, 'No session.');
          break;
        }
        try {
          client.setReaction(chatId, msgId, '👍').catch(() => {});
          client.sendTyping(chatId);
          const r = await s.compact();
          const info = contextInfoMap.get(chatId);
          const pct = info ? ' (' + Math.round((info.currentTokens / info.tokenLimit) * 100) + '% used)' : '';
          client.setReaction(chatId, msgId, '✅').catch(() => {});
          await client.sendMessage(chatId, '🗜️ Compacted — ' + (r?.tokensFreed ?? 0) + ' tokens freed' + pct);
        } catch (e) {
          await client.sendMessage(chatId, '❌ ' + e);
        }
        break;
      }
      case '/context': {
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await client.sendMessage(chatId, 'No session.');
          break;
        }
        const msgs = await s.getMessages();
        const types: Record<string, number> = {};
        for (const m of msgs) types[m.type] = (types[m.type] ?? 0) + 1;
        const lines = ['📊 *Context* (' + msgs.length + ' events)'];
        for (const [t, n] of Object.entries(types)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10))
          lines.push('  `' + t + '`: ' + n);
        await client.sendMessage(chatId, lines.join('\n'));
        break;
      }
      case '/usage': {
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await client.sendMessage(chatId, 'No session.');
          break;
        }
        try {
          const q = await s.getQuota();
          const snaps = q?.quotaSnapshots;
          const lines: string[] = [];
          if (snaps && typeof snaps === 'object') {
            for (const [name, snap] of Object.entries(snaps) as [string, any][]) {
              const used = snap.usedRequests ?? 0;
              const total = snap.entitlementRequests ?? 0;
              const pct = snap.remainingPercentage ?? 100;
              const reset = snap.resetDate ? new Date(snap.resetDate).toLocaleDateString() : '';
              lines.push(`*${name}*: ${used}/${total} used · ${pct}% remaining${reset ? ' · resets ' + reset : ''}`);
            }
          }
          // Add context info if available
          const ci = contextInfoMap.get(chatId);
          if (ci) {
            const pct = ci.tokenLimit ? Math.round((ci.currentTokens / ci.tokenLimit) * 100) : 0;
            lines.push(`📊 ${pct}% context · ${ci.messagesLength} msgs`);
          }

          if (lines.length) {
            await client.sendMessage(chatId, '📊 *Usage*\n' + lines.join('\n'));
          } else {
            await client.sendMessage(chatId, '📊 No usage data available.');
          }
        } catch (e) {
          await client.sendMessage(chatId, '❌ ' + e);
        }
        break;
      }
      case '/tools': {
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await client.sendMessage(chatId, 'No session.');
          break;
        }
        try {
          const r = await s.listTools();
          const tools = r?.tools ?? [];
          if (tools.length) {
            const lines = tools.slice(0, 30).map((t: ToolInfo) => '• `' + (t.name ?? t) + '`');
            await client.sendMessage(chatId, '🔧 *Tools* (' + tools.length + ')\n' + lines.join('\n'));
          } else await client.sendMessage(chatId, '🔧 No tools.');
        } catch (e) {
          await client.sendMessage(chatId, '❌ ' + e);
        }
        break;
      }
      case '/files': {
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await client.sendMessage(chatId, 'No session.');
          break;
        }
        try {
          if (args[0] === 'read' && args[1]) {
            const content = await s.readFile(args[1]);
            await client.sendMessage(chatId, '📄 `' + args[1] + '`\n```\n' + content.slice(0, 3800) + '\n```');
          } else {
            const files = await s.listFiles();
            const lines = files.slice(0, 40).map((f: string) => '• `' + f + '`');
            await client.sendMessage(chatId, '📂 ' + files.length + ' files\n' + lines.join('\n'));
          }
        } catch (e) {
          await client.sendMessage(chatId, '❌ ' + e);
        }
        break;
      }
      case '/config': {
        await sendConfigMenu(chatId);
        break;
      }
      case '/help':
      default: {
        await client.sendMessage(
          chatId,
          [
            '⚡ *Copilot Remote* v' + version,
            '',
            '*💬 Session*',
            '`/new` — Fresh session',
            '`/stop` — Kill session',
            '`/cd <dir>` — Change working directory',
            '`/status` — Model, mode, cwd, quota',
            '`/compact` — Compress context window',
            '`/abort` — Cancel current request',
            '',
            '*🧠 Modes*',
            '`/plan [task]` — Toggle plan mode or plan a task',
            '`/fleet [task]` — Spawn parallel sub-agents',
            '',
            '*💻 Coding*',
            '`/research <topic>` — Deep research',
            '`/diff` — Show uncommitted changes',
            '`/review` — Code review current changes',
            '`/init` — Generate copilot-instructions.md',
            '',
            '*🔧 Tools & Agents*',
            '`/agent [name]` — Switch or list agents',
            '`/tools` — List available tools',
            '`/files` — Browse workspace files',
            '`/usage` — Token quota info',
            '',
            '*⚙️ Config*',
            '`/config` — Settings menu (model, mode, security, display)',
            '`/yes` `/no` — Approve/deny tool permission',
            '',
            '*📎 Tips*',
            '• Send images, files, or voice messages',
            '• Reply to a message to provide context',
            '• Use topics for separate workspaces',
          ].join('\n'),
        );
        break;
      }
    }
  }

  // ── Config menu ──
  async function sendConfigMenu(chatId: string, editId?: number) {
    const c = cfg(chatId);
    // Prefix callback data with session key so callbacks in topics resolve correctly
    // Telegram doesn't include message_thread_id in callback_query.message
    const pfx = (d: string) => `@${chatId}|${d}`;

    // Get current mode from config (not session — session may be killed during mode switch)
    const mode = c.mode ?? 'interactive';
    const globalCfg = configStore.raw();

    const MODE_STYLES: Record<string, string> = {
      interactive: 'primary',
      plan: 'success',
      autopilot: 'danger',
    };
    const MODE_BTN_LABELS: Record<string, string> = {
      interactive: '⚡ Ask',
      plan: '📋 Plan',
      autopilot: '🚀 Auto',
    };
    const modeBtn = (m: string) => ({
      text: MODE_BTN_LABELS[m] ?? m,
      data: pfx('mode:' + m),
      ...(m === mode ? { style: MODE_STYLES[m] } : {}),
    });
    const text =
      '⚙️ *Settings*\nModel: `' +
      c.model +
      '`\n' +
      (c.autopilot ? '🟢 Autopilot' : '🔴 Ask before acting') +
      (c.agent ? '\nAgent: `' + c.agent + '`' : '') +
      (globalCfg.provider ? '\nProvider: Custom (' + globalCfg.provider.baseUrl + ')' : '') +
      (globalCfg.mcpServers ? '\nMCP: ' + Object.keys(globalCfg.mcpServers).length + ' servers' : '');
    const buttons = [
      [{
        text: c.autopilot ? '🟢 Autopilot ON' : '🔴 Autopilot OFF',
        data: pfx('cfg:autopilot'),
        style: c.autopilot ? 'danger' : 'primary',
      }],
      [{ text: '🤖 Change Model', data: pfx('cfg:modelPicker') }],
      [{ text: '🧠 Reasoning: ' + (c.reasoningEffort || 'Default'), data: pfx('cfg:reasoning') }],
      [{ text: '📨 Messages: ' + (c.messageMode || 'Default'), data: pfx('cfg:messageMode') }],
      [
        {
          text: '🔧 Tools' + (c.excludedTools?.length ? ': ' + c.excludedTools.length + ' disabled' : ''),
          data: pfx('cfg:tools'),
        },
      ],
      [{ text: '🔒 Tool Security', data: pfx('cfg:security') }],
      [{ text: '🎨 Display', data: pfx('cfg:display') }],
      [{ text: '📊 Usage', data: pfx('cfg:usage') }],
    ];
    if (editId) {
      await client.editButtons(chatId, editId, text, buttons);
    } else {
      await client.sendButtons(chatId, text, buttons);
    }
  }

  async function sendToolsMenu(chatId: string, editId: number) {
    const c = cfg(chatId);
    const pfx = (d: string) => `@${chatId}|${d}`;

    // Get tool list - need a session
    let tools: string[] = [];
    const s = sessions.get(chatId);
    if (s?.alive) {
      try {
        const r = await s.listTools();
        tools = (r?.tools ?? []).map((t: any) => t.name).filter(Boolean);
      } catch {
        /* ignore */
      }
    }

    if (!tools.length) {
      await client.editButtons(
        chatId,
        editId,
        '🔧 *Tools*\nSend a message first to start a session, then open Tools.',
        [[{ text: '← Back', data: pfx('cfg:back') }]],
      );
      return;
    }

    const excluded = new Set(c.excludedTools ?? []);
    // 2 tools per row
    const buttons: any[][] = [];
    for (let i = 0; i < tools.length; i += 2) {
      buttons.push(
        tools.slice(i, i + 2).map((t) => ({
          text: t,
          data: pfx('tool:' + t),
          ...(excluded.has(t) ? {} : { style: 'success' }),
        })),
      );
    }
    buttons.push([{ text: '← Back', data: pfx('cfg:back') }]);

    const excludedCount = excluded.size;
    await client.editButtons(
      chatId,
      editId,
      '🔧 *Tools* (' + tools.length + ')' + (excludedCount ? '\n' + excludedCount + ' disabled' : '\nAll enabled'),
      buttons,
    );
  }

  async function sendReasoningMenu(chatId: string, editId: number) {
    const c = cfg(chatId);
    const pfx = (d: string) => `@${chatId}|${d}`;
    // Ensure models are cached
    if (!cachedModels.length) {
      const s = sessions.get(chatId);
      if (s?.alive) {
        try { cachedModels = await s.listModels(); } catch { /* ignore */ }
      }
    }
    // Find current model's supported reasoning efforts
    const modelInfo = cachedModels.find((m) => (m.id ?? m.name) === c.model);
    const supported: string[] = modelInfo?.supportedReasoningEfforts ?? [];
    if (!supported.length) {
      await client.editButtons(
        chatId,
        editId,
        '🧠 *Reasoning Effort*\n⚠️ ' + c.model + ' does not support reasoning effort.',
        [[{ text: '← Back', data: pfx('cfg:back') }]],
      );
      return;
    }
    const labels: Record<string, string> = {
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      xhigh: 'XHigh',
    };
    const levels = ['', ...supported];
    const allLabels: Record<string, string> = { '': 'Default', ...labels };
    const current = c.reasoningEffort || '';
    const buttons = levels.map((l) => [
      {
        text: allLabels[l] ?? l,
        data: pfx('reason:' + (l || 'default')),
        ...(l === current ? { style: 'success' } : {}),
      },
    ]);
    const defaultNote = modelInfo?.defaultReasoningEffort ? ` (default: ${modelInfo.defaultReasoningEffort})` : '';
    buttons.push([{ text: '← Back', data: pfx('cfg:back') }]);
    await client.editButtons(
      chatId,
      editId,
      '🧠 *Reasoning Effort*' + defaultNote + '\nHigher = smarter but slower/costlier:',
      buttons,
    );
  }

  async function sendDisplayMenu(chatId: string, editId: number) {
    const c = cfg(chatId);
    const pfx = (d: string) => `@${chatId}|${d}`;
    const toggle = (on: boolean, label: string, data: string) => ({
      text: label,
      data,
      ...(on ? { style: 'success' } : {}),
    });
    const buttons = [
      [toggle(c.showThinking, 'Thinking', pfx('dsp:showThinking')), toggle(c.showTools, 'Tools', pfx('dsp:showTools'))],
      [toggle(c.showReactions, 'Reactions', pfx('dsp:showReactions'))],
      [toggle(c.infiniteSessions !== false, 'Infinite Sessions', pfx('dsp:infiniteSessions'))],
      [{ text: '← Back', data: pfx('cfg:back') }],
    ];
    await client.editButtons(chatId, editId, '🎨 *Display*\nToggle what shows in responses:', buttons);
  }

  async function sendSecurityMenu(chatId: string, editId: number) {
    const c = cfg(chatId);
    const pfx = (d: string) => `@${chatId}|${d}`;
    const buttons: { text: string; data: string; style?: string }[][] = [];
    for (const [kind, label] of Object.entries(PERM_KIND_LABELS)) {
      const on = c.autoApprove[kind as PermKind];
      buttons.push([{ text: label, data: pfx('sec:' + kind), ...(on ? { style: 'success' } : {}) }]);
    }
    const allOn = Object.values(c.autoApprove).every(Boolean);
    buttons.push([
      {
        text: allOn ? 'Revoke All' : 'Approve All',
        data: pfx('sec:toggle-all'),
        ...(allOn ? { style: 'danger' } : { style: 'success' }),
      },
    ]);
    buttons.push([{ text: '← Back', data: pfx('cfg:back') }]);
    await client.editButtons(chatId, editId, '🔒 *Tool Security*\nAuto-approve by type:', buttons);
  }

  async function sendModelPicker(chatId: string, editId: number) {
    const c = cfg(chatId);
    const pfx = (d: string) => `@${chatId}|${d}`;
    // Ensure we have models cached - create session if needed
    if (!cachedModels.length) {
      try {
        let s = sessions.get(chatId);
        if (!s?.alive) s = await getSession(chatId);
        cachedModels = await s.listModels();
        log.info(
          'Models:',
          cachedModels.map((m) => m.id ?? m.name ?? m),
        );
      } catch {
        /* ignore */
      }
    }
    const modelIds = cachedModels.length
      ? cachedModels.map((m) => m.id ?? m.name ?? String(m)).filter(Boolean)
      : ['claude-sonnet-4', 'gpt-5.2', 'gemini-3-pro-preview'];
    const buttons: { text: string; data: string }[][] = [];
    for (let i = 0; i < modelIds.length; i += 2) {
      buttons.push(
        modelIds
          .slice(i, i + 2)
          .map((m: string) => ({ text: m, data: pfx('model:' + m), ...(m === c.model ? { style: 'success' } : {}) })),
      );
    }
    buttons.push([{ text: '← Back', data: pfx('cfg:back') }]);
    await client.editButtons(chatId, editId, '🤖 *Select Model*', buttons);
  }

  // ── Callbacks ──
  client.onReaction = async (emoji, rawChatId, msgId, threadId) => {
    const chatId = threadId ? sessionKey(rawChatId, threadId) : rawChatId;
    if (!pendingPerms.has(msgId)) return;
    const s = sessions.get(chatId);
    if (!s?.alive) return;
    if (emoji === '👍' || emoji === '✅') {
      s.approve();
      pendingPerms.delete(msgId);
      await client.editButtons(chatId, msgId, '✅ Approved', []);
    } else if (emoji === '👎' || emoji === '❌') {
      s.deny();
      pendingPerms.delete(msgId);
      await client.editButtons(chatId, msgId, '❌ Denied', []);
    }
  };

  // ── File handler — download and pass to Copilot ──
  client.onFile = async (fileId, fileName, caption, rawChatId, msgId, threadId) => {
    const chatId = threadId ? sessionKey(rawChatId, threadId) : rawChatId;
    if (!client.getFileUrl) return;
    const url = await client.getFileUrl(fileId);
    if (!url) {
      await client.sendMessage(chatId, '❌ Could not download file.');
      return;
    }
    // Download to temp and tell Copilot about it
    try {
      const res = await fetch(url);
      const buffer = Buffer.from(await res.arrayBuffer());
      const tmpDir = '/tmp/copilot-remote';
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpPath = tmpDir + '/' + fileName;
      fs.writeFileSync(tmpPath, buffer);

      // Voice message transcription
      if (fileName.endsWith('.oga') || fileName.endsWith('.ogg')) {
        try {
          const wavPath = tmpPath.replace(/\.(oga|ogg)$/, '.wav');
          execSync('ffmpeg -y -i ' + JSON.stringify(tmpPath) + ' ' + JSON.stringify(wavPath), { timeout: 10000 });
          // Use Gemini for transcription (free)
          const transcript = execSync(
            'gemini -p "Transcribe this audio file exactly. Return ONLY the transcription text, nothing else." ' +
              JSON.stringify(wavPath),
            { timeout: 30000, encoding: 'utf-8' },
          ).trim();
          if (transcript) {
            const prompt = caption ? caption + '\n\n(Voice transcription: ' + transcript + ')' : transcript;
            await handlePrompt(chatId, msgId, prompt);
            return;
          }
        } catch (e) {
          log.debug('Voice transcription failed:', e);
          // Fall through to file-based handling
        }
      }

      // Check if it's an image file — use SDK attachments for vision support
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
      const isImage = imageExts.some((ext) => fileName.toLowerCase().endsWith(ext));

      if (isImage) {
        const prompt = caption || 'Describe this image.';
        const attachments: FileAttachment[] = [{ type: 'file' as const, path: tmpPath }];
        await handlePrompt(chatId, msgId, prompt, attachments);
        return;
      }

      const prompt = caption
        ? caption + '\n\n[Attached file: ' + tmpPath + ']'
        : 'I sent you a file: ' + tmpPath + '\nPlease read and analyze it.';
      await handlePrompt(chatId, msgId, prompt);
    } catch (e) {
      await client.sendMessage(chatId, '❌ ' + String(e));
    }
  };

  // ── Inline query handler — one-shot answers from any chat ──
  client.onInlineQuery = async (queryId, query) => {
    if (!client.answerInlineQuery) return;
    // Try to get a one-shot answer from Copilot within Telegram's inline timeout
    try {
      const s = new Session();
      await s.start({ cwd: config.workDir, binary: bin, githubToken: config.githubToken });
      const res = await Promise.race([
        s.send(query),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 12000)),
      ]);
      s.kill();
      if (res?.content) {
        const answer = res.content.slice(0, 4000);
        const title = answer.slice(0, 60).replace(/\n/g, ' ');
        await client.answerInlineQuery(queryId, [
          {
            type: 'article',
            id: '1',
            title: '✅ ' + title,
            description: answer.slice(0, 200),
            input_message_content: { message_text: answer },
          },
        ]);
        return;
      }
    } catch {
      // Timeout or error — fall back to echo
    }
    await client.answerInlineQuery(queryId, [
      {
        type: 'article',
        id: '1',
        title: '💬 Ask Copilot: ' + query.slice(0, 50),
        description: 'Send this question to Copilot',
        input_message_content: { message_text: query },
      },
    ]);
  };

  client.onCallback = async (callbackId, data, rawChatId, msgId, threadId) => {
    // Always answer callback to dismiss loading spinner
    client.answerCallback?.(callbackId);

    // Extract session key from callback data prefix: @sessionKey|actualData
    let chatId: string;
    if (data.startsWith('@') && data.includes('|')) {
      const pipeIdx = data.indexOf('|');
      chatId = data.slice(1, pipeIdx);
      data = data.slice(pipeIdx + 1);
    } else {
      // Legacy callbacks or permission buttons without prefix
      chatId = threadId ? sessionKey(rawChatId, threadId) : rawChatId;
    }

    if (data.startsWith('perm:')) {
      const s = sessions.get(chatId);
      if (!s?.alive) return;
      if (data === 'perm:all') {
        // Approve all pending prompts in this chat (doesn't switch mode)
        s.approve();
        for (const [id, cid] of pendingPerms) {
          if (cid === chatId) {
            s.approve();
            pendingPerms.delete(id);
            if (id !== msgId) client.editButtons(chatId, id, '✅', []).catch(() => {});
          }
        }
        await client.editButtons(chatId, msgId, '✅ All approved', []);
      } else {
        const ok = data === 'perm:yes';
        if (ok) {
          s.approve();
        } else {
          s.deny();
        }
        pendingPerms.delete(msgId);
        await client.editButtons(chatId, msgId, ok ? '✅' : '❌', []);
      }
      return;
    }
    if (data.startsWith('reason:')) {
      const level = data.slice(7) === 'default' ? '' : data.slice(7);
      const c = cfg(chatId);
      c.reasoningEffort = level;
      setCfg(chatId, c);
      // Restart to apply
      const old = sessions.get(chatId);
      const savedId = old?.sessionId ?? sessionStore.get(chatId)?.sessionId;
      if (old?.alive) await old.disconnect();
      sessions.delete(chatId);
      if (savedId) {
        const s = new Session();
        try {
          await s.resume(savedId, {
            cwd: workDir(chatId),
            binary: bin,
            model: c.model,
            autopilot: c.autopilot,
            reasoningEffort: level as 'low' | 'medium' | 'high' | 'xhigh',
          });
          sessions.set(chatId, s);
        } catch {
          sessionStore.delete(chatId);
          await getSession(chatId);
        }
      }
      return sendConfigMenu(chatId, msgId);
    }
    if (data.startsWith('input:')) {
      const answer = data.slice(6);
      const s = sessions.get(chatId);
      if (s?.alive) s.answerInput(answer);
      await client.editButtons(chatId, msgId, '❓ → ' + answer, []);
      return;
    }
    // Agent selection from /agent button menu
    if (data.startsWith('agent:')) {
      const agentName = data.slice(6);
      const s = sessions.get(chatId);
      if (!s?.alive) {
        await client.editButtons(chatId, msgId, '❌ No active session.', []);
        return;
      }
      try {
        if (agentName === '__deselect__') {
          await s.deselectAgent();
          await client.editButtons(chatId, msgId, '🤖 Agent deselected.', []);
        } else {
          await s.selectAgent(agentName);
          await client.editButtons(chatId, msgId, '🤖 Agent: `' + agentName + '`', []);
        }
      } catch (e) {
        await client.editButtons(chatId, msgId, '❌ ' + e, []);
      }
      return;
    }
    if (data === 'cfg:reasoning') return sendReasoningMenu(chatId, msgId);
    if (data === 'cfg:display') return sendDisplayMenu(chatId, msgId);
    if (data === 'cfg:security') return sendSecurityMenu(chatId, msgId);
    if (data === 'cfg:modelPicker') return sendModelPicker(chatId, msgId);
    if (data === 'cfg:usage') {
      const s = sessions.get(chatId);
      const lines: string[] = [];
      if (s?.alive) {
        try {
          const q = await s.getQuota();
          const snaps = q?.quotaSnapshots;
          if (snaps && typeof snaps === 'object') {
            for (const [name, snap] of Object.entries(snaps) as [string, any][]) {
              const used = snap.usedRequests ?? 0;
              const total = snap.entitlementRequests ?? 0;
              const pct = snap.remainingPercentage ?? 100;
              lines.push(`*${name}*: ${used}/${total} · ${pct}% left`);
            }
          }
        } catch { /* ignore */ }
      }
      const ci = contextInfoMap.get(chatId);
      if (ci) {
        const pct = ci.tokenLimit ? Math.round((ci.currentTokens / ci.tokenLimit) * 100) : 0;
        lines.push(`📊 ${pct}% context · ${ci.messagesLength} msgs`);
      }
      const lu = lastUsageMap.get(chatId);
      if (lu) {
        const parts: string[] = [];
        if (lu.model) parts.push('Model: `' + lu.model + '`');
        if (lu.inputTokens || lu.outputTokens) parts.push(`Last: ${lu.inputTokens ?? 0}→${lu.outputTokens ?? 0} tokens`);
        if (lu.cacheReadTokens) parts.push(`Cache: ${lu.cacheReadTokens} read`);
        if (lu.duration) parts.push(`Time: ${(lu.duration / 1000).toFixed(1)}s`);
        lines.push(parts.join(' · '));
      }
      await client.editButtons(
        chatId, msgId,
        '📊 *Usage*\n' + (lines.length ? lines.join('\n') : 'No data yet — send a message first.'),
        [[{ text: '← Back', data: `@${chatId}|cfg:back` }]],
      );
      return;
    }
    if (data === 'cfg:back') return sendConfigMenu(chatId, msgId);
    if (data === 'cfg:messageMode') {
      const c = cfg(chatId);
      const cycle: Array<'' | 'enqueue' | 'immediate'> = ['', 'enqueue', 'immediate'];
      const idx = cycle.indexOf(c.messageMode || '');
      c.messageMode = cycle[(idx + 1) % cycle.length];
      setCfg(chatId, c);
      // Update session if alive
      const s = sessions.get(chatId);
      if (s?.alive) s.messageMode = c.messageMode || undefined;
      return sendConfigMenu(chatId, msgId);
    }
    if (data === 'cfg:tools') {
      return sendToolsMenu(chatId, msgId);
    }
    if (data.startsWith('tool:')) {
      const toolName = data.slice(5);
      const c = cfg(chatId);
      const excluded = new Set(c.excludedTools ?? []);
      if (excluded.has(toolName)) {
        excluded.delete(toolName);
      } else {
        excluded.add(toolName);
      }
      c.excludedTools = [...excluded];
      setCfg(chatId, c);
      // Re-render first (session still alive to list tools), then kill session
      await sendToolsMenu(chatId, msgId);
      // Kill existing session so next message picks up new tool config
      const old = sessions.get(chatId);
      if (old?.alive) await old.disconnect();
      sessions.delete(chatId);
      return;
    }
    if (data.startsWith('model:')) {
      const c = cfg(chatId);
      c.model = data.slice(6);
      setCfg(chatId, c);
      const s = sessions.get(chatId);
      if (s?.alive)
        try {
          await s.setModel(c.model);
        } catch {
          /* ignore */
        }
      return sendConfigMenu(chatId, msgId);
    }
    if (data.startsWith('dsp:')) {
      const key = data.slice(4) as keyof ChatConfig;
      const c = cfg(chatId);
      if (key === 'infiniteSessions') {
        c.infiniteSessions = c.infiniteSessions === false ? undefined : false;
        setCfg(chatId, c);
        return sendDisplayMenu(chatId, msgId);
      }
      const rec = c as unknown as Record<string, unknown>;
      if (key in c && typeof rec[key] === 'boolean') {
        rec[key] = !rec[key];
        setCfg(chatId, c);
        const label = key.replace('show', '');
        const state = rec[key] ? '✅ ON' : '⬜ OFF';
        client.answerCallback?.(callbackId, label + ': ' + state);
      }
      return sendDisplayMenu(chatId, msgId);
    }
    if (data.startsWith('sec:')) {
      const c = cfg(chatId);
      if (data === 'sec:toggle-all') {
        const allOn = Object.values(c.autoApprove).every(Boolean);
        for (const k of Object.keys(c.autoApprove)) c.autoApprove[k as PermKind] = !allOn;
      } else {
        const kind = data.slice(4) as PermKind;
        c.autoApprove[kind] = !c.autoApprove[kind];
      }
      setCfg(chatId, c);
      return sendSecurityMenu(chatId, msgId);
    }
    if (data === 'cfg:autopilot') {
      const c = cfg(chatId);
      c.autopilot = !c.autopilot;
      c.mode = c.autopilot ? 'autopilot' : 'interactive';
      setCfg(chatId, c);
      // Kill old session — next message will create a fresh one with new config
      const old = sessions.get(chatId);
      if (old?.alive) { await old.disconnect(); }
      sessions.delete(chatId);
      sessionStore.delete(chatId);
      return sendConfigMenu(chatId, msgId);
    }
    if (data.startsWith('mode:')) {
      const newMode = data.slice(5) as 'interactive' | 'plan' | 'autopilot';
      const c = cfg(chatId);
      log.debug(`Mode switch: ${c.mode} → ${newMode} [${chatId}]`);
      c.mode = newMode;
      c.autopilot = newMode === 'autopilot';
      setCfg(chatId, c);
      // Kill old session — next message will create a fresh one with new config
      const old = sessions.get(chatId);
      if (old?.alive) {
        log.debug(`Killing session for mode switch [${chatId}]`);
        await old.disconnect();
      }
      sessions.delete(chatId);
      sessionStore.delete(chatId);
      log.info(`Mode: ${newMode} [${chatId}]`);
      return sendConfigMenu(chatId, msgId);
    }
    if (data.startsWith('cfg:')) {
      const key = data.slice(4) as keyof ChatConfig;
      const c = cfg(chatId);
      const rec = c as unknown as Record<string, unknown>;
      if (key in c && typeof rec[key] === 'boolean') {
        rec[key] = !rec[key];
        setCfg(chatId, c);
        if (key === 'autopilot') {
          const s = sessions.get(chatId);
          if (s?.alive) s.autopilot = c.autopilot;
        }
        return sendConfigMenu(chatId, msgId);
      }
    }
  };

  // ── Shutdown ──
  const shutdown = async () => {
    client.stop();
    await Promise.allSettled([...sessions.values()].map((s) => s.disconnect().catch(() => {})));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());

  await client.start();
}

main().catch((e) => {
  log.error('Fatal:', e);
  process.exit(1);
});
