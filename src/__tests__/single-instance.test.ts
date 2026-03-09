import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acquireSingleInstanceLock,
  createInstanceOwner,
  type InstanceOwner,
} from '../single-instance.js';

function makeTempLockDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-remote-lock-')), 'instance.lock');
}

function seedLock(lockDir: string, owner: InstanceOwner): void {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner, null, 2) + '\n');
}

describe('single-instance lock', () => {
  it('acquires and releases a fresh lock', () => {
    const lockDir = makeTempLockDir();
    const result = acquireSingleInstanceLock(lockDir, createInstanceOwner({ pid: process.pid }));

    assert.equal(result.acquired, true);
    if (!result.acquired) return;

    assert.equal(fs.existsSync(path.join(lockDir, 'owner.json')), true);
    result.lock.release();
    assert.equal(fs.existsSync(lockDir), false);
  });

  it('rejects acquisition when another live pid owns the lock', () => {
    const lockDir = makeTempLockDir();
    seedLock(lockDir, createInstanceOwner({ pid: process.pid, argv: ['node', 'dist/index.js'] }));

    const result = acquireSingleInstanceLock(lockDir, createInstanceOwner({ pid: process.pid + 1000 }));

    assert.equal(result.acquired, false);
    if (result.acquired) return;

    assert.equal(result.failure.existing?.pid, process.pid);
    assert.equal(fs.existsSync(lockDir), true);
  });

  it('reclaims stale locks from dead pids', () => {
    const lockDir = makeTempLockDir();
    seedLock(lockDir, createInstanceOwner({ pid: -1, argv: ['node', 'old.js'] }));

    const result = acquireSingleInstanceLock(lockDir, createInstanceOwner({ pid: process.pid }));

    assert.equal(result.acquired, true);
    if (!result.acquired) return;

    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf-8')) as InstanceOwner;
    assert.equal(owner.pid, process.pid);
    result.lock.release();
  });
});