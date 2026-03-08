// ============================================================
// Copilot Remote — Main Entry Point
// ============================================================
// Bridges Copilot CLI ↔ Telegram via @github/copilot-sdk.
// Full customization: agents, skills, MCP, prompt files.
// ============================================================

import { Session } from './session.js';
import { TelegramBridge } from './telegram.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

function findBinary(name: string): string {
  try {
    return execSync('which ' + name, { encoding: 'utf-8' }).trim();
  } catch {
    return name;
  }
}

interface Config {
  botToken: string;
  allowedUsers: string[];
  workDir: string;
  copilotBinary?: string;
}

function loadConfig(): Config {
  const configPath = path.join(process.cwd(), '.copilot-remote.json');

  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  }

  const botToken = process.env.COPILOT_REMOTE_BOT_TOKEN;
  const allowedUsers = process.env.COPILOT_REMOTE_ALLOWED_USERS?.split(',').filter(Boolean) ?? [];
  const workDir = process.env.COPILOT_REMOTE_WORKDIR ?? process.cwd();
  const copilotBinary = process.env.COPILOT_REMOTE_BINARY;

  if (!botToken) {
    console.error('Missing bot token. Set COPILOT_REMOTE_BOT_TOKEN or create .copilot-remote.json');
    process.exit(1);
  }

  return { botToken, allowedUsers, workDir, copilotBinary };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const copilotBin = config.copilotBinary ?? findBinary('copilot');

  console.log('╔══════════════════════════════════════╗');
  console.log('║       ⚡ Copilot Remote v0.5.0       ║');
  console.log('╠══════════════════════════════════════╣');
  console.log('║  Copilot CLI ↔ Telegram Bridge       ║');
  console.log('║  @github/copilot-sdk + streaming      ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log('Work dir:', config.workDir);
  console.log('Binary:', copilotBin);
  console.log('Allowed users:', config.allowedUsers.length > 0 ? config.allowedUsers.join(', ') : 'auto-pair first user');
  console.log('');

  const telegram = new TelegramBridge({
    botToken: config.botToken,
    allowedUsers: config.allowedUsers,
  });

  // Per-chat state
  const sessions = new Map<string, Session>();
  const chatWorkDirs = new Map<string, string>();

  // Per-chat config with defaults
  interface ChatConfig {
    showUsage: boolean;
    showThinking: boolean;
    showTools: boolean;
    showReactions: boolean;
    allowAllTools: boolean;
    model: string;
    agent: string | null;
  }
  const defaultConfig: ChatConfig = {
    showUsage: false,
    showThinking: false,
    showTools: false,
    showReactions: true,
    allowAllTools: false,
    model: 'claude-sonnet-4',
    agent: null,
  };

  // Models loaded dynamically from SDK
  let cachedModels: string[] = [];

  const chatConfigs = new Map<string, ChatConfig>();
  const getConfig = (chatId: string): ChatConfig => {
    return chatConfigs.get(chatId) ?? { ...defaultConfig };
  };
  const setConfig = (chatId: string, cfg: ChatConfig) => {
    chatConfigs.set(chatId, cfg);
  };

  telegram.setMessageHandler(async (text: string, chatId: string, messageId: number, replyText?: string) => {
    console.log('[Message] ' + chatId + ': ' + text + (replyText ? ' [reply to: ' + replyText.slice(0, 50) + '...]' : ''));

    if (text.startsWith('/')) {
      await handleCommand(text, chatId, messageId);
      return;
    }

    // If replying to a message, prepend context
    let prompt = text;
    if (replyText) {
      prompt = 'Context (from a previous message I\'m replying to):\n"""\n' + replyText + '\n"""\n\nMy message: ' + text;
    }

    await handlePrompt(chatId, messageId, prompt);
  });

  async function handlePrompt(chatId: string, messageId: number, prompt: string): Promise<void> {
    // Get or create session
    let session = sessions.get(chatId);
    if (!session || !session.alive) {
      session = new Session();
      const workDir = chatWorkDirs.get(chatId) ?? config.workDir;

      try {
        const cfg = getConfig(chatId); await session.start({ cwd: workDir, binary: copilotBin, model: cfg.model, allowAllTools: cfg.allowAllTools, agent: cfg.agent ?? undefined });
        session.allowAllTools = getConfig(chatId).allowAllTools;
        session.model = getConfig(chatId).model;
        sessions.set(chatId, session);
      } catch (err) {
        await telegram.sendMessage(chatId, '❌ Failed to start: ' + String(err));
        return;
      }
    }

    if (session.busy) {
      // Messages queue automatically in ACP mode
      await telegram.sendTyping(chatId);
    }

    // Status reactions on user's message
    const cfg = getConfig(chatId);
    const react = cfg.showReactions ? (emoji: string) => telegram.setReaction(chatId, messageId, emoji) : async (_: string) => {};
    await react('🤔');
    await telegram.sendTyping(chatId);

    // Stream state — one message, continuously edited
    let streamMsgId: number | null = null;
    let thinkingText = '';
    let toolLines: string[] = [];
    let responseText = '';
    let phase: 'thinking' | 'tools' | 'responding' = 'thinking';
    let lastEditTime = 0;
    let editTimer: NodeJS.Timeout | null = null;
    const THROTTLE_MS = 1200;
    const MIN_INITIAL_CHARS = 15;

    const buildDisplay = (): string => {
      const parts: string[] = [];
      if (thinkingText) {
        // Show last ~300 chars of thinking, italic
        const snippet = thinkingText.length > 300 ? '...' + thinkingText.slice(-300) : thinkingText;
        parts.push('💭 _' + snippet.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&') + '_');
      }
      if (toolLines.length > 0) {
        parts.push(toolLines.join('\n'));
      }
      if (responseText) {
        parts.push(responseText);
      }
      return parts.join('\n\n');
    };

    const flushEdit = async () => {
      editTimer = null;
      lastEditTime = Date.now();
      const display = buildDisplay();
      if (!display.trim()) return;

      if (!streamMsgId) {
        if (display.length < MIN_INITIAL_CHARS) return;
        streamMsgId = await telegram.sendMessage(chatId, display, { replyTo: messageId, disableLinkPreview: true });
      } else {
        await telegram.editMessage(chatId, streamMsgId, display);
      }
    };

    const scheduleEdit = () => {
      if (editTimer) return;
      const delay = Math.max(0, THROTTLE_MS - (Date.now() - lastEditTime));
      editTimer = setTimeout(flushEdit, delay);
    };

    // Tool type classification for reactions
    const codingTools = ['bash', 'exec', 'read_file', 'edit_file', 'create_file', 'delete_file', 'write_file', 'list_dir', 'view'];
    const webTools = ['web_search', 'web_fetch', 'browser'];

    const prettyTool: Record<string, string> = {
      read_file: '📖 Read', edit_file: '✏️ Edit', create_file: '📝 Create',
      bash: '▶️ Run', report_intent: '🎯 Plan', view: '👁 View',
      list_dir: '📂 List', search: '🔍 Search', grep_search: '🔍 Search',
      think: '💡 Think', glob: '📂 Glob', delete_file: '🗑 Delete',
      write_file: '📝 Write',
    };

    const onThinking = (text: string) => {
      if (!cfg.showThinking) return;
      thinkingText += text;
      scheduleEdit();
    };

    const onThinkingDone = () => {
      // Keep thinking text visible until response starts
    };

    const onDelta = (text: string) => {
      if (phase !== 'responding') {
        phase = 'responding';
        // Clear thinking when response starts — tools stay
        thinkingText = '';
      }
      responseText += text;
      scheduleEdit();
    };

    const onToolStart = (tool: any) => {
      const name = tool.toolName;
      phase = 'tools';

      // React based on tool type + refresh typing
      telegram.sendTyping(chatId);
      if (webTools.includes(name)) react('⚡');
      else if (codingTools.includes(name)) react('👨‍💻');
      else react('🔥');

      if (!cfg.showTools) return;

      // Build tool line
      const label = prettyTool[name] ?? '🔧 ' + name.replace(/_/g, ' ');
      const args = tool.arguments;
      let detail = '';
      if (name === 'bash' && args?.command) {
        detail = ' `' + args.command.slice(0, 60) + (args.command.length > 60 ? '...' : '') + '`';
      } else if (args?.file_path) {
        detail = ' `' + args.file_path + '`';
      } else if (args?.pattern) {
        detail = ' `' + args.pattern + '`';
      } else if (args?.query) {
        detail = ' "' + args.query.slice(0, 40) + '"';
      }
      toolLines.push(label + detail);
      scheduleEdit();
    };

    const onToolComplete = (tool: any) => {
      if (!cfg.showTools) return;
      // Mark tool as done with checkmark
      const idx = toolLines.length - 1;
      if (idx >= 0 && tool.success !== false) {
        toolLines[idx] = toolLines[idx] + ' ✓';
        scheduleEdit();
      } else if (idx >= 0) {
        toolLines[idx] = toolLines[idx] + ' ✗';
        scheduleEdit();
      }
    };

    session.on('thinking', onThinking);
    session.on('thinking_done', onThinkingDone);
    session.on('delta', onDelta);
    session.on('tool_start', onToolStart);
    session.on('tool_complete', onToolComplete);

    // Track usage for footer
    let resultData: any = null;
    const onResult = (data: any) => { resultData = data; };
    session.on('result', onResult);

    try {
      const response = await session.send(prompt);

      if (editTimer) { clearTimeout(editTimer); editTimer = null; }
      session.off('thinking', onThinking);
      session.off('thinking_done', onThinkingDone);
      session.off('delta', onDelta);
      session.off('tool_start', onToolStart);
      session.off('tool_complete', onToolComplete);
      session.off('result', onResult);

      // Build final message: clean response + usage footer
      let finalText = response.content || '_(no response)_';

      // Add usage footer if enabled
      const usage = resultData?.usage;
      if (cfg.showUsage && usage) {
        const parts: string[] = [];
        if (usage.premiumRequests) parts.push(usage.premiumRequests + ' reqs');
        if (usage.totalApiDurationMs) parts.push((usage.totalApiDurationMs / 1000).toFixed(1) + 's');
        const changes = usage.codeChanges;
        if (changes && (changes.linesAdded || changes.linesRemoved)) {
          parts.push('+' + (changes.linesAdded ?? 0) + ' -' + (changes.linesRemoved ?? 0) + ' lines');
        }
        if (changes?.filesModified?.length) {
          parts.push(changes.filesModified.length + ' files');
        }
        if (parts.length > 0) {
          finalText += '\n\n`' + parts.join(' · ') + '`';
        }
      }

      if (streamMsgId && finalText.length <= 4096) {
        await telegram.editMessage(chatId, streamMsgId, finalText);
      } else if (streamMsgId && finalText.length > 4096) {
        await telegram.editMessage(chatId, streamMsgId, finalText.slice(0, 4096));
        await telegram.sendMessage(chatId, finalText.slice(4096), { disableLinkPreview: true });
      } else {
        await telegram.sendMessage(chatId, finalText, { replyTo: messageId, disableLinkPreview: true });
      }

      await telegram.removeReaction(chatId, messageId);
      if (session.currentSessionId) {
        console.log('[Session] Conversation ID: ' + session.currentSessionId);
      }
    } catch (err) {
      if (editTimer) { clearTimeout(editTimer); editTimer = null; }
      session.off('thinking', onThinking);
      session.off('thinking_done', onThinkingDone);
      session.off('delta', onDelta);
      session.off('tool_start', onToolStart);
      session.off('tool_complete', onToolComplete);
      session.off('result', onResult);
      await react('😱');
      await telegram.sendMessage(chatId, '❌ ' + String(err));
    }
  }

  async function handleCommand(text: string, chatId: string, messageId: number): Promise<void> {
    const [cmd, ...args] = text.split(' ');

    switch (cmd) {
      case '/start': {
        const workDir = args[0] ?? config.workDir;
        chatWorkDirs.set(chatId, workDir);

        const existing = sessions.get(chatId);
        if (existing?.alive) existing.kill();

        const session = new Session();
        try {
          const cfg = getConfig(chatId); await session.start({ cwd: workDir, binary: copilotBin, model: cfg.model, allowAllTools: cfg.allowAllTools, agent: cfg.agent ?? undefined });
          sessions.set(chatId, session);
          await telegram.sendMessage(chatId, '✅ Ready in `' + workDir + '`\n\nSend a prompt to get started.');
        } catch (err) {
          await telegram.sendMessage(chatId, '❌ Failed to start: ' + String(err));
        }
        break;
      }

      case '/stop': {
        const session = sessions.get(chatId);
        if (session?.alive) {
          session.kill();
          sessions.delete(chatId);
          await telegram.sendMessage(chatId, '🛑 Session killed.');
        } else {
          await telegram.sendMessage(chatId, 'No active session.');
        }
        break;
      }

      case '/new': {
        // Start fresh session (clear conversation history)
        const session = sessions.get(chatId);
        if (session?.alive) session.kill();

        const workDir = chatWorkDirs.get(chatId) ?? config.workDir;
        const newSession = new Session();
        try {
          const ncfg = getConfig(chatId); await newSession.start({ cwd: workDir, binary: copilotBin, model: ncfg.model, allowAllTools: ncfg.allowAllTools, agent: ncfg.agent ?? undefined });
          sessions.set(chatId, newSession);
          await telegram.sendMessage(chatId, '🆕 New session started. Previous conversation cleared.');
        } catch (err) {
          await telegram.sendMessage(chatId, '❌ ' + String(err));
        }
        break;
      }

      case '/cd': {
        const dir = args[0];
        if (!dir) {
          const current = chatWorkDirs.get(chatId) ?? config.workDir;
          await telegram.sendMessage(chatId, '📂 ' + current);
        } else {
          chatWorkDirs.set(chatId, dir);
          const existing = sessions.get(chatId);
          if (existing?.alive) existing.kill();
          sessions.delete(chatId);
          await telegram.sendMessage(chatId, '📂 Switched to `' + dir + '`');
        }
        break;
      }

      case '/status': {
        const session = sessions.get(chatId);
        const workDir = chatWorkDirs.get(chatId) ?? config.workDir;
        const lines = [];
        if (session?.alive) {
          lines.push('✅ Active in `' + workDir + '`');
          if (session.currentSessionId) lines.push('🆔 Session: `' + session.currentSessionId.slice(0, 8) + '...`');
          if (session.busy) lines.push('⏳ Processing...');
        } else {
          lines.push('⚪ No active session. Send a message to auto-start.');
        }
        await telegram.sendMessage(chatId, lines.join('\n'));
        break;
      }

      case '/yes':
      case '/y': {
        const session = sessions.get(chatId);
        if (session?.alive) session.approve();
        else await telegram.sendMessage(chatId, 'No active session.');
        break;
      }

      case '/no':
      case '/n': {
        const session = sessions.get(chatId);
        if (session?.alive) session.deny();
        else await telegram.sendMessage(chatId, 'No active session.');
        break;
      }

      case '/allowall': {
        const cfg = getConfig(chatId);
        cfg.allowAllTools = !cfg.allowAllTools;
        setConfig(chatId, cfg);
        const session = sessions.get(chatId);
        if (session?.alive) session.allowAllTools = cfg.allowAllTools;
        await telegram.sendMessage(chatId,
          cfg.allowAllTools ? '✅ Auto-approve all tools ON' : '⚪ Auto-approve all tools OFF');
        break;
      }

      case '/abort': {
        const session = sessions.get(chatId);
        if (session?.alive) {
          await session.abort();
          await telegram.sendMessage(chatId, '🛑 Request aborted.');
        } else {
          await telegram.sendMessage(chatId, 'No active session.');
        }
        break;
      }

      case '/agent': {
        const agentName = args[0] || null;
        const cfg = getConfig(chatId);
        cfg.agent = agentName;
        setConfig(chatId, cfg);

        if (agentName) {
          // Restart session with the agent
          const session = sessions.get(chatId);
          if (session?.alive) await session.kill();
          sessions.delete(chatId);
          await telegram.sendMessage(chatId, '🤖 Agent set to `' + agentName + '`. Next message will start a new session.');
        } else {
          await telegram.sendMessage(chatId, '🤖 Agent cleared. Using default Copilot.');
        }
        break;
      }

      case '/config': {
        await sendConfigMenu(chatId);
        break;
      }

      // ── Copilot CLI passthrough commands ──
      // These send the command directly to the Copilot session.
      // The SDK/CLI handles them natively.

      case '/plan': {
        const session = sessions.get(chatId);
        if (!session?.alive) { await telegram.sendMessage(chatId, 'No active session.'); break; }
        const planPrompt = args.length > 0
          ? '/plan ' + args.join(' ')
          : '/plan';
        await telegram.sendMessage(chatId, '📋 Entering plan mode...');
        // Send as a regular prompt — Copilot handles /plan internally
        await handlePrompt(chatId, messageId, planPrompt);
        break;
      }

      case '/research': {
        const session = sessions.get(chatId);
        if (!session?.alive) { await telegram.sendMessage(chatId, 'No active session.'); break; }
        if (args.length === 0) { await telegram.sendMessage(chatId, 'Usage: `/research <topic>`'); break; }
        await telegram.sendMessage(chatId, '🔬 Starting deep research...');
        await handlePrompt(chatId, messageId, '/research ' + args.join(' '));
        break;
      }

      case '/compact': {
        const session = sessions.get(chatId);
        if (!session?.alive) { await telegram.sendMessage(chatId, 'No active session.'); break; }
        await telegram.sendMessage(chatId, '🗜️ Compacting context...');
        await handlePrompt(chatId, messageId, '/compact');
        break;
      }

      case '/diff': {
        const session = sessions.get(chatId);
        if (!session?.alive) { await telegram.sendMessage(chatId, 'No active session.'); break; }
        await telegram.sendMessage(chatId, '📝 Reviewing changes...');
        await handlePrompt(chatId, messageId, '/diff');
        break;
      }

      case '/review': {
        const session = sessions.get(chatId);
        if (!session?.alive) { await telegram.sendMessage(chatId, 'No active session.'); break; }
        await telegram.sendMessage(chatId, '🔍 Running code review...');
        await handlePrompt(chatId, messageId, '/review');
        break;
      }

      case '/context': {
        const session = sessions.get(chatId);
        if (!session?.alive) { await telegram.sendMessage(chatId, 'No active session.'); break; }
        await handlePrompt(chatId, messageId, '/context');
        break;
      }

      case '/usage': {
        const session = sessions.get(chatId);
        if (!session?.alive) { await telegram.sendMessage(chatId, 'No active session.'); break; }
        await handlePrompt(chatId, messageId, '/usage');
        break;
      }

      case '/share': {
        const session = sessions.get(chatId);
        if (!session?.alive) { await telegram.sendMessage(chatId, 'No active session.'); break; }
        const shareArg = args.length > 0 ? ' ' + args.join(' ') : '';
        await handlePrompt(chatId, messageId, '/share' + shareArg);
        break;
      }

      case '/init': {
        const session = sessions.get(chatId);
        if (!session?.alive) { await telegram.sendMessage(chatId, 'No active session.'); break; }
        await telegram.sendMessage(chatId, '📄 Initializing copilot-instructions.md...');
        await handlePrompt(chatId, messageId, '/init');
        break;
      }

      case '/fleet': {
        const session = sessions.get(chatId);
        if (!session?.alive) { await telegram.sendMessage(chatId, 'No active session.'); break; }
        await handlePrompt(chatId, messageId, '/fleet');
        break;
      }

      case '/tasks': {
        const session = sessions.get(chatId);
        if (!session?.alive) { await telegram.sendMessage(chatId, 'No active session.'); break; }
        await handlePrompt(chatId, messageId, '/tasks');
        break;
      }

      case '/resume': {
        const session = sessions.get(chatId);
        if (!session?.alive) { await telegram.sendMessage(chatId, 'No active session.'); break; }
        const resumeArg = args.length > 0 ? ' ' + args.join(' ') : '';
        await handlePrompt(chatId, messageId, '/resume' + resumeArg);
        break;
      }

      case '/instructions': {
        const session = sessions.get(chatId);
        if (!session?.alive) { await telegram.sendMessage(chatId, 'No active session.'); break; }
        await handlePrompt(chatId, messageId, '/instructions');
        break;
      }

      case '/skills': {
        const session = sessions.get(chatId);
        if (!session?.alive) { await telegram.sendMessage(chatId, 'No active session.'); break; }
        await handlePrompt(chatId, messageId, '/skills');
        break;
      }

      case '/mcp': {
        const session = sessions.get(chatId);
        if (!session?.alive) { await telegram.sendMessage(chatId, 'No active session.'); break; }
        const mcpArg = args.length > 0 ? ' ' + args.join(' ') : '';
        await handlePrompt(chatId, messageId, '/mcp' + mcpArg);
        break;
      }

      case '/clear': {
        // Alias for /new
        const session = sessions.get(chatId);
        if (session?.alive) await session.kill();
        sessions.delete(chatId);
        await telegram.sendMessage(chatId, '🧹 Session cleared.');
        break;
      }

      case '/help':
      default:
        await telegram.sendMessage(chatId, [
          '⚡ *Copilot Remote v0.5.0*',
          '',
          '*Session*',
          '`/new` `/clear` — Fresh session',
          '`/stop` — Kill session',
          '`/cd [dir]` — Change working directory',
          '`/status` — Session info',
          '`/resume [id]` — Switch session',
          '',
          '*Coding*',
          '`/plan [task]` — Plan before coding',
          '`/diff` — Review changes',
          '`/review` — Code review agent',
          '`/fleet` — Parallel subagents',
          '`/tasks` — View background tasks',
          '',
          '*Research & Context*',
          '`/research [topic]` — Deep research',
          '`/context` — Token usage',
          '`/usage` — Session metrics',
          '`/compact` — Compress context',
          '`/share` — Export to markdown/gist',
          '',
          '*Tools & Permissions*',
          '`/yes` `/no` — Approve/deny action',
          '`/abort` — Cancel request',
          '`/allowall` — Toggle auto-approve',
          '',
          '*Customization*',
          '`/config` — Settings',
          '`/agent [name]` — Custom agent',
          '`/init` — Setup copilot-instructions',
          '`/instructions` — View instructions',
          '`/skills` — Manage skills',
          '`/mcp` — Manage MCP servers',
        ].join('\n'));
        break;
    }
  }

  async function sendConfigMenu(chatId: string, editMsgId?: number): Promise<void> {
    const cfg = getConfig(chatId);
    const toggle = (v: boolean) => v ? '✅' : '⬜';
    const agentLine = cfg.agent ? '\nAgent: `' + cfg.agent + '`' : '';
    const text = '⚙️ *Settings*\nModel: `' + cfg.model + '`' + agentLine;
    const buttons = [
      [
        { text: toggle(cfg.showThinking) + ' Thinking', data: 'cfg:showThinking' },
        { text: toggle(cfg.showTools) + ' Tools', data: 'cfg:showTools' },
      ],
      [
        { text: toggle(cfg.showUsage) + ' Usage', data: 'cfg:showUsage' },
        { text: toggle(cfg.showReactions) + ' Reactions', data: 'cfg:showReactions' },
      ],
      [
        { text: toggle(cfg.allowAllTools) + ' Auto-approve', data: 'cfg:allowAllTools' },
      ],
      [{ text: '🤖 Change Model', data: 'cfg:modelPicker' }],
    ];

    if (editMsgId) {
      await telegram.editMessageButtons(chatId, editMsgId, text, buttons);
    } else {
      await telegram.sendMessageWithButtons(chatId, text, buttons);
    }
  }

  async function sendModelPicker(chatId: string, editMsgId: number): Promise<void> {
    const cfg = getConfig(chatId);
    const session = sessions.get(chatId);

    // Fetch live models from SDK
    if (cachedModels.length === 0 && session?.alive) {
      try {
        const models = await session.listModels();
        cachedModels = models.map(m => m.id ?? m.name ?? String(m)).filter(Boolean);
        console.log('[SDK] Loaded ' + cachedModels.length + ' models');
      } catch (err) {
        console.error('[SDK] Failed to list models:', err);
      }
    }

    // Fallback if no models loaded
    const modelList = cachedModels.length > 0 ? cachedModels : [
      'claude-sonnet-4', 'claude-sonnet-4.6', 'claude-opus-4.6',
      'gemini-3-pro-preview', 'gpt-5.2', 'gpt-5.4',
    ];

    const text = '🤖 *Select Model* (' + modelList.length + ' available)';
    const buttons: { text: string; data: string }[][] = [];
    for (let i = 0; i < modelList.length; i += 2) {
      const row = modelList.slice(i, i + 2).map(m => ({
        text: (m === cfg.model ? '● ' : '') + m,
        data: 'model:' + m,
      }));
      buttons.push(row);
    }
    buttons.push([{ text: '← Back', data: 'cfg:back' }]);
    await telegram.editMessageButtons(chatId, editMsgId, text, buttons);
  }

  telegram.setCallbackHandler(async (callbackId: string, data: string, chatId: string, msgId: number) => {
    if (data === 'cfg:modelPicker') {
      await sendModelPicker(chatId, msgId);
      return;
    }

    if (data === 'cfg:back') {
      await sendConfigMenu(chatId, msgId);
      return;
    }

    if (data.startsWith('model:')) {
      const model = data.slice(6);
      const cfg = getConfig(chatId);
      cfg.model = model;
      setConfig(chatId, cfg);
      // Use SDK's setModel for runtime switch
      const session = sessions.get(chatId);
      if (session?.alive) {
        try { await session.setModel(model); } catch {}
      }
      await sendConfigMenu(chatId, msgId);
      return;
    }

    if (data.startsWith('cfg:')) {
      const key = data.slice(4) as keyof ChatConfig;
      const cfg = getConfig(chatId);
      if (key in cfg && typeof (cfg as any)[key] === 'boolean') {
        (cfg as any)[key] = !(cfg as any)[key];
        setConfig(chatId, cfg);

        if (key === 'allowAllTools') {
          const session = sessions.get(chatId);
          if (session?.alive) session.allowAllTools = cfg.allowAllTools;
        }

        await sendConfigMenu(chatId, msgId);
      }
    }
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    telegram.stopPolling();
    for (const [, session] of sessions) session.kill();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    telegram.stopPolling();
    for (const [, session] of sessions) session.kill();
    process.exit(0);
  });

  await telegram.startPolling();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
