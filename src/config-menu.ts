// Copilot Remote — Config menu UI (/config command and callback handlers)
import type { Client, Button } from './client.js';
import type { ChatConfig, PermKind } from './config-store.js';
import type { ConfigStore } from './config-store.js';
import type { Session } from './session.js';
import type { ModelInfo } from '@github/copilot-sdk';
import { PERM_KIND_LABELS } from './constants.js';
import { log } from './log.js';
import type { SessionStore } from './store.js';

export interface ConfigMenuDeps {
  client: Client;
  configStore: ConfigStore;
  sessions: Map<string, Session>;
  sessionStore: SessionStore;
  cachedModels: ModelInfo[];
  setCachedModels: (models: ModelInfo[]) => void;
  workDir: (id: string) => string;
  bin: string;
  getSession: (chatId: string) => Promise<Session>;
}

function pfx(chatId: string, data: string): string {
  return `@${chatId}|${data}`;
}

export async function sendConfigMenu(chatId: string, deps: ConfigMenuDeps, editId?: number): Promise<void> {
  const { client, configStore } = deps;
  const c = configStore.get(chatId);
  const globalCfg = configStore.raw();

  const text =
    '⚙️ *Settings*\nModel: `' +
    c.model +
    '`\n' +
    (c.autopilot ? '🟢 Autopilot' : '🔴 Ask before acting') +
    (c.agent ? '\nAgent: `' + c.agent + '`' : '') +
    (globalCfg.provider ? `\nProvider: Custom (${globalCfg.provider.baseUrl})` : '') +
    (globalCfg.mcpServers ? `\nMCP: ${Object.keys(globalCfg.mcpServers).length} servers` : '');

  const buttons = [
    [{
      text: c.autopilot ? '🟢 Autopilot ON' : '🔴 Autopilot OFF',
      data: pfx(chatId, 'cfg:autopilot'),
      style: c.autopilot ? 'danger' : 'primary',
    }],
    [{ text: '🤖 Change Model', data: pfx(chatId, 'cfg:modelPicker') }],
    [{ text: `🧠 Reasoning: ${c.reasoningEffort || 'Default'}`, data: pfx(chatId, 'cfg:reasoning') }],
    [{ text: `📨 Messages: ${c.messageMode || 'Default'}`, data: pfx(chatId, 'cfg:messageMode') }],
    [{
      text: '🔧 Tools' + (c.excludedTools?.length ? `: ${c.excludedTools.length} disabled` : ''),
      data: pfx(chatId, 'cfg:tools'),
    }],
    [{ text: '🔒 Tool Security', data: pfx(chatId, 'cfg:security') }],
    [{ text: '🎨 Display', data: pfx(chatId, 'cfg:display') }],
    [{ text: '📊 Usage', data: pfx(chatId, 'cfg:usage') }],
  ];

  if (editId) {
    await client.editButtons(chatId, editId, text, buttons);
  } else {
    await client.sendButtons(chatId, text, buttons);
  }
}

export async function sendToolsMenu(chatId: string, editId: number, deps: ConfigMenuDeps): Promise<void> {
  const { client, configStore, sessions } = deps;
  const c = configStore.get(chatId);

  let tools: string[] = [];
  const s = sessions.get(chatId);
  if (s?.alive) {
    try {
      const r = await s.listTools();
      tools = (r?.tools ?? []).map((t: { name?: string }) => t.name).filter((n): n is string => !!n);
    } catch { /* ignore */ }
  }

  if (!tools.length) {
    await client.editButtons(
      chatId, editId,
      '🔧 *Tools*\nSend a message first to start a session, then open Tools.',
      [[{ text: '← Back', data: pfx(chatId, 'cfg:back') }]],
    );
    return;
  }

  const excluded = new Set(c.excludedTools ?? []);
  const buttons: Button[][] = [];
  for (let i = 0; i < tools.length; i += 2) {
    buttons.push(
      tools.slice(i, i + 2).map((t) => ({
        text: t,
        data: pfx(chatId, `tool:${t}`),
        ...(excluded.has(t) ? {} : { style: 'success' }),
      })),
    );
  }
  buttons.push([{ text: '← Back', data: pfx(chatId, 'cfg:back') }]);

  await client.editButtons(
    chatId, editId,
    `🔧 *Tools* (${tools.length})` + (excluded.size ? `\n${excluded.size} disabled` : '\nAll enabled'),
    buttons,
  );
}

