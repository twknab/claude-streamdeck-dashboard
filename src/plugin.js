import streamDeck, { SingletonAction } from "@elgato/streamdeck";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

const STATE = join(homedir(), ".claude", "state");
const STATUS_DIR = join(STATE, "agent-status"); // hooks write live status here
const GROUP_FILE = join(STATE, "streamdeck-group.json"); // the curated sidebar group
const STALE_MS = 10 * 60 * 1000;
const SYNC_MS = 1000; // reload data (group + statuses) at 1 Hz
const FRAME_MS = 66; // repaint animated keys ~15 fps

// Vibrant, slightly-psychedelic orbs. green = done, amber = working, red = needs you.
const PAL = {
  cooking: { c1: "#FFCE38", c2: "#EA6A00", accent: "#FFF3C4" }, // gold → vivid orange
  needs_me: { c1: "#FF4D6A", c2: "#CE0A3E", accent: "#FFDCE3" }, // hot red → crimson
  done: { c1: "#2EEE95", c2: "#00A85A", accent: "#C6FFE2" }, // neon mint → green
  idle: { c1: "#2A2A33", c2: "#0D0D12", accent: "#33333E" }, // dim grey
};
const S = 144; // canvas px
const RAD = 30; // corner radius
const CX = 72;
const CY = 66; // emoji + motion center (vertically centered over the caption)

const escapeXml = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ease = (x) => x * x * (3 - 2 * x); // smoothstep
const lerp = (a, b, m) => a + (b - a) * m;
const lerp3 = (A, B, m) => [lerp(A[0], B[0], m), lerp(A[1], B[1], m), lerp(A[2], B[2], m)];
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgb2hex = (a) => "#" + a.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");

/** Split "{emoji} {short title}" into { emoji, label }. */
function parseTitle(title) {
  const t = String(title).trim();
  const lead = t.match(/^((?:\p{Extended_Pictographic}[️‍]?)+)\s+(\S.*)$/u);
  if (lead) return { emoji: lead[1], label: lead[2].trim() };
  const all = t.match(/\p{Extended_Pictographic}/gu);
  const label = t.replace(/[\p{Extended_Pictographic}️⃣]/gu, "").replace(/\s+/g, " ").trim();
  return { emoji: all && all.length ? all[all.length - 1] : "•", label: label || t };
}

/** sessionId (uuid) -> live status doc, dropping stale/crashed sessions. */
function readStatuses() {
  const map = new Map();
  let names;
  try {
    names = readdirSync(STATUS_DIR);
  } catch {
    return map;
  }
  const now = Date.now();
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const a = JSON.parse(readFileSync(join(STATUS_DIR, n), "utf8"));
      if (typeof a.updatedAt === "number" && now - a.updatedAt * 1000 <= STALE_MS) map.set(a.sessionId, a);
    } catch {
      /* mid-write — skip this tick */
    }
  }
  return map;
}

// --- conversation-id ↔ transcript-id bridge --------------------------------
const CCS = join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
let cliMapCache = null;
let cliMapAt = 0;
function readCliMap() {
  const map = new Map();
  let workspaces;
  try {
    workspaces = readdirSync(CCS);
  } catch {
    return map;
  }
  for (const ws of workspaces) {
    let parents;
    try {
      parents = readdirSync(join(CCS, ws));
    } catch {
      continue;
    }
    for (const p of parents) {
      const dir = join(CCS, ws, p);
      let files;
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
        try {
          const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
          const conv = String(d.sessionId || "").replace(/^local_/, "");
          if (conv && d.cliSessionId) map.set(conv, d.cliSessionId);
        } catch {
          /* skip */
        }
      }
    }
  }
  return map;
}
function convToCli(convId) {
  const now = Date.now();
  if (!cliMapCache || now - cliMapAt > 8000) {
    cliMapCache = readCliMap();
    cliMapAt = now;
  }
  return cliMapCache.get(convId) || convId;
}

/** The curated group's chats, in file order (initial auto-fill only). */
function readGroup() {
  if (!existsSync(GROUP_FILE)) return null;
  try {
    const g = JSON.parse(readFileSync(GROUP_FILE, "utf8"));
    return (g.chats || []).map((c) => {
      const p = parseTitle(c.title);
      return { sessionId: c.sessionId, title: c.title, emoji: p.emoji, label: p.label };
    });
  } catch {
    return null;
  }
}

/** Fallback (no group file): whatever agents are live, one per session. */
function readAuto() {
  const items = [...readStatuses().values()];
  items.sort(
    (x, y) => (x.project || "").localeCompare(y.project || "") || (x.sessionId || "").localeCompare(y.sessionId || ""),
  );
  return items.map((a) => ({ sessionId: a.sessionId, emoji: a.emoji, label: a.project, status: a.status }));
}

