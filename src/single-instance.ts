import * as fs from 'fs';
import * as path from 'path';

export interface InstanceOwner {
  pid: number;
  cwd: string;
  argv: string[];
  startedAt: string;
}

export interface InstanceLock {
  lockDir: string;
  owner: InstanceOwner;
  release: () => void;
}

export interface InstanceLockFailure {
  lockDir: string;
  existing: InstanceOwner | null;
}

const OWNER_FILE = 'owner.json';

function ownerFilePath(lockDir: string): string {
  return path.join(lockDir, OWNER_FILE);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(lockDir: string): InstanceOwner | null {
  try {
    const raw = fs.readFileSync(ownerFilePath(lockDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<InstanceOwner>;
    if (!parsed || typeof parsed !== 'object') return null;
    const pid = parsed.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid)) return null;
    return {
      pid,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      argv: Array.isArray(parsed.argv) ? parsed.argv.filter((value): value is string => typeof value === 'string') : [],
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    };
  } catch {
    return null;
  }
}

function writeOwner(lockDir: string, owner: InstanceOwner): void {
  fs.writeFileSync(ownerFilePath(lockDir), JSON.stringify(owner, null, 2) + '\n');
}

function removeLockDir(lockDir: string): void {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

export function createInstanceOwner(overrides: Partial<InstanceOwner> = {}): InstanceOwner {
  return {
    pid: overrides.pid ?? process.pid,
    cwd: overrides.cwd ?? process.cwd(),
    argv: overrides.argv ?? process.argv.slice(),
    startedAt: overrides.startedAt ?? new Date().toISOString(),
  };
}

export function acquireSingleInstanceLock(
  lockDir: string,
  owner = createInstanceOwner(),
): { acquired: true; lock: InstanceLock } | { acquired: false; failure: InstanceLockFailure } {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lockDir);
      writeOwner(lockDir, owner);

      let released = false;
      return {
        acquired: true,
        lock: {
          lockDir,
          owner,
          release: () => {
            if (released) return;
            released = true;
            const existing = readOwner(lockDir);
            if (existing && existing.pid !== owner.pid) return;
            removeLockDir(lockDir);
          },
        },
      };
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== 'EEXIST') throw error;

      const existing = readOwner(lockDir);
      if (existing?.pid && existing.pid !== owner.pid && isProcessAlive(existing.pid)) {
        return {
          acquired: false,
          failure: {
            lockDir,
            existing,
          },
        };
      }

      removeLockDir(lockDir);
    }
  }

  const existing = readOwner(lockDir);
  return {
    acquired: false,
    failure: {
      lockDir,
      existing,
    },
  };
}