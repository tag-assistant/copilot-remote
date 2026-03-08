// Copilot Remote — Telegram ↔ Copilot SDK bridge
import { Session } from './session.js';
import type { Client } from './client.js';
import { TelegramClient } from './clients/telegram.js';
import { log } from './log.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

function findBin(name: string): string {
  try { return execSync('which ' + name, { encoding: 'utf-8' }).trim(); } catch { return name; }
}

function loadConfig() {
  const cfgPath = path.join(process.cwd(), '.copilot-remote.json');
  if (fs.existsSync(cfgPath)) return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));

  const botToken = process.env.COPILOT_REMOTE_BOT_TOKEN;
  if (!botToken) { log.error('Missing COPILOT_REMOTE_BOT_TOKEN'); process.exit(1); }
  return {
    botToken,
    allowedUsers: process.env.COPILOT_REMOTE_ALLOWED_USERS?.split(',').filter(Boolean) ?? [],
    workDir: process.env.COPILOT_REMOTE_WORKDIR ?? process.cwd(),
    copilotBinary: process.env.COPILOT_REMOTE_BINARY,
  };
}

// ── Passthrough commands: just prompt Copilot with context ──
const PROMPT_COMMANDS: Record<string, { usage?: string; prompt: (args: string) => string }> = {
  '/research':     { usage: '`/research <topic>`', prompt: a => 'Research this topic thoroughly using web search and GitHub: ' + a },
  '/diff':         { prompt: () => 'Review all uncommitted changes. Show a summary and any issues.' },
  '/review':       { prompt: () => 'Thorough code review of recent changes. Check bugs, security, style.' },
  '/share':        { prompt: () => 'Share this conversation as a markdown summary.' },
  '/init':         { prompt: () => 'Initialize copilot-instructions.md with sensible defaults for this codebase.' },
  '/tasks':        { prompt: () => 'List all active background tasks and subagents.' },
  '/instructions': { prompt: () => 'Show which custom instruction files are active in this repository.' },
  '/skills':       { prompt: () => 'List all available skills and their status.' },
  '/mcp':          { prompt: () => 'Show configured MCP servers and their status.' },
};

