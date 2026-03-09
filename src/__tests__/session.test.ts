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

  it('serializes queued sends and isolates streamed events by reserved turn', async () => {
    const session = createTestSession();
    let releaseFirst: (() => void) | undefined;

    const sdk = createFakeSdkSession(async (opts) => {
      const prompt = String(opts.prompt ?? '');
      const turnId = prompt === 'first' ? 'turn-1' : 'turn-2';
      session.handleEvent({ type: 'assistant.turn_start', data: { turnId } } as any);
      session.handleEvent({ type: 'assistant.reasoning_delta', data: { deltaContent: `${prompt}-thinking` } } as any);
      session.handleEvent({ type: 'assistant.message_delta', data: { deltaContent: `${prompt}-delta` } } as any);

      if (prompt === 'first') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }

      session.handleEvent({ type: 'assistant.turn_end', data: { turnId } } as any);

      return { data: { content: `${prompt}-final` } };
    });

    session.session = sdk;
    session.messageMode = 'enqueue';

    const firstReservation = session.reserveTurn();
    const secondReservation = session.reserveTurn();
    const firstThinking: string[] = [];
    const secondThinking: string[] = [];

    session.on('thinking_event', (event: { turnId: string | null; text: string }) => {
      if (event.turnId === firstReservation.currentTurnId) firstThinking.push(event.text);
      if (event.turnId === secondReservation.currentTurnId) secondThinking.push(event.text);
    });

    const first = session.send('first', undefined, firstReservation);
    const second = session.send('second', undefined, secondReservation);

    await new Promise<void>((resolve) => setImmediate(resolve));

    // Only the active turn should be running; queued sends wait their turn in the wrapper.
    assert.equal(sdk.sendAndWaitCalls.length, 1);
    assert.equal(sdk.sendAndWaitCalls[0]?.prompt, 'first');

    releaseFirst?.();

    await new Promise<void>((resolve) => setImmediate(resolve));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.deepEqual(
      sdk.sendAndWaitCalls.map((call) => call.prompt),
      ['first', 'second'],
    );
    assert.equal(firstResult.content, 'first-delta');
    assert.equal(secondResult.content, 'second-delta');
    assert.deepEqual(firstThinking, ['first-thinking']);
    assert.deepEqual(secondThinking, ['second-thinking']);
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
      turnId: null,
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

  it('resetSharedClient stops and clears the shared client state', async () => {
    const originalSharedClient = (Session as any).sharedClient;
    const originalSharedClientStarting = (Session as any).sharedClientStarting;
    const originalSharedClientSignature = (Session as any).sharedClientSignature;
    const originalClientRefCount = (Session as any).clientRefCount;
    let stopCalls = 0;
    let forceStopCalls = 0;

    (Session as any).sharedClient = {
      async stop() {
        stopCalls++;
        return [];
      },
      async forceStop() {
        forceStopCalls++;
      },
    };
    (Session as any).sharedClientStarting = Promise.resolve();
    (Session as any).sharedClientSignature = 'sig';
    (Session as any).clientRefCount = 3;

    try {
      await Session.resetSharedClient('test-reset');
    } finally {
      (Session as any).sharedClient = originalSharedClient;
      (Session as any).sharedClientStarting = originalSharedClientStarting;
      (Session as any).sharedClientSignature = originalSharedClientSignature;
      (Session as any).clientRefCount = originalClientRefCount;
    }

    assert.equal(stopCalls, 1);
    assert.equal(forceStopCalls, 0);
    assert.equal((Session as any).sharedClient, originalSharedClient);
    assert.equal((Session as any).sharedClientSignature, originalSharedClientSignature);
    assert.equal((Session as any).clientRefCount, originalClientRefCount);
  });

  it('resetSharedClient force stops when graceful stop fails', async () => {
    const originalSharedClient = (Session as any).sharedClient;
    const originalSharedClientStarting = (Session as any).sharedClientStarting;
    const originalSharedClientSignature = (Session as any).sharedClientSignature;
    const originalClientRefCount = (Session as any).clientRefCount;
    let forceStopCalls = 0;

    (Session as any).sharedClient = {
      async stop() {
        throw new Error('boom');
      },
      async forceStop() {
        forceStopCalls++;
      },
    };
    (Session as any).sharedClientStarting = null;
    (Session as any).sharedClientSignature = 'sig';
    (Session as any).clientRefCount = 2;

    try {
      await Session.resetSharedClient('test-force-reset');
    } finally {
      (Session as any).sharedClient = originalSharedClient;
      (Session as any).sharedClientStarting = originalSharedClientStarting;
      (Session as any).sharedClientSignature = originalSharedClientSignature;
      (Session as any).clientRefCount = originalClientRefCount;
    }

    assert.equal(forceStopCalls, 1);
    assert.equal((Session as any).sharedClient, originalSharedClient);
    assert.equal((Session as any).sharedClientSignature, originalSharedClientSignature);
    assert.equal((Session as any).clientRefCount, originalClientRefCount);
  });
});