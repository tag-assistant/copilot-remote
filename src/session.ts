// ============================================================
// Copilot Remote — Session Manager (JSONL mode)
// ============================================================
// Spawns Copilot CLI with --output-format json for structured
// streaming. Maintains session continuity via --resume.
// ============================================================

import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import * as fs from 'fs';

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

export interface CopilotToolExecute {
  toolId: string;
  toolName: string;
  input: any;
  confirmationRequired?: boolean;
}

export interface CopilotResult {
  sessionId: string;
  exitCode: number;
  usage: {
    premiumRequests: number;
    totalApiDurationMs: number;
    sessionDurationMs: number;
    codeChanges: {
      linesAdded: number;
      linesRemoved: number;
      filesModified: string[];
    };
  };
}

export class CopilotSession extends EventEmitter {
  private proc: pty.IPty | null = null;
  private _alive = false;
  private _busy = false;
  private cwd!: string;
  private binary!: string;
  private sessionEnv!: Record<string, string>;
  private _sessionId: string | null = null;
  private lineBuffer = '';

  get alive(): boolean { return this._alive; }
  get busy(): boolean { return this._busy; }
  get sessionId(): string | null { return this._sessionId; }

  async start(options: SessionOptions): Promise<void> {
    if (!fs.existsSync(options.cwd)) {
      throw new Error('Working directory does not exist: ' + options.cwd);
    }
    this.cwd = options.cwd;
    this.binary = options.binary ?? 'copilot';
    this.sessionEnv = { ...process.env, ...options.env } as Record<string, string>;
    this._alive = true;
    console.log('[Session] Ready — binary: ' + this.binary + ', cwd: ' + this.cwd);
  }

  async send(prompt: string): Promise<CopilotMessage> {
    if (!this._alive) throw new Error('Session not started');
    if (this._busy) throw new Error('Session is busy');

    this._busy = true;
    this.lineBuffer = '';
    const userShell = process.env.SHELL ?? '/bin/zsh';

    // Build command
    const escaped = prompt.replace(/'/g, "'\\''");
    const parts = [
      this.binary,
      "-p '" + escaped + "'",
      '--output-format json',
      '--no-alt-screen',
      '--no-color',
      '-s',
      '--allow-all-tools',
    ];

    // Resume existing session for conversation continuity
    if (this._sessionId) {
      parts.push('--resume ' + this._sessionId);
    }

    const cmd = parts.join(' ');
    console.log('[Session] Running: ' + cmd.slice(0, 120) + '...');

    return new Promise((resolve, reject) => {
      let finalMessage: CopilotMessage | null = null;
      let streamedContent = '';

      try {
        this.proc = pty.spawn(userShell, ['-l', '-c', cmd], {
          name: 'dumb',
          cols: 120,
          rows: 40,
          cwd: this.cwd,
          env: this.sessionEnv,
        });
      } catch (err) {
        this._busy = false;
        reject(err);
        return;
      }

      console.log('[Session] Spawned pid: ' + this.proc.pid);

      this.proc.onData((raw: string) => {
        this.lineBuffer += raw;

        // Process complete lines
        const lines = this.lineBuffer.split('\n');
        this.lineBuffer = lines.pop() ?? ''; // Keep incomplete line

        for (const line of lines) {
          const trimmed = line.replace(/\r/g, '').trim();
          if (!trimmed || !trimmed.startsWith('{')) continue;

          try {
            const event = JSON.parse(trimmed);
            this.handleEvent(event, (msg) => {
              finalMessage = msg;
            }, (delta) => {
              streamedContent += delta;
              this.emit('delta', delta);
            });
          } catch {
            // Not valid JSON — skip
          }
        }
      });

      this.proc.onExit(({ exitCode }) => {
        console.log('[Session] Exit code: ' + exitCode);
        this._busy = false;
        this.proc = null;

        // Process any remaining buffer
        if (this.lineBuffer.trim()) {
          const remaining = this.lineBuffer.replace(/\r/g, '').trim();
          if (remaining.startsWith('{')) {
            try {
              const event = JSON.parse(remaining);
              this.handleEvent(event, (msg) => {
                finalMessage = msg;
              }, (delta) => {
                streamedContent += delta;
              });
            } catch {}
          }
        }

        if (finalMessage) {
          resolve(finalMessage);
        } else if (streamedContent.trim()) {
          // Fallback: construct message from streamed deltas
          resolve({
            messageId: 'streamed',
            content: streamedContent.trim(),
            toolRequests: [],
          });
        } else {
          reject(new Error('Copilot exited with code ' + exitCode + ' and no output'));
        }
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this._busy) {
          this.proc?.kill();
          this._busy = false;
          reject(new Error('Prompt timed out after 5 minutes'));
        }
      }, 300_000);
    });
  }

  private handleEvent(
    event: any,
    onMessage: (msg: CopilotMessage) => void,
    onDelta: (text: string) => void,
  ): void {
    switch (event.type) {
      case 'assistant.message_delta': {
        const delta = event.data?.deltaContent;
        if (delta) onDelta(delta);
        break;
      }

      case 'assistant.message': {
        const data = event.data;
        if (data?.content) {
          onMessage({
            messageId: data.messageId,
            content: data.content,
            toolRequests: data.toolRequests ?? [],
            outputTokens: data.outputTokens,
          });
          this.emit('message', data);
        }
        break;
      }

      case 'tool.execute': {
        const data = event.data;
        console.log('[Session] Tool: ' + data?.toolName);
        this.emit('tool_execute', {
          toolId: data?.toolId,
          toolName: data?.toolName,
          input: data?.input,
          confirmationRequired: data?.confirmationRequired,
        } as CopilotToolExecute);
        break;
      }

      case 'tool.result': {
        console.log('[Session] Tool result: ' + event.data?.toolId);
        this.emit('tool_result', event.data);
        break;
      }

      case 'assistant.turn_start': {
        console.log('[Session] Turn ' + event.data?.turnId + ' started');
        break;
      }

      case 'assistant.turn_end': {
        console.log('[Session] Turn ' + event.data?.turnId + ' ended');
        break;
      }

      case 'result': {
        if (event.sessionId) {
          this._sessionId = event.sessionId;
          console.log('[Session] Session ID: ' + event.sessionId);
        }
        const usage = event.usage;
        if (usage) {
          console.log('[Session] Usage: ' + usage.premiumRequests + ' reqs, ' +
            usage.totalApiDurationMs + 'ms API, ' +
            usage.codeChanges?.linesAdded + '+ ' +
            usage.codeChanges?.linesRemoved + '- lines');
        }
        this.emit('result', event as CopilotResult);
        break;
      }
    }
  }

  approve(): void {
    this.proc?.write('y\r');
  }

  deny(): void {
    this.proc?.write('n\r');
  }

  kill(): void {
    this._alive = false;
    this._busy = false;
    this.proc?.kill();
    this.proc = null;
  }
}
