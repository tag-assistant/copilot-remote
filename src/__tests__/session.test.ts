import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session.js';

type FakeEventHandler = (event: unknown) => void;

interface FakeSdkSession {
  sessionId: string;
  sendCalls: Array<Record<string, unknown>>;
  sendAndWaitCalls: Array<Record<string, unknown>>;
  on: (handler: FakeEventHandler) => () => void;
  send: (opts: Record<string, unknown>) => Promise<void>;
  sendAndWait: (opts: Record<string, unknown>, timeout: number) => Promise<unknown>;
}

function createTestSession() {
  const session = new Session() as any;
  session._alive = true;
  return session;
}

function createFakeSdkSession(
  impl?: (opts: Record<string, unknown>, timeout: number) => Promise<unknown>,
): FakeSdkSession {
  const handlers = new Set<FakeEventHandler>();

  return {
    sessionId: 'fake-session-id',
    sendCalls: [],
    sendAndWaitCalls: [],
    on(handler: FakeEventHandler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async send(opts: Record<string, unknown>) {
      this.sendCalls.push(opts);
    },
    async sendAndWait(opts: Record<string, unknown>, timeout: number) {
      this.sendAndWaitCalls.push(opts);
      return impl ? impl(opts, timeout) : { data: { content: `final:${String(opts.prompt ?? '')}` } };
    },
  };
}

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

describe('Session', () => {
  it('rejects send before the session is started', async () => {
    const session = new Session();
    await assert.rejects(() => session.send('hello'), /Session not started/);
  });

  it('sendImmediate forwards mode=immediate and attachments to the SDK session', async () => {
    const session = createTestSession();
    const sdk = createFakeSdkSession();
    session.session = sdk;

    const attachments = [{ type: 'file', path: '/tmp/demo.txt' }];
    await session.sendImmediate('steer this turn', attachments as never);

    assert.equal(sdk.sendCalls.length, 1);
    assert.deepEqual(sdk.sendCalls[0], {
      prompt: 'steer this turn',
      mode: 'immediate',
      attachments,
    });
  });

  it('sends prompts directly to SDK (SDK handles queueing via enqueue mode)', async () => {
    const session = createTestSession();
    let releaseFirst: (() => void) | undefined;

    const sdk = createFakeSdkSession(async (opts) => {
      const prompt = String(opts.prompt ?? '');
      session.emit('delta', `${prompt}-delta`);

      if (prompt === 'first') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }

      return { data: { content: `${prompt}-final` } };
    });

    session.session = sdk;
    session.messageMode = 'enqueue';

    const first = session.send('first');
    const second = session.send('second');

    await new Promise<void>((resolve) => setImmediate(resolve));

    // Both calls are made immediately — SDK handles queueing internally
    assert.equal(sdk.sendAndWaitCalls.length, 2);
    assert.equal(sdk.sendAndWaitCalls[0]?.prompt, 'first');
    assert.equal(sdk.sendAndWaitCalls[1]?.prompt, 'second');

    releaseFirst?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.deepEqual(
      sdk.sendAndWaitCalls.map((call) => call.prompt),
      ['first', 'second'],
    );
    // Both deltas are captured by their respective send() calls
    assert.ok(firstResult.content.includes('first-delta'));
    assert.ok(secondResult.content.includes('second-delta'));
  });

  it('falls back to final SDK content when no delta events were streamed', async () => {
    const session = createTestSession();
    const sdk = createFakeSdkSession(async (opts) => ({
      data: { content: `final:${String(opts.prompt ?? '')}` },
    }));
    session.session = sdk;
    session.messageMode = 'enqueue';

    const result = await session.send('no delta path');

    assert.equal(result.content, 'final:no delta path');
    assert.equal(sdk.sendAndWaitCalls[0]?.mode, 'enqueue');
  });

  it('emits permission_request and resolves approval when approve() is called', async () => {
    const session = new Session() as any;
    const seen: unknown[] = [];
    session.on('permission_request', (req: unknown) => {
      seen.push(req);
      queueMicrotask(() => session.approve());
    });

    const result = await session.handlePermission({ kind: 'shell' });

    assert.equal(seen.length, 1);
    assert.equal((result as { kind: string }).kind, 'approved');
  });

  it('emits permission_request and resolves denial when deny() is called', async () => {
    const session = new Session() as any;
    session.on('permission_request', () => {
      queueMicrotask(() => session.deny());
    });

    const result = await session.handlePermission({ kind: 'write' });

    assert.equal((result as { kind: string }).kind, 'denied-interactively-by-user');
  });

  it('emits permission_timeout and denies when approval expires', async () => {
    const session = new Session() as any;
    const events: string[] = [];
    let timerCallback: (() => void) | undefined;

    globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
      timerCallback = () => callback();
      return { mocked: true } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;

    session.on('permission_request', () => {
      events.push('request');
    });
    session.on('permission_timeout', () => {
      events.push('timeout');
    });

    const pending = session.handlePermission({ kind: 'shell' });
    assert.deepEqual(events, ['request']);

    timerCallback?.();

    const result = await pending;
    assert.deepEqual(events, ['request', 'timeout']);
    assert.equal((result as { kind: string }).kind, 'denied-interactively-by-user');
  });

  it('buildConfig pre-tool hook emits telemetry without overriding permissions', async () => {
    const session = new Session() as any;
    session.cwd = '/tmp/project';

    const seen: Array<Record<string, unknown>> = [];
    session.on('hook:pre_tool', (payload: unknown) => {
      seen.push(payload as Record<string, unknown>);
    });

    const config = session.buildConfig({ cwd: '/tmp/project', autopilot: false, messageMode: 'enqueue' }) as {
      hooks?: {
        onPreToolUse?: (input: { toolName?: string; arguments?: unknown }) => Promise<unknown>;
      };
    };

    const result = await config.hooks?.onPreToolUse?.({ toolName: 'bash', arguments: { command: 'ls' } });

    assert.equal(result, undefined);
    assert.deepEqual(seen, [{ toolName: 'bash', arguments: { command: 'ls' } }]);
  });

  it('maps tool.execution_complete events and extracts image payloads', () => {
    const session = new Session() as any;
    let toolEvent: Record<string, unknown> | undefined;

    session.on('tool_complete', (event: unknown) => {
      toolEvent = event as Record<string, unknown>;
    });

    session.handleEvent({
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'call-1',
        name: 'generate_image',
        exitCode: 0,
        result: {
          detailedContent: 'done',
          content: [
            { type: 'image', data: 'base64-image-1' },
            { type: 'text', text: 'ignored' },
            { type: 'image', data: 'base64-image-2' },
          ],
        },
      },
    } as any);

    assert.deepEqual(toolEvent, {
      toolCallId: 'call-1',
      toolName: 'generate_image',
      success: true,
      detailedContent: 'done',
      images: ['base64-image-1', 'base64-image-2'],
    });
  });

  it('prewarmSharedClient delegates to the shared client bootstrap path', async () => {
    const originalGetSharedClient = (Session as any).getSharedClient;
    const seen: Array<Record<string, unknown> | undefined> = [];

    (Session as any).getSharedClient = async (opts?: Record<string, unknown>, retain?: boolean) => {
      seen.push({ ...(opts ?? {}), retain });
      return {};
    };

    try {
      await Session.prewarmSharedClient({ binary: 'copilot', githubToken: 'token-123' });
    } finally {
      (Session as any).getSharedClient = originalGetSharedClient;
    }

    assert.deepEqual(seen, [{ binary: 'copilot', githubToken: 'token-123', retain: false }]);
  });

  it('builds external-server client options when cliUrl is provided', () => {
    const clientOpts = (Session as any).buildSharedClientOptions({
      binary: 'copilot',
      cliUrl: 'http://127.0.0.1:4141',
      githubToken: 'token-123',
    });

    assert.deepEqual(clientOpts, {
      cliUrl: 'http://127.0.0.1:4141',
    });
  });

  it('disables logged-in user auth when a BYOK provider is configured', () => {
    const clientOpts = (Session as any).buildSharedClientOptions({
      binary: 'copilot',
      githubToken: 'token-123',
      provider: {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
      },
    });

    assert.deepEqual(clientOpts, {
      useStdio: true,
      useLoggedInUser: false,
      cliPath: 'copilot',
    });
  });

  it('includes a custom sessionId in the SDK session config', () => {
    const session = new Session() as any;
    session.cwd = '/tmp/project';

    const config = session.buildConfig({
      cwd: '/tmp/project',
      sessionId: 'telegram--100123-thread-42',
      autopilot: false,
    });

    assert.equal(config.sessionId, 'telegram--100123-thread-42');
  });

  it('passes provider config through to the SDK session config', () => {
    const session = new Session() as any;
    session.cwd = '/tmp/project';

    const config = session.buildConfig({
      cwd: '/tmp/project',
      model: 'gpt-4.1-mini',
      provider: {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        wireApi: 'responses',
      },
    });

    assert.deepEqual(config.provider, {
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      wireApi: 'responses',
    });
  });

  it('deletePersistedSession uses the shared client without retaining it', async () => {
    const originalGetSharedClient = (Session as any).getSharedClient;
    const deleted: string[] = [];

    (Session as any).getSharedClient = async (_opts?: Record<string, unknown>, retain?: boolean) => {
      assert.equal(retain, false);
      return {
        async deleteSession(sessionId: string) {
          deleted.push(sessionId);
        },
      };
    };

    try {
      await Session.deletePersistedSession('telegram--100123-thread-42', { binary: 'copilot' });
    } finally {
      (Session as any).getSharedClient = originalGetSharedClient;
    }

    assert.deepEqual(deleted, ['telegram--100123-thread-42']);
  });
});