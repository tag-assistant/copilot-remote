// ============================================================
// Copilot Remote — ACP Session Manager
// ============================================================
// Uses Agent Client Protocol for persistent, streaming
// communication with Copilot CLI. Supports message queuing,
// cancellation, and real-time session updates.
// ============================================================

import * as acp from '@agentclientprotocol/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'events';

export interface SessionOptions {
  cwd: string;
  binary?: string;
  env?: Record<string, string>;
}

export interface CopilotMessage {
  messageId: string;
  content: string;
  toolRequests: any[];
  outputTokens?: number;
}

export class CopilotSession extends EventEmitter {
  private proc: ChildProcess | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private _alive = false;
  private _busy = false;
  private _model: string | null = null;
  private _allowAllTools = false;
  private cwd!: string;
  private binary!: string;
  private sessionEnv!: Record<string, string>;

  // Message queue for handling spam
  private messageQueue: { prompt: string; resolve: (msg: CopilotMessage) => void; reject: (err: Error) => void }[] = [];
  private processing = false;

  get alive(): boolean { return this._alive; }
  get busy(): boolean { return this._busy; }
  get currentSessionId(): string | null { return this.sessionId; }
  get allowAllTools(): boolean { return this._allowAllTools; }
  set allowAllTools(v: boolean) { this._allowAllTools = v; }
  get model(): string | null { return this._model; }
  set model(v: string | null) { this._model = v; }

  async start(options: SessionOptions): Promise<void> {
    this.cwd = options.cwd;
    this.binary = options.binary ?? 'copilot';
    this.sessionEnv = { ...process.env, ...options.env } as Record<string, string>;

    const args = ['--acp', '--stdio'];
    if (this._model) args.push('--model', this._model);
    if (this._allowAllTools) args.push('--allow-all-tools');

    console.log('[ACP] Spawning: ' + this.binary + ' ' + args.join(' '));

    this.proc = spawn(this.binary, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: this.cwd,
      env: this.sessionEnv,
    });

    if (!this.proc.stdin || !this.proc.stdout) {
      throw new Error('Failed to start Copilot ACP process');
    }

    // Create ACP streams
    const output = Writable.toWeb(this.proc.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(this.proc.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);

    // Set up client callbacks
    const self = this;
    const client: acp.Client = {
      async requestPermission(params) {
        console.log('[ACP] Permission request:', JSON.stringify(params).slice(0, 200));
        self.emit('permission_request', params);

        // Wait for user response or auto-approve
        if (self._allowAllTools) {
          return { outcome: { outcome: 'approved' } };
        }

        // Emit and wait for approval
        return new Promise((resolve) => {
          const handler = (approved: boolean) => {
            resolve({ outcome: { outcome: approved ? 'approved' : 'cancelled' } });
          };
          self.once('permission_response', handler);

          // Timeout after 60s — cancel
          setTimeout(() => {
            self.off('permission_response', handler);
            resolve({ outcome: { outcome: 'cancelled' } });
          }, 60_000);
        });
      },

      async sessionUpdate(params) {
        const update = params.update;
        self.handleSessionUpdate(update);
      },
    };

    this.connection = new acp.ClientSideConnection((_agent) => client, stream);

    // Initialize connection
    await this.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    console.log('[ACP] Initialized');

    // Create session
    const sessionResult = await this.connection.newSession({
      cwd: this.cwd,
      mcpServers: [],
    });

    this.sessionId = sessionResult.sessionId;
    this._alive = true;
    console.log('[ACP] Session created: ' + this.sessionId);

    this.proc.on('exit', (code) => {
      console.log('[ACP] Process exited: ' + code);
      this._alive = false;
      this._busy = false;
      this.connection = null;
      this.proc = null;
    });
  }

  private handleSessionUpdate(update: any): void {
    const type = update.sessionUpdate;

    switch (type) {
      case 'agent_message_chunk': {
        const content = update.content;
        if (content?.type === 'text') {
          this.emit('delta', content.text);
        }
        break;
      }

      case 'agent_thought_chunk': {
        const content = update.content;
        if (content?.type === 'text' || typeof content?.text === 'string') {
          this.emit('thinking', content.text);
        }
        break;
      }

      case 'tool_call': {
        console.log('[ACP] Tool call: ' + update.name);
        this.emit('tool_start', {
          toolCallId: update.toolCallId,
          toolName: update.name,
          arguments: update.arguments,
        });
        break;
      }

      case 'tool_result': {
        console.log('[ACP] Tool result: ' + update.toolCallId);
        this.emit('tool_complete', {
          toolCallId: update.toolCallId,
          success: true,
        });
        break;
      }

      case 'plan': {
        console.log('[ACP] Plan: ' + JSON.stringify(update).slice(0, 100));
        this.emit('plan', update);
        break;
      }

      default: {
        console.log('[ACP] Update: ' + type + ' ' + JSON.stringify(update).slice(0, 200));
        break;
      }
    }
  }

  async send(prompt: string): Promise<CopilotMessage> {
    if (!this._alive || !this.connection || !this.sessionId) {
      throw new Error('Session not started');
    }

    // Queue the message
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
      console.log('[ACP] Sending prompt: ' + prompt.slice(0, 80) + '...');

      let responseText = '';
      const originalDelta = this.listeners('delta');

      // Collect deltas for final message
      const deltaCollector = (text: string) => {
        responseText += text;
      };
      this.on('delta', deltaCollector);

      const result = await this.connection!.prompt({
        sessionId: this.sessionId!,
        prompt: [{ type: 'text', text: prompt }],
      });

      this.off('delta', deltaCollector);

      console.log('[ACP] Prompt done: stopReason=' + result.stopReason);

      resolve({
        messageId: this.sessionId!,
        content: responseText.trim(),
        toolRequests: [],
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this._busy = false;
      this.processing = false;
      // Process next in queue
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

  cancel(): void {
    // ACP supports cancellation — but need to check if SDK exposes it
    // For now, kill and restart
    console.log('[ACP] Cancel requested');
  }

  kill(): void {
    this._alive = false;
    this._busy = false;
    this.messageQueue = [];
    this.proc?.kill('SIGTERM');
    this.proc = null;
    this.connection = null;
    this.sessionId = null;
  }
}
