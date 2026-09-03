#!/bin/bash
# Claude agent status -> Stream Deck.
#
# Wired to several Claude Code hook events (see ~/.claude/settings.json). On each
# event it writes ONE file per session to ~/.claude/state/agent-status/<id>.json
# describing that agent's live state: cooking (working) / needs_me / done. A
# Stream Deck plugin polls those files and paints a key per agent.
#
# Contract: this runs on EVERY hook of EVERY session, so it must be fast and it
# must NEVER block a session — it always exits 0, even on malformed input.

JQ=/usr/bin/jq
DIR="$HOME/.claude/state/agent-status"
EMOJI_MAP="$HOME/.claude/agent-emojis.json"

mkdir -p "$DIR" 2>/dev/null
[ -x "$JQ" ] || exit 0

payload="$(cat 2>/dev/null)"
[ -z "$payload" ] && exit 0

get() { printf '%s' "$payload" | "$JQ" -r "$1 // \"\"" 2>/dev/null; }

event="$(get '.hook_event_name')"
sid="$(get '.session_id')"
[ -z "$sid" ] && exit 0

# End of session -> remove the light and stop.
if [ "$event" = "SessionEnd" ]; then
  rm -f "$DIR/$sid.json" 2>/dev/null
  exit 0
fi

ntype="$(get '.notification_type')"
tool="$(get '.tool_name')"
cwd="$(get '.cwd')"
[ -z "$cwd" ] && cwd="${CLAUDE_PROJECT_DIR:-$PWD}"
# Project ROOT for the label: cwd can be a deep subdir (e.g. .../roles/[id])
# whose basename is meaningless. Prefer $CLAUDE_PROJECT_DIR, else walk up to the
# nearest ancestor with a .git or .claude, else fall back to cwd.
root="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$root" ]; then
  d="$cwd"
  while [ -n "$d" ] && [ "$d" != "/" ]; do
    if [ -e "$d/.git" ] || [ -d "$d/.claude" ]; then root="$d"; break; fi
    d="$(dirname "$d")"
  done
fi
[ -z "$root" ] && root="$cwd"

# Event -> status.
status=""
case "$event" in
  UserPromptSubmit|PreToolUse|PostToolUse|PostToolUseFailure) status="cooking" ;;
  PermissionRequest) status="needs_me" ;;
  Stop|StopFailure|SessionStart) status="done" ;;
  Notification)
    case "$ntype" in
      agent_needs_input|permission_prompt) status="needs_me" ;;
      idle_prompt) status="done" ;;  # "you went quiet after it finished" = still just done, not blocked
      agent_completed) status="done" ;;
      *) exit 0 ;;  # ignore auth/quota/elicitation/other notification noise
    esac ;;
  *) exit 0 ;;
esac
[ -z "$status" ] && exit 0

# Human label = the project root's basename (each worktree is its own agent).
project="$(basename "$root" 2>/dev/null)"
[ -z "$project" ] && project="agent"

# Emoji: explicit override, else a deterministic palette pick so every project
# gets a stable glyph even without a mapping.
emoji=""
[ -r "$EMOJI_MAP" ] && emoji="$("$JQ" -r --arg p "$project" '.[$p] // ""' "$EMOJI_MAP" 2>/dev/null)"
if [ -z "$emoji" ] || [ "$emoji" = "null" ]; then
  palette=(🚀 🔮 🛰️ 🌊 🔧 🧪 🛠️ 🌱 ⚡ 🦊 🐙 🧭 📦 🎛️ 🔭 🌵 🍄 🎧)
  h="$(printf '%s' "$project" | cksum | awk '{print $1}')"
  emoji="${palette[$(( h % ${#palette[@]} ))]}"
fi

now="$(date +%s)"
tmp="$DIR/.$sid.$$.tmp"
if "$JQ" -n \
    --arg sessionId "$sid" --arg project "$project" --arg cwd "$cwd" \
    --arg emoji "$emoji" --arg status "$status" --arg detail "$tool" \
    --argjson updatedAt "$now" \
    '{sessionId:$sessionId, project:$project, cwd:$cwd, emoji:$emoji, status:$status, detail:$detail, updatedAt:$updatedAt}' \
    > "$tmp" 2>/dev/null; then
  mv -f "$tmp" "$DIR/$sid.json" 2>/dev/null
fi
rm -f "$tmp" 2>/dev/null
exit 0
