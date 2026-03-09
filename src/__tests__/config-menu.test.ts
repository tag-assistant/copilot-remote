import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendConfigMenu, handleConfigCallback } from '../config-menu.js';
import { DEFAULT_CONFIG, type ChatConfig } from '../config-store.js';

function createDeps(initialConfig?: Partial<ChatConfig>) {
  const state = {
    config: {
      ...DEFAULT_CONFIG,
      ...initialConfig,
      autoApprove: { ...DEFAULT_CONFIG.autoApprove, ...(initialConfig?.autoApprove ?? {}) },
    } satisfies ChatConfig,
    raw: {} as Record<string, unknown>,
    deletedSessionStoreKeys: [] as string[],
  };

  const client = {
    sendButtonsCalls: [] as Array<Record<string, unknown>>,
    editButtonsCalls: [] as Array<Record<string, unknown>>,
    answerCallbackCalls: [] as Array<Record<string, unknown>>,
    async sendButtons(chatId: string, text: string, buttons: unknown[][]) {
      this.sendButtonsCalls.push({ chatId, text, buttons });
      return 1;
    },
    async editButtons(chatId: string, msgId: number, text: string, buttons: unknown[][]) {
      this.editButtonsCalls.push({ chatId, msgId, text, buttons });
    },
    async answerCallback(callbackId: string, text?: string) {
      this.answerCallbackCalls.push({ callbackId, text });
    },
  };

  const configStore = {
    get: () => ({ ...state.config, autoApprove: { ...state.config.autoApprove } }),
    set: (_key: string, updates: Partial<ChatConfig>) => {
      state.config = {
        ...state.config,
        ...updates,
        autoApprove: { ...state.config.autoApprove, ...(updates.autoApprove ?? {}) },
      };
      return { ...state.config, autoApprove: { ...state.config.autoApprove } };
    },
    raw: () => state.raw,
  };

  const deps = {
    client,
    configStore,
    sessions: new Map<string, Record<string, unknown>>(),
    sessionStore: {
      delete: (key: string) => state.deletedSessionStoreKeys.push(key),
      get: () => undefined,
    },
    cachedModels: [],
    setCachedModels: () => {},
    workDir: () => '/tmp/project',
    bin: 'copilot',
    getSession: async () => ({ alive: true }),
  };

  return { state, deps };
}

describe('config-menu', () => {
  it('shows queue-first message mode label in the config menu', async () => {
    const { deps } = createDeps({ messageMode: 'enqueue' });

    await sendConfigMenu('chat-1', deps as never);

    const firstCall = deps.client.sendButtonsCalls[0];
    assert.ok(firstCall);
    const buttons = firstCall.buttons as Array<Array<{ text: string }>>;
    assert.equal(buttons[3]?.[0]?.text, '📨 Messages: Queue next message');
  });

  it('toggles message mode and updates the live session setting', async () => {
    const { state, deps } = createDeps({ messageMode: 'enqueue' });
    const liveSession = { alive: true, messageMode: 'enqueue' };
    deps.sessions.set('chat-1', liveSession);

    const handled = await handleConfigCallback('cfg:messageMode', 'chat-1', 99, 'cb-1', deps as never);

    assert.equal(handled, true);
    assert.equal(state.config.messageMode, 'immediate');
    assert.equal(liveSession.messageMode, 'immediate');

    const lastEdit = deps.client.editButtonsCalls.at(-1);
    assert.ok(lastEdit);
    const buttons = lastEdit?.buttons as Array<Array<{ text: string }>>;
    assert.equal(buttons[3]?.[0]?.text, '📨 Messages: Interrupt current turn');
  });

  it('toggles display settings and answers the callback with the new state', async () => {
    const { state, deps } = createDeps({ showThinking: false });

    const handled = await handleConfigCallback('dsp:showThinking', 'chat-1', 55, 'cb-2', deps as never);

    assert.equal(handled, true);
    assert.equal(state.config.showThinking, true);
    assert.deepEqual(deps.client.answerCallbackCalls[0], {
      callbackId: 'cb-2',
      text: 'Thinking: ✅ ON',
    });
  });
});