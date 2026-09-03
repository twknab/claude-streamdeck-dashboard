---
name: streamdeck-sync
description: Re-sync the Stream Deck "Claude Agents" plugin with a Claude Code sidebar group. Reads the chats in a chosen sidebar group via list_sessions and writes them to ~/.claude/state/streamdeck-group.json, so the deck mirrors that group's chats (emoji + title + live status). Run this after you add/remove a chat from the group, rename a chat title, or rename the group. Use for "sync the streamdeck", "refresh the streamdeck group", "/streamdeck-sync", "update my agent deck".
---

# Sync the Stream Deck group

Mirror a Claude Code **sidebar group** onto the Stream Deck. The deck plugin renders one
key per chat in the group: the leading emoji of the chat title is the key icon, the rest
is the caption, and the circle color comes from that chat's live status (via the hooks).
This skill just refreshes **which chats** are on the deck and **their titles**.

## Steps

1. **Determine the target group name.**
   - If the user passed a group name as an argument, use it.
   - Else read the current one:
     ```bash
     jq -r '.group // "Author-Watcher-Duo"' ~/.claude/state/streamdeck-group.json 2>/dev/null || echo "Author-Watcher-Duo"
     ```

2. **Fetch the group's chats** with `mcp__ccd_session_mgmt__list_sessions`, passing
   `group: "<that name>"`. Each returned session has `sessionId` (like
   `local_<uuid>`), `title`, and `group`.

2b. **Include the CURRENT chat.** `list_sessions` EXCLUDES the session you're running in,
   so also call `mcp__ccd_session_mgmt__get_session` with `session_id: "self"`; if its
   `group.name` equals the target group, add it to the list too (otherwise the chat you're
   syncing from is silently missing from the deck).

3. **Build the chat list.** For every returned session:
   - `sessionId` = the returned id **with a leading `local_` stripped** (the hooks key
     status files by the bare `<uuid>`, so this is what makes the color match).
   - `title` = the session `title` verbatim (the user controls it as `{emoji} {short title}`).
   - Keep the order list_sessions returns (the plugin sorts by label anyway).
   - If there are **more than 13** chats, keep the 13 most-recently-active and tell the
     user the rest were dropped (a deck holds at most 13 here).

4. **Write** `~/.claude/state/streamdeck-group.json` as:
   ```json
   { "group": "<name>", "updatedAt": <epoch seconds>, "chats": [ { "sessionId": "<uuid>", "title": "<title>" } ] }
   ```
   Use the `Write` tool (or `jq`/`python3`) — ensure emojis are preserved (UTF-8, not
   escaped). Set `updatedAt` to the current epoch seconds.

5. **Confirm**: reply with the group name, the count, and each chat as `emoji — label`
   (parse the leading emoji from each title) so the user can eyeball the mapping. The
   plugin picks up the new file within ~1s; no restart needed.

## Notes
- Status **colors** are already real-time and free (the hooks write per-session files);
  this skill only refreshes membership + titles, which change rarely.
- If `list_sessions` returns nothing for the group, say so — the group is empty or the
  name is wrong (check the exact sidebar group name in the Claude Code app).
- To point the deck at a **different** group, run `/streamdeck-sync <Group Name>` — that
  new name is written into the file and becomes the default next time.