async function main(): Promise<void> {
  const config = loadConfig();
  const bin = config.copilotBinary ?? findBin('copilot');

  log.info('⚡ Copilot Remote v0.5 | dir: ' + config.workDir);

  const client: Client = new TelegramClient({ botToken: config.botToken, allowedUsers: config.allowedUsers });

  // ── Per-chat state ──
  interface ChatConfig { showUsage: boolean; showThinking: boolean; showTools: boolean; showReactions: boolean; autopilot: boolean; model: string; agent: string | null }
  const defaultCfg: ChatConfig = { showUsage: false, showThinking: false, showTools: false, showReactions: true, autopilot: false, model: 'claude-sonnet-4', agent: null };

  const sessions = new Map<string, Session>();
  const workDirs = new Map<string, string>();
  const configs = new Map<string, ChatConfig>();
  const pendingPerms = new Map<number, string>();
  let cachedModels: string[] = [];

  const cfg = (id: string) => configs.get(id) ?? { ...defaultCfg };
  const setCfg = (id: string, c: ChatConfig) => configs.set(id, c);
  const workDir = (id: string) => workDirs.get(id) ?? config.workDir;

  // Get or create session
  async function getSession(chatId: string): Promise<Session> {
    let s = sessions.get(chatId);
    if (s?.alive) return s;
    s = new Session();
    const c = cfg(chatId);
    await s.start({ cwd: workDir(chatId), binary: bin, model: c.model, autopilot: c.autopilot, agent: c.agent ?? undefined });
    s.autopilot = c.autopilot;
    sessions.set(chatId, s);
    return s;
  }

  // ── Prompt handler (streaming + reactions) ──
  async function handlePrompt(chatId: string, msgId: number, prompt: string): Promise<void> {
    const session = await getSession(chatId);
    const c = cfg(chatId);
    const react = c.showReactions ? (e: string) => client.setReaction(chatId, msgId, e) : async () => {};
    await react('🤔');
    await client.sendTyping(chatId);

    let streamMsgId: number | null = null;
    let thinkingText = '', responseText = '';
    let toolLines: string[] = [];
    let lastEdit = 0, timer: NodeJS.Timeout | null = null;
    const THROTTLE = 1200;

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
      if (!streamMsgId) {
        if (text.length < 15) return;
        streamMsgId = await client.sendMessage(chatId, text, { replyTo: msgId, disableLinkPreview: true });
      } else {
        await client.editMessage(chatId, streamMsgId, text);
      }
    };

    const schedEdit = () => { if (!timer) timer = setTimeout(flush, Math.max(0, THROTTLE - (Date.now() - lastEdit))); };

    const prettyTool: Record<string, string> = {
      read_file: '📖 Read', edit_file: '✏️ Edit', create_file: '📝 Create', bash: '▶️ Run',
      view: '👁 View', list_dir: '📂 List', search: '🔍 Search', grep_search: '🔍 Search',
      think: '💡 Think', glob: '📂 Glob', delete_file: '🗑 Delete', write_file: '📝 Write',
    };

    const onThink = (t: string) => { if (c.showThinking) { thinkingText += t; schedEdit(); } };
    const onDelta = (t: string) => { thinkingText = ''; responseText += t; schedEdit(); };
    const onToolStart = (t: any) => {
      client.sendTyping(chatId);
      react('👨‍💻');
      if (!c.showTools) return;
      const label = prettyTool[t.toolName] ?? '🔧 ' + t.toolName;
      let detail = '';
      if (t.arguments?.command) detail = ' `' + t.arguments.command.slice(0, 60) + '`';
      else if (t.arguments?.file_path) detail = ' `' + t.arguments.file_path + '`';
      toolLines.push(label + detail);
      schedEdit();
    };
    const onToolEnd = (t: any) => {
      if (!c.showTools || !toolLines.length) return;
      toolLines[toolLines.length - 1] += t.success !== false ? ' ✓' : ' ✗';
      schedEdit();
    };
    const onPerm = async (req: any) => {
      const p = req.permissionRequest ?? req;
      const icons: Record<string, string> = { shell: '⚡', write: '✏️', url: '🌐', mcp: '🔌', read: '📖' };
      const icon = icons[p.kind] ?? '🔐';
      let title = p.kind === 'shell' ? 'Run command' : p.kind === 'url' ? 'Fetch URL' : p.kind === 'write' ? 'Write file' : p.kind;
      let detail = p.kind === 'shell' ? '```\n' + (p.fullCommandText ?? '').slice(0, 300) + '\n```'
                 : p.kind === 'url' ? '`' + (p.url ?? '').slice(0, 200) + '`'
                 : p.intention ?? '';
      if (p.intention && p.kind !== detail) detail += '\n_' + p.intention + '_';
      const id = await client.sendButtons(chatId, icon + ' *' + title + '*\n' + detail, [
        [{ text: '✅ Approve', data: 'perm:yes' }, { text: '❌ Deny', data: 'perm:no' }, { text: '✅ All', data: 'perm:all' }],
      ]);
      if (id) pendingPerms.set(id, chatId);
    };

    session.on('thinking', onThink);
    session.on('delta', onDelta);
    session.on('tool_start', onToolStart);
    session.on('tool_complete', onToolEnd);
    session.on('permission_request', onPerm);

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      session.off('thinking', onThink);
      session.off('delta', onDelta);
      session.off('tool_start', onToolStart);
      session.off('tool_complete', onToolEnd);
      session.off('permission_request', onPerm);
    };

    try {
      const res = await session.send(prompt);
      cleanup();

      let final = res.content;
      if (c.showUsage) {
        try {
          const q = await session.getQuota();
          const s = (q as any)?.quotaSnapshots?.[0];
          if (s) final += '\n\n`' + s.usedRequests + '/' + s.entitlementRequests + ' reqs (' + s.remainingPercentage + '% left)`';
        } catch {}
      }

      if (streamMsgId && final.length <= 4096) {
        await client.editMessage(chatId, streamMsgId, final);
      } else if (streamMsgId) {
        await client.editMessage(chatId, streamMsgId, final.slice(0, 4096));
        await client.sendMessage(chatId, final.slice(4096), { disableLinkPreview: true });
      } else {
        await client.sendMessage(chatId, final, { replyTo: msgId, disableLinkPreview: true });
      }
      await client.removeReaction(chatId, msgId);
    } catch (err) {
      cleanup();
      await react('😱');
      await client.sendMessage(chatId, '❌ ' + String(err));
    }
  }

  // ── Message handler ──
  client.onMessage = async (text, chatId, messageId, replyText, replyToMsgId) => {
    // Reply to permission message
    if (replyToMsgId && pendingPerms.has(replyToMsgId)) {
      const lower = text.toLowerCase().trim();
      const s = sessions.get(chatId);
      if (s?.alive) {
        if (['yes', 'y', 'approve', '👍'].includes(lower)) { s.approve(); pendingPerms.delete(replyToMsgId); await client.editButtons(chatId, replyToMsgId, '✅ Approved', []); return; }
        if (['no', 'n', 'deny', '👎'].includes(lower)) { s.deny(); pendingPerms.delete(replyToMsgId); await client.editButtons(chatId, replyToMsgId, '❌ Denied', []); return; }
      }
    }

    if (text.startsWith('/')) return handleCommand(text, chatId, messageId);

    let prompt = text;
    if (replyText) prompt = 'Context (replying to):\n"""\n' + replyText + '\n"""\n\nMy message: ' + text;
    await handlePrompt(chatId, messageId, prompt);
  };

  // ── Command handler ──
  async function handleCommand(text: string, chatId: string, msgId: number): Promise<void> {
    const [cmd, ...args] = text.split(' ');
    const argStr = args.join(' ');

    // Passthrough prompt commands
    const pc = PROMPT_COMMANDS[cmd];
    if (pc) {
      if (pc.usage && !argStr) { await client.sendMessage(chatId, 'Usage: ' + pc.usage); return; }
      const s = sessions.get(chatId);
      if (!s?.alive) { await getSession(chatId); }
      return handlePrompt(chatId, msgId, pc.prompt(argStr));
    }

    switch (cmd) {
      case '/start': case '/new': {
        if (args[0] && cmd === '/start') workDirs.set(chatId, args[0]);
        const old = sessions.get(chatId);
        if (old?.alive) old.kill();
        sessions.delete(chatId);
        const s = await getSession(chatId);
        await client.sendMessage(chatId, cmd === '/new' ? '🆕 New session.' : '✅ Ready in `' + workDir(chatId) + '`');
        break;
      }
      case '/stop': case '/clear': {
        const s = sessions.get(chatId);
        if (s?.alive) s.kill();
        sessions.delete(chatId);
        await client.sendMessage(chatId, '🛑 Session cleared.');
        break;
      }
      case '/cd': {
        if (!args[0]) { await client.sendMessage(chatId, '📂 ' + workDir(chatId)); break; }
        workDirs.set(chatId, args[0]);
        const s = sessions.get(chatId); if (s?.alive) s.kill(); sessions.delete(chatId);
        await client.sendMessage(chatId, '📂 Switched to `' + args[0] + '`');
        break;
      }
      case '/status': {
        const s = sessions.get(chatId);
        if (!s?.alive) { await client.sendMessage(chatId, '⚪ No session. Send a message to start.'); break; }
        const lines = ['✅ `' + workDir(chatId) + '`'];
        try {
          const [model, mode, agent] = await Promise.all([
            s.getCurrentModel().catch(() => null), s.getMode().catch(() => null), s.getCurrentAgent().catch(() => null),
          ]);
          if ((model as any)?.modelId) lines.push('🤖 `' + (model as any).modelId + '`');
          if (mode) lines.push('⚙️ `' + mode + '`');
          if ((agent as any)?.agent?.name) lines.push('🎭 `' + (agent as any).agent.name + '`');
        } catch {}
        try {
          const q = await s.getQuota();
          const snap = (q as any)?.quotaSnapshots?.[0];
          if (snap) lines.push('📊 ' + snap.usedRequests + '/' + snap.entitlementRequests + ' (' + snap.remainingPercentage + '% left)');
        } catch {}
        await client.sendMessage(chatId, lines.join('\n'));
        break;
      }
      case '/yes': case '/y': { sessions.get(chatId)?.approve(); break; }
      case '/no': case '/n': { sessions.get(chatId)?.deny(); break; }
      case '/abort': {
        const s = sessions.get(chatId);
        if (s?.alive) { await s.abort(); await client.sendMessage(chatId, '🛑 Aborted.'); }
        break;
      }
      case '/debug': {
        log.enabled = !log.enabled;
        await client.sendMessage(chatId, log.enabled ? '🐛 Debug ON' : '🐛 Debug OFF');
        break;
      }
      case '/autopilot': case '/allowall': {
        const s = sessions.get(chatId);
        if (!s?.alive) { await client.sendMessage(chatId, 'No session.'); break; }
        const c = cfg(chatId); c.autopilot = !c.autopilot; s.autopilot = c.autopilot; setCfg(chatId, c);
        await client.sendMessage(chatId, c.autopilot ? '🚀 Autopilot ON' : '🔐 Autopilot OFF');
        break;
      }
      case '/agent': {
        const s = sessions.get(chatId);
        if (!args[0] && s?.alive) {
          try {
            const r = await s.listAgents();
            const agents = (r as any)?.agents ?? r;
            const lines = Array.isArray(agents) && agents.length
              ? agents.map((a: any) => '• `' + (a.name ?? a) + '`') : ['No agents found.'];
            await client.sendMessage(chatId, '🤖 *Agents*\n' + lines.join('\n'));
          } catch (e) { await client.sendMessage(chatId, '❌ ' + e); }
          break;
        }
        if (args[0] && s?.alive) {
          try { await s.selectAgent(args[0]); await client.sendMessage(chatId, '🤖 Agent: `' + args[0] + '`'); }
          catch (e) { await client.sendMessage(chatId, '❌ ' + e); }
        } else if (args[0]) {
          const c = cfg(chatId); c.agent = args[0]; setCfg(chatId, c);
          await client.sendMessage(chatId, '🤖 Agent `' + args[0] + '` set for next session.');
        }
        break;
      }
      case '/plan': {
        const s = sessions.get(chatId);
        if (!s?.alive) { await getSession(chatId); return handleCommand(text, chatId, msgId); }
        try {
          if (args[0] === 'show') {
            const p = await s.readPlan();
            await client.sendMessage(chatId, (p as any)?.content ? '📋 ' + (p as any).content.slice(0, 3800) : '📋 No plan.');
          } else if (args[0] === 'delete') {
            await s.deletePlan(); await client.sendMessage(chatId, '🗑 Plan deleted.');
          } else if (argStr) {
            await s.setMode('plan'); await handlePrompt(chatId, msgId, argStr);
          } else {
            const cur = await s.getMode();
            const next = cur === 'plan' ? 'interactive' : 'plan';
            await s.setMode(next);
            await client.sendMessage(chatId, next === 'plan' ? '📋 Plan mode ON' : '⚡ Interactive');
          }
        } catch (e) { await client.sendMessage(chatId, '❌ ' + e); }
        break;
      }
      case '/fleet': {
        const s = sessions.get(chatId);
        if (!s?.alive) { await client.sendMessage(chatId, 'No session.'); break; }
        try { const r = await s.startFleet(argStr || undefined); await client.sendMessage(chatId, '🚀 Fleet: ' + JSON.stringify(r)); }
        catch (e) { await client.sendMessage(chatId, '❌ ' + e); }
        break;
      }
      case '/compact': {
        const s = sessions.get(chatId);
        if (!s?.alive) { await client.sendMessage(chatId, 'No session.'); break; }
        try { const r = await s.compact(); await client.sendMessage(chatId, '🗜️ ' + (r as any)?.tokensFreed + ' tokens freed'); }
        catch (e) { await client.sendMessage(chatId, '❌ ' + e); }
        break;
      }
      case '/context': {
        const s = sessions.get(chatId);
        if (!s?.alive) { await client.sendMessage(chatId, 'No session.'); break; }
        const msgs = await s.getMessages();
        const types: Record<string, number> = {};
        for (const m of msgs) types[(m as any).type] = (types[(m as any).type] ?? 0) + 1;
        const lines = ['📊 *Context* (' + msgs.length + ' events)'];
        for (const [t, n] of Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 10)) lines.push('  `' + t + '`: ' + n);
        await client.sendMessage(chatId, lines.join('\n'));
        break;
      }
      case '/usage': {
        const s = sessions.get(chatId);
        if (!s?.alive) { await client.sendMessage(chatId, 'No session.'); break; }
        try {
          const q = await s.getQuota();
          const snaps = (q as any)?.quotaSnapshots;
          if (Array.isArray(snaps)) {
            const lines = snaps.map((s: any) => '• ' + s.usedRequests + '/' + s.entitlementRequests + ' (' + s.remainingPercentage + '% left)');
            await client.sendMessage(chatId, '📊 *Usage*\n' + lines.join('\n'));
          } else await client.sendMessage(chatId, '📊 ' + JSON.stringify(q).slice(0, 300));
        } catch (e) { await client.sendMessage(chatId, '❌ ' + e); }
        break;
      }
      case '/tools': {
        const s = sessions.get(chatId);
        if (!s?.alive) { await client.sendMessage(chatId, 'No session.'); break; }
        try {
          const r = await s.listTools();
          const tools = (r as any)?.tools ?? r;
          if (Array.isArray(tools) && tools.length) {
            const lines = tools.slice(0, 30).map((t: any) => '• `' + (t.name ?? t) + '`');
            await client.sendMessage(chatId, '🔧 *Tools* (' + tools.length + ')\n' + lines.join('\n'));
          } else await client.sendMessage(chatId, '🔧 No tools.');
        } catch (e) { await client.sendMessage(chatId, '❌ ' + e); }
        break;
      }
      case '/files': {
        const s = sessions.get(chatId);
        if (!s?.alive) { await client.sendMessage(chatId, 'No session.'); break; }
        try {
          if (args[0] === 'read' && args[1]) {
            const content = await s.readFile(args[1]);
            await client.sendMessage(chatId, '📄 `' + args[1] + '`\n```\n' + content.slice(0, 3800) + '\n```');
          } else {
            const files = await s.listFiles();
            const lines = files.slice(0, 40).map((f: string) => '• `' + f + '`');
            await client.sendMessage(chatId, '📂 ' + files.length + ' files\n' + lines.join('\n'));
          }
        } catch (e) { await client.sendMessage(chatId, '❌ ' + e); }
        break;
      }
      case '/resume': { await client.sendMessage(chatId, '🔄 Not yet implemented. Use `/new`.'); break; }
      case '/config': { await sendConfigMenu(chatId); break; }
      case '/help': default: {
        await client.sendMessage(chatId, [
          '⚡ *Copilot Remote*',
          '', '`/new` `/stop` `/cd` `/status`',
          '`/plan` `/autopilot` `/fleet`',
          '`/research` `/diff` `/review`',
          '`/compact` `/context` `/usage`',
          '`/tools` `/files` `/agent`',
          '`/config` `/abort` `/yes` `/no`',
        ].join('\n'));
        break;
      }
    }
  }

  // ── Config menu ──
  async function sendConfigMenu(chatId: string, editId?: number) {
    const c = cfg(chatId);
    const t = (v: boolean) => v ? '✅' : '⬜';
    const text = '⚙️ *Settings*\nModel: `' + c.model + '`' + (c.agent ? '\nAgent: `' + c.agent + '`' : '');
    const buttons = [
      [{ text: t(c.showThinking) + ' Thinking', data: 'cfg:showThinking' }, { text: t(c.showTools) + ' Tools', data: 'cfg:showTools' }],
      [{ text: t(c.showUsage) + ' Usage', data: 'cfg:showUsage' }, { text: t(c.showReactions) + ' Reactions', data: 'cfg:showReactions' }],
      [{ text: t(c.autopilot) + ' Autopilot', data: 'cfg:autopilot' }],
      [{ text: '🤖 Change Model', data: 'cfg:modelPicker' }],
    ];
    editId ? await client.editButtons(chatId, editId, text, buttons) : await client.sendButtons(chatId, text, buttons);
  }

  async function sendModelPicker(chatId: string, editId: number) {
    const c = cfg(chatId);
    const s = sessions.get(chatId);
    if (!cachedModels.length && s?.alive) {
      try { cachedModels = (await s.listModels()).map(m => (m as any).id ?? (m as any).name).filter(Boolean); } catch {}
    }
    const models = cachedModels.length ? cachedModels : ['claude-sonnet-4', 'gpt-5.2', 'gemini-3-pro-preview'];
    const buttons: { text: string; data: string }[][] = [];
    for (let i = 0; i < models.length; i += 2) {
      buttons.push(models.slice(i, i + 2).map(m => ({ text: (m === c.model ? '● ' : '') + m, data: 'model:' + m })));
    }
    buttons.push([{ text: '← Back', data: 'cfg:back' }]);
    await client.editButtons(chatId, editId, '🤖 *Select Model*', buttons);
  }

  // ── Callbacks ──
  client.onReaction = async (emoji, chatId, msgId) => {
    if (!pendingPerms.has(msgId)) return;
    const s = sessions.get(chatId);
    if (!s?.alive) return;
    if (emoji === '👍' || emoji === '✅') { s.approve(); pendingPerms.delete(msgId); await client.editButtons(chatId, msgId, '✅ Approved', []); }
    else if (emoji === '👎' || emoji === '❌') { s.deny(); pendingPerms.delete(msgId); await client.editButtons(chatId, msgId, '❌ Denied', []); }
  };

  client.onCallback = async (_, data, chatId, msgId) => {
    if (data.startsWith('perm:')) {
      const s = sessions.get(chatId);
      if (!s?.alive) return;
      if (data === 'perm:all') {
        s.autopilot = true;
        const c = cfg(chatId); c.autopilot = true; setCfg(chatId, c);
        s.approve();
        for (const [id, cid] of pendingPerms) { if (cid === chatId) { s.approve(); pendingPerms.delete(id); if (id !== msgId) client.editButtons(chatId, id, '🚀', []).catch(() => {}); } }
        await client.editButtons(chatId, msgId, '🚀 Autopilot ON', []);
      } else {
        const ok = data === 'perm:yes';
        ok ? s.approve() : s.deny();
        pendingPerms.delete(msgId);
        await client.editButtons(chatId, msgId, ok ? '✅' : '❌', []);
      }
      return;
    }
    if (data === 'cfg:modelPicker') return sendModelPicker(chatId, msgId);
    if (data === 'cfg:back') return sendConfigMenu(chatId, msgId);
    if (data.startsWith('model:')) {
      const c = cfg(chatId); c.model = data.slice(6); setCfg(chatId, c);
      const s = sessions.get(chatId); if (s?.alive) try { await s.setModel(c.model); } catch {}
      return sendConfigMenu(chatId, msgId);
    }
    if (data.startsWith('cfg:')) {
      const key = data.slice(4) as keyof ChatConfig;
      const c = cfg(chatId);
      if (key in c && typeof (c as any)[key] === 'boolean') {
        (c as any)[key] = !(c as any)[key]; setCfg(chatId, c);
        if (key === 'autopilot') { const s = sessions.get(chatId); if (s?.alive) s.autopilot = c.autopilot; }
        return sendConfigMenu(chatId, msgId);
      }
    }
  };

  // ── Shutdown ──
  const shutdown = () => { client.stop(); for (const [, s] of sessions) s.kill(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await client.start();
}

main().catch(e => { log.error('Fatal:', e); process.exit(1); });
