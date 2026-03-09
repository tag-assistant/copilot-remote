import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { log, normalizeLogLevel } from '../log.js';

const originalLevel = log.getLevel();

describe('log', () => {
  afterEach(() => {
    log.setLevel(originalLevel);
  });

  it('normalizes common log level aliases', () => {
    assert.equal(normalizeLogLevel('TRACE'), 'debug');
    assert.equal(normalizeLogLevel('notice'), 'info');
    assert.equal(normalizeLogLevel('off'), 'silent');
    assert.equal(normalizeLogLevel('verbose'), 'verbose');
    assert.equal(normalizeLogLevel('wat'), null);
  });

  it('filters messages by threshold', () => {
    log.setLevel('warn');
    assert.equal(log.shouldLog('error'), true);
    assert.equal(log.shouldLog('warn'), true);
    assert.equal(log.shouldLog('info'), false);
    assert.equal(log.shouldLog('debug'), false);
  });

  it('supports verbose and debug thresholds distinctly', () => {
    log.setLevel('verbose');
    assert.equal(log.shouldLog('verbose'), true);
    assert.equal(log.shouldLog('debug'), false);

    log.setLevel('debug');
    assert.equal(log.shouldLog('verbose'), true);
    assert.equal(log.shouldLog('debug'), true);
  });

  it('preserves backward-compatible debug toggle', () => {
    log.setDebug(true);
    assert.equal(log.getLevel(), 'debug');
    assert.equal(log.isDebug(), true);

    log.setDebug(false);
    assert.equal(log.getLevel(), 'info');
    assert.equal(log.isDebug(), false);
  });
});