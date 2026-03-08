// ============================================================
// Copilot Remote — Session Manager (Copilot SDK)
// ============================================================
// Uses @github/copilot-sdk for full Copilot CLI integration.
// Handles streaming, tools, permissions, model switching,
// custom agents, and message queuing.
// ============================================================

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

export interface SessionOptions {
  cwd: string;
  binary?: string;
  env?: Record<string, string>;
  model?: string;
  allowAllTools?: boolean;
  agent?: string;
}

export interface CopilotMessage {
  messageId: string;
  content: string;
  toolCalls: ToolCall[];
  usage?: UsageInfo;
}

export interface ToolCall {
  name: string;
  arguments?: string;
  result?: string;
  success?: boolean;
  duration?: number;
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  totalRequests?: number;
}

export class Session extends EventEmitter {
  private client: CopilotClient | null = null;
  private session: SDKSession | null = null;
  private _alive = false;
  private _busy = false;
  private _model: string | null = null;
  private _allowAllTools = false;
  private _agent: string | null = null;
  private cwd: string = '';

  // Message queue
  private messageQueue: { prompt: string; resolve: (msg: CopilotMessage) => void; reject: (err: Error) => void }[] = [];
  private processing = false;

  get alive(): boolean { return this._alive; }
  get busy(): boolean { return this._busy; }
  get currentSessionId(): string | null { return this.session?.sessionId ?? null; }
  get allowAllTools(): boolean { return this._allowAllTools; }
  set allowAllTools(v: boolean) { this._allowAllTools = v; }
  get model(): string | null { return this._model; }
  set model(v: string | null) { this._model = v; }
  get agent(): string | null { return this._agent; }
  set agent(v: string | null) { this._agent = v; }

  async start(options: SessionOptions): Promise<void> {
    this.cwd = options.cwd;
    this._model = options.model ?? null;
    this._allowAllTools = options.allowAllTools ?? false;
    this._agent = options.agent ?? null;

    const clientOptions: Record<string, any> = {
      useStdio: true,
    };
    if (options.binary) clientOptions.cliPath = options.binary;

    this.client = new CopilotClient(clientOptions);
    await this.client.start();

    console.log('[SDK] Client started');

    await this.createSession();
  }

  private async createSession(): Promise<void> {
    if (!this.client) throw new Error('Client not started');

    const config: SessionConfig = {
      clientName: 'copilot-remote',
      workingDirectory: this.cwd,
      onPermissionRequest: this._allowAllTools
        ? approveAll
        : (req: PermissionRequest) => this.handlePermission(req),
    };

    if (this._model) config.model = this._model;

    this.session = await this.client.createSession(config);
    this._alive = true;

    console.log('[SDK] Session created: ' + this.session.sessionId);

    // Subscribe to all events
    this.session.on((event: SessionEvent) => {
      this.handleEvent(event);
    });
  }

  private handleEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'assistant.message_delta':
        this.emit('delta', (event.data as any).content ?? (event.data as any).text ?? '');
        break;

      case 'assistant.reasoning_delta':
        this.emit('thinking', (event.data as any).content ?? (event.data as any).text ?? '');
        break;

      case 'assistant.message':
        this.emit('message', (event.data as any).content ?? '');
        break;

      case 'assistant.usage':
        this.emit('usage', event.data);
        break;

      case 'tool.execution_start':
        this.emit('tool_start', {
          toolName: (event.data as any).name ?? (event.data as any).toolName,
          arguments: (event.data as any).arguments,
        });
        break;

      case 'tool.execution_complete':
        this.emit('tool_complete', {
          toolName: (event.data as any).name ?? (event.data as any).toolName,
          success: (event.data as any).exitCode === 0 || (event.data as any).success !== false,
          duration: (event.data as any).duration,
        });
        break;

      case 'permission.requested':
        this.emit('permission_request', event.data);
        break;

      case 'session.idle':
        this.emit('idle');
        break;

      case 'session.error':
        this.emit('error', (event.data as any).message ?? 'Unknown error');
        break;

      case 'session.model_change':
        console.log('[SDK] Model changed: ' + JSON.stringify(event.data));
        break;

