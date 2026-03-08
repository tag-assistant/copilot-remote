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
  type CopilotClientOptions,
  type MessageOptions,
} from '@github/copilot-sdk';

/** SDK-compatible file attachment */
export type FileAttachment = NonNullable<MessageOptions['attachments']>[number];
import { EventEmitter } from 'events';
import { log } from './log.js';
import { createTelegramTools } from './tools.js';

/** Reasoning effort levels supported by the SDK */
type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** User input request from the agent (ask_user tool) */
interface UserInputRequest {
  question: string;
  choices?: string[];
}

/** Event data from SDK session events */
interface SessionEventData {
  content?: string;
  text?: string;
  name?: string;
  toolName?: string;
  arguments?: unknown;
  exitCode?: number;
  success?: boolean;
  message?: string;
  [key: string]: unknown;
}

/** Quota snapshot from the account API */
export interface QuotaSnapshot {
  usedRequests: number;
  entitlementRequests: number;
  remainingPercentage: number;
}

/** Quota response from the account API */
export interface QuotaResponse {
  quotaSnapshots?: QuotaSnapshot[];
}

/** Agent info from the agent API */
export interface AgentInfo {
  name: string;
  [key: string]: unknown;
}

/** Agent list response */
export interface AgentListResponse {
  agents?: AgentInfo[];
}

/** Current agent response */
export interface CurrentAgentResponse {
  agent?: AgentInfo;
}

/** Current model response */
export interface CurrentModelResponse {
  modelId?: string;
}

/** Compact response */
export interface CompactResponse {
  tokensFreed?: number;
}

/** Plan response */
export interface PlanResponse {
  content?: string;
}

/** Tool info from the tools API */
export interface ToolInfo {
  name: string;
  [key: string]: unknown;
}

/** Tools list response */
export interface ToolsListResponse {
  tools?: ToolInfo[];
}

/** Session message */
export interface SessionMessage {
  type: string;
  content?: string;
  [key: string]: unknown;
}

export interface SessionOptions {
  cwd: string;
  binary?: string;
  model?: string;
  autopilot?: boolean;
  agent?: string;
  reasoningEffort?: ReasoningEffort;
  topicContext?: string;
  githubToken?: string;
  infiniteSessions?: boolean;
  messageMode?: 'enqueue' | 'immediate';
  // Global config passthrough
  provider?: { type?: 'openai' | 'azure' | 'anthropic'; baseUrl: string; apiKey?: string; model?: string };
  mcpServers?: Record<string, unknown>;
  customAgents?: unknown[];
  skillDirectories?: string[];
  disabledSkills?: string[];
  systemInstructions?: string;
  availableTools?: string[];
  excludedTools?: string[];
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
  private _messageMode: 'enqueue' | 'immediate' | undefined = undefined;
  private cwd = '';

  // Message queue for sequential processing
  private queue: { prompt: string; attachments?: FileAttachment[]; resolve: (msg: CopilotMessage) => void; reject: (err: Error) => void }[] = [];
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
  get messageMode() {
    return this._messageMode;
  }
  set messageMode(v: 'enqueue' | 'immediate' | undefined) {
    this._messageMode = v;
  }

