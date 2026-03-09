# Changelog

## 0.8.0 (2026-03-09)

### Streaming & Session UX
- **Full live activity relay** — thinking, tool progress, plan updates, and subagent status now stream through Telegram in real time
- **Stable overlapping tool status** — active tool progress no longer disappears when multiple tool calls overlap
- **No-op `turn_start` scaffolding** — event wiring stays in place for future expansion without changing current behavior
- **Cleaner status output** — removed the fallback `✍️ Writing response` indicator

### Packaging & Install
- **npm publish-ready package** — tarball now includes only runtime artifacts, bundled installer assets, and the SDK patch script
- **Dedicated install commands** — `copilot-remote install` and `copilot-remote daemon-install` now invoke the bundled daemon installer
- **Portable installer cleanup** — docs, metadata, Node version requirements, and auth behavior now match the actual supported install paths

### Service Hardening
- **Secrets moved out of service definitions** — launchd/systemd no longer persist bot or GitHub tokens in environment blocks
- **Locked-down local config** — installer writes `~/.copilot-remote/config.json` with user-only permissions for unattended startup
- **Safer daemon logging** — macOS logs now live under `~/.copilot-remote/logs/` with tightened file permissions

## 0.7.0 (2026-03-08)

### Telegram Features
- **Native draft streaming** — `sendMessageDraft` with 400ms throttle, auto-fallback to edit-in-place
- **HTML rendering** — Markdown → Telegram HTML converter with plain text fallback
- **Emoji validation** — Only Telegram-supported reactions, with fallback map
- **Bot command menu** — `setMyCommands` registered on startup for autocomplete
- **Forum topic routing** — Each topic gets isolated session via `chatId:threadId` keys
- **Photo/document receiving** — Send screenshots/files, downloaded and passed to Copilot
- **File sending** — `sendDocument`, `sendPhoto` for Copilot output
- **Forum topic management** — `createForumTopic`, `deleteForumTopic`
- **Pin messages** — `pinChatMessage` for status
- **Per-topic typing** — `sendChatAction` with `message_thread_id`
- **Delete messages** — Cleanup old drafts and prompts
- **Poll offset persistence** — Survives restarts
- **Retry with backoff** — Exponential backoff + 429 rate limit handling

### Copilot SDK
- **`onUserInputRequest`** — Copilot can ask questions via buttons or text reply
- **Reasoning effort** — low/medium/high/xhigh in `/config`
- **`infiniteSessions`** — Auto-compaction at 80%, blocks at 95%
- **Custom tools (`defineTool`)** — `send_notification` tool for Copilot → Telegram alerts
- **System instructions** — Copilot knows it's in Telegram, uses tools proactively
- **Session resume** — `client.resumeSession()` with persistent session store
- **Shared config builder** — DRY `buildConfig()` for create and resume

### Config & UX
- **Mode switcher** — Interactive/Plan/Autopilot as inline buttons in `/config`
- **Tool security** — Per-kind auto-approve (read/write/shell/url/mcp/custom-tool)
- **Reasoning effort** — 4 levels in `/config` submenu
- **Display settings** — Thinking, Tools, Usage, Reactions toggles
- **`/cd` restarts live** — Kill + restart session in new directory
- **`/status` with git branch** — cwd [⎇ branch], model, mode, quota
- **`/help` organized** — Commands by category with descriptions
- **Approve All** — Approves pending prompts without switching mode
- **No quote replies** — Clean message delivery

### Infrastructure
- ESLint + Prettier + EditorConfig
- CI workflow (Node 20/22 matrix, lint, build, typecheck)
- Publish workflow (npm publish on GitHub release with provenance)
- `.npmignore` for clean package

## 0.5.0 (2026-03-07)

- Switched to `@github/copilot-sdk`
- Full SDK RPC coverage
- Inline permission approval
- Client interface for multi-platform

## 0.4.0 (2026-03-06)

- ACP mode (replaced PTY)

## 0.3.0 (2026-03-06)

- npm package: `npx copilot-remote`
- launchd service

## 0.2.0 (2026-03-06)

- JSONL streaming + session resume
- Edit-in-place streaming
- Tool calls inline

## 0.1.0 (2026-03-05)

- Initial release
- Telegram Bot API via fetch
- Basic Copilot CLI integration
