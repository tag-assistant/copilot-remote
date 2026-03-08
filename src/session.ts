// Copilot Remote — Session (SDK wrapper)
import {
  CopilotClient,
  CopilotSession as SDKSession,
  approveAll,
  type SessionEvent,
  type ModelInfo,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionConfig,
} from '@github/copilot-sdk';
import { EventEmitter } from 'events';
import { log } from './log.js';
import { createTelegramTools } from './tools.js';

export interface SessionOptions {
  cwd: string;
  binary?: string;
  model?: string;
  autopilot?: boolean;
  agent?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  topicContext?: string; // e.g. "Fix auth bug" — injected into system prompt
}

export interface CopilotMessage {
  content: string;
  usage?: { inputTokens?: number; outputTokens?: number; model?: string };
}

export class Session extends EventEmitter {
  private client: CopilotClient | null = null;
  private session: SDKSession | null = null;
  private _alive = false;
  private _busy = false;
  private _autopilot = false;
  private cwd = '';

  // Message queue for sequential processing
  private queue: { prompt: string; resolve: (msg: CopilotMessage) => void; reject: (err: Error) => void }[] = [];
  private processing = false;

  get alive() {
    return this._alive;
  }
  get busy() {
    return this._busy;
  }
  get sessionId() {
    return this.session?.sessionId ?? null;
  }
  get autopilot() {
    return this._autopilot;
  }
  set autopilot(v: boolean) {
    this._autopilot = v;
  }

