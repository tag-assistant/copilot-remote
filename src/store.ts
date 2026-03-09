// Copilot Remote — Session store backed by shared Copilot CLI SQLite database
// Uses ~/.copilot/session-store.db for session metadata (shared with CLI)
// Uses deterministic Telegram-derived session IDs by default.
// Keeps ~/.copilot-remote/chat-sessions.json only for legacy migrations/fallback mappings.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { log } from './log.js';

// node:sqlite is experimental (Node 22 needs --experimental-sqlite, Node 23+ has it auto).
// Make it optional so the app degrades gracefully — /sessions and /search lose
// summaries, turn counts, and FTS but everything else works fine.
let DatabaseSyncClass: (new (path: string, opts?: { open?: boolean; readOnly?: boolean }) => DatabaseSyncLike) | null = null;

interface DatabaseSyncLike {
  prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
}

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = await import('node:sqlite');
  DatabaseSyncClass = mod.DatabaseSync;
} catch {
  log.info('[store] node:sqlite not available — session DB features disabled');
}

const DB_PATH = join(process.env.HOME ?? '/tmp', '.copilot', 'session-store.db');
const CHAT_MAP_PATH = join(process.env.HOME ?? '/tmp', '.copilot-remote', 'chat-sessions.json');
const WORK_DIR_PATH = join(process.env.HOME ?? '/tmp', '.copilot-remote', 'work-dirs.json');

export interface SessionEntry {
  sessionId: string;
  cwd: string;
  model: string;
  createdAt: number;
  lastUsed: number;
}

