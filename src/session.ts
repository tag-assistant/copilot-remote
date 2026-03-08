// ============================================================
// Copilot Remote — PTY Session Manager
// ============================================================
// Spawns and manages a Copilot CLI session in a pseudo-terminal.
// Handles input/output, ANSI stripping, and response detection.
// ============================================================

import * as pty from 'node-pty';
import stripAnsi from 'strip-ansi';
import { EventEmitter } from 'events';

export interface SessionOptions {
  cwd: string;
  shell?: string;
  env?: Record<string, string>;
}

export interface SessionEvents {
  output: (text: string) => void;
  response: (text: string) => void;
  exit: (code: number) => void;
  error: (err: Error) => void;
  waiting: () => void; // Copilot is waiting for input
}

export class CopilotSession extends EventEmitter {
  private ptyProcess: pty.IPty | null = null;
  private buffer = '';
  private responseBuffer = '';
  private collecting = false;
  private collectTimer: NodeJS.Timeout | null = null;
  private _alive = false;

  // Copilot CLI prompt patterns
  // The CLI shows a prompt like "❯ " or "copilot> " when waiting for input
  // And shows tool approval prompts like "Allow <tool>? (y/n)"
  private static PROMPT_PATTERNS = [
    /❯\s*$/,
    /copilot>\s*$/,
    /\?\s*\(y\/n\)\s*$/i,
    /\?\s*$/,
    />\s*$/,
  ];

  // Patterns that indicate a response is still streaming
  private static STREAMING_PATTERNS = [
    /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/, // spinners
    /thinking\.\.\./i,
    /running\.\.\./i,
  ];

  get alive(): boolean {
    return this._alive;
  }

  async start(options: SessionOptions): Promise<void> {
    const copilotBin = options.shell ?? 'copilot';

    // Spawn via login shell to pick up PATH/nvm/etc
    const userShell = process.env.SHELL ?? '/bin/zsh';

    this.ptyProcess = pty.spawn(userShell, ['-l', '-c', copilotBin], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: options.cwd,
      env: { ...process.env, ...options.env } as Record<string, string>,
    });

    this._alive = true;

    this.ptyProcess.onData((data: string) => {
      const cleaned = stripAnsi(data);
      this.buffer += cleaned;
      this.emit('output', cleaned);

      // Accumulate response text
      if (this.collecting) {
        this.responseBuffer += cleaned;
        this.resetCollectTimer();
      }

      // Check if Copilot is now waiting for input
      if (this.isPrompt(this.buffer)) {
        if (this.collecting) {
          this.finishCollecting();
        } else {
          this.emit('waiting');
        }
      }
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      this._alive = false;
      this.emit('exit', exitCode);
    });

    // Wait for initial prompt
    await this.waitForPrompt(30_000);
  }

  send(text: string): void {
    if (!this.ptyProcess || !this._alive) {
      throw new Error('Session not running');
    }

    // Start collecting the response
    this.buffer = '';
    this.responseBuffer = '';
    this.collecting = true;

    // Send the message + Enter
    this.ptyProcess.write(text + '\r');
  }

  approve(): void {
    this.send('y');
  }

  deny(): void {
    this.send('n');
  }

  resize(cols: number, rows: number): void {
    this.ptyProcess?.resize(cols, rows);
  }

  kill(): void {
    this._alive = false;
    this.ptyProcess?.kill();
    this.ptyProcess = null;
  }

  private isPrompt(text: string): boolean {
    const trimmed = text.trimEnd();
    const lastLine = trimmed.split('\n').pop() ?? '';
    return CopilotSession.PROMPT_PATTERNS.some(p => p.test(lastLine));
  }

  private isStreaming(text: string): boolean {
    return CopilotSession.STREAMING_PATTERNS.some(p => p.test(text));
  }

  private resetCollectTimer(): void {
    if (this.collectTimer) {
      clearTimeout(this.collectTimer);
    }
    // Wait 1.5s of silence before considering response complete
    this.collectTimer = setTimeout(() => {
      if (this.collecting && !this.isStreaming(this.responseBuffer)) {
        this.finishCollecting();
      }
    }, 1500);
  }

  private finishCollecting(): void {
    this.collecting = false;
    if (this.collectTimer) {
      clearTimeout(this.collectTimer);
      this.collectTimer = null;
    }

    const response = this.cleanResponse(this.responseBuffer);
    if (response.trim()) {
      this.emit('response', response);
    }
    this.responseBuffer = '';
  }

  private cleanResponse(raw: string): string {
    // Remove the echoed input (first line) and trailing prompt
    const lines = raw.split('\n');

    // Skip first line (echoed command) and last line (prompt)
    const content = lines.slice(1);

    // Remove trailing prompt lines
    while (content.length > 0) {
      const last = content[content.length - 1].trim();
      if (last === '' || last === '❯' || last === '>' || last.endsWith('(y/n)')) {
        content.pop();
      } else {
        break;
      }
    }

    return content.join('\n').trim();
  }

  private waitForPrompt(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for Copilot CLI prompt'));
      }, timeoutMs);

      const check = (text: string) => {
        if (this.isPrompt(this.buffer)) {
          clearTimeout(timeout);
          this.removeListener('output', check);
          resolve();
        }
      };

      this.on('output', check);

      // Check immediately in case prompt already appeared
      if (this.isPrompt(this.buffer)) {
        clearTimeout(timeout);
        this.removeListener('output', check);
        resolve();
      }
    });
  }
}