  private buildConfig(opts: SessionOptions): Partial<SessionConfig> {
    return {
      clientName: 'copilot-remote',
      streaming: true,
      workingDirectory: this.cwd,
      systemMessage: {
        mode: 'append',
        content: [
          'You are being accessed via a Telegram bot bridge called copilot-remote.',
          'The user is chatting with you from their phone. Keep responses concise but complete.',
          'You have full access to the filesystem, shell, and all tools. Use them proactively.',
          "When asked to do something, do it — don't just explain how.",
          'Show your work: mention files you read, commands you ran, changes you made.',
          'Format responses with markdown (bold, code blocks, lists) — it renders in Telegram.',
          ...(opts.topicContext
            ? ['This conversation topic is: "' + opts.topicContext + '". Stay focused on this subject.']
            : []),
        ].join('\n'),
      },
      onPermissionRequest: this._autopilot ? approveAll : (req: PermissionRequest) => this.handlePermission(req),
      onUserInputRequest: (req: any) => this.handleUserInput(req),
      infiniteSessions: { enabled: true, backgroundCompactionThreshold: 0.8, bufferExhaustionThreshold: 0.95 },
      tools: createTelegramTools({
        sendNotification: async (text: string) => {
          this.emit('notification', text);
        },
      }),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort as any } : {}),
    };
  }

  async start(opts: SessionOptions): Promise<void> {
    this.cwd = opts.cwd;
    this._autopilot = opts.autopilot ?? false;

    const clientOpts: Record<string, any> = { useStdio: true };
    if (opts.binary) clientOpts.cliPath = opts.binary;

    this.client = new CopilotClient(clientOpts);
    await this.client.start();

    this.session = await this.client.createSession(this.buildConfig(opts) as SessionConfig);
    this._alive = true;
    this.session.on((e: SessionEvent) => this.handleEvent(e));
  }

  private handleEvent(e: SessionEvent): void {
    const d = e.data as any;
    switch (e.type) {
      case 'assistant.message_delta':
        this.emit('delta', d.content ?? d.text ?? '');
        break;
      case 'assistant.reasoning_delta':
        this.emit('thinking', d.content ?? d.text ?? '');
        break;
      case 'assistant.message':
        this.emit('message', d.content ?? '');
        break;
      case 'assistant.usage':
        this.emit('usage', d);
        break;
      case 'tool.execution_start':
        this.emit('tool_start', { toolName: d.name ?? d.toolName, arguments: d.arguments });
        break;
      case 'tool.execution_complete':
        this.emit('tool_complete', {
          toolName: d.name ?? d.toolName,
          success: d.exitCode === 0 || d.success !== false,
        });
        break;
      case 'permission.requested':
        this.emit('permission_request', d);
        break;
      case 'session.idle':
        this.emit('idle');
        break;
      case 'session.error':
        this.emit('error', d.message ?? 'Unknown error');
        break;
      default:
        log.sdk(e.type, d);
        break;
    }
  }

  private async handlePermission(req: PermissionRequest): Promise<PermissionRequestResult> {
    this.emit('permission_request', req);
    log.debug('Permission prompt (waiting for user):', req.kind);
    return new Promise<PermissionRequestResult>((resolve) => {
      const handler = (approved: boolean) => {
        resolve({ kind: approved ? 'approved' : 'denied-interactively-by-user' } as PermissionRequestResult);
      };
      this.once('permission_response', handler);
      setTimeout(() => {
        this.off('permission_response', handler);
        resolve({ kind: 'denied-interactively-by-user' } as PermissionRequestResult);
      }, 120_000);
    });
  }

  private async handleUserInput(req: any): Promise<{ answer: string; wasFreeform: boolean }> {
    this.emit('user_input_request', req);
    log.debug('User input request:', req.question);
    return new Promise<{ answer: string; wasFreeform: boolean }>((resolve) => {
      const handler = (answer: string) => {
        resolve({ answer, wasFreeform: !req.choices?.length });
      };
      this.once('user_input_response', handler);
      setTimeout(() => {
        this.off('user_input_response', handler);
        resolve({ answer: '', wasFreeform: true }); // Empty response on timeout
      }, 300_000); // 5 min timeout for user questions
    });
  }

  answerInput(answer: string) {
    this.emit('user_input_response', answer);
  }

  // ── Core ──

  async send(prompt: string): Promise<CopilotMessage> {
    if (!this._alive) throw new Error('Session not started');
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || !this.queue.length) return;
    this.processing = true;
    this._busy = true;
    const { prompt, resolve, reject } = this.queue.shift()!;

    try {
      let text = '';
      const onDelta = (t: string) => {
        text += t;
      };
      this.on('delta', onDelta);

      const result = await this.session!.sendAndWait({ prompt }, 300_000);
      log.debug('sendAndWait result:', JSON.stringify(result).slice(0, 500));

      this.off('delta', onDelta);
      resolve({
        content:
          text.trim() ||
          (result as any)?.data?.content ||
          (result as any)?.content ||
          String(result ?? '').slice(0, 500) ||
          '_(no response)_',
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this._busy = false;
      this.processing = false;
      if (this.queue.length) this.processQueue();
    }
  }

  approve() {
    this.emit('permission_response', true);
  }
  deny() {
    this.emit('permission_response', false);
  }
  async abort() {
    this.session?.abort();
  }

  // ── SDK RPCs ──

  async setModel(model: string) {
    this.session?.setModel(model);
  }
  async listModels(): Promise<ModelInfo[]> {
    return this.client?.listModels() ?? [];
  }
  async setMode(mode: string) {
    await this.session!.rpc.mode.set({ mode: mode as any });
  }
  async getMode(): Promise<string> {
    return (await this.session!.rpc.mode.get()).mode;
  }
  async compact(): Promise<any> {
    return this.session!.rpc.compaction.compact();
  }
  async startFleet(prompt?: string): Promise<any> {
    return this.session!.rpc.fleet.start({ prompt });
  }
  async listAgents(): Promise<any> {
    return this.session!.rpc.agent.list();
  }
  async selectAgent(name: string): Promise<any> {
    return this.session!.rpc.agent.select({ name });
  }
  async deselectAgent(): Promise<any> {
    return this.session!.rpc.agent.deselect();
  }
  async getCurrentModel(): Promise<any> {
    return this.session!.rpc.model.getCurrent();
  }
  async getCurrentAgent(): Promise<any> {
    return this.session!.rpc.agent.getCurrent();
  }
  async readPlan(): Promise<any> {
    return this.session!.rpc.plan.read();
  }
  async deletePlan(): Promise<any> {
    return this.session!.rpc.plan.delete();
  }
  async listTools(): Promise<any> {
    return (this.client as any).rpc.tools.list({ sessionId: this.session!.sessionId });
  }
  async getQuota(): Promise<any> {
    return (this.client as any).rpc.account.getQuota();
  }
  async getMessages(): Promise<any[]> {
    return this.session?.getMessages() ?? [];
  }
  async listFiles(): Promise<string[]> {
    return ((await this.session!.rpc.workspace.listFiles()) as any)?.files ?? [];
  }
  async readFile(path: string): Promise<string> {
    return ((await this.session!.rpc.workspace.readFile({ path })) as any)?.content ?? '';
  }

  async newSession(): Promise<void> {
    if (this.session) await this.session.disconnect();
    const config: SessionConfig = {
      clientName: 'copilot-remote',
      streaming: true,
      workingDirectory: this.cwd,
      onPermissionRequest: this._autopilot ? approveAll : (req: PermissionRequest) => this.handlePermission(req),
    };
    this.session = await this.client!.createSession(config);
    this.session.on((e: SessionEvent) => this.handleEvent(e));
  }

  // ── Session management ──

  async disconnect(): Promise<void> {
    // Disconnect but preserve session data on disk for resume
    this._alive = false;
    this._busy = false;
    this.queue = [];
    try {
      await this.session?.disconnect();
    } catch {
      /* ignore */
    }
    this.session = null;
    // Keep client alive for resume
    return;
  }

  async resume(sessionId: string, opts: SessionOptions): Promise<void> {
    this.cwd = opts.cwd;
    this._autopilot = opts.autopilot ?? false;

    if (!this.client) {
      const clientOpts: Record<string, any> = { useStdio: true };
      if (opts.binary) clientOpts.cliPath = opts.binary;
      this.client = new CopilotClient(clientOpts);
      await this.client.start();
    }

    this.session = await this.client.resumeSession(sessionId, this.buildConfig(opts) as any);
    this._alive = true;
    this.session.on((e: SessionEvent) => this.handleEvent(e));
  }

  async listSessions(): Promise<any[]> {
    if (!this.client) return [];
    return this.client.listSessions();
  }

  async getLastSessionId(): Promise<string | undefined> {
    return this.client?.getLastSessionId();
  }

  async deleteSession(id: string): Promise<void> {
    await this.client?.deleteSession(id);
  }

  async kill() {
    this._alive = false;
    this._busy = false;
    this.queue = [];
    try {
      await this.session?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await this.client?.stop();
    } catch {
      /* ignore */
    }
    this.session = null;
    this.client = null;
  }
}
