import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../cli-runner.js';

describe('runCli', () => {
  it('delegates install to the bundled installer', async () => {
    const installerCalls: Array<{ scriptPath: string; args: string[]; env: NodeJS.ProcessEnv }> = [];

    const exitCode = await runCli(['install', '--hackable'], {
      env: {},
      installerPath: '/tmp/copilot-remote/install.sh',
      runInstaller: (scriptPath, args, env) => {
        installerCalls.push({ scriptPath, args, env });
        return 0;
      },
      startMain: async () => {
        throw new Error('startMain should not run for install');
      },
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(installerCalls, [
      {
        scriptPath: '/tmp/copilot-remote/install.sh',
        args: ['--hackable'],
        env: {},
      },
    ]);
  });

  it('treats daemon-install as an install alias', async () => {
    const installerCalls: string[][] = [];

    const exitCode = await runCli(['daemon-install'], {
      env: {},
      installerPath: '/tmp/copilot-remote/install.sh',
      runInstaller: (_scriptPath, args) => {
        installerCalls.push(args);
        return 0;
      },
      startMain: async () => {
        throw new Error('startMain should not run for daemon-install');
      },
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(installerCalls, [[]]);
  });

  it('forwards parsed options into env before starting the main app', async () => {
    const env: NodeJS.ProcessEnv = {};
    let started = false;

    const exitCode = await runCli([
      '--token', 'bot-123',
      '--github-token', 'gh-123',
      '--workdir', '/tmp/project',
      '--binary', '/usr/local/bin/copilot',
      '--allowed-users', '1,2,3',
      '--fake-telegram',
    ], {
      env,
      execSync: ((() => '') as unknown) as typeof import('node:child_process').execSync,
      startMain: async () => {
        started = true;
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(started, true);
    assert.equal(env.COPILOT_REMOTE_BOT_TOKEN, 'bot-123');
    assert.equal(env.GITHUB_TOKEN, 'gh-123');
    assert.equal(env.COPILOT_REMOTE_WORKDIR, '/tmp/project');
    assert.equal(env.COPILOT_REMOTE_BINARY, '/usr/local/bin/copilot');
    assert.equal(env.COPILOT_REMOTE_ALLOWED_USERS, '1,2,3');
    assert.equal(env.COPILOT_REMOTE_FAKE_TELEGRAM, '1');
  });

  it('uses gh auth token as a fallback for foreground runs', async () => {
    const env: NodeJS.ProcessEnv = {};

    await runCli([], {
      env,
      execSync: ((() => 'gh-fallback-token\n') as unknown) as typeof import('node:child_process').execSync,
      startMain: async () => {},
    });

    assert.equal(env.GITHUB_TOKEN, 'gh-fallback-token');
  });
});