export async function sendReasoningMenu(chatId: string, editId: number, deps: ConfigMenuDeps): Promise<void> {
  const { client, configStore, sessions } = deps;
  const c = configStore.get(chatId);

  if (!deps.cachedModels.length) {
    const s = sessions.get(chatId);
    if (s?.alive) {
      try {
        const models = await s.listModels();
        deps.setCachedModels(models);
      } catch { /* ignore */ }
    }
  }

  const modelInfo = deps.cachedModels.find((m) => (m.id ?? m.name) === c.model);
  const supported: string[] = modelInfo?.supportedReasoningEfforts ?? [];

  if (!supported.length) {
    await client.editButtons(
      chatId, editId,
      `🧠 *Reasoning Effort*\n⚠️ ${c.model} does not support reasoning effort.`,
      [[{ text: '← Back', data: pfx(chatId, 'cfg:back') }]],
    );
    return;
  }

  const labels: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh' };
  const levels = ['', ...supported];
  const allLabels: Record<string, string> = { '': 'Default', ...labels };
  const current = c.reasoningEffort || '';
  const buttons = levels.map((l) => [{
    text: allLabels[l] ?? l,
    data: pfx(chatId, `reason:${l || 'default'}`),
    ...(l === current ? { style: 'success' } : {}),
  }]);
  const defaultNote = modelInfo?.defaultReasoningEffort ? ` (default: ${modelInfo.defaultReasoningEffort})` : '';
  buttons.push([{ text: '← Back', data: pfx(chatId, 'cfg:back') }]);
  await client.editButtons(chatId, editId, `🧠 *Reasoning Effort*${defaultNote}\nHigher = smarter but slower/costlier:`, buttons);
}

export async function sendDisplayMenu(chatId: string, editId: number, deps: ConfigMenuDeps): Promise<void> {
  const { client, configStore } = deps;
  const c = configStore.get(chatId);

  const toggle = (on: boolean, label: string, data: string) => ({
    text: label, data, ...(on ? { style: 'success' } : {}),
  });
  const buttons = [
    [toggle(c.showThinking, 'Thinking', pfx(chatId, 'dsp:showThinking')), toggle(c.showTools, 'Tools', pfx(chatId, 'dsp:showTools'))],
    [toggle(c.showReactions, 'Reactions', pfx(chatId, 'dsp:showReactions'))],
    [toggle(c.infiniteSessions !== false, 'Infinite Sessions', pfx(chatId, 'dsp:infiniteSessions'))],
    [{ text: '← Back', data: pfx(chatId, 'cfg:back') }],
  ];
  await client.editButtons(chatId, editId, '🎨 *Display*\nToggle what shows in responses:', buttons);
}

export async function sendSecurityMenu(chatId: string, editId: number, deps: ConfigMenuDeps): Promise<void> {
  const { client, configStore } = deps;
  const c = configStore.get(chatId);

  const buttons: { text: string; data: string; style?: string }[][] = [];
  for (const [kind, label] of Object.entries(PERM_KIND_LABELS)) {
    const on = c.autoApprove[kind as PermKind];
    buttons.push([{ text: label, data: pfx(chatId, `sec:${kind}`), ...(on ? { style: 'success' } : {}) }]);
  }
  const allOn = Object.values(c.autoApprove).every(Boolean);
  buttons.push([{
    text: allOn ? 'Revoke All' : 'Approve All',
    data: pfx(chatId, 'sec:toggle-all'),
    ...(allOn ? { style: 'danger' } : { style: 'success' }),
  }]);
  buttons.push([{ text: '← Back', data: pfx(chatId, 'cfg:back') }]);
  await client.editButtons(chatId, editId, '🔒 *Tool Security*\nAuto-approve by type:', buttons);
}