      case 'session.mode_changed':
        this.emit('mode_changed', event.data);
        break;

      case 'subagent.started':
        this.emit('subagent_start', event.data);
        break;

      case 'subagent.completed':
        this.emit('subagent_complete', event.data);
        break;

      case 'session.title_changed':
        this.emit('title', (event.data as any).title);
        break;

      default:
        // Log for debugging
        if (!event.ephemeral) {
          console.log('[SDK] Event: ' + event.type);
        }
        break;
    }
  }

  // Read-only operations auto-approved
  private static readonly AUTO_APPROVE_KINDS = new Set(['read', 'url']);

  // Read-only shell commands auto-approved
  private static readonly READONLY_COMMANDS = [
    'cat ', 'ls ', 'ls\n', 'pwd', 'echo ', 'head ', 'tail ', 'wc ',
    'find ', 'grep ', 'rg ', 'fd ', 'which ', 'whoami', 'hostname',
    'date', 'git status', 'git log', 'git diff', 'git branch',
    'git show', 'git rev-parse', 'git remote', 'git --no-pager',
    'gh api', 'gh repo view', 'gh repo list', 'gh pr list', 'gh issue list',
    'gh pr view', 'gh issue view', 'gh search',
    'node -e', 'node -p', 'curl -s', 'curl --silent',
  ];

  private shouldAutoApprove(req: PermissionRequest): boolean {
    // Always approve reads and URL fetches
    if (Session.AUTO_APPROVE_KINDS.has(req.kind)) return true;

    // Check shell commands for read-only patterns
    if (req.kind === 'shell') {
      const cmd = ((req as any).fullCommandText ?? '').trim();
      // cd is always safe
      if (cmd.startsWith('cd ')) return true;
      // Check readonly command prefixes
      for (const prefix of Session.READONLY_COMMANDS) {
        if (cmd.startsWith(prefix)) return true;
      }
    }

    return false;
  }

  private async handlePermission(req: PermissionRequest): Promise<PermissionRequestResult> {
    // Smart auto-approve for safe operations
    if (this.shouldAutoApprove(req)) {
      console.log('[SDK] Auto-approved: ' + req.kind + ' ' + ((req as any).fullCommandText ?? (req as any).url ?? '').slice(0, 80));
      return { kind: 'approved' };
    }

    console.log('[SDK] Permission request:', JSON.stringify(req).slice(0, 200));
    this.emit('permission_request', req);

    return new Promise<PermissionRequestResult>((resolve) => {
      const handler = (approved: boolean) => {
        resolve(approved 
          ? { kind: 'approved' as const } 
          : { kind: 'denied-interactively-by-user' as const });
      };
      this.once('permission_response', handler);

      // Timeout after 120s
      setTimeout(() => {
        this.off('permission_response', handler);
        resolve({ kind: 'denied-interactively-by-user' as const });
      }, 120_000);
    });
  }

  async send(prompt: string): Promise<CopilotMessage> {
    if (!this._alive || !this.session) {
      throw new Error('Session not started');
    }

    return new Promise((resolve, reject) => {
      this.messageQueue.push({ prompt, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.messageQueue.length === 0) return;
    this.processing = true;
    this._busy = true;

    const { prompt, resolve, reject } = this.messageQueue.shift()!;

    try {
      console.log('[SDK] Sending: ' + prompt.slice(0, 80) + (prompt.length > 80 ? '...' : ''));

      let responseText = '';
      const toolCalls: ToolCall[] = [];
      let usage: UsageInfo | undefined;

      const deltaHandler = (text: string) => { responseText += text; };
      const usageHandler = (data: any) => {
        usage = {
          inputTokens: data.inputTokens ?? data.input_tokens,
          outputTokens: data.outputTokens ?? data.output_tokens,
          model: data.model,
        };
      };

      this.on('delta', deltaHandler);
      this.on('usage', usageHandler);

      const result = await this.session!.sendAndWait(
        { prompt },
        300_000, // 5 min timeout
      );

      this.off('delta', deltaHandler);
      this.off('usage', usageHandler);

      // Use result content if deltas didn't capture it
      const finalContent = responseText.trim() || (result?.data as any)?.content || '';

      resolve({
        messageId: this.session!.sessionId,
        content: finalContent,
        toolCalls,
        usage,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this._busy = false;
      this.processing = false;
      if (this.messageQueue.length > 0) {
        this.processQueue();
      }
    }
  }

  approve(): void {
    this.emit('permission_response', true);
  }

  deny(): void {
    this.emit('permission_response', false);
  }

  async abort(): Promise<void> {
    if (this.session) {
      await this.session.abort();
    }
  }

  async setModel(model: string): Promise<void> {
    this._model = model;
    if (this.session) {
      await this.session.setModel(model);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.client) return [];
    return this.client.listModels();
  }

  // ── Copilot RPC commands ──

  async setMode(mode: 'interactive' | 'plan' | 'autopilot'): Promise<void> {
    if (!this.session) throw new Error('No session');
    await this.session.rpc.mode.set({ mode });
  }

  async getMode(): Promise<string> {
    if (!this.session) throw new Error('No session');
    const result = await this.session.rpc.mode.get();
    return result.mode;
  }

  async startFleet(prompt?: string): Promise<any> {
    if (!this.session) throw new Error('No session');
    return this.session.rpc.fleet.start({ prompt });
  }

  async compact(): Promise<any> {
    if (!this.session) throw new Error('No session');
    return this.session.rpc.compaction.compact();
  }

  async listAgents(): Promise<any> {
    if (!this.session) throw new Error('No session');
    return this.session.rpc.agent.list();
  }

  async selectAgent(agent: string): Promise<any> {
    if (!this.session) throw new Error('No session');
    return this.session.rpc.agent.select({ name: agent });
  }

  async deselectAgent(): Promise<any> {
    if (!this.session) throw new Error('No session');
    return this.session.rpc.agent.deselect();
  }

  async listTools(): Promise<any> {
    if (!this.client) throw new Error('No client');
    return (this.client as any).rpc.tools.list({ sessionId: this.session!.sessionId });
  }

  async getQuota(): Promise<any> {
    if (!this.client) throw new Error('No client');
    return (this.client as any).rpc.account.getQuota();
  }

  async getCurrentModel(): Promise<any> {
    if (!this.session) throw new Error('No session');
    return this.session.rpc.model.getCurrent();
  }

  async getCurrentAgent(): Promise<any> {
    if (!this.session) throw new Error('No session');
    return this.session.rpc.agent.getCurrent();
  }

  // ── Plan management ──

  async readPlan(): Promise<any> {
    if (!this.session) throw new Error('No session');
    return this.session.rpc.plan.read();
  }

  async updatePlan(content: string): Promise<any> {
    if (!this.session) throw new Error('No session');
    return this.session.rpc.plan.update({ content });
  }

  async deletePlan(): Promise<any> {
    if (!this.session) throw new Error('No session');
    return this.session.rpc.plan.delete();
  }

  // ── Workspace ──

  async listWorkspaceFiles(): Promise<string[]> {
    if (!this.session) throw new Error('No session');
    const result = await this.session.rpc.workspace.listFiles();
    return (result as any)?.files ?? [];
  }

  async readWorkspaceFile(path: string): Promise<string> {
    if (!this.session) throw new Error('No session');
    const result = await this.session.rpc.workspace.readFile({ path });
    return (result as any)?.content ?? '';
  }

  async createWorkspaceFile(path: string, content: string): Promise<any> {
    if (!this.session) throw new Error('No session');
    return this.session.rpc.workspace.createFile({ path, content });
  }

  // ── Health ──

  async ping(): Promise<any> {
    if (!this.client) throw new Error('No client');
    return this.client.ping('health');
  }

  async getSessionMessages(): Promise<any[]> {
    if (!this.session) return [];
    return this.session.getMessages();
  }

  async newSession(): Promise<void> {
    if (this.session) {
      await this.session.disconnect();
    }
    await this.createSession();
  }

  async kill(): Promise<void> {
    this._alive = false;
    this._busy = false;
    this.messageQueue = [];

    if (this.session) {
      try { await this.session.disconnect(); } catch {}
    }
    if (this.client) {
      try { await this.client.stop(); } catch {}
    }

    this.session = null;
    this.client = null;
  }
}
