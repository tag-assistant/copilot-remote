import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleSessionCallback } from '../session-menu.js';
import type { SessionOptions } from '../session.js';
import type { SessionEntry } from '../store.js';

function createDeps() {
  const client = {
    editButtonsCalls: [] as Array<Record<string, unknown>>,
    answerCallbackCalls: [] as Array<Record<string, unknown>>,
    async editButtons(chatId: string, msgId: number, text: string, buttons: unknown[][]) {
      this.editButtonsCalls.push({ chatId, msgId, text, buttons });
    },
    async answerCallback(callbackId: string, text?: string, showAlert?: boolean) {
      this.answerCallbackCalls.push({ callbackId, text, showAlert });
    },
  };

  const rememberedWorkDirs: Array<{ chatId: string; cwd: string }> = [];
  const registered: Array<{ chatId: string; session: unknown }> = [];
  const sessions = new Map<string, {
    alive?: boolean;
    sessionId?: string | null;
    disconnect?: () => Promise<void>;
    resume: (sessionId: string, opts: SessionOptions) => Promise<void>;
  }>();
  const storeWrites: Array<Record<string, unknown>> = [];
  const resumableSession = {
    alive: true,
    sessionId: 'cli-session-1',
    resumeCalls: [] as Array<Record<string, unknown>>,
    async resume(sessionId: string, opts: SessionOptions) {
      this.resumeCalls.push({ sessionId, opts });
      this.sessionId = sessionId;
      this.alive = true;
    },
  };

  return {
    client,
    rememberedWorkDirs,
    registered,
    sessions,
    storeWrites,
    resumableSession,
    deps: {
      client,
      sessions,
      sessionStore: {
        getBySessionId(sessionId: string) {
          if (sessionId !== 'cli-session-1') return undefined;
          return {
            sessionId,
            cwd: '/tmp/cli-session',
            model: 'gpt-5.2',
            createdAt: 100,
            lastUsed: 200,
          };
        },
        set(chatId: string, entry: SessionEntry) {
          storeWrites.push({ chatId, entry });
        },
      },
      getWorkDir: () => '/tmp/fallback',
      rememberWorkDir(chatId: string, cwd: string) {
        rememberedWorkDirs.push({ chatId, cwd });
      },
      createSession: () => resumableSession,
      buildResumeOptions: (_chatId: string, cwd: string, sessionId: string) => ({
        cwd,
        sessionId,
        model: 'claude-sonnet-4',
        autopilot: false,
        messageMode: 'enqueue' as const,
      }),
      registerSessionListeners(session: unknown, chatId: string) {
        registered.push({ chatId, session });
      },
    },
  };
}

describe('handleSessionCallback', () => {
  it('returns false for unrelated callbacks', async () => {
    const { deps } = createDeps();

    const handled = await handleSessionCallback('agent:notes', 'chat-1', 7, 'cb-1', deps);

    assert.equal(handled, false);
  });

  it('resumes a selected session and binds it to the current chat', async () => {
    const { client, rememberedWorkDirs, registered, sessions, storeWrites, resumableSession, deps } = createDeps();
    let disconnected = false;
    sessions.set('chat-1', {
      alive: true,
      sessionId: 'old-session',
      async disconnect() {
        disconnected = true;
      },
      async resume() {
        throw new Error('should not resume existing session');
      },
    });

    const handled = await handleSessionCallback('session:cli-session-1', 'chat-1', 7, 'cb-1', deps);

    assert.equal(handled, true);
    assert.equal(disconnected, true);
    assert.deepEqual(resumableSession.resumeCalls, [{
      sessionId: 'cli-session-1',
      opts: {
        cwd: '/tmp/cli-session',
        sessionId: 'cli-session-1',
        model: 'claude-sonnet-4',
        autopilot: false,
        messageMode: 'enqueue',
      },
    }]);
    assert.deepEqual(rememberedWorkDirs, [{ chatId: 'chat-1', cwd: '/tmp/cli-session' }]);
    assert.deepEqual(registered, [{ chatId: 'chat-1', session: resumableSession }]);
    assert.equal(sessions.get('chat-1'), resumableSession);
    assert.equal(storeWrites.length, 1);
    assert.equal(storeWrites[0]?.chatId, 'chat-1');
    assert.equal((storeWrites[0]?.entry as { sessionId: string }).sessionId, 'cli-session-1');
    assert.match(String(client.editButtonsCalls[0]?.text), /Resumed session/);
    assert.deepEqual(client.answerCallbackCalls[0], { callbackId: 'cb-1', text: 'Session resumed', showAlert: undefined });
  });

  it('blocks attaching a session that is already active in another chat', async () => {
    const { client, sessions, deps } = createDeps();
    sessions.set('chat-2', {
      alive: true,
      sessionId: 'cli-session-1',
      async resume() {
        throw new Error('should not resume active session');
      },
    });

    const handled = await handleSessionCallback('session:cli-session-1', 'chat-1', 7, 'cb-2', deps);

    assert.equal(handled, true);
    assert.match(String(client.editButtonsCalls[0]?.text), /already active in another chat/i);
    assert.deepEqual(client.answerCallbackCalls[0], {
      callbackId: 'cb-2',
      text: 'Session already active elsewhere',
      showAlert: true,
    });
  });

  it('reports missing sessions cleanly', async () => {
    const { client, deps } = createDeps();

    const handled = await handleSessionCallback('session:missing-session', 'chat-1', 7, 'cb-3', deps);

    assert.equal(handled, true);
    assert.match(String(client.editButtonsCalls[0]?.text), /no longer exists/i);
    assert.deepEqual(client.answerCallbackCalls[0], {
      callbackId: 'cb-3',
      text: 'Session not found',
      showAlert: true,
    });
  });
});