interface DbSession {
  id: string;
  cwd: string;
  repository: string | null;
  branch: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export class SessionStore {
  private chatMap: Record<string, { sessionId: string; model: string }> = {};
  private workDirMap: Record<string, string> = {};
  private db: DatabaseSyncLike | null = null;

  static deterministicSessionId(chatId: string): string {
    const [chatPart, threadPart] = chatId.split(':');
    return threadPart ? `telegram-${chatPart}-thread-${threadPart}` : `telegram-${chatPart}`;
  }

  static sessionKeyFromSessionId(sessionId: string): string | null {
    if (!sessionId.startsWith('telegram-')) return null;
    const encoded = sessionId.slice('telegram-'.length);
    const threadMarker = '-thread-';
    const threadIdx = encoded.lastIndexOf(threadMarker);
    if (threadIdx === -1) return encoded;
    return `${encoded.slice(0, threadIdx)}:${encoded.slice(threadIdx + threadMarker.length)}`;
  }

  constructor() {
    this.loadChatMap();
    this.loadWorkDirMap();
    this.openDb();
  }

  private openDb(): void {
    if (!DatabaseSyncClass) return;
    try {
      if (existsSync(DB_PATH)) {
        this.db = new DatabaseSyncClass(DB_PATH, { open: true, readOnly: true });
        log.info('[store] Opened shared session DB:', DB_PATH);
      }
    } catch (e) {
      log.error('[store] Failed to open session DB:', e);
    }
  }

  /** Get the session entry for a chat */
  get(chatId: string): SessionEntry | undefined {
    return this.getResumeCandidates(chatId)[0];
  }

  /** Get resumable sessions for a chat, preferring the deterministic session ID. */
  getResumeCandidates(chatId: string): SessionEntry[] {
    const deterministicId = SessionStore.deterministicSessionId(chatId);
    const legacyId = this.chatMap[chatId]?.sessionId;
    const model = this.chatMap[chatId]?.model ?? '';
    const candidates = [deterministicId, ...(legacyId && legacyId !== deterministicId ? [legacyId] : [])];

    return candidates
      .map((sessionId) => this.getExistingEntry(sessionId, model))
      .filter((entry): entry is SessionEntry => !!entry);
  }

  /** All known candidate session IDs for a chat, deterministic first. */
  getSessionIds(chatId: string): string[] {
    const deterministicId = SessionStore.deterministicSessionId(chatId);
    const legacyId = this.chatMap[chatId]?.sessionId;
    return [...new Set([deterministicId, ...(legacyId && legacyId !== deterministicId ? [legacyId] : [])])];
  }

  /** Map a chat to a session */
  set(chatId: string, entry: SessionEntry): void {
    const deterministicId = SessionStore.deterministicSessionId(chatId);
    if (entry.sessionId === deterministicId) {
      if (this.chatMap[chatId]) {
        delete this.chatMap[chatId];
        this.saveChatMap();
      }
      return;
    }
    this.chatMap[chatId] = { sessionId: entry.sessionId, model: entry.model };
    this.saveChatMap();
  }

  /** Touch = no-op (DB updated_at is managed by SDK) */
  touch(_chatId: string): void {}

  /** Remove chat→session mapping */
  delete(chatId: string): void {
    delete this.chatMap[chatId];
    this.saveChatMap();
  }

  /** Get persisted working directory for a chat */
  getWorkDir(chatId: string): string | undefined {
    return this.workDirMap[chatId];
  }

  /** Persist working directory for a chat */
  setWorkDir(chatId: string, cwd: string): void {
    this.workDirMap[chatId] = cwd;
    this.saveWorkDirMap();
  }

  /** Remove persisted working directory for a chat */
  deleteWorkDir(chatId: string): void {
    delete this.workDirMap[chatId];
    this.saveWorkDirMap();
  }

  /** Get all persisted working directories */
  getAllWorkDirs(): Map<string, string> {
    return new Map(Object.entries(this.workDirMap));
  }

  /** List all sessions from SQLite DB, sorted by most recent */
  list(): [string, SessionEntry][] {
    if (!this.db) return this.legacyList();
    try {
      const rows = this.db.prepare(
        'SELECT id, cwd, summary, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 20'
      ).all() as unknown as DbSession[];
      // Build reverse map: sessionId → chatId
      const reverseMap: Record<string, string> = {};
      for (const [chatId, m] of Object.entries(this.chatMap)) {
        reverseMap[m.sessionId] = chatId;
      }
      return rows.map(row => {
        const chatId = reverseMap[row.id] ?? SessionStore.sessionKeyFromSessionId(row.id) ?? row.id;
        return [chatId, {
          sessionId: row.id,
          cwd: row.cwd ?? '',
          model: this.chatMap[chatId]?.model ?? '',
          createdAt: new Date(row.created_at).getTime(),
          lastUsed: new Date(row.updated_at).getTime(),
        }] as [string, SessionEntry];
      });
    } catch (e) {
      log.error('[store] Failed to list sessions:', e);
      return [];
    }
  }

  /** Get session summary from DB */
  getSummary(sessionId: string): string | null {
    const row = this.getDbSession(sessionId);
    return row?.summary ?? null;
  }

  /** Search sessions using FTS5 index */
  search(query: string, limit = 5): { sessionId: string; snippet: string; summary: string | null }[] {
    if (!this.db) return [];
    try {
      const rows = this.db.prepare(
        `SELECT DISTINCT s.id, s.summary, snippet(search_index, 0, '<b>', '</b>', '...', 32) as snip
         FROM search_index si
         JOIN sessions s ON s.id = si.session_id
         WHERE search_index MATCH ?
         LIMIT ?`
      ).all(query, limit) as unknown as Array<{ id: string; summary: string | null; snip: string }>;
      return rows.map(r => ({ sessionId: r.id, snippet: r.snip, summary: r.summary }));
    } catch (e) {
      log.debug('[store] Search failed:', e);
      return [];
    }
  }

  /** Get turn count for a session */
  getTurnCount(sessionId: string): number {
    if (!this.db) return 0;
    try {
      const row = this.db.prepare('SELECT COUNT(*) as cnt FROM turns WHERE session_id = ?').get(sessionId) as unknown as { cnt: number };
      return row?.cnt ?? 0;
    } catch { return 0; }
  }

  private getDbSession(sessionId: string): DbSession | undefined {
    if (!this.db) return undefined;
    try {
      return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as unknown as DbSession | undefined;
    } catch { return undefined; }
  }

  private getExistingEntry(sessionId: string, model = ''): SessionEntry | undefined {
    const row = this.getDbSession(sessionId);
    if (!row) return undefined;
    return {
      sessionId,
      cwd: row.cwd ?? '',
      model,
      createdAt: new Date(row.created_at).getTime(),
      lastUsed: new Date(row.updated_at).getTime(),
    };
  }

  private legacyList(): [string, SessionEntry][] {
    return Object.entries(this.chatMap)
      .map(([chatId, m]) => [chatId, { sessionId: m.sessionId, cwd: '', model: m.model, createdAt: 0, lastUsed: 0 }] as [string, SessionEntry])
      .sort((a, b) => b[1].lastUsed - a[1].lastUsed);
  }

  private loadChatMap(): void {
    try {
      this.chatMap = JSON.parse(readFileSync(CHAT_MAP_PATH, 'utf-8'));
    } catch {
      // Try migrating from old sessions.json
      try {
        const oldPath = join(process.env.HOME ?? '/tmp', '.copilot-remote', 'sessions.json');
        const old = JSON.parse(readFileSync(oldPath, 'utf-8')) as Record<string, SessionEntry>;
        for (const [chatId, entry] of Object.entries(old)) {
          this.chatMap[chatId] = { sessionId: entry.sessionId, model: entry.model };
        }
        this.saveChatMap();
        log.info('[store] Migrated from sessions.json → chat-sessions.json');
      } catch {
        this.chatMap = {};
      }
    }
  }

  private saveChatMap(): void {
    try {
      mkdirSync(dirname(CHAT_MAP_PATH), { recursive: true });
      writeFileSync(CHAT_MAP_PATH, JSON.stringify(this.chatMap, null, 2));
    } catch { /* ignore */ }
  }

  private loadWorkDirMap(): void {
    try {
      this.workDirMap = JSON.parse(readFileSync(WORK_DIR_PATH, 'utf-8'));
    } catch {
      this.workDirMap = {};
    }
  }

  private saveWorkDirMap(): void {
    try {
      mkdirSync(dirname(WORK_DIR_PATH), { recursive: true });
      writeFileSync(WORK_DIR_PATH, JSON.stringify(this.workDirMap, null, 2));
    } catch { /* ignore */ }
  }
}
