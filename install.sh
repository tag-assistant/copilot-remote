#!/bin/bash
# ============================================================
# Copilot Remote — One-line Installer
# ============================================================
# curl -fsSL https://raw.githubusercontent.com/austenstone/copilot-remote/main/install.sh | bash
# Hackable mode (self-dev, source watching, hot reload):
#   curl -fsSL ... | bash -s -- --hackable
# ============================================================

set -e
umask 077

REPO="austenstone/copilot-remote"
INSTALL_DIR="$HOME/.copilot-remote"
PLIST_PATH="$HOME/Library/LaunchAgents/com.copilot-remote.plist"
HACKABLE=0

read_secret() {
  local __target="$1"
  if [ -t 0 ]; then
    IFS= read -rs "$__target"
    echo ""
  else
    IFS= read -r "$__target"
  fi
}

# Parse flags
for arg in "$@"; do
  case "$arg" in
    --hackable) HACKABLE=1 ;;
  esac
done

echo ""
echo "  ⚡ Copilot Remote Installer"
echo "  ─────────────────────────────"
if [ "$HACKABLE" -eq 1 ]; then
  echo "  🔧 Hackable mode — self-dev enabled"
fi
echo ""

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "❌ Node.js required. Install: https://nodejs.org"; exit 1; }
command -v copilot >/dev/null 2>&1 || { echo "❌ GitHub Copilot CLI required. Install: npm install -g @github/copilot"; exit 1; }

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  echo "❌ Node.js 22+ required (found $(node -v))"
  exit 1
fi

# Get tokens
if [ -z "$COPILOT_REMOTE_BOT_TOKEN" ]; then
  echo "  Telegram bot token (from @BotFather):"
  printf "  > "
  read_secret COPILOT_REMOTE_BOT_TOKEN
fi

GH_BIN=""
GITHUB_TOKEN_SOURCE=""
if command -v gh >/dev/null 2>&1; then
  GH_BIN=$(which gh)
fi

if [ -n "$GITHUB_TOKEN" ]; then
  GITHUB_TOKEN_SOURCE="env"
fi

if [ -z "$GITHUB_TOKEN" ] && [ -n "$GH_BIN" ]; then
  GITHUB_TOKEN=$(gh auth token 2>/dev/null || true)
  if [ -n "$GITHUB_TOKEN" ]; then
    GITHUB_TOKEN_SOURCE="gh"
  fi
fi

if [ -z "$GITHUB_TOKEN" ]; then
  echo ""
  echo "  GitHub token (with Copilot access, optional if gh auth login already works):"
  printf "  > "
  read_secret GITHUB_TOKEN
  if [ -n "$GITHUB_TOKEN" ]; then
    GITHUB_TOKEN_SOURCE="prompt"
  fi
fi

if [ -z "$COPILOT_REMOTE_BOT_TOKEN" ]; then
  echo "❌ Telegram bot token is required."
  exit 1
fi

if [ -z "$GITHUB_TOKEN" ]; then
  echo "❌ Need GitHub auth via GITHUB_TOKEN or gh auth login."
  exit 1
fi

echo ""
echo "  📦 Installing copilot-remote..."

# Clone or update
if [ -d "$INSTALL_DIR" ]; then
  cd "$INSTALL_DIR"
  git pull --quiet
else
  git clone --quiet "https://github.com/$REPO.git" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

npm install --silent 2>/dev/null
npm run build --silent 2>/dev/null

COPILOT_BIN=$(which copilot)
NODE_BIN=$(which node)
GH_DIR=""
CONFIG_DIR="$INSTALL_DIR"
CONFIG_PATH="$CONFIG_DIR/config.json"
LOG_DIR="$INSTALL_DIR/logs"
LOG_PATH="$LOG_DIR/copilot-remote.log"
if [ -n "$GH_BIN" ]; then
  GH_DIR=$(dirname "$GH_BIN")
fi

mkdir -p "$CONFIG_DIR" "$LOG_DIR"
chmod 700 "$CONFIG_DIR" "$LOG_DIR"
touch "$LOG_PATH"
chmod 600 "$LOG_PATH"

PERSIST_GITHUB_TOKEN=""
if [ "$GITHUB_TOKEN_SOURCE" != "gh" ]; then
  PERSIST_GITHUB_TOKEN="$GITHUB_TOKEN"
fi

CONFIG_PATH="$CONFIG_PATH" \
COPILOT_REMOTE_BOT_TOKEN="$COPILOT_REMOTE_BOT_TOKEN" \
COPILOT_REMOTE_GITHUB_TOKEN="$PERSIST_GITHUB_TOKEN" \
COPILOT_REMOTE_HACKABLE="$HACKABLE" \
node <<'EOF'
const fs = require('fs');

const configPath = process.env.CONFIG_PATH;
const botToken = process.env.COPILOT_REMOTE_BOT_TOKEN;
const githubToken = process.env.COPILOT_REMOTE_GITHUB_TOKEN;
const hackable = process.env.COPILOT_REMOTE_HACKABLE === '1';

let config = {};
if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.warn(`⚠️  Failed to parse ${configPath}; rewriting it with a fresh config.`);
  }
}

config.botToken = botToken;
if (githubToken) config.githubToken = githubToken;

