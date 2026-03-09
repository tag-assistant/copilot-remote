import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatPromptLogText } from '../prompt-log.js';

describe('formatPromptLogText', () => {
  it('preserves short text', () => {
    assert.equal(formatPromptLogText('hello', 20), 'hello');
  });

  it('normalizes CRLF line endings', () => {
    assert.equal(formatPromptLogText('hello\r\nworld', 20), 'hello\nworld');
  });

  it('truncates long text with omitted count', () => {
    assert.equal(formatPromptLogText('abcdefghij', 5), 'abcde…[+5 chars]');
  });

  it('returns empty string when max chars is zero or negative', () => {
    assert.equal(formatPromptLogText('hello', 0), '');
    assert.equal(formatPromptLogText('hello', -1), '');
  });
});
