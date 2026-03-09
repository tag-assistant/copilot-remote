# copilot-remote

Control GitHub Copilot from Telegram. Full SDK integration — streaming, tool calls, permissions, multi-session forum topics.

Conceptually, this is a lot like [Claude Code Remote Control's requirements](https://code.claude.com/docs/en/remote-control#requirements): the real session keeps running locally on your machine, and your phone is just a remote control surface for that local environment.

[![CI](https://github.com/austenstone/copilot-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/austenstone/copilot-remote/actions/workflows/ci.yml)

## Setup

```bash
curl -fsSL https://raw.githubusercontent.com/austenstone/copilot-remote/main/install.sh | bash
```

That installs the persistent launchd/systemd daemon.

After publishing to npm, the same daemon install flow will also be available via the CLI itself:

```bash
npx copilot-remote install
# or
npx copilot-remote daemon-install
```

If you want to run the bridge in the foreground instead of installing the daemon, use a local clone for now:

```bash
git clone https://github.com/austenstone/copilot-remote.git
cd copilot-remote && npm install && npm run build && node dist/cli.js
```

Plain `npx copilot-remote` is intended to work once the package is published to npm, but it is not a valid production install path yet.

### Hackable Mode

Want to hack on the source? Install in hackable mode — runs from TypeScript source, auto-restarts on file/config capability changes, and enables self-development features:

```bash
# One-liner
curl -fsSL https://raw.githubusercontent.com/austenstone/copilot-remote/main/install.sh | bash -s -- --hackable

# Or clone + run
git clone https://github.com/austenstone/copilot-remote.git
cd copilot-remote && npm install && npm run dev
```

In hackable mode the bot watches config, MCP, agents, and skills for changes and auto-restarts via launchd/systemd. Edit `~/.copilot-remote/src/`, save, and it reloads.

---

On first run, you'll be prompted for your Telegram bot token (get one from [@BotFather](https://t.me/BotFather)). The installer saves runtime secrets to `~/.copilot-remote/config.json` with user-only permissions, so the launchd plist / systemd unit does not need to embed tokens.

GitHub auth is auto-detected from `gh auth login` when available. If the logged-in account doesn't have a Copilot license, set `githubToken` in config or `GITHUB_TOKEN` env.

If you already run a headless Copilot CLI server, set `cliUrl` in config or `COPILOT_REMOTE_CLI_URL` and the bridge will connect to it instead of spawning its own CLI process.

If you want Bring Your Own Key (BYOK), configure `provider` in `~/.copilot-remote/config.json` or use the `COPILOT_REMOTE_PROVIDER_*` env vars. When a provider is set, `copilot-remote` skips GitHub Copilot auth and uses your provider directly.

## Requirements

- A local Copilot session environment that is already authenticated and able to run on this machine
- Node.js ≥ 22 (LTS)
- `gh` CLI authenticated (`gh auth login`)
- GitHub account with Copilot license
- Telegram bot token from [@BotFather](https://t.me/BotFather)

Like Claude Remote Control, the important bit is that the local process must stay alive and authenticated. `copilot-remote` does not move your tools, files, or MCP setup into the cloud — it relays into the Copilot session running on your machine.

## Features

- **Streaming** — edit-in-place responses with typing indicators
- **Tool calls** — see file reads, edits, shell commands as they happen
- **Inline permissions** — approve/deny with buttons, reactions, or reply text
- **Queued messages by default** — follow-up Telegram messages wait their turn instead of silently steering the current one
- **Three modes** — Interactive (approve each), Plan (review first), Autopilot (approve all)
- **Model switching** — pick from available models via `/config`
- **Reasoning effort** — off/low/medium/high per model capability
- **Forum topics** — each Telegram topic = isolated Copilot session with its own context
- **Voice messages** — transcribed and forwarded to Copilot
- **Photos & documents** — sent as context
- **Infinite sessions** — automatic context compaction, no token limit crashes
- **Session persistence** — deterministic Telegram chat/topic session IDs survive restarts and line up cleanly with CLI resume
- **Custom agents** — use workspace `.copilot/agents/` definitions
- **Custom tools** — Copilot can send you Telegram notifications
- **Self-development hooks** — watch config, MCP wiring, prompts, skills, and agents, then restart cleanly to load new capabilities

## Commands

| Command | What it does |
|---------|-------------|
| `/new` | Fresh session |
| `/stop` | Kill session |
| `/cd <dir>` | Change working directory (restarts session) |
| `/status` | Model, mode, git branch, quota |
| `/config` | Settings menu (model, mode, display, auto-approve) |
| `/plan` | Plan mode |
| `/agent <name>` | Switch agent |
| `/research <topic>` | Deep research |
| `/diff` | Review uncommitted changes |
| `/review` | Code review |
| `/compact` | Compress context |
| `/tools` | List available tools |
| `/files` | Workspace files |
| `/usage` | Token quota |
| `/selfdev` | Show watched capability paths and restart status |
| `/restart` | Restart the bridge to load new capabilities |

## Config

`~/.copilot-remote/config.json`:

```json
{
  "botToken": "telegram-bot-token",
  "githubToken": "ghp_...",
  "workDir": "/home/user/projects",
  "copilotBinary": "/path/to/copilot",
  "cliUrl": "http://127.0.0.1:4141",
  "allowedUsers": ["123456789"],
  "model": "claude-sonnet-4",
  "mode": "interactive",
  "showThinking": false,
  "showTools": true,
  "showReactions": true,
  "messageMode": "enqueue",
  "autoApprove": {
    "read": true,
    "shell": false,
    "write": false
  }
}
```

Only `botToken` is required. If you are not using `cliUrl`, you also need GitHub auth via `gh auth login` or `GITHUB_TOKEN`. The installer writes `config.json` as `0600`, and on macOS the daemon log lives at `~/.copilot-remote/logs/copilot-remote.log`.

### BYOK providers

`copilot-remote` supports the Copilot SDK BYOK providers documented by GitHub:

- `openai`
- `azure`
- `anthropic`

Example config:

```json
{
  "botToken": "telegram-bot-token",
  "model": "gpt-4.1-mini",
  "provider": {
    "type": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "wireApi": "responses"
  }
}
```

Supported env vars:

- `COPILOT_REMOTE_PROVIDER_TYPE`
- `COPILOT_REMOTE_PROVIDER_BASE_URL`
- `COPILOT_REMOTE_PROVIDER_API_KEY`
- `COPILOT_REMOTE_PROVIDER_BEARER_TOKEN`
- `COPILOT_REMOTE_PROVIDER_WIRE_API`
- `COPILOT_REMOTE_PROVIDER_AZURE_API_VERSION`

Notes:

- BYOK uses your provider's billing and limits, not your GitHub Copilot quota.
- You still need to set `model` explicitly for the provider you choose.
- Native Azure OpenAI endpoints should use `type: "azure"` with the host root as `baseUrl`.
- Azure AI Foundry endpoints that already expose `/openai/v1/` should use `type: "openai"`.

`cliUrl` connects to an already-running headless Copilot CLI server. When set, `copilot-remote` does not spawn its own CLI process and does not pass `GITHUB_TOKEN` through to the SDK client.

Example external server flow:

```bash
copilot --headless --port 4141
COPILOT_REMOTE_CLI_URL=http://127.0.0.1:4141 npx copilot-remote
```

`messageMode` controls what happens if you send another Telegram message while Copilot is still working:

- `enqueue` — queue it as the next normal prompt
- `immediate` — inject it into the in-flight turn as a steering message

For a plain phone relay, `enqueue` is the sane default.

## Forum Topics (Multi-Session)

Add the bot to a Telegram supergroup with **admin rights** (`can_manage_topics`). Each forum topic gets its own isolated Copilot session — separate context, model, working directory. Topic name is injected into the system prompt to keep Copilot focused.

## Session IDs

By default, each Telegram chat or forum topic maps to a deterministic Copilot session ID:

- DM/chat: `telegram-<chatId>`
- forum topic: `telegram-<chatId>-thread-<threadId>`

That makes persistence and debugging a lot less mysterious, and it plays nicely with Copilot CLI resume flows.

The old `~/.copilot-remote/chat-sessions.json` file is now legacy-only. It is still read for migration/fallback, but deterministic session IDs are the default path.

## Running as a Service (macOS)

```bash
# Create launch script
cat > ~/.copilot-remote/launch.sh << 'EOF'
#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
export HOME=/Users/$USER
exec npx tsx ~/src/copilot-remote/src/index.ts
EOF
chmod +x ~/.copilot-remote/launch.sh

# Create launchd plist
cat > ~/Library/LaunchAgents/com.copilot-remote.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.copilot-remote</string>
  <key>ProgramArguments</key><array>
    <string>$HOME/.copilot-remote/launch.sh</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/.copilot-remote/logs/copilot-remote.log</string>
  <key>StandardErrorPath</key><string>$HOME/.copilot-remote/logs/copilot-remote.log</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.copilot-remote.plist
```

Running under `launchd` or `systemd` is what makes self-development pleasant: when `copilot-remote` exits for a capability reload, the supervisor brings it right back.

## Self Development

`copilot-remote` can now watch modular capability inputs and reload itself when they change.

Watched targets include:

- `~/.copilot-remote/config.json`
- `~/.copilot/mcp-config.json`
- workspace agent directories such as `.github/agents/`, `.copilot/agents/`, `.claude/agents/`
- workspace prompt directories such as `.github/prompts/`
- skill directories such as `~/.copilot/skills`, `~/.github/skills`, and any configured `skillDirectories`

Useful commands:

- `/selfdev` — show watcher status, supervisor detection, pending restart state, and watched paths
- `/restart` — force a clean bridge restart to load newly added capabilities

Behavior notes:

- if `copilot-remote` detects `launchd` or `systemd`, it can auto-restart after capability changes
- if no supervisor is detected, it will still flag that a restart is needed and you can use `/restart`
- this is meant for **modular self-development**: config, skills, prompts, agents, and MCP wiring
- core bridge rewrites are still restart-bound and intentionally not hot-loaded into the running process

Optional config in `~/.copilot-remote/config.json`:

```json
{
  "selfDevelopment": {
    "enabled": true,
    "autoRestart": true,
    "debounceMs": 1500,
    "watchConfig": true,
    "watchMcp": true,
    "watchAgents": true,
    "watchSkills": true,
    "watchPrompts": true
  }
}
```

This gives you the fun part of OpenClaw-style evolution without going full goblin mode on the bridge core.

## Browser Mocking for Telegram Web Apps

`copilot-remote` itself is a Telegram bot bridge, not a browser-based Telegram Mini App. But if you build a companion web UI around it with React, Next.js, or another frontend stack, you can mock the Telegram environment locally instead of constantly reopening the Telegram client.

The usual pattern is to use `@telegram-apps/sdk` helpers such as `mockTelegramEnv` and `isTMA` to spoof `initData` and detect whether the page is really running inside Telegram. That lets you develop and debug in a normal browser with desktop devtools while keeping behavior close to the real Telegram container.

Practical rules:

- use `isTMA()` (or an equivalent guard) before relying on Telegram runtime APIs
- use `mockTelegramEnv(...)` only in development to inject test `initData`
- keep the mocked path dev-only so production still depends on real Telegram launch data

If you add a web surface later, this is the easiest way to test it without constantly bouncing through the Telegram app on mobile.

## Local Mock Telegram Harness

If you want to test the bot bridge itself without opening Telegram, run the built-in mock transport harness:

```bash
npm run dev:mock
```

You can also use the CLI/env switch directly:

```bash
COPILOT_REMOTE_FAKE_TELEGRAM=1 npx copilot-remote
```

or:

```bash
npx copilot-remote --fake-telegram
```

This starts a local stdin/stdout harness that pretends to be Telegram and prints outbound bot traffic to your terminal.

The old `fake-telegram` naming is still accepted in flags/env vars for compatibility, but this harness now lives under `src/testing/` and is intentionally treated as a lightweight dev/test surface—not the source of truth for real Telegram behavior.

Useful commands inside the harness:

- `<text>` — send a normal incoming message
- `/mock reply <msgId> <text>` — simulate replying to an earlier message
- `/mock callback <msgId> <data>` — simulate pressing an inline button
- `/mock reaction <msgId> <emoji>` — simulate a reaction update
- `/mock file <path> [caption]` — simulate a file upload
- `/mock topic <threadId> [name]` — switch into a forum topic/thread
- `/mock topic dm` — switch back to direct-message mode

This is great for testing queueing, button callbacks, reply threading, reactions, and general bridge behavior without touching the real Telegram client.

## Architecture

```
src/
  index.ts           — Bridge: commands, streaming, config routing
  session.ts         — Copilot SDK wrapper (create, send, resume, permissions)
  telegram.ts        — grammY-based Telegram client
  client.ts          — Platform-agnostic Client interface
  config-store.ts    — Persistent config with per-topic overrides
  store.ts           — Session persistence (JSON)
  format/            — Markdown → Telegram HTML (ported from OpenClaw)
    ir.ts            — markdown-it IR parser
    render.ts        — Style marker renderer
    telegram.ts      — Telegram HTML with chunking, file ref wrapping
    chunk.ts         — Text chunking utilities
  emoji.ts           — Status emoji mapping
  tools.ts           — Custom tool definitions
  log.ts             — Minimal logger
```

Built on [grammY](https://grammy.dev) with auto-retry, hydrate, and parse-mode plugins.

## License

MIT — Telegram formatter ported from [OpenClaw](https://github.com/openclaw/openclaw).