if (hackable) {
  config.selfDevelopment = { ...config.selfDevelopment, enabled: true, autoRestart: true };
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
fs.chmodSync(configPath, 0o600);
EOF

if [ "$HACKABLE" -eq 1 ]; then
  echo "  🔧 Self-development enabled in config"
fi

# ProgramArguments
if [ "$HACKABLE" -eq 1 ]; then
  # Hackable: run TypeScript directly via tsx (no watch) for Node 24 ESM compat
  PROG_ARGS="        <string>$NODE_BIN</string>
        <string>$INSTALL_DIR/node_modules/.bin/tsx</string>
        <string>src/index.ts</string>"
else
  # Standard: run compiled JS directly with Node
  PROG_ARGS="        <string>$NODE_BIN</string>
        <string>$INSTALL_DIR/dist/index.js</string>"
fi
EXTRA_ENV="        <key>LAUNCH_JOB_NAME</key>
        <string>com.copilot-remote</string>"

# Detect OS
if [ "$(uname)" = "Darwin" ]; then
  echo "  🍎 Setting up macOS LaunchAgent..."

  # Stop existing
  launchctl unload "$PLIST_PATH" 2>/dev/null || true

  cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.copilot-remote</string>
    <key>ProgramArguments</key>
    <array>
$PROG_ARGS
    </array>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>COPILOT_REMOTE_WORKDIR</key>
        <string>$HOME</string>
        <key>PATH</key>
        <string>$(dirname "$NODE_BIN"):$(dirname "$COPILOT_BIN")${GH_DIR:+:$GH_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>$HOME</string>
        <key>NODE_OPTIONS</key>
        <string>--experimental-sqlite</string>
$EXTRA_ENV
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>$LOG_PATH</string>
    <key>StandardErrorPath</key>
    <string>$LOG_PATH</string>
</dict>
</plist>
EOF

  chmod 600 "$PLIST_PATH"

  launchctl load "$PLIST_PATH"

  echo ""
  echo "  ✅ Copilot Remote is running!"
  echo ""
  echo "  ─────────────────────────────"
  echo "  Config:   ~/.copilot-remote/config.json (0600)"
  if [ "$HACKABLE" -eq 1 ]; then
    echo "  Mode:     🔧 Hackable (self-dev, file watching)"
    echo "  Source:   ~/.copilot-remote/src/"
  fi
  echo "  Service:  launchctl list | grep copilot"
  echo "  Logs:     tail -f ~/.copilot-remote/logs/copilot-remote.log"
  echo "  Stop:     launchctl unload $PLIST_PATH"
  echo "  Start:    launchctl load $PLIST_PATH"
  if [ "$HACKABLE" -eq 1 ]; then
    echo "  Update:   cd ~/.copilot-remote && git pull && npm install && npm run build"
    echo "  Hack:     code ~/.copilot-remote  (edit src/, build, auto-restarts)"
  else
    echo "  Update:   cd ~/.copilot-remote && git pull && npm run build"
  fi
  echo "  Uninstall: launchctl unload $PLIST_PATH && rm -rf ~/.copilot-remote $PLIST_PATH"
  echo ""

elif command -v systemctl >/dev/null 2>&1; then
  echo "  🐧 Setting up systemd service..."

  UNIT_PATH="$HOME/.config/systemd/user/copilot-remote.service"
  mkdir -p "$(dirname "$UNIT_PATH")"

  # Hackable: run TypeScript directly, standard: compiled JS via plain Node
  if [ "$HACKABLE" -eq 1 ]; then
    EXEC_START="$NODE_BIN $INSTALL_DIR/node_modules/.bin/tsx src/index.ts"
  else
    EXEC_START="$NODE_BIN $INSTALL_DIR/dist/index.js"
  fi

  cat > "$UNIT_PATH" << EOF
[Unit]
Description=Copilot Remote — Telegram ↔ Copilot CLI bridge
After=network.target

[Service]
ExecStart=$EXEC_START
WorkingDirectory=$INSTALL_DIR
Environment=COPILOT_REMOTE_WORKDIR=$HOME
Environment=PATH=$(dirname "$NODE_BIN"):$(dirname "$COPILOT_BIN")${GH_DIR:+:$GH_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
Environment=NODE_OPTIONS=--experimental-sqlite
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

  chmod 600 "$UNIT_PATH"

  systemctl --user daemon-reload
  systemctl --user enable copilot-remote
  systemctl --user start copilot-remote

  echo ""
  echo "  ✅ Copilot Remote is running!"
  echo ""
  echo "  ─────────────────────────────"
  echo "  Config:    ~/.copilot-remote/config.json (0600)"
  echo "  Status:    systemctl --user status copilot-remote"
  echo "  Logs:      journalctl --user -u copilot-remote -f"
  echo "  Stop:      systemctl --user stop copilot-remote"
  echo "  Start:     systemctl --user start copilot-remote"
  if [ "$HACKABLE" -eq 1 ]; then
    echo "  Update:    cd ~/.copilot-remote && git pull && npm install"
    echo "  Hack:      code ~/.copilot-remote  (edit src/, auto-reloads)"
  else
    echo "  Update:    cd ~/.copilot-remote && git pull && npm run build && systemctl --user restart copilot-remote"
  fi
  echo "  Uninstall: systemctl --user disable --now copilot-remote && rm -rf ~/.copilot-remote $UNIT_PATH"
  echo ""

else
  echo ""
  echo "  ✅ Installed to ~/.copilot-remote"
  echo ""
  echo "  Config saved to ~/.copilot-remote/config.json (0600)."
  echo ""
  echo "  Run manually:"
  if [ "$HACKABLE" -eq 1 ]; then
    echo "    ~/.copilot-remote/node_modules/.bin/tsx ~/.copilot-remote/src/index.ts"
  else
    echo "    node ~/.copilot-remote/dist/index.js"
  fi
  echo ""
fi

echo "  Open your bot in Telegram and send a message. 🚀"
echo ""
