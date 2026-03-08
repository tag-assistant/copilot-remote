import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigStore, DEFAULT_CONFIG } from '../config-store.js';

describe('ConfigStore', () => {
  // Note: ConfigStore reads from ~/.copilot-remote/config.json at construction.
  // These tests work with whatever global config exists, testing behavior not absolute values.

  it('returns a config object with all expected keys', () => {
    const store = new ConfigStore();
    const cfg = store.get('test-chat-' + Date.now());
    assert.equal(typeof cfg.model, 'string');
    assert.equal(typeof cfg.autopilot, 'boolean');
    assert.equal(typeof cfg.showReactions, 'boolean');
    assert.equal(typeof cfg.autoApprove, 'object');
    assert.ok('read' in cfg.autoApprove);
    assert.ok('shell' in cfg.autoApprove);
  });

  it('global set changes all keys', () => {
    const store = new ConfigStore();
    const before = store.getGlobal().model;
    const testModel = 'test-model-' + Date.now();
    store.set('chat1', { model: testModel }, true);
    assert.equal(store.get('chat1').model, testModel);
    assert.equal(store.get('other-chat').model, testModel);
    // Restore
    store.set('chat1', { model: before }, true);
  });

  it('thread overrides only affect that thread', () => {
    const store = new ConfigStore();
    const globalModel = store.getGlobal().model;
    const threadKey = 'thread-' + Date.now();
    store.set(threadKey, { model: 'thread-only-model' }, false);
    assert.equal(store.get(threadKey).model, 'thread-only-model');
    assert.equal(store.getGlobal().model, globalModel);
  });

  it('thread overrides merge with global', () => {
    const store = new ConfigStore();
    const threadKey = 'thread-merge-' + Date.now();
    store.set(threadKey, { showThinking: true }, false);
    const cfg = store.get(threadKey);
    assert.equal(cfg.showThinking, true);
    // Other fields come from global
    assert.equal(cfg.model, store.getGlobal().model);
  });

  it('autoApprove merges correctly', () => {
    const store = new ConfigStore();
    const threadKey = 'thread-approve-' + Date.now();
    const globalShell = store.getGlobal().autoApprove.shell;
    store.set(threadKey, { autoApprove: { shell: !globalShell } as any }, false);
    const cfg = store.get(threadKey);
    assert.equal(cfg.autoApprove.shell, !globalShell);
    // Other approve settings come from global
    assert.equal(cfg.autoApprove.read, store.getGlobal().autoApprove.read);
  });

  it('hasOverrides tracks thread state', () => {
    const store = new ConfigStore();
    const key = 'has-overrides-' + Date.now();
    assert.equal(store.hasOverrides(key), false);
    store.set(key, { model: 'x' }, false);
    assert.equal(store.hasOverrides(key), true);
  });

  it('resetOverrides reverts to global', () => {
    const store = new ConfigStore();
    const key = 'reset-' + Date.now();
    store.set(key, { model: 'custom' }, false);
    assert.equal(store.get(key).model, 'custom');
    store.resetOverrides(key);
    assert.equal(store.get(key).model, store.getGlobal().model);
    assert.equal(store.hasOverrides(key), false);
  });

  it('DEFAULT_CONFIG has sensible defaults', () => {
    assert.equal(DEFAULT_CONFIG.autopilot, false);
    assert.equal(DEFAULT_CONFIG.showReactions, true);
    assert.equal(DEFAULT_CONFIG.autoApprove.read, true);
    assert.equal(DEFAULT_CONFIG.autoApprove.shell, false);
    assert.equal(DEFAULT_CONFIG.autoApprove.write, false);
  });
});
