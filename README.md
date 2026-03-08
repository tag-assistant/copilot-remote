# copilot-remote

Control GitHub Copilot from Telegram. Full SDK integration — streaming, tool calls, permissions, multi-session forum topics.

[![CI](https://github.com/tag-assistant/copilot-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/tag-assistant/copilot-remote/actions/workflows/ci.yml)

## Setup

```bash
npx copilot-remote
```

On first run, you'll be prompted for your Telegram bot token (get one from [@BotFather](https://t.me/BotFather)). Config is saved to `~/.copilot-remote/config.json`.

GitHub auth is auto-detected from `gh auth login`. If the logged-in account doesn't have a Copilot license, set `githubToken` in config or `GITHUB_TOKEN` env.

## Features

- **Streaming** — edit-in-place responses with typing indicators
- **Tool calls** — see file reads, edits, shell commands as they happen
- **Inline permissions** — approve/deny with buttons, reactions, or reply text
- **Three modes** — Interactive (approve each), Plan (review first), Autopilot (approve all)
- **Model switching** — pick from available models via `/config`
- **Reasoning effort** — off/low/medium/high per model capability
- **Forum topics** — each Telegram topic = isolated Copilot session with its own context
- **Voice messages** — transcribed and forwarded to Copilot
- **Photos & documents** — sent as context
- **Infinite sessions** — automatic context compaction, no token limit crashes
- **Session persistence** — survives restarts
- **Custom agents** — use workspace `.copilot/agents/` definitions
- **Custom tools** — Copilot can send you Telegram notifications

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

## Config

`~/.copilot-remote/config.json`:

```json
{
  "botToken": "telegram-bot-token",
  "githubToken": "ghp_...",
  "workDir": "/home/user/projects",
  "copilotBinary": "/path/to/copilot",
  "allowedUsers": ["123456789"],
  "model": "claude-sonnet-4",
  "mode": "interactive",
  "showThinking": false,
  "showTools": true,
  "showReactions": true,
  "autoApprove": {
    "read": true,
    "shell": false,
    "write": false
  }
}
```

Only `botToken` is required. Everything else has sensible defaults.

## Forum Topics (Multi-Session)

Add the bot to a Telegram supergroup with **admin rights** (`can_manage_topics`). Each forum topic gets its own isolated Copilot session — separate context, model, working directory. Topic name is injected into the system prompt to keep Copilot focused.

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

## Requirements

- Node.js ≥ 20
- `gh` CLI authenticated (`gh auth login`)
- GitHub account with Copilot license
- Telegram bot token from [@BotFather](https://t.me/BotFather)

## License

MIT — Telegram formatter ported from [OpenClaw](https://github.com/openclaw/openclaw).
