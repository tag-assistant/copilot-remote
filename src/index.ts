// Copilot Remote — Telegram ↔ Copilot SDK bridge
import { Session } from './session.js';
import type {
  QuotaSnapshot,
  QuotaResponse,
  AgentInfo,
  AgentListResponse,
  CurrentAgentResponse,
  CurrentModelResponse,
  CompactResponse,
  PlanResponse,
  ToolInfo,
  ToolsListResponse,
  SessionMessage,
} from './session.js';
import type { Client, MessageOptions, Button } from './client.js';
import type { ModelInfo, PermissionRequest } from '@github/copilot-sdk';
import { TelegramClient } from './telegram.js';
import { SessionStore } from './store.js';
import { ConfigStore, type ChatConfig, type PermKind } from './config-store.js';
import { log } from './log.js';
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
}

/** User input request from the agent */
interface UserInputRequest {
  question: string;
  choices?: string[];
}

/** ChatConfig boolean keys for dynamic toggle */
type ChatConfigBooleanKey = 'showUsage' | 'showThinking' | 'showTools' | 'showReactions' | 'autopilot';

/** Reasoning effort level (including 'none' for disabled) */
type ReasoningEffortLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

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
    prompt: (a) => 'Research this topic thoroughly using web search and GitHub: ' + a,
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
  const botToken = await ensureBotToken(config);
  const bin = config.copilotBinary ?? findBin('copilot');

  log.info('⚡ Copilot Remote v' + version + ' | dir: ' + config.workDir);

  const client: Client = new TelegramClient({ botToken, allowedUsers: config.allowedUsers });

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

  const workDir = (id: string) => workDirs.get(id) ?? config.workDir;

  // Get or create session
  async function getSession(chatId: string): Promise<Session> {
    let s = sessions.get(chatId);
    if (s?.alive) return s;

    s = new Session();
    const c = cfg(chatId);
    const opts = {
      cwd: workDir(chatId),
      binary: bin,
      model: c.model,
      autopilot: c.autopilot,
      reasoningEffort:
        c.reasoningEffort !== 'none' ? (c.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh') : undefined,
      agent: c.agent ?? undefined,
      topicContext: client.getTopicName?.(chatId),
      githubToken: config.githubToken,
    };

    // Try to resume a saved session
    const saved = sessionStore.get(chatId);
    if (saved?.sessionId) {
      try {
        await s.resume(saved.sessionId, opts);
        sessionStore.touch(chatId);
        sessions.set(chatId, s);
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
    sessions.set(chatId, s);
    return s;
  }

  // ── Prompt handler (streaming + reactions) ──
  async function handlePrompt(chatId: string, msgId: number, prompt: string): Promise<void> {
    let session: Session;
    try {
      session = await getSession(chatId);
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? String(err);
      // If reasoning effort not supported, retry without it
      if (msg.includes('reasoning effort')) {
        const c = cfg(chatId);
        c.reasoningEffort = 'none';
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
    const react = c.showReactions ? (e: string) => client.setReaction(chatId, msgId, e) : async () => {};
    await react('🤔');
    await client.sendTyping(chatId);
    // Keep typing indicator alive every 4s while processing
    const typingInterval = setInterval(() => client.sendTyping(chatId), 4000);

    let streamMsgId: number | null = null;
    let draftId: number | null = null;
    let useDraft = !!client.sendDraft; // try draft mode if client supports it
    let thinkingText = '',
      responseText = '';
    const toolLines: string[] = [];
    let lastEdit = 0,
      timer: NodeJS.Timeout | null = null;
    const THROTTLE = useDraft ? 400 : 1200; // drafts can update faster

    const display = () => {
      const p: string[] = [];
      if (thinkingText) {
        const s = thinkingText.length > 300 ? '...' + thinkingText.slice(-300) : thinkingText;
        p.push('💭 _' + s.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&') + '_');
      }
      if (toolLines.length) p.push(toolLines.join('\n'));
      if (responseText) p.push(responseText);
      return p.join('\n\n');
    };

    const flush = async () => {
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
        if (text.length < 15) return;
        streamMsgId = await client.sendMessage(chatId, text, { disableLinkPreview: true });
      } else {
        await client.editMessage(chatId, streamMsgId, text);
      }
    };

    const schedEdit = () => {
      if (!timer) timer = setTimeout(flush, Math.max(0, THROTTLE - (Date.now() - lastEdit)));
    };

    const onThink = (t: string) => {
      if (c.showThinking) {
        thinkingText += t;
        schedEdit();
      }
    };
    const onDelta = (t: string) => {
      thinkingText = '';
      responseText += t;
      schedEdit();
    };
    const onToolStart = (t: ToolEvent) => {
      client.sendTyping(chatId);
      react('👨‍💻');
      if (!c.showTools) return;
      const label = TOOL_LABELS[t.toolName] ?? '🔧 ' + t.toolName;
      let detail = '';
      if (t.arguments?.command) detail = ' `' + t.arguments.command.slice(0, 60) + '`';
      else if (t.arguments?.file_path) detail = ' `' + t.arguments.file_path + '`';
      toolLines.push(label + detail);
      schedEdit();
    };
    const onToolEnd = (t: ToolEvent) => {
      if (!c.showTools || !toolLines.length) return;
      toolLines[toolLines.length - 1] += t.success !== false ? ' ✓' : ' ✗';
      schedEdit();
    };
    const onPerm = async (req: PermissionRequest) => {
      const p = (req as PermissionRequest & { permissionRequest?: PermissionRequest }).permissionRequest ?? req;
      const kind = p.kind as PermKind;

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
      const question = req.question ?? String(req);
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
    session.on('tool_start', onToolStart);
    session.on('tool_complete', onToolEnd);
    session.on('permission_request', onPerm);
    session.on('user_input_request', onUserInput);
    session.on('permission_timeout', () => {
      // Clean up expired permission prompts for this chat
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

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      session.off('thinking', onThink);
      session.off('delta', onDelta);
      session.off('tool_start', onToolStart);
      session.off('tool_complete', onToolEnd);
      session.off('permission_request', onPerm);
      session.off('user_input_request', onUserInput);
    };

    try {
      const res = await session.send(prompt);
      cleanup();
      clearInterval(typingInterval);

      let final = res.content;
      if (c.showUsage) {
        try {
          const q = await session.getQuota();
          const s = q?.quotaSnapshots?.[0];
          if (s)
            final +=
              '\n\n`' + s.usedRequests + '/' + s.entitlementRequests + ' reqs (' + s.remainingPercentage + '% left)`';
        } catch {
          /* ignore */
        }
      }

      // Finalize: send the complete response
      if (draftId) {
        // Draft mode: send real message to replace the draft preview
        await client.sendMessage(chatId, final, { disableLinkPreview: true });
      } else if (streamMsgId && final.length <= 4096) {
        await client.editMessage(chatId, streamMsgId, final);
      } else if (streamMsgId) {
        await client.editMessage(chatId, streamMsgId, final.slice(0, 4096));
        await client.sendMessage(chatId, final.slice(4096), { disableLinkPreview: true });
      } else {
        await client.sendMessage(chatId, final, { disableLinkPreview: true });
      }
      await client.removeReaction(chatId, msgId);
    } catch (err) {
      cleanup();
      clearInterval(typingInterval);
      await react('😱');
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
      const s = sessions.get(chatId);
      if (!s?.alive) {
        await getSession(chatId);
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

        try {
          const q = await s.getQuota();
          const snap = q?.quotaSnapshots?.[0];
          if (snap)
            lines.push(
              '📊 ' +
                snap.usedRequests +
                '/' +
                snap.entitlementRequests +
                ' reqs (' +
                snap.remainingPercentage +
                '% left)',
            );
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
        if (!args[0] && s?.alive) {
          try {
            const r = await s.listAgents();
            const agents = r?.agents ?? [];
            const lines = agents.length
              ? agents.map((a: AgentInfo) => '• `' + (a.name ?? a) + '`')
              : ['No agents found.'];
            await client.sendMessage(chatId, '🤖 *Agents*\n' + lines.join('\n'));
          } catch (e) {
            await client.sendMessage(chatId, '❌ ' + e);
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
          const r = await s.compact();
          await client.sendMessage(chatId, '🗜️ ' + (r?.tokensFreed ?? 0) + ' tokens freed');
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
          if (Array.isArray(snaps)) {
            const lines = snaps.map(
              (s: QuotaSnapshot) =>
                '• ' + s.usedRequests + '/' + s.entitlementRequests + ' (' + s.remainingPercentage + '% left)',
            );
            await client.sendMessage(chatId, '📊 *Usage*\n' + lines.join('\n'));
          } else await client.sendMessage(chatId, '📊 ' + JSON.stringify(q).slice(0, 300));
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
            '⚡ *Copilot Remote*',
            '',
            '*Session*',
            '`/new` — Fresh session',
            '`/stop` — Kill session',
            '`/cd <dir>` — Change directory (restarts)',
            '`/status` — Model, mode, cwd, quota',
            '`/compact` — Compress context',
            '',
            '*Modes*',
            '`/plan [task]` — Plan mode (toggle or plan)',
            '`/fleet [task]` — Parallel sub-agents',
            '',
            '*Coding*',
            '`/research <topic>` — Deep research',
            '`/diff` — Uncommitted changes',
            '`/review` — Code review',
            '`/init` — Generate copilot-instructions.md',
            '',
            '*Tools*',
            '`/agent [name]` — Switch agent',
            '`/tools` — List available tools',
            '`/files` — Browse workspace',
            '`/usage` — Quota info',
            '',
            '*Other*',
            '`/config` — Settings (model, mode, security, display)',
            '`/abort` — Cancel current request',
            '`/yes` `/no` — Approve/deny permission',
          ].join('\n'),
        );
        break;
      }
    }
  }

  // ── Config menu ──
  async function sendConfigMenu(chatId: string, editId?: number) {
    const c = cfg(chatId);
    const s = sessions.get(chatId);

    // Get current mode
    let mode = 'interactive';
    if (s?.alive) {
      try {
        mode = await s.getMode();
      } catch {
        /* ignore */
      }
    }

    const modeLabel = (m: string) => (m === mode ? '● ' : '') + (MODE_LABELS[m] ?? m);
    const text =
      '⚙️ *Settings*\nModel: `' +
      c.model +
      '`\nMode: ' +
      modeLabel(mode) +
      (c.agent ? '\nAgent: `' + c.agent + '`' : '');
    const buttons = [
      [
        { text: modeLabel('interactive')!, data: 'mode:interactive' },
        { text: modeLabel('plan')!, data: 'mode:plan' },
        { text: modeLabel('autopilot')!, data: 'mode:autopilot' },
      ],
      [{ text: '🤖 Change Model', data: 'cfg:modelPicker' }],
      [{ text: '🧠 Reasoning: ' + c.reasoningEffort, data: 'cfg:reasoning' }],
      [{ text: '🔒 Tool Security', data: 'cfg:security' }],
      [{ text: '🎨 Display', data: 'cfg:display' }],
    ];
    if (editId) {
      await client.editButtons(chatId, editId, text, buttons);
    } else {
      await client.sendButtons(chatId, text, buttons);
    }
  }

  async function sendReasoningMenu(chatId: string, editId: number) {
    const c = cfg(chatId);
    // Find current model's supported reasoning efforts
    const modelInfo = cachedModels.find((m) => (m.id ?? m.name) === c.model);
    const supported: string[] = modelInfo?.supportedReasoningEfforts ?? [];
    if (!supported.length) {
      await client.editButtons(
        chatId,
        editId,
        '🧠 *Reasoning Effort*\n⚠️ ' + c.model + ' does not support reasoning effort.',
        [[{ text: '← Back', data: 'cfg:back' }]],
      );
      return;
    }
    const labels: Record<string, string> = {
      low: '🐇 Low',
      medium: '⚖️ Medium',
      high: '🧠 High',
      xhigh: '🔥 XHigh',
    };
    const levels = ['none', ...supported];
    const allLabels: Record<string, string> = { none: '⚪ Off', ...labels };
    const buttons = levels.map((l) => [
      { text: (l === c.reasoningEffort ? '● ' : '') + (allLabels[l] ?? l), data: 'reason:' + l },
    ]);
    const defaultNote = modelInfo?.defaultReasoningEffort ? ` (default: ${modelInfo.defaultReasoningEffort})` : '';
    buttons.push([{ text: '← Back', data: 'cfg:back' }]);
    await client.editButtons(
      chatId,
      editId,
      '🧠 *Reasoning Effort*' + defaultNote + '\nHigher = smarter but slower/costlier:',
      buttons,
    );
  }

  async function sendDisplayMenu(chatId: string, editId: number) {
    const c = cfg(chatId);
    const t = (v: boolean) => (v ? '✅' : '⬜');
    const buttons = [
      [
        { text: t(c.showThinking) + ' Thinking', data: 'dsp:showThinking' },
        { text: t(c.showTools) + ' Tools', data: 'dsp:showTools' },
      ],
      [
        { text: t(c.showUsage) + ' Usage', data: 'dsp:showUsage' },
        { text: t(c.showReactions) + ' Reactions', data: 'dsp:showReactions' },
      ],
      [{ text: '← Back', data: 'cfg:back' }],
    ];
    await client.editButtons(chatId, editId, '🎨 *Display*\nToggle what shows in responses:', buttons);
  }

  async function sendSecurityMenu(chatId: string, editId: number) {
    const c = cfg(chatId);
    const t = (v: boolean) => (v ? '✅' : '⬜');
    const buttons: { text: string; data: string }[][] = [];
    for (const [kind, label] of Object.entries(PERM_KIND_LABELS)) {
      buttons.push([{ text: t(c.autoApprove[kind as PermKind]) + ' ' + label, data: 'sec:' + kind }]);
    }
    const allOn = Object.values(c.autoApprove).every(Boolean);
    buttons.push([{ text: allOn ? '🔓 Revoke All' : '✅ Approve All', data: 'sec:toggle-all' }]);
    buttons.push([{ text: '← Back', data: 'cfg:back' }]);
    await client.editButtons(chatId, editId, '🔒 *Tool Security*\nAuto-approve by type:', buttons);
  }

  async function sendModelPicker(chatId: string, editId: number) {
    const c = cfg(chatId);
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
        modelIds.slice(i, i + 2).map((m: string) => ({ text: (m === c.model ? '● ' : '') + m, data: 'model:' + m })),
      );
    }
    buttons.push([{ text: '← Back', data: 'cfg:back' }]);
    await client.editButtons(chatId, editId, '🤖 *Select Model*', buttons);
  }

  // ── Callbacks ──
  client.onReaction = async (emoji, chatId, msgId) => {
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
  client.onFile = async (fileId, fileName, caption, chatId, msgId) => {
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
    // For inline mode, we just return a "Send to Copilot" option
    // that switches to the bot's DM with the query pre-filled
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

    // Resolve session key for topic-aware routing
    const chatId = threadId ? sessionKey(rawChatId, threadId) : rawChatId;

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
      const level = data.slice(7);
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
    if (data === 'cfg:reasoning') return sendReasoningMenu(chatId, msgId);
    if (data === 'cfg:display') return sendDisplayMenu(chatId, msgId);
    if (data === 'cfg:security') return sendSecurityMenu(chatId, msgId);
    if (data === 'cfg:modelPicker') return sendModelPicker(chatId, msgId);
    if (data === 'cfg:back') return sendConfigMenu(chatId, msgId);
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
