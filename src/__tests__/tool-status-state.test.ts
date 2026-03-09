import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolStatusState } from '../tool-status-state.js';

describe('ToolStatusState', () => {
  it('keeps the latest active tool status visible when another tool completes', () => {
    const state = new ToolStatusState();

    state.set('intent', '📝 Logging intent');
    state.set('fetch', '🌐 Fetch `https://feeds.bbci.co.uk/news/rss.xml`');
    state.delete('intent');

    assert.equal(state.current(), '🌐 Fetch `https://feeds.bbci.co.uk/news/rss.xml`');
  });

  it('falls back to empty when all tracked tools complete', () => {
    const state = new ToolStatusState();

    state.set('fetch', '🌐 Fetch `https://news.ycombinator.com/`');
    state.delete('fetch');

    assert.equal(state.current(), '');
  });

  it('updates an existing tool status in place', () => {
    const state = new ToolStatusState();

    state.set('agent', '🤖 Starting Code Review Agent');
    state.set('agent', '🤖 Starting Security Review Agent');

    assert.equal(state.current(), '🤖 Starting Security Review Agent');
  });
});