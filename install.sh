#!/usr/bin/env bash
#
# Installs the Claude Stream Deck Dashboard on this Mac:
#   1. builds the Elgato plugin and links it into Stream Deck
#   2. installs the Claude Code status hook + wires it in settings.json
#   3. installs the /streamdeck-sync skill
#
# Safe to re-run. It backs up settings.json and never clobbers existing hooks
# it didn't add. macOS only.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE="$HOME/.claude"
SDPLUGIN="com.tknab.claudeagents.sdPlugin"
SD_PLUGINS="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins"
HOOK="$CLAUDE/hooks/agent-status.sh"

say() { printf "\033[1;32m▸\033[0m %s\n" "$1"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$1"; }

# --- 1. build + link the plugin -------------------------------------------
say "Building the Stream Deck plugin…"
cd "$REPO"
[ -d node_modules ] || npm install
npm run build

say "Linking the plugin into Stream Deck…"
mkdir -p "$SD_PLUGINS"
ln -sfn "$REPO/$SDPLUGIN" "$SD_PLUGINS/$SDPLUGIN"

# --- 2. install + wire the status hook ------------------------------------
say "Installing the status hook…"
mkdir -p "$CLAUDE/hooks" "$CLAUDE/state/agent-status"
cp "$REPO/claude/hooks/agent-status.sh" "$HOOK"
chmod +x "$HOOK"

say "Wiring the hook into ~/.claude/settings.json…"
SETTINGS="$CLAUDE/settings.json"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
if jq -e '.hooks.Stop' "$SETTINGS" >/dev/null 2>&1; then
  warn "settings.json already has a hooks block — leaving it as-is (check it points at $HOOK)."
else
  cp "$SETTINGS" "$SETTINGS.bak.$(date +%s)"
  jq --arg cmd "$HOOK" '.hooks = {
    "UserPromptSubmit":[{"hooks":[{"type":"command","command":$cmd}]}],
    "PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":$cmd}]}],
    "PostToolUse":[{"matcher":"*","hooks":[{"type":"command","command":$cmd}]}],
    "Notification":[{"matcher":"","hooks":[{"type":"command","command":$cmd}]}],
    "PermissionRequest":[{"hooks":[{"type":"command","command":$cmd}]}],
    "Stop":[{"hooks":[{"type":"command","command":$cmd}]}],
    "SessionStart":[{"hooks":[{"type":"command","command":$cmd}]}],
    "SessionEnd":[{"hooks":[{"type":"command","command":$cmd}]}]
  }' "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"
  say "Backed up the old settings.json and added the hooks block."
fi

# --- 3. install the sync skill --------------------------------------------
say "Installing the /streamdeck-sync skill…"
mkdir -p "$CLAUDE/skills/streamdeck-sync"
cp "$REPO/claude/skills/streamdeck-sync/SKILL.md" "$CLAUDE/skills/streamdeck-sync/"

# optional emoji overrides (auto-fill fallback only)
[ -f "$CLAUDE/agent-emojis.json" ] || cp "$REPO/claude/agent-emojis.example.json" "$CLAUDE/agent-emojis.json"

# --- done -----------------------------------------------------------------
if command -v streamdeck >/dev/null 2>&1; then
  streamdeck restart com.tknab.claudeagents >/dev/null 2>&1 || true
fi

cat <<'DONE'

✅ Installed. Next:
   1. Open the Stream Deck app → drag the "Agent" action (category "Claude Agents")
      onto a row of keys.
   2. In a Claude Code chat, run:  /streamdeck-sync <Your Sidebar Group Name>
      (or just /streamdeck-sync to use the default group).
   3. Watch your keys light up: green = done, amber = working, red = needs you.

   Restart a Claude Code session so the new hooks load.
DONE