  private buildConfig(opts: SessionOptions): Partial<SessionConfig> {
    const systemLines = [
      'You are being accessed via a Telegram bot bridge called copilot-remote.',
      'The user is chatting with you from their phone. Keep responses concise but complete.',
      'You have full access to the filesystem, shell, and all tools. Use them proactively.',
      "When asked to do something, do it — don't just explain how.",
      'Show your work: mention files you read, commands you ran, changes you made.',
      'Format responses with markdown (bold, code blocks, lists) — it renders in Telegram.',
      ...(opts.topicContext
        ? ['This conversation topic is: "' + opts.topicContext + '". Stay focused on this subject.']
        : []),
    ];
    if (opts.systemInstructions) systemLines.push(opts.systemInstructions);

    return {
      clientName: 'copilot-remote',
      streaming: true,
      workingDirectory: this.cwd,
      systemMessage: {
        mode: 'append',
        content: systemLines.join('\n'),
      },
      onPermissionRequest: this._autopilot ? approveAll : (req: PermissionRequest) => this.handlePermission(req),
      onUserInputRequest: (req: UserInputRequest) => this.handleUserInput(req),
      infiniteSessions:
        opts.infiniteSessions === false
          ? { enabled: false }
          : { enabled: true, backgroundCompactionThreshold: 0.8, bufferExhaustionThreshold: 0.95 },
      tools: createTelegramTools({
        sendNotification: async (text: string) => {
          this.emit('notification', text);
        },
      }),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.mcpServers ? { mcpServers: opts.mcpServers as SessionConfig['mcpServers'] } : {}),
      ...(opts.customAgents ? { customAgents: opts.customAgents as SessionConfig['customAgents'] } : {}),
      ...(opts.skillDirectories ? { skillDirectories: opts.skillDirectories } : {}),
      ...(opts.disabledSkills ? { disabledSkills: opts.disabledSkills } : {}),
      ...(opts.availableTools ? { availableTools: opts.availableTools } : {}),
      ...(opts.excludedTools ? { excludedTools: opts.excludedTools } : {}),
      hooks: {
        onSessionStart: async () => {
          this.emit('hook:session_start');
        },
        onSessionEnd: async () => {
          this.emit('hook:session_end');
        },
        onPreToolUse: async (input: { toolName?: string; arguments?: unknown }) => {
          this.emit('hook:pre_tool', { toolName: input.toolName, arguments: input.arguments });
        },
        onPostToolUse: async (input: { toolName?: string; result?: unknown }) => {
          this.emit('hook:post_tool', { toolName: input.toolName, result: input.result });
        },
        onErrorOccurred: async (input: { error?: unknown; message?: string }) => {
          this.emit('hook:error', { error: input.error, message: input.message });
        },
        onUserPromptSubmitted: async (input: { prompt?: string }) => {
          this.emit('hook:user_prompt', { prompt: input.prompt });
        },
      },
    };
  }

  async start(opts: SessionOptions): Promise<void> {
    this.cwd = opts.cwd;
    this._autopilot = opts.autopilot ?? false;
    this._messageMode = opts.messageMode;

    const clientOpts: CopilotClientOptions = { useStdio: true };
    if (opts.binary) clientOpts.cliPath = opts.binary;
    if (opts.githubToken) clientOpts.githubToken = opts.githubToken;

    this.client = new CopilotClient(clientOpts);
    await this.client.start();

    this.session = await this.client.createSession(this.buildConfig(opts) as SessionConfig);
    this._alive = true;
    this.session.on((e: SessionEvent) => this.handleEvent(e));
  }

  private handleEvent(e: SessionEvent): void {
    log.debug(`[SDK event] ${e.type}:`, JSON.stringify(e.data ?? {}).slice(0, 500));
    const d = e.data as SessionEventData;
    switch (e.type) {
      case 'assistant.message_delta':
        this.emit('delta', d.content ?? d.text ?? '');
        break;
      case 'assistant.reasoning_delta':
        this.emit('thinking', d.deltaContent ?? d.content ?? d.text ?? '');
        break;
      case 'assistant.message':
        this.emit('message', d.content ?? '');
        break;
      case 'assistant.usage':
        this.emit('usage', d);
        break;
      case 'assistant.turn_start':
        this.emit('turn_start', { turnId: d.turnId, interactionId: d.interactionId });
        break;
      case 'assistant.turn_end':
        this.emit('turn_end', { turnId: d.turnId });
        break;
      case 'session.usage_info':
        this.emit('context_info', {
          tokenLimit: d.tokenLimit,
          currentTokens: d.currentTokens,
          messagesLength: d.messagesLength,
        });
        break;
      case 'tool.execution_start':
        this.emit('tool_start', { toolName: d.name ?? d.toolName, arguments: d.arguments });
        break;
      case 'tool.execution_complete':
        this.emit('tool_complete', {
          toolName: d.name ?? d.toolName,
          success: d.exitCode === 0 || d.success !== false,
          detailedContent: (d.result as any)?.detailedContent ?? (d.result as any)?.content,
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
        this.emit('permission_timeout');
        resolve({ kind: 'denied-interactively-by-user' } as PermissionRequestResult);
      }, 120_000);
    });
  }

  private async handleUserInput(req: UserInputRequest): Promise<{ answer: string; wasFreeform: boolean }> {
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

  async send(prompt: string, attachments?: FileAttachment[]): Promise<CopilotMessage> {
    if (!this._alive) throw new Error('Session not started');
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, attachments, resolve, reject });
      this.processQueue();
    });
  }

  /** Send with mode: 'immediate' to steer the agent mid-turn (bypasses queue) */
  async sendImmediate(prompt: string, attachments?: FileAttachment[]): Promise<void> {
    if (!this._alive) throw new Error('Session not started');
    const opts: MessageOptions = { prompt, mode: 'immediate' };
    if (attachments?.length) opts.attachments = attachments;
    // Fire-and-forget: immediate messages steer the current turn, no separate response
    await this.session!.send(opts);
  }

  private async processQueue(): Promise<void> {
    if (this.processing || !this.queue.length) return;
    this.processing = true;
    this._busy = true;
    const { prompt, attachments, resolve, reject } = this.queue.shift()!;

    try {
      let text = '';
      const onDelta = (t: string) => {
        text += t;
      };
      this.on('delta', onDelta);

      // Reject if session emits an error (e.g. auth failure)
      let errorHandler: ((msg: string) => void) | null = null;
      const errorPromise = new Promise<never>((_, rej) => {
        errorHandler = (msg: string) => rej(new Error(msg));
        this.once('error', errorHandler);
      });

      const sendOpts: MessageOptions = { prompt };
      if (this._messageMode) sendOpts.mode = this._messageMode;
      if (attachments?.length) sendOpts.attachments = attachments;

      const result = await Promise.race([this.session!.sendAndWait(sendOpts, 300_000), errorPromise]);
      if (errorHandler) this.off('error', errorHandler);
      log.debug('sendAndWait result:', JSON.stringify(result).slice(0, 500));

      const resultObj = result as Record<string, unknown>;
      const resultData = (resultObj?.data as Record<string, unknown>) ?? {};

      this.off('delta', onDelta);
      resolve({
        content:
          text.trim() ||
          (resultData?.content as string) ||
          (resultObj?.content as string) ||
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
    await this.session!.rpc.mode.set({ mode: mode as 'interactive' | 'plan' | 'autopilot' });
  }
  async getMode(): Promise<string> {
    return (await this.session!.rpc.mode.get()).mode;
  }
  async compact(): Promise<CompactResponse> {
    return this.session!.rpc.compaction.compact() as Promise<CompactResponse>;
  }
  async startFleet(prompt?: string): Promise<unknown> {
    return this.session!.rpc.fleet.start({ prompt });
  }
  async listAgents(): Promise<AgentListResponse> {
    return this.session!.rpc.agent.list() as Promise<AgentListResponse>;
  }
  async selectAgent(name: string): Promise<unknown> {
    return this.session!.rpc.agent.select({ name });
  }
  async deselectAgent(): Promise<unknown> {
    return this.session!.rpc.agent.deselect();
  }
  async getCurrentModel(): Promise<CurrentModelResponse> {
    return this.session!.rpc.model.getCurrent() as Promise<CurrentModelResponse>;
  }
  async getCurrentAgent(): Promise<CurrentAgentResponse> {
    return this.session!.rpc.agent.getCurrent() as Promise<CurrentAgentResponse>;
  }
  async readPlan(): Promise<PlanResponse> {
    return this.session!.rpc.plan.read() as Promise<PlanResponse>;
  }
  async deletePlan(): Promise<unknown> {
    return this.session!.rpc.plan.delete();
  }
  async listTools(): Promise<ToolsListResponse> {
    return (
      this.client as unknown as {
        rpc: { tools: { list: (opts: { sessionId: string }) => Promise<ToolsListResponse> } };
      }
    ).rpc.tools.list({ sessionId: this.session!.sessionId! });
  }
  async getQuota(): Promise<QuotaResponse> {
    return (
      this.client as unknown as { rpc: { account: { getQuota: () => Promise<QuotaResponse> } } }
    ).rpc.account.getQuota();
  }
  async getMessages(): Promise<SessionMessage[]> {
    return (this.session?.getMessages() ?? []) as SessionMessage[];
  }
  async listFiles(): Promise<string[]> {
    return ((await this.session!.rpc.workspace.listFiles()) as { files?: string[] })?.files ?? [];
  }
  async readFile(path: string): Promise<string> {
    return ((await this.session!.rpc.workspace.readFile({ path })) as { content?: string })?.content ?? '';
  }

  async newSession(opts?: Partial<SessionOptions>): Promise<void> {
    if (this.session) await this.session.disconnect();
    const config = this.buildConfig({
      cwd: this.cwd,
      autopilot: this._autopilot,
      ...opts,
    });
    this.session = await this.client!.createSession(config as SessionConfig);
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
    this._messageMode = opts.messageMode;

    if (!this.client) {
      const clientOpts: CopilotClientOptions = { useStdio: true };
      if (opts.binary) clientOpts.cliPath = opts.binary;
      if (opts.githubToken) clientOpts.githubToken = opts.githubToken;
      this.client = new CopilotClient(clientOpts);
      await this.client.start();
    }

    this.session = await this.client.resumeSession(sessionId, this.buildConfig(opts) as SessionConfig);
    this._alive = true;
    this.session.on((e: SessionEvent) => this.handleEvent(e));
  }

  async listSessions(): Promise<unknown[]> {
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
