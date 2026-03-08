// ============================================================
// Copilot Remote — Main Entry Point
// ============================================================
// Bridges Copilot CLI ↔ Telegram with JSONL streaming,
// session continuity, and tool approval flows.
// ============================================================

import { CopilotSession } from './session.js';
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
  console.log('║       ⚡ Copilot Remote v0.2.0       ║');
  console.log('╠══════════════════════════════════════╣');
  console.log('║  Copilot CLI ↔ Telegram Bridge       ║');
  console.log('║  JSONL streaming + session resume     ║');
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
  const sessions = new Map<string, CopilotSession>();
  const chatWorkDirs = new Map<string, string>();

  // Per-chat config with defaults
  interface ChatConfig {
    showUsage: boolean;
    showThinking: boolean;
    showTools: boolean;
    allowAllTools: boolean;
  }
  const defaultConfig: ChatConfig = {
    showUsage: false,
    showThinking: true,
    showTools: true,
    allowAllTools: false,
  };
  const chatConfigs = new Map<string, ChatConfig>();
  const getConfig = (chatId: string): ChatConfig => {
    return chatConfigs.get(chatId) ?? { ...defaultConfig };
  };
  const setConfig = (chatId: string, cfg: ChatConfig) => {
    chatConfigs.set(chatId, cfg);
  };

  telegram.setMessageHandler(async (text: string, chatId: string, messageId: number) => {
    console.log('[Message] ' + chatId + ': ' + text);

    if (text.startsWith('/')) {
      await handleCommand(text, chatId);
      return;
    }

    // Get or create session
    let session = sessions.get(chatId);
    if (!session || !session.alive) {
      session = new CopilotSession();
      const workDir = chatWorkDirs.get(chatId) ?? config.workDir;

      try {
        await session.start({ cwd: workDir, binary: copilotBin });
        session.allowAllTools = getConfig(chatId).allowAllTools;
        sessions.set(chatId, session);
      } catch (err) {
        await telegram.sendMessage(chatId, '❌ Failed to start: ' + String(err));
        return;
      }
    }

    if (session.busy) {
      await telegram.sendMessage(chatId, '⏳ Still processing...');
      return;
    }

    // Status reactions on user's message
    const react = (emoji: string) => telegram.setReaction(chatId, messageId, emoji);
    await react('🤔');
    const cfg = getConfig(chatId);

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
        streamMsgId = await telegram.sendMessage(chatId, display);
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

      // React based on tool type
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
      const response = await session.send(text);

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
        await telegram.sendMessage(chatId, finalText.slice(4096));
      } else {
        await telegram.sendMessage(chatId, finalText);
      }

      await react('👍');
      if (session.sessionId) {
        console.log('[Session] Conversation ID: ' + session.sessionId);
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
  });

  async function handleCommand(text: string, chatId: string): Promise<void> {
    const [cmd, ...args] = text.split(' ');

    switch (cmd) {
      case '/start': {
        const workDir = args[0] ?? config.workDir;
        chatWorkDirs.set(chatId, workDir);

        const existing = sessions.get(chatId);
        if (existing?.alive) existing.kill();

        const session = new CopilotSession();
        try {
          await session.start({ cwd: workDir, binary: copilotBin });
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
        const newSession = new CopilotSession();
        try {
          await newSession.start({ cwd: workDir, binary: copilotBin });
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
          if (session.sessionId) lines.push('🆔 Session: `' + session.sessionId.slice(0, 8) + '...`');
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

      case '/config': {
        await sendConfigMenu(chatId);
        break;
      }

      case '/help':
      default:
        await telegram.sendMessage(chatId, [
          '⚡ *Copilot Remote v0.2.0*',
          '',
          '`/start [dir]` — Start in directory',
          '`/stop` — Kill session',
          '`/new` — Fresh session (clear history)',
          '`/cd [dir]` — Change working directory',
          '`/status` — Session status + ID',
          '`/yes` `/y` — Approve tool action',
          '`/no` `/n` — Deny tool action',
          '`/help` — This message',
          '',
          'Or just type a prompt — session auto-starts.',
          'Conversation context persists via `--resume`.',
        ].join('\n'));
        break;
    }
  }

  async function sendConfigMenu(chatId: string, editMsgId?: number): Promise<void> {
    const cfg = getConfig(chatId);
    const toggle = (v: boolean) => v ? '✅' : '⬜';
    const text = '⚙️ *Settings*';
    const buttons = [
      [
        { text: toggle(cfg.showThinking) + ' Thinking', data: 'cfg:showThinking' },
        { text: toggle(cfg.showTools) + ' Tools', data: 'cfg:showTools' },
      ],
      [
        { text: toggle(cfg.showUsage) + ' Usage Stats', data: 'cfg:showUsage' },
        { text: toggle(cfg.allowAllTools) + ' Auto-approve', data: 'cfg:allowAllTools' },
      ],
    ];

    if (editMsgId) {
      await telegram.editMessageButtons(chatId, editMsgId, text, buttons);
    } else {
      await telegram.sendMessageWithButtons(chatId, text, buttons);
    }
  }

  // Handle inline button presses
  telegram.setCallbackHandler(async (callbackId: string, data: string, chatId: string, msgId: number) => {
    if (data.startsWith('cfg:')) {
      const key = data.slice(4) as keyof ChatConfig;
      const cfg = getConfig(chatId);
      if (key in cfg) {
        (cfg as any)[key] = !(cfg as any)[key];
        setConfig(chatId, cfg);

        // Sync allowAllTools to active session
        if (key === 'allowAllTools') {
          const session = sessions.get(chatId);
          if (session?.alive) session.allowAllTools = cfg.allowAllTools;
        }

        // Update the config menu in-place
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
