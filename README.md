# Copilot Remote ⚡

> Control GitHub Copilot CLI from Telegram. Start local coding sessions from your phone.

## How it works

```
┌──────────┐    Telegram API    ┌─────────────────┐    PTY     ┌─────────────┐
│  Phone   │ ←───────────────→ │  copilot-remote  │ ←───────→ │ copilot CLI │
│ Telegram │                    │  (bridge daemon) │           │  (local)    │
└──────────┘                    └─────────────────┘            └─────────────┘
                                       ↕
                                  Your filesystem,
                                  MCP servers, tools
```

Your Copilot CLI runs locally with full access to your filesystem, GitHub context, and MCP servers. The bridge daemon relays messages between Telegram and the CLI via a pseudo-terminal. Nothing leaves your machine except the chat messages.

## Prerequisites

- [Copilot CLI](https://github.com/github/copilot-cli) installed and authenticated
- A Telegram bot token (create via [@BotFather](https://t.me/botfather))
- Node.js 22+

## Setup

### 1. Install Copilot CLI

```bash
# macOS/Linux
brew install copilot-cli

# or via npm
npm install -g @github/copilot

# Authenticate
copilot
```

### 2. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/botfather)
2. Send `/newbot`
3. Choose a name (e.g. "Copilot")
4. Choose a username (e.g. `my_copilot_remote_bot`)
5. BotFather gives you a token like `123456:ABC-DEF...` — copy it

### 3. Install & Run

```bash
git clone https://github.com/tag-assistant/copilot-remote.git
cd copilot-remote
npm install
```

Set your bot token and start:

```bash
export COPILOT_REMOTE_BOT_TOKEN="your-token-from-botfather"
npm run dev
```

### 4. Pair

Message your bot in Telegram. The first person to message gets auto-paired — no config needed. Everyone else is blocked.

Optionally, pre-configure allowed users in `.copilot-remote.json`:

```json
{
  "botToken": "your-token-from-botfather",
  "allowedUsers": ["your-telegram-user-id"],
  "workDir": "/path/to/your/project"
}
```

> **Tip:** To find your Telegram user ID, message [@userinfobot](https://t.me/userinfobot).

## Usage

```bash
npm run dev    # development (watch mode)
npm start      # production
```

Then in Telegram:

| Command | Description |
|---------|-------------|
| `/start [dir]` | Start a Copilot session in directory |
| `/stop` | Kill current session |
| `/status` | Check if session is alive |
| `/yes` `/y` | Approve tool action |
| `/no` `/n` | Deny tool action |
| `/help` | Show commands |

Or just type a message to send it as a prompt to Copilot.

## Architecture

- **`src/session.ts`** — PTY manager for Copilot CLI. Spawns the process, handles ANSI stripping, detects prompts/responses, manages approve/deny flows.
- **`src/telegram.ts`** — Lightweight Telegram Bot API client. Long-polling, message splitting, typing indicators. Zero dependencies.
- **`src/index.ts`** — Wires it all together. Per-chat session management, command routing, graceful shutdown.

## Security

- Only Telegram user IDs in `allowedUsers` can interact
- Copilot CLI runs with your local permissions — same as running it in your terminal
- Bot token should be kept secret (use env vars in production)

## License

MIT
