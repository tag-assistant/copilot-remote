import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../store.js';

describe('SessionStore deterministic IDs', () => {
  it('builds a deterministic session ID for DMs', () => {
    assert.equal(SessionStore.deterministicSessionId('123456789'), 'telegram-123456789');
  });

  it('builds a deterministic session ID for topic chats', () => {
    assert.equal(
      SessionStore.deterministicSessionId('-1001234567890:42'),
      'telegram--1001234567890-thread-42',
    );
  });

  it('can recover the Telegram session key from a deterministic session ID', () => {
    assert.equal(
      SessionStore.sessionKeyFromSessionId('telegram--1001234567890-thread-42'),
      '-1001234567890:42',
    );
    assert.equal(SessionStore.sessionKeyFromSessionId('telegram-123456789'), '123456789');
  });

  it('ignores non-deterministic legacy session IDs', () => {
    assert.equal(SessionStore.sessionKeyFromSessionId('session-abc-123'), null);
  });
});

describe('SessionStore workDir persistence', () => {
  // Use unique keys per test run to avoid collisions with real data
  const prefix = `test-${Date.now()}-`;

  afterEach(() => {
    // Clean up test keys
    const store = new SessionStore();
    for (const [key] of store.getAllWorkDirs()) {
      if (key.startsWith(prefix)) store.deleteWorkDir(key);
    }
  });

  it('persists and restores workDirs across instances', () => {
    const k1 = `${prefix}chat-1`;
    const k2 = `${prefix}chat-2`;
    const store1 = new SessionStore();
    store1.setWorkDir(k1, '/projects/foo');
    store1.setWorkDir(k2, '/projects/bar');

    // New instance should restore persisted dirs
    const store2 = new SessionStore();
    assert.equal(store2.getWorkDir(k1), '/projects/foo');
    assert.equal(store2.getWorkDir(k2), '/projects/bar');
  });

  it('deleteWorkDir removes the entry', () => {
    const k1 = `${prefix}chat-del`;
    const store1 = new SessionStore();
    store1.setWorkDir(k1, '/projects/foo');
    store1.deleteWorkDir(k1);

    const store2 = new SessionStore();
    assert.equal(store2.getWorkDir(k1), undefined);
  });
});