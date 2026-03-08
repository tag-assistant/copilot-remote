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

  telegram.setMessageHandler(async (text: string, chatId: string, _messageId: number) => {
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

    // Send typing indicator
    await telegram.sendTyping(chatId);

    // Collect thinking and stream it as one message when done
    let thinkingText = '';
    let thinkingMsgId: number | null = null;
    let thinkingDone = false;
    let lastThinkingEdit = 0;
    let thinkingTimer: NodeJS.Timeout | null = null;

    const flushThinking = async () => {
      if (!thinkingText.trim()) return;
      const display = '💭 ' + thinkingText.trim();
      if (!thinkingMsgId) {
        thinkingMsgId = await telegram.sendMessage(chatId, display);
      } else {
        await telegram.editMessage(chatId, thinkingMsgId, display);
      }
      lastThinkingEdit = Date.now();
    };

    const onThinking = (text: string) => {
      thinkingText += text;
      if (thinkingDone) return;

      // Throttle edits to every 2s
      if (thinkingTimer) return;
      const delay = Math.max(0, 2000 - (Date.now() - lastThinkingEdit));
      thinkingTimer = setTimeout(async () => {
        thinkingTimer = null;
        await flushThinking();
      }, delay);
    };

    const onThinkingDone = async () => {
      thinkingDone = true;
      if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
      await flushThinking();
    };

    const onToolStart = async (tool: any) => {
      const name = tool.toolName;
      const args = tool.arguments;
      let detail = '';
      if (name === 'bash' && args?.command) {
        detail = '\n`' + args.command + '`';
      } else if ((name === 'edit_file' || name === 'read_file') && args?.file_path) {
        detail = '\n`' + args.file_path + '`';
      } else if (args?.description) {
        detail = '\n' + args.description;
      }
      await telegram.sendMessage(chatId, '🔧 *' + name + '*' + detail);
    };

    session.on('thinking', onThinking);
    session.on('thinking_done', onThinkingDone);
    session.on('tool_start', onToolStart);

    try {
      const response = await session.send(text);

      // Clean up
      if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
      session.off('thinking', onThinking);
      session.off('thinking_done', onThinkingDone);
      session.off('tool_start', onToolStart);

      // Send the actual response as a separate message
      if (response.content) {
        await telegram.sendMessage(chatId, response.content);
      } else {
        await telegram.sendMessage(chatId, '_(no response)_');
      }

      if (session.sessionId) {
        console.log('[Session] Conversation ID: ' + session.sessionId);
      }
    } catch (err) {
      if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
      session.off('thinking', onThinking);
      session.off('thinking_done', onThinkingDone);
      session.off('tool_start', onToolStart);
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
        let session = sessions.get(chatId);
        if (!session || !session.alive) {
          session = new CopilotSession();
          const workDir = chatWorkDirs.get(chatId) ?? config.workDir;
          await session.start({ cwd: workDir, binary: copilotBin });
          sessions.set(chatId, session);
        }
        session.allowAllTools = !session.allowAllTools;
        await telegram.sendMessage(chatId,
          session.allowAllTools ? '✅ Auto-approve all tools ON' : '⚪ Auto-approve all tools OFF');
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
