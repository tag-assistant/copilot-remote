import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatPromptTimeline } from '../prompt-timeline.js';

describe('formatPromptTimeline', () => {
  it('formats timeline entries in order', () => {
    assert.equal(
      formatPromptTimeline([
        { label: 'start', atMs: 0 },
        { label: 'session', atMs: 123.4 },
        { label: 'first_delta', atMs: 456.7, detail: 'thinking' },
        { label: 'done', atMs: 890.1 },
      ]),
      'start@0ms -> session@123ms -> first_delta@457ms(thinking) -> done@890ms',
    );
  });

  it('returns empty string for an empty timeline', () => {
    assert.equal(formatPromptTimeline([]), '');
  });
});
