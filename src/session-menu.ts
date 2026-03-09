import type { Button } from './client.js';
import type { SessionOptions } from './session.js';
import type { SessionEntry } from './store.js';

interface SessionMenuClient {
  editButtons: (chatId: string, msgId: number, text: string, buttons: Button[][]) => Promise<void>;
  answerCallback?: (callbackId: string, text?: string, showAlert?: boolean) => Promise<void>;
}

interface ResumableSession {
  alive?: boolean;
  sessionId?: string | null;
  disconnect?: () => Promise<void>;
  resume: (sessionId: string, opts: SessionOptions) => Promise<void>;
}

interface SessionMenuStore {
  getBySessionId: (sessionId: string) => SessionEntry | undefined;
  set: (chatId: string, entry: SessionEntry) => void;
}

export interface SessionMenuDeps {
  client: SessionMenuClient;
  sessions: Map<string, ResumableSession>;
  sessionStore: SessionMenuStore;
  getWorkDir: (chatId: string) => string;
  rememberWorkDir: (chatId: string, cwd: string) => void;
  createSession: () => ResumableSession;
  buildResumeOptions: (chatId: string, cwd: string, sessionId: string) => SessionOptions;
  registerSessionListeners: (session: ResumableSession, chatId: string) => void;
}

export async function handleSessionCallback(
  data: string,
  chatId: string,
  msgId: number,
  callbackId: string,
  deps: SessionMenuDeps,
): Promise<boolean> {
  if (!data.startsWith('session:')) return false;

  const selectedSessionId = data.slice('session:'.length);
  const entry = deps.sessionStore.getBySessionId(selectedSessionId);
  if (!entry) {
    await deps.client.editButtons(chatId, msgId, '❌ Session no longer exists or cannot be resumed.', []);
    await deps.client.answerCallback?.(callbackId, 'Session not found', true);
    return true;
  }

  const current = deps.sessions.get(chatId);
  if (current?.alive && current.sessionId === selectedSessionId) {
    await deps.client.editButtons(
      chatId,
      msgId,
      '✅ Already attached to this session. Send a message to keep going.',
      [],
    );
    await deps.client.answerCallback?.(callbackId, 'Already on this session');
    return true;
  }

  const activeElsewhere = [...deps.sessions.entries()].find(
    ([otherChatId, session]) => otherChatId !== chatId && session.alive && session.sessionId === selectedSessionId,
  );
  if (activeElsewhere) {
    await deps.client.editButtons(
      chatId,
      msgId,
      '🟢 That session is already active in another chat/topic. Pause it there first, then attach it here.',
      [],
    );
    await deps.client.answerCallback?.(callbackId, 'Session already active elsewhere', true);
    return true;
  }

  const targetCwd = entry.cwd || deps.getWorkDir(chatId);
  const resumeOpts = deps.buildResumeOptions(chatId, targetCwd, selectedSessionId);
  const nextSession = deps.createSession();

  try {
    if (current?.alive) await current.disconnect?.();
    deps.sessions.delete(chatId);

    await nextSession.resume(selectedSessionId, resumeOpts);

    deps.rememberWorkDir(chatId, targetCwd);
    deps.registerSessionListeners(nextSession, chatId);
    deps.sessions.set(chatId, nextSession);
    deps.sessionStore.set(chatId, {
      sessionId: selectedSessionId,
      cwd: targetCwd,
      model: resumeOpts.model ?? entry.model,
      createdAt: entry.createdAt,
      lastUsed: Date.now(),
    });

    await deps.client.editButtons(
      chatId,
      msgId,
      '🔁 Resumed session. Send a message to continue.\n\n'
        + '🆔 `' + selectedSessionId + '`\n'
        + '📂 `' + targetCwd + '`',
      [],
    );
    await deps.client.answerCallback?.(callbackId, 'Session resumed');
  } catch (error) {
    deps.sessions.delete(chatId);
    const message = error instanceof Error ? error.message : String(error);
    await deps.client.editButtons(chatId, msgId, '❌ Failed to resume session:\n`' + message.slice(0, 300) + '`', []);
    await deps.client.answerCallback?.(callbackId, 'Resume failed', true);
  }

  return true;
}