export async function sendModelPicker(chatId: string, editId: number, deps: ConfigMenuDeps): Promise<void> {
  const { client, configStore, sessions } = deps;
  const c = configStore.get(chatId);

  if (!deps.cachedModels.length) {
    try {
      let s = sessions.get(chatId);
      if (!s?.alive) s = await deps.getSession(chatId);
      const models = await s.listModels();
      deps.setCachedModels(models);
      log.info('Models:', models.map((m) => m.id ?? m.name ?? m));
    } catch { /* ignore */ }
  }

  const modelIds = deps.cachedModels.length
    ? deps.cachedModels.map((m) => m.id ?? m.name ?? String(m)).filter(Boolean)
    : ['claude-sonnet-4', 'gpt-5.2', 'gemini-3-pro-preview'];

  const buttons: { text: string; data: string; style?: string }[][] = [];
  for (let i = 0; i < modelIds.length; i += 2) {
    buttons.push(
      modelIds.slice(i, i + 2).map((m: string) => ({
        text: m,
        data: pfx(chatId, `model:${m}`),
        ...(m === c.model ? { style: 'success' } : {}),
      })),
    );
  }
  buttons.push([{ text: '← Back', data: pfx(chatId, 'cfg:back') }]);
  await client.editButtons(chatId, editId, '🤖 *Select Model*', buttons);
}

/** Handle all config-related callbacks. Returns true if handled. */
export async function handleConfigCallback(
  data: string,
  chatId: string,
  msgId: number,
  callbackId: string,
  deps: ConfigMenuDeps,
): Promise<boolean> {
  const { client, configStore, sessions, sessionStore } = deps;
  const cfg = (key: string) => configStore.get(key);
  const setCfg = (key: string, updates: Partial<ChatConfig>) => configStore.set(key, updates, true);

  if (data.startsWith('reason:')) {
    const level = data.slice(7) === 'default' ? '' : data.slice(7);
    const c = cfg(chatId);
    c.reasoningEffort = level;
    setCfg(chatId, c);
    const old = sessions.get(chatId);
    const savedId = old?.sessionId ?? sessionStore.get(chatId)?.sessionId;
    if (old?.alive) await old.disconnect();
    sessions.delete(chatId);
    if (savedId) {
      const { Session } = await import('./session.js');
      const s = new Session();
      try {
        await s.resume(savedId, {
          cwd: deps.workDir(chatId),
          binary: deps.bin,
          model: c.model,
          autopilot: c.autopilot,
          reasoningEffort: level as 'low' | 'medium' | 'high' | 'xhigh',
        });
        sessions.set(chatId, s);
      } catch {
        sessionStore.delete(chatId);
        await deps.getSession(chatId);
      }
    }
    await sendConfigMenu(chatId, deps, msgId);
    return true;
  }

  if (data === 'cfg:reasoning') { await sendReasoningMenu(chatId, msgId, deps); return true; }
  if (data === 'cfg:display') { await sendDisplayMenu(chatId, msgId, deps); return true; }
  if (data === 'cfg:security') { await sendSecurityMenu(chatId, msgId, deps); return true; }
  if (data === 'cfg:modelPicker') { await sendModelPicker(chatId, msgId, deps); return true; }
  if (data === 'cfg:back') { await sendConfigMenu(chatId, deps, msgId); return true; }
  if (data === 'cfg:tools') { await sendToolsMenu(chatId, msgId, deps); return true; }

  if (data === 'cfg:usage') {
    const s = sessions.get(chatId);
    const lines: string[] = [];
    if (s?.alive) {
      try {
        const q = await s.getQuota();
        const snaps = q?.quotaSnapshots;
        if (snaps && typeof snaps === 'object') {
          for (const [name, snap] of Object.entries(snaps) as unknown as [string, Record<string, unknown>][]) {
            const used = snap.usedRequests ?? 0;
            const total = snap.entitlementRequests ?? 0;
            const pct = snap.remainingPercentage ?? 100;
            lines.push(`*${name}*: ${used}/${total} · ${pct}% left`);
          }
        }
      } catch { /* ignore */ }
    }
    await client.editButtons(
      chatId, msgId,
      '📊 *Usage*\n' + (lines.length ? lines.join('\n') : 'No data yet — send a message first.'),
      [[{ text: '← Back', data: pfx(chatId, 'cfg:back') }]],
    );
    return true;
  }

  if (data === 'cfg:messageMode') {
    const c = cfg(chatId);
    const cycle: Array<'' | 'enqueue' | 'immediate'> = ['', 'enqueue', 'immediate'];
    const idx = cycle.indexOf(c.messageMode || '');
    c.messageMode = cycle[(idx + 1) % cycle.length];
    setCfg(chatId, c);
    const s = sessions.get(chatId);
    if (s?.alive) s.messageMode = c.messageMode || undefined;
    await sendConfigMenu(chatId, deps, msgId);
    return true;
  }

  if (data.startsWith('tool:')) {
    const toolName = data.slice(5);
    const c = cfg(chatId);
    const excluded = new Set(c.excludedTools ?? []);
    if (excluded.has(toolName)) excluded.delete(toolName);
    else excluded.add(toolName);
    c.excludedTools = [...excluded];
    setCfg(chatId, c);
    await sendToolsMenu(chatId, msgId, deps);
    const old = sessions.get(chatId);
    if (old?.alive) await old.disconnect();
    sessions.delete(chatId);
    return true;
  }

  if (data.startsWith('model:')) {
    const c = cfg(chatId);
    c.model = data.slice(6);
    setCfg(chatId, c);
    const s = sessions.get(chatId);
    if (s?.alive) try { await s.setModel(c.model); } catch { /* ignore */ }
    await sendConfigMenu(chatId, deps, msgId);
    return true;
  }

  if (data.startsWith('dsp:')) {
    const key = data.slice(4) as keyof ChatConfig;
    const c = cfg(chatId);
    if (key === 'infiniteSessions') {
      c.infiniteSessions = c.infiniteSessions === false ? undefined : false;
      setCfg(chatId, c);
      await sendDisplayMenu(chatId, msgId, deps);
      return true;
    }
    const rec = c as unknown as Record<string, unknown>;
    if (key in c && typeof rec[key] === 'boolean') {
      rec[key] = !rec[key];
      setCfg(chatId, c);
      const label = key.replace('show', '');
      const state = rec[key] ? '✅ ON' : '⬜ OFF';
      client.answerCallback?.(callbackId, `${label}: ${state}`);
    }
    await sendDisplayMenu(chatId, msgId, deps);
    return true;
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
    await sendSecurityMenu(chatId, msgId, deps);
    return true;
  }

  if (data === 'cfg:autopilot') {
    const c = cfg(chatId);
    c.autopilot = !c.autopilot;
    c.mode = c.autopilot ? 'autopilot' : 'interactive';
    setCfg(chatId, c);
    const old = sessions.get(chatId);
    if (old?.alive) await old.disconnect();
    sessions.delete(chatId);
    sessionStore.delete(chatId);
    await sendConfigMenu(chatId, deps, msgId);
    return true;
  }

  if (data.startsWith('mode:')) {
    const newMode = data.slice(5) as 'interactive' | 'plan' | 'autopilot';
    const c = cfg(chatId);
    log.debug(`Mode switch: ${c.mode} → ${newMode} [${chatId}]`);
    c.mode = newMode;
    c.autopilot = newMode === 'autopilot';
    setCfg(chatId, c);
    const old = sessions.get(chatId);
    if (old?.alive) {
      log.debug(`Killing session for mode switch [${chatId}]`);
      await old.disconnect();
    }
    sessions.delete(chatId);
    sessionStore.delete(chatId);
    log.info(`Mode: ${newMode} [${chatId}]`);
    await sendConfigMenu(chatId, deps, msgId);
    return true;
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
      await sendConfigMenu(chatId, deps, msgId);
      return true;
    }
  }

  return false;
}
