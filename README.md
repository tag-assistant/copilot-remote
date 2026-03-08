# copilot-remote

Control GitHub Copilot from your phone. Telegram today, Discord/iMessage/WhatsApp tomorrow.

[![CI](https://github.com/tag-assistant/copilot-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/tag-assistant/copilot-remote/actions/workflows/ci.yml)

## What

A bridge between the [GitHub Copilot SDK](https://github.com/github/copilot-sdk) and messaging platforms. Send prompts from Telegram, get streamed responses with tool calls, inline permission approval, model switching, and full Copilot CLI command parity.

## Quick Start

```bash
npm i -g copilot-remote
export COPILOT_REMOTE_BOT_TOKEN=your-telegram-bot-token
copilot-remote
```

Or one-liner:

```bash
COPILOT_REMOTE_BOT_TOKEN=xxx npx copilot-remote
```

## Features

- **Streaming** — edit-in-place responses, just like ChatGPT
- **Tool calls** — see what Copilot is doing (read, edit, run, search)
- **Permissions** — approve/deny tool calls inline, or enable autopilot
- **Models** — switch models live via `/config` inline keyboard
- **Agents** — use custom Copilot agents from your workspace
- **Commands** — `/plan`, `/fleet`, `/research`, `/diff`, `/review`, `/compact`, and more
- **Config** — toggle thinking, tools, usage, reactions, autopilot

## Commands

| Command | Description |
|---------|-------------|
| `/new` | Fresh session |
| `/stop` | Kill session |
| `/cd [dir]` | Change working directory |
| `/status` | Model, mode, quota |
| `/config` | Settings menu |
| `/plan [task]` | Plan mode toggle or create plan |
| `/autopilot` | Toggle auto-approve all tools |
| `/fleet [task]` | Parallel subagents |
| `/agent [name]` | Switch custom agent |
| `/research <topic>` | Deep research |
| `/diff` | Review uncommitted changes |
| `/review` | Code review |
| `/compact` | Compress context |
| `/tools` | List available tools |
| `/files` | Browse workspace files |
| `/usage` | Quota and requests |
| `/debug` | Toggle debug logging |

## Configuration

Environment variables:

| Variable | Description |
|----------|-------------|
| `COPILOT_REMOTE_BOT_TOKEN` | Telegram bot token (required) |
| `COPILOT_REMOTE_ALLOWED_USERS` | Comma-separated Telegram user IDs |
| `COPILOT_REMOTE_WORKDIR` | Working directory (default: cwd) |
| `COPILOT_REMOTE_BINARY` | Path to copilot binary |
| `COPILOT_REMOTE_DEBUG` | Set to `1` for debug logging |

Or create `.copilot-remote.json`:

```json
{
  "botToken": "xxx",
  "allowedUsers": ["123456"],
  "workDir": "/home/user/projects"
}
```

## Architecture

```
src/
  client.ts          — Platform-agnostic Client interface
  session.ts         — Copilot SDK wrapper
  index.ts           — Bridge: commands, streaming, config
  telegram.ts        — Raw Telegram Bot API
  clients/
    telegram.ts      — TelegramClient adapter
  log.ts             — Debug logger
```

Adding a new platform: implement `Client` interface, swap one line in `main()`.

## Requirements

- Node.js >= 20
- GitHub Copilot CLI installed and authenticated (`copilot auth`)
- Telegram bot token from [@BotFather](https://t.me/BotFather)

## License

MIT