/** Target orb color + emoji opacity for a status. Done HOLDS green (it's a real
 * state: alive + finished), distinct from dim idle (no live session). */
function targetLook(status) {
  const p = PAL[status] || PAL.idle;
  return { c1: hex2rgb(p.c1), c2: hex2rgb(p.c2), eOp: status === "idle" ? 0.55 : 1, accent: p.accent };
}

// ---------------------------------------------------------------------------
// The key image. Whole key = a glowing orb; `disp` carries the (already smoothed)
// orb color + emoji opacity so transitions cross-fade; motion comes from status.
// ---------------------------------------------------------------------------
function keyImage(item, t, age, disp, accent, flash) {
  const flashRect =
    flash > 0
      ? `<rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="${RAD}" fill="#FFFFFF" opacity="${(flash * 0.6).toFixed(3)}"/>`
      : "";
  const hasChat = !!item;
  if (!hasChat) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">` +
      `<rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="${RAD}" fill="#0B0B0F"/>` +
      `<circle cx="${CX}" cy="${CY}" r="3" fill="#1C1C24"/>${flashRect}</svg>`;
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  const status = item.status || "idle";
  const emoji = item.emoji || "";
  const label = item.label || "";
  const c1 = rgb2hex(disp.c1);
  const c2 = rgb2hex(disp.c2);
  const isWork = status === "cooking";
  const isNeed = status === "needs_me";
  const isDone = status === "done";
  const isIdle = status === "idle";

  const breathe = 0.5 + 0.5 * Math.sin(t * (TAU / 1.5)); // deeper, slower breath

  let defs = "";
  let g = "";
  defs += `<clipPath id="rr"><rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="${RAD}"/></clipPath>`;
  g += `<rect x="2" y="2" width="${S - 4}" height="${S - 4}" rx="${RAD + 1}" fill="#0A0A0E"/>`;

  defs +=
    `<radialGradient id="orb" gradientUnits="userSpaceOnUse" cx="${CX}" cy="42" r="120">` +
    `<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></radialGradient>`;
  g += `<g clip-path="url(#rr)">`;
  g += `<rect x="3" y="3" width="${S - 6}" height="${S - 6}" fill="url(#orb)"/>`;

  // working: a big breathing glow + shimmer sweep
  if (isWork) {
    const lift = 0.08 + 0.4 * breathe; // deeper pulse
    defs +=
      `<radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="${CX}" cy="42" r="104">` +
      `<stop offset="0" stop-color="#FFFFFF" stop-opacity="${lift.toFixed(3)}"/>` +
      `<stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>`;
    g += `<rect x="3" y="3" width="${S - 6}" height="${S - 6}" fill="url(#glow)"/>`;
    const period = 2.4;
    const ph = (t % period) / period;
    const sx = -70 + ph * (S + 150);
    defs +=
      `<linearGradient id="shm" x1="0" y1="0" x2="1" y2="0">` +
      `<stop offset="0" stop-color="#FFFFFF" stop-opacity="0"/>` +
      `<stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0.22"/>` +
      `<stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>`;
    g += `<g transform="translate(${sx.toFixed(1)},0) skewX(-16)"><rect x="-30" y="-24" width="60" height="${S + 48}" fill="url(#shm)"/></g>`;
  }

  // needs you: sonar rings
  if (isNeed) {
    for (let i = 0; i < 2; i++) {
      const rp = ((t / 1.5) + i * 0.5) % 1;
      const r = 22 + rp * 62;
      const op = (1 - rp) * 0.55;
      g += `<circle cx="${CX}" cy="${CY}" r="${r.toFixed(1)}" fill="none" stroke="${accent}" stroke-width="3.5" opacity="${op.toFixed(3)}"/>`;
    }
  }

  // glossy sheen on the top
  defs +=
    `<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#FFFFFF" stop-opacity="${isIdle ? "0.05" : "0.20"}"/>` +
    `<stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>`;
  g += `<rect x="3" y="3" width="${S - 6}" height="${(S - 6) * 0.55}" fill="url(#gloss)"/>`;

  // done: a one-shot "pop" ring + flash the instant it lands
  if (isDone && age < 0.6) {
    const a = ease(Math.min(1, age / 0.6));
    const r = 18 + a * 62;
    g += `<circle cx="${CX}" cy="${CY}" r="${r.toFixed(1)}" fill="none" stroke="${PAL.done.accent}" stroke-width="${(4 * (1 - a)).toFixed(2)}" opacity="${((1 - a) * 0.75).toFixed(3)}"/>`;
    g += `<rect x="3" y="3" width="${S - 6}" height="${S - 6}" fill="#FFFFFF" opacity="${((1 - a) * 0.32).toFixed(3)}"/>`;
  }
  // needs: entry flash
  if (isNeed && age < 0.4) {
    const a = 1 - age / 0.4;
    g += `<rect x="3" y="3" width="${S - 6}" height="${S - 6}" fill="#FFFFFF" opacity="${(a * 0.55).toFixed(3)}"/>`;
  }

  // bottom scrim + caption
  defs +=
    `<linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#000000" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="#000000" stop-opacity="0.58"/></linearGradient>`;
  g += `<rect x="3" y="${S - 54}" width="${S - 6}" height="51" fill="url(#scrim)"/>`;

  // emoji — bigger, and gently breathing while working
  const eScale = isWork ? (1 + 0.05 * breathe).toFixed(3) : "1";
  g += `<g transform="translate(${CX} ${CY + 2}) scale(${eScale}) translate(${-CX} ${-(CY + 2)})">`;
  g += `<text x="${CX}" y="${CY + 2}" font-size="64" text-anchor="middle" dominant-baseline="central" opacity="${disp.eOp.toFixed(3)}">${escapeXml(emoji)}</text>`;
  g += `</g>`;

  const cap = escapeXml(label.slice(0, 11));
  const capFill = disp.eOp < 0.7 ? "#8A8A96" : "#FFFFFF";
  g += `<text x="${CX}" y="${S - 18}" font-size="21" font-weight="600" font-family="-apple-system,Helvetica,Arial,sans-serif" fill="#000000" fill-opacity="0.45" text-anchor="middle">${cap}</text>`;
  g += `<text x="${CX}" y="${S - 19}" font-size="21" font-weight="600" font-family="-apple-system,Helvetica,Arial,sans-serif" fill="${capFill}" text-anchor="middle">${cap}</text>`;

  // elapsed timer, top-right — how long it's been working / waiting on you
  if (isWork || isNeed) {
    const secs = Math.max(0, age);
    let tx;
    if (isNeed) {
      const m = Math.floor(secs / 60);
      tx = m + ":" + String(Math.floor(secs % 60)).padStart(2, "0");
    } else {
      tx = secs < 60 ? Math.floor(secs) + "s" : secs < 3600 ? Math.floor(secs / 60) + "m" : Math.floor(secs / 3600) + "h";
    }
    g += `<text x="${S - 9}" y="25" font-size="16" font-weight="700" font-family="Menlo,monospace" fill="#000000" fill-opacity="0.5" text-anchor="end">${tx}</text>`;
    g += `<text x="${S - 10}" y="24" font-size="16" font-weight="700" font-family="Menlo,monospace" fill="#FFFFFF" fill-opacity="0.92" text-anchor="end">${tx}</text>`;
  }
  g += `</g>`;

  // rim light
  defs +=
    `<linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#FFFFFF" stop-opacity="0.18"/>` +
    `<stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>`;
  g += `<rect x="3.5" y="3.5" width="${S - 7}" height="${S - 7}" rx="${RAD - 1}" fill="none" stroke="url(#rim)" stroke-width="1.5"/>`;
  if (isNeed) {
    const ro = 0.4 + 0.55 * breathe;
    g += `<rect x="4" y="4" width="${S - 8}" height="${S - 8}" rx="${RAD - 1}" fill="none" stroke="${PAL.needs_me.c1}" stroke-width="3" opacity="${ro.toFixed(3)}"/>`;
  }

  g += flashRect; // deck-wide flash when any chat turns red

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><defs>${defs}</defs>${g}</svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

// ---------------------------------------------------------------------------
const shown = new Map(); // action id -> item currently on the key (or null)
const keyBind = new Map(); // action id -> chat sessionId this key OWNS (persisted)
const trans = new Map(); // action id -> { sig, since } for entry animations + decay age
const disp = new Map(); // action id -> { c1:[r,g,b], c2:[r,g,b], eOp } smoothed for cross-fade
const lastImg = new Map(); // action id -> last data-uri pushed (skip static redraws)
let flashStart = 0; // ms — when a chat last turned red (drives the deck-wide flash)

class AgentSlot extends SingletonAction {
  manifestId = "com.tknab.claudeagents.slot";

  onWillAppear(ev) {
    const sid = ev.payload?.settings?.sessionId;
    if (sid) keyBind.set(ev.action.id, sid);
    syncModel();
    paintFrame();
  }

  onWillDisappear(ev) {
    keyBind.delete(ev.action.id);
    lastImg.delete(ev.action.id);
    trans.delete(ev.action.id);
    disp.delete(ev.action.id);
  }

  onDidReceiveSettings(ev) {
    const sid = ev.payload?.settings?.sessionId;
    if (sid) keyBind.set(ev.action.id, sid);
    else keyBind.delete(ev.action.id);
    syncModel();
    paintFrame();
  }

  onKeyDown(ev) {
    const item = shown.get(ev.action.id);
    streamDeck.logger.info(`keyDown → ${item ? item.sessionId : "(no chat)"}`);
    focusAgent(item);
  }
}

const slot = new AgentSlot();

const byPosition = (a, b) => {
  const da = a.device?.id || "";
  const db = b.device?.id || "";
  if (da !== db) return da < db ? -1 : 1;
  const ra = a.coordinates?.row ?? 0;
  const rb = b.coordinates?.row ?? 0;
  if (ra !== rb) return ra - rb;
  return (a.coordinates?.column ?? 0) - (b.coordinates?.column ?? 0);
};

/** Decide which chat each key shows (bindings persist so drags stick). ~1 Hz. */
function syncModel() {
  const keys = [...slot.actions].sort(byPosition);
  const group = readGroup();

  if (!group) {
    const items = readAuto();
    shown.clear();
    keys.forEach((k, i) => shown.set(k.id, items[i] || null));
    return;
  }

  const statuses = readStatuses();
  const statusOf = (convId) => {
    const s = statuses.get(convToCli(convId));
    return s ? s.status : null;
  };
  const byId = new Map(group.map((c) => [c.sessionId, c]));

  const claimed = new Set();
  for (const k of keys) {
    const sid = keyBind.get(k.id);
    if (sid && byId.has(sid)) claimed.add(sid);
  }
  const unclaimed = group.map((c) => c.sessionId).filter((s) => !claimed.has(s));
  let u = 0;
  for (const k of keys) {
    const sid = keyBind.get(k.id);
    if (!sid || !byId.has(sid)) {
      const next = unclaimed[u++];
      if (next) {
        keyBind.set(k.id, next);
        k.setSettings({ sessionId: next }).catch(() => {});
      } else {
        keyBind.delete(k.id);
      }
    }
  }

  shown.clear();
  for (const k of keys) {
    const sid = keyBind.get(k.id);
    const c = sid ? byId.get(sid) : null;
    shown.set(k.id, c ? { sessionId: c.sessionId, emoji: c.emoji, label: c.label, status: statusOf(c.sessionId) } : null);
  }
}

/** Repaint at ~15 fps; color-smoothing gives cross-fades, static keys dedup out. */
function paintFrame() {
  const now = Date.now();
  const t = now / 1000;
  const flash = flashStart ? Math.max(0, 1 - (now - flashStart) / 650) : 0;
  for (const key of slot.actions) {
    const item = shown.get(key.id) || null;
    const status = item ? item.status || "idle" : "idle";
    const sig = (item ? status : "empty") + "|" + (item ? item.sessionId : "");

    let info = trans.get(key.id);
    if (!info || info.sig !== sig) {
      const prev = info ? info.sig.split("|")[0] : null;
      if (info && prev !== "needs_me" && status === "needs_me") flashStart = now; // fresh red → flash the deck
      info = { sig, since: now };
      trans.set(key.id, info);
    }
    const age = (now - info.since) / 1000;

    // smooth the orb color toward its target → automatic cross-fade on any change
    const target = targetLook(status);
    let d = disp.get(key.id);
    if (!d) {
      d = { c1: target.c1.slice(), c2: target.c2.slice(), eOp: target.eOp };
      disp.set(key.id, d);
    } else {
      const K = 0.16;
      d.c1 = lerp3(d.c1, target.c1, K);
      d.c2 = lerp3(d.c2, target.c2, K);
      d.eOp = lerp(d.eOp, target.eOp, K);
    }

    const img = keyImage(item, t, age, d, target.accent, flash);
    if (lastImg.get(key.id) === img) continue; // settled + static → already on the key
    lastImg.set(key.id, img);
    key.setImage(img).catch(() => {});
    key.setTitle("").catch(() => {});
  }
}

/** Press → try to jump to that exact chat (claude://code/needs-input?session=<id>
 * is the route the app itself builds with a specific session), then ALWAYS focus
 * Claude — the deep link silently no-ops for an unknown session, so focusing is
 * what guarantees a press does something. */
function focusAgent(item) {
  const OPEN = "/usr/bin/open"; // Stream Deck spawns us with a bare PATH — use the absolute path
  if (item && item.sessionId) {
    const sid = item.sessionId.startsWith("local_") ? item.sessionId : "local_" + item.sessionId;
    execFile(OPEN, [`claude://code/needs-input?session=${sid}&source=desktop_action`], (e) =>
      streamDeck.logger.info(`deep-link ${e ? "ERR " + e.message : "ok"}`),
    );
  }
  // Focus by bundle id (more reliable than the app name).
  execFile(OPEN, ["-b", "com.anthropic.claudefordesktop"], (e) =>
    streamDeck.logger.info(`focus ${e ? "ERR " + e.message : "ok"}`),
  );
}

streamDeck.actions.registerAction(slot);
streamDeck.connect();
syncModel();
setInterval(syncModel, SYNC_MS);
setInterval(paintFrame, FRAME_MS);
