// swarm-board: board tools for the `swarm` skill (swarm, post_message, read_board, swarm_wait).
// Pure V2 plugin (same shape as @dietrichgebert/ponytail): no external deps.
// Workers are real OpenCode sessions; the board is an append-log woken by @mentions.
// Tier 1: 15 s live-state reconcile, [done]/[blocked]/[stall] markers, built-in
//   stall monitor, and auto-heal for tool calls printed as text.
// Tier 2: channels (#main + area channels) and a static local board UI.
// shortcut: one board per coordinator session; no fork/workspace/model-switch
//   semantics yet, no `n`/`tasks` batched add, no narrator. Add them when the
//   swarm actually needs them.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const FILE = path.join(os.homedir(), ".local", "share", "opencode", "swarm-board.json");
const UI_DIR = path.join(os.homedir(), ".local", "share", "opencode", "swarm-board");
const WAIT_TIMEOUT_MS = 60_000;
const STALL_MS = 180_000;   // board quiet this long with live members => monitor [stall]
const TICK_MS = 15_000;     // reconcile live session state + heal pseudo tool calls
const HEAL_CAP = 2;         // max auto-heal prompts per worker session
const GROUP_CAP = 8;        // max workers one add{n|tasks} call will spawn
const CHANNEL_RE = /^[a-z0-9][a-z0-9-]*$/;

let db = { swarms: {}, memberIndex: {} };
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { /* fresh board */ }
db.swarms ??= {};
db.memberIndex ??= {};
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch {} };

const waiters = []; // { coordID, sessionID, names, resolve }

function boardFor(sessionID) {
  if (db.memberIndex[sessionID]) {
    const { coordID, name } = db.memberIndex[sessionID];
    if (db.swarms[coordID]) return { board: db.swarms[coordID], coordID, who: name };
  }
  if (db.swarms[sessionID]) return { board: db.swarms[sessionID], coordID: sessionID, who: "coordinator" };
  return null;
}

function mentionedNames(text) {
  const set = new Set();
  for (const m of String(text ?? "").matchAll(/@([a-z0-9][a-z0-9-]*)/gi)) set.add(m[1].toLowerCase());
  return set;
}

// @#channel calls the whole channel; plain @name is parsed separately above.
function mentionedChannels(text) {
  const set = new Set();
  for (const m of String(text ?? "").matchAll(/@#([a-z0-9][a-z0-9-]*)/gi)) set.add(m[1].toLowerCase());
  return set;
}

// add{n:k} / add{tasks:[…]} spawn a group: <base>-1..<base>-k, one slice each.
function expandAddTargets({ name, n, tasks }) {
  const base = String(name ?? "").toLowerCase();
  if (n != null && tasks != null) throw new Error("pass either n or tasks, not both");
  if (tasks != null) {
    if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks must be a non-empty array of strings");
    if (tasks.some((s) => typeof s !== "string" || !s.trim())) throw new Error("every task must be a non-empty string");
    if (tasks.length > GROUP_CAP) throw new Error(`tasks is capped at ${GROUP_CAP} workers`);
    return tasks.map((slice, i) => ({ name: `${base}-${i + 1}`, slice: String(slice).trim() }));
  }
  if (n != null) {
    const k = Number(n);
    if (!Number.isInteger(k) || k < 1) throw new Error("n must be an integer >= 1");
    if (k > GROUP_CAP) throw new Error(`n is capped at ${GROUP_CAP} workers`);
    return Array.from({ length: k }, (_, i) => ({ name: `${base}-${i + 1}`, slice: "" }));
  }
  return [{ name: base, slice: "" }];
}

// One @token (or kill name) hits the member itself or every copy of its group.
function groupTargets(board, token) {
  const t = String(token ?? "").toLowerCase();
  const members = board?.members ?? {};
  return Object.keys(members).filter((n) => n === t || members[n].group === t);
}

function mentionHit(board, names, who) {
  if (names.has(who)) return true;
  const g = board?.members?.[who]?.group;
  return Boolean(g && names.has(g));
}

function channelOf(p) { return p.channel ?? "main"; }

function channelsOf(board, who) {
  const subs = board.members?.[who]?.channels;
  return ["main", ...(Array.isArray(subs) ? subs : [])];
}

function isPrivileged(who) {
  return who === "coordinator" || /^monitor(-\d+)?$/.test(String(who ?? ""));
}

// Everyone is in main; members also see the channels they joined. Coordinator
// and a worker named monitor see every channel.
function canSee(board, who, channel) {
  return channel === "main" || isPrivileged(who) || channelsOf(board, who).includes(channel);
}

function visiblePosts(board, who) {
  return (board.posts ?? []).filter((p) => canSee(board, who, channelOf(p)));
}

function defaultChannel(board, who) {
  if (isPrivileged(who)) return "main";
  const subs = board.members?.[who]?.channels ?? [];
  return subs.find((c) => board.channels?.[c] && !board.channels[c].archived) ?? "main";
}

// One post, one waiter: named mentions cross channels, @all wakes everyone,
// @#x wakes subscribers, mentions_only:false wakes for the waiter's channels.
function wakeHit(board, w, p) {
  if (p.from === w.who) return false;
  if (w.who === "coordinator") return true;
  const names = mentionedNames(p.text);
  if (names.has("all") || mentionHit(board, names, w.who)) return true;
  for (const c of mentionedChannels(p.text)) {
    const rec = board.channels?.[c];
    if (rec && !rec.archived && w.channels.includes(c)) return true;
  }
  return w.mentionsOnly === false && w.channels.includes(channelOf(p));
}

function mayMove(board, actor, target) {
  if (!board.members?.[target]) return false;
  return actor === "coordinator" || actor === target || board.members[target].addedBy === actor;
}

function channelForPost(board, who, requested) {
  const ch = String(requested ?? defaultChannel(board, who)).toLowerCase();
  if (ch === "main") return ch;
  if (!CHANNEL_RE.test(ch)) throw new Error(`bad channel '${ch}'; use [a-z0-9-]`);
  const rec = board.channels?.[ch];
  if (!rec) throw new Error(`no #${ch} channel; create it first`);
  if (rec.archived) throw new Error(`#${ch} is archived; post in main or another channel`);
  return ch;
}

function markerOf(text) {
  const m = /\[(done|blocked|stall)\]/i.exec(String(text ?? ""));
  return m ? m[1].toLowerCase() : null;
}

// The local-model failure we hit live: a tool call printed as literal XML text.
function looksLikePseudoToolCall(text) {
  return /<\s*\/?\s*tool_call\b|<\s*function\s*=|<\s*parameter\s*=/i.test(String(text ?? ""));
}

function idleNow(s) {
  const t = s?.time ?? s?.data?.time ?? {};
  return Boolean(t.idle && t.busy && t.idle >= t.busy);
}

function deliver(coordID, post) {
  const board = db.swarms[coordID];
  if (!board) return;
  const mentions = mentionedNames(post.text);
  const chans = mentionedChannels(post.text);
  const promptIDs = new Set();
  const prompt = (sid) => sid && promptIDs.add(sid);
  if (mentions.has("all") && post.from !== "coordinator") prompt(coordID);
  for (const [name, m] of Object.entries(board.members ?? {})) {
    if (m.status === "killed" || name === post.from) continue;
    const calledChannel = [...chans].some((c) => {
      const rec = board.channels?.[c];
      return rec && !rec.archived && (m.channels ?? []).includes(c);
    });
    if (mentionHit(board, mentions, name) || mentions.has("all") || calledChannel) prompt(m.sessionID);
  }
  if (post.from !== "coordinator") {
    if (mentions.has("coordinator")) prompt(coordID);
    if ([...chans].some((c) => board.channels?.[c] && !board.channels[c].archived)) prompt(coordID);
  }
  // Parked waiters resolve for their own view; one resolved waiter means the
  // session gets the post, so do not also send it a prompt.
  const resolved = new Set();
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    if (w.coordID !== coordID || !wakeHit(board, w, post)) continue;
    waiters.splice(i, 1)[0].resolve(post);
    resolved.add(w.sessionID);
  }
  for (const sid of promptIDs) {
    if (resolved.has(sid)) continue;
    const member = Object.values(board.members ?? {}).find((m) => m.sessionID === sid);
    if (member) { member.status = "working"; member.marker = null; }
    ctx.session.prompt({ sessionID: sid, text:
      `[swarm '${board.title}' #${channelOf(post)}, head #${board.seq}] ${post.text}\n` +
      `Act on it if it is for you; reply on the board via post_message to '@${post.from} ...' ` +
      `(or '@coordinator' when done), then end your turn.` }).catch((e) => {
      if (member) member.status = "stopped: " + String(e?.message ?? e).slice(0, 120);
      save();
    });
  }
  save();
  writeUi(coordID);
}

function post(coordID, from, text, requestedChannel) {
  const board = db.swarms[coordID];
  const channel = channelForPost(board, from, requestedChannel);
  if (mentionedChannels(text).has("main"))
    throw new Error("@#main is refused; use @all for everyone");
  board.seq += 1;
  const p = { seq: board.seq, from, channel, text, at: new Date().toISOString() };
  board.posts.push(p);
  board.posts = board.posts.slice(-500); // shortcut: cap history at 500; prune to file when it hurts
  const marker = markerOf(text);
  const member = from !== "coordinator" && from !== "monitor" ? board.members?.[from] : null;
  if (member && marker) { member.marker = marker; member.markerAt = p.at; }
  if (from !== "monitor") board.stalls = 0; // a human/agent reply restarts the stall window
  save();
  writeUi(coordID);
  deliver(coordID, p);
  return p;
}

// Reconcile one member with its live session. Marker labels survive; stale
// "working" becomes "waiting (idle)"; an idle session that printed a tool call
// as text gets one correction prompt per idle transition (HEAL_CAP overall).
async function reconcileMember(m) {
  if (!ctx || m.status === "killed" || typeof ctx.session?.get !== "function") return;
  let s;
  try { s = await ctx.session.get({ sessionID: m.sessionID }); } catch { return; }
  const outcome = s?.outcome ?? s?.data?.outcome;
  if (outcome && outcome !== "succeeded") {
    m.status = `stopped: ${outcome}`;
    save();
    return;
  }
  if (!idleNow(s)) {
    m.status = "working";
    save();
    return;
  }
  m.status = "waiting (idle)";
  save();
  if (m.marker) return; // [done]/[blocked]/[stall] already answers "why idle"
  const idle = (s.time ?? s.data.time).idle;
  if ((m.heals ?? 0) >= HEAL_CAP) {
    if (m.healMsgID) { m.status = "needs help (heal cap)"; save(); }
    return;
  }
  if (m.idleChecked === idle) return;
  m.idleChecked = idle;
  await healMember(m);
}

async function healMember(m) {
  if (typeof ctx.session?.context !== "function") return;
  let msgs;
  try { msgs = await ctx.session.context({ sessionID: m.sessionID }); } catch { return; }
  if (!Array.isArray(msgs) || msgs.at(-1)?.type !== "idle") return;
  const last = [...msgs].reverse().find((x) => x.type === "assistant");
  if (!last || m.healMsgID === last.id) return;
  const text = (last.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (!looksLikePseudoToolCall(text)) return;
  m.healMsgID = last.id;
  m.heals = (m.heals ?? 0) + 1;
  m.status = "working";
  save();
  await ctx.session.prompt({ sessionID: m.sessionID, text:
    `[swarm monitor] Auto-heal ${m.heals}/${HEAL_CAP}: your last message printed a tool call as text ` +
    `instead of invoking the tool. Do not write XML. Invoke your normal tool interface now ` +
    `(in Code Mode: execute with tools.post_message), then end your turn.` }).catch((e) => {
      m.status = "stopped: " + String(e?.message ?? e).slice(0, 120);
      save();
    });
}

async function stallCheck(coordID) {
  const b = db.swarms[coordID];
  if (!b) return;
  // A worker-based monitor (swarm_monitor skill) replaces the built-in one.
  if (Object.entries(b.members).some(([n, m]) => /^monitor(-\d+)?$/.test(n) && m.status !== "killed")) return;
  const last = b.posts.at(-1);
  if (!last || last.from === "monitor") return;
  if (Date.now() - Date.parse(last.at) < STALL_MS) return;
  const pending = Object.entries(b.members)
    .filter(([, m]) => m.status !== "killed" && !String(m.status).startsWith("stopped")
      && !["done", "blocked"].includes(m.marker))
    .map(([n]) => n);
  if (!pending.length) return;
  if ((b.stalls ?? 0) >= 3) return; // shortcut: at most 3 auto-stalls per quiet period
  if (!waiters.some((w) => w.coordID === coordID)) {
    try { if (!idleNow(await ctx.session.get({ sessionID: coordID }))) return; } catch {}
  }
  b.stalls = (b.stalls ?? 0) + 1;
  save();
  const quiet = Date.now() - Date.parse(last.at);
  const howLong = quiet >= 60_000 ? `${Math.round(quiet / 60_000)}m` : `${Math.round(quiet / 1000)}s`;
  post(coordID, "monitor", `@coordinator [stall] quiet ${howLong} since #${last.seq} (${last.from}); ` +
    `silent: ${pending.join(", ")}. Hand out the next step or unblock.`);
}

function boardSnapshot(coordID, b) {
  const members = Object.entries(b.members ?? {}).map(([name, m]) => ({
    name,
    status: m.status ?? "unknown",
    marker: m.marker ?? null,
    heals: m.heals ?? 0,
    sessionID: m.sessionID,
    channels: ["main", ...(Array.isArray(m.channels) ? m.channels : [])],
    addedBy: m.addedBy ?? null,
  }));
  const alive = members.filter((m) => m.status !== "killed");
  const subs = (name) => alive.filter((m) => m.channels.includes(name)).length;
  const channels = [
    { name: "main", topic: "cross-area traffic", creator: "everyone", archived: false, subs: alive.length },
    ...Object.entries(b.channels ?? {}).map(([name, c]) => ({
      name, topic: c.topic ?? "", creator: c.creator ?? "", archived: !!c.archived, subs: subs(name),
    })),
  ];
  return {
    coordID,
    title: b.title ?? "the swarm",
    seq: b.seq ?? 0,
    posts: (b.posts ?? []).map((p) => ({ ...p, channel: channelOf(p) })),
    members,
    channels,
  };
}

function uiFile(coordID) {
  return path.join(UI_DIR, String(coordID).replace(/[^a-z0-9_-]/gi, "_") + ".html");
}

// One self-contained file: no server, no network, data only through textContent.
function renderBoardHtml(coordID, b) {
  const data = JSON.stringify(boardSnapshot(coordID, b)).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>swarm board</title>
<style>
*{box-sizing:border-box}
:root{--bg:#f5f7fb;--panel:#fff;--ink:#0f172a;--muted:#64748b;--line:#dbe3ee;--accent:#2563eb;--soft:#eef2ff}
@media(prefers-color-scheme:dark){:root{--bg:#0b1220;--panel:#111c31;--ink:#e2e8f0;--muted:#94a3b8;--line:#24324a;--accent:#60a5fa;--soft:#172554}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 20px 0}
.head{display:flex;gap:12px;align-items:baseline;justify-content:space-between;max-width:1000px;margin:0 auto;flex-wrap:wrap}
h1{font-size:18px;margin:0}
.muted{color:var(--muted);font-size:12px}
nav{max-width:1000px;margin:10px auto 0;display:flex;gap:4px}
nav a{padding:8px 14px;color:var(--muted);text-decoration:none;border-radius:8px 8px 0 0;font-weight:600}
nav a.on{color:var(--accent);background:var(--panel);border:1px solid var(--line);border-bottom-color:var(--panel);margin-bottom:-1px}
main{max-width:1000px;margin:0 auto;padding:20px}
.controls{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px}
label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted);font-weight:600}
select,input{font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);min-width:180px}
input[type=search]{min-width:240px}
.post{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:10px;padding:10px 14px;margin-bottom:10px}
.phead{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px}
.seq{font-weight:700;color:var(--accent)}
.from{font-weight:700}
.time{margin-left:auto}
.body{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:6px}
.mention{color:var(--accent)}
.chip{display:inline-block;padding:1px 7px;border-radius:999px;background:var(--soft);font-size:11px;font-weight:600;color:var(--accent)}
.chip.done{background:#dcfce7;color:#166534}
.chip.blocked{background:#fee2e2;color:#991b1b}
.chip.stall{background:#fef3c7;color:#92400e}
.empty{padding:40px;text-align:center;color:var(--muted)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top;font-size:13px}
th:first-child,td:first-child{white-space:nowrap}
td:last-child{color:var(--muted);font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;word-break:break-all}
th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
tr:last-child td{border-bottom:0}
.st{font-weight:600}
.st-working{color:#b45309}.st-waiting{color:var(--muted)}.st-killed{color:#64748b;text-decoration:line-through}.st-stopped{color:#b91c1c}.st-needs{color:#c2410c}
tr.killed{opacity:.55}
@media(max-width:640px){th:last-child,td:last-child{display:none}}
#graph{width:100%;height:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}
svg text{font:11px ui-sans-serif,system-ui,sans-serif;fill:var(--ink);paint-order:stroke;stroke:var(--panel);stroke-width:3px;stroke-linejoin:round}
svg .edge{stroke:var(--muted);stroke-opacity:.35;fill:none}
svg .edge.channel{stroke-dasharray:5 4;stroke:var(--accent);stroke-opacity:.55}
svg .node circle{stroke:var(--panel);stroke-width:2px}
svg .node.coordinator circle{fill:#2563eb}
svg .node.agent circle{fill:#64748b}
svg .node.agent.killed circle{fill:#94a3b8}
svg .node.channel circle{fill:#0f766e}
svg .node.unknown circle{fill:#a855f7}
svg .node text{font-weight:600}
footer{max-width:1000px;margin:0 auto;padding:0 20px 30px}
</style>
</head>
<body>
<header>
  <div class="head"><h1 id="title">swarm board</h1><div id="meta" class="muted"></div></div>
  <nav id="tabs">
    <a href="#board" data-tab="board">Board</a>
    <a href="#members" data-tab="members">Members</a>
    <a href="#graph" data-tab="graph">Graph</a>
  </nav>
</header>
<main>
  <section id="tab-board" data-view="board">
    <div class="controls">
      <label>Channel <select id="f-chan"><option value="*">all</option></select></label>
      <label>Text <input id="f-text" type="search" placeholder="filter posts"></label>
      <span id="count" class="muted"></span>
    </div>
    <div id="posts"></div>
  </section>
  <section id="tab-members" data-view="members" hidden>
    <div id="members"></div>
  </section>
  <section id="tab-graph" data-view="graph" hidden>
    <p class="muted">Mentions in the last 200 posts. Solid lines are @names, dashed lines are @#channel calls.</p>
    <svg id="graph" viewBox="0 0 760 620" role="img" aria-label="mention graph"></svg>
  </section>
</main>
<footer class="muted">static file · auto-refresh every 3 s · <span id="path"></span></footer>
<script id="board-data" type="application/json">${data}</script>
<script>
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('board-data').textContent);
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function pill(text, cls) { return el('span', 'chip ' + (cls || ''), text); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  var store = (function () {
    try {
      var s = window.sessionStorage;
      s.setItem('swarm.probe', '1');
      s.removeItem('swarm.probe');
      return s;
    } catch (e) {
      return { getItem: function () { return null; }, setItem: function () {} };
    }
  })();

  document.title = 'swarm: ' + data.title;
  $('title').textContent = data.title;
  $('meta').textContent = 'head #' + data.seq + ' · ' + data.members.length + ' member(s) · ' +
    data.channels.length + ' channel(s) · coordinator ' + data.coordID;
  $('path').textContent = data.coordID;

  var select = $('f-chan'), search = $('f-text');
  for (var i = 0; i < data.channels.length; i++) {
    var c = data.channels[i];
    var o = el('option', null, '#' + c.name + (c.archived ? ' (archived)' : ''));
    o.value = c.name;
    select.appendChild(o);
  }
  var savedChan = store.getItem('swarm.chan');
  if (savedChan) {
    for (var j = 0; j < select.options.length; j++) {
      if (select.options[j].value === savedChan) select.value = savedChan;
    }
  }
  var savedText = store.getItem('swarm.text');
  if (savedText) search.value = savedText;

  function appendMentions(parent, text) {
    var re = /(@#?[a-z0-9][a-z0-9-]*)/gi, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      parent.appendChild(el('strong', 'mention', m[1]));
      last = m.index + m[1].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderPosts() {
    var chan = select.value, q = search.value.trim().toLowerCase();
    var list = data.posts.filter(function (p) {
      if (chan !== '*' && p.channel !== chan) return false;
      if (!q) return true;
      return p.text.toLowerCase().indexOf(q) >= 0 || p.from.toLowerCase().indexOf(q) >= 0;
    });
    list.sort(function (a, b) { return b.seq - a.seq; });
    var box = $('posts');
    clear(box);
    $('count').textContent = list.length + ' / ' + data.posts.length + ' posts';
    if (!list.length) { box.appendChild(el('p', 'empty', 'no posts match')); return; }
    for (var i = 0; i < list.length; i++) {
      var p = list[i], art = el('article', 'post'), head = el('div', 'phead');
      head.appendChild(el('span', 'seq', '#' + p.seq));
      head.appendChild(el('span', 'from', p.from));
      head.appendChild(pill('#' + p.channel, 'chan'));
      head.appendChild(el('span', 'time muted', p.at ? new Date(p.at).toLocaleString() : ''));
      if (/\[done\]/i.test(p.text)) head.appendChild(pill('done', 'done'));
      if (/\[blocked\]/i.test(p.text)) head.appendChild(pill('blocked', 'blocked'));
      var body = el('div', 'body');
      appendMentions(body, p.text);
      art.appendChild(head);
      art.appendChild(body);
      box.appendChild(art);
    }
  }

  function statusClass(status) {
    var word = String(status || '').split(' ')[0].replace(/[^a-z]/g, '');
    return 'st st-' + word;
  }

  function memberRow(name, status, chans, sid, dead, m) {
    var tr = el('tr', dead ? 'killed' : '');
    tr.appendChild(el('td', null, '@' + name));
    var td = el('td');
    td.appendChild(el('span', statusClass(status), status));
    if (m && m.marker) {
      td.appendChild(document.createTextNode(' '));
      td.appendChild(pill(m.marker, m.marker));
    }
    if (m && m.heals) {
      td.appendChild(document.createTextNode(' '));
      td.appendChild(pill('heals ' + m.heals + '/2', ''));
    }
    tr.appendChild(td);
    var tc = el('td');
    for (var i = 0; i < chans.length; i++) {
      tc.appendChild(pill('#' + chans[i], 'chan'));
      tc.appendChild(document.createTextNode(' '));
    }
    tr.appendChild(tc);
    tr.appendChild(el('td', 'muted', sid));
    return tr;
  }

  function renderMembers() {
    var box = $('members');
    clear(box);
    var table = el('table'), thead = el('thead'), hr = el('tr');
    ['Member', 'Status', 'Channels', 'Session'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tb = el('tbody');
    tb.appendChild(memberRow('coordinator', 'coordinator', data.channels.map(function (c) { return c.name; }), data.coordID, false, null));
    var ms = data.members.slice().sort(function (a, b) {
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    ms.forEach(function (m) {
      tb.appendChild(memberRow(m.name, m.status, m.channels, m.sessionID, m.status === 'killed', m));
    });
    table.appendChild(tb);
    box.appendChild(table);
  }

  function renderGraph() {
    var svg = $('graph');
    clear(svg);
    var W = 760, H = 620, cx = W / 2, cy = H / 2;
    var nodes = {};
    function add(id, label, kind, status) {
      if (!nodes[id]) nodes[id] = { id: id, label: label, kind: kind, status: status || '' };
    }
    add('coordinator', 'coordinator', 'coordinator', '');
    data.members.forEach(function (m) { add(m.name, '@' + m.name, 'agent', m.status); });
    data.channels.forEach(function (c) {
      if (c.name !== 'main') add('#' + c.name, '#' + c.name, 'channel', c.archived ? 'archived' : '');
    });
    var edges = {};
    data.posts.slice(-200).forEach(function (p) {
      var text = p.text || '';
      add(p.from, p.from, 'agent', '');
      (text.match(/@[a-z0-9][a-z0-9-]*/gi) || []).forEach(function (raw) {
        var n = raw.slice(1).toLowerCase();
        if (n === 'all' || n === p.from) return;
        if (!nodes[n]) add(n, n, 'agent', 'unknown');
        var k = p.from + '>' + n;
        if (!edges[k]) edges[k] = { from: p.from, to: n, kind: 'mention', count: 0 };
        edges[k].count++;
      });
      (text.match(/@#[a-z0-9][a-z0-9-]*/gi) || []).forEach(function (raw) {
        var c = raw.slice(2).toLowerCase();
        if (c === 'main') return;
        if (!nodes['#' + c]) add('#' + c, '#' + c, 'channel', 'unknown');
        var k = p.from + '>#' + c;
        if (!edges[k]) edges[k] = { from: p.from, to: '#' + c, kind: 'channel', count: 0 };
        edges[k].count++;
      });
    });
    var agents = [], chans = [];
    Object.keys(nodes).forEach(function (id) {
      if (nodes[id].kind === 'channel') chans.push(id);
      else if (id !== 'coordinator') agents.push(id);
    });
    var pos = { coordinator: { x: cx, y: cy } };
    agents.forEach(function (id, i) {
      var a = -Math.PI / 2 + i * 2 * Math.PI / Math.max(1, agents.length);
      pos[id] = { x: cx + 220 * Math.cos(a), y: cy + 220 * Math.sin(a) };
    });
    chans.forEach(function (id, i) {
      var a = -Math.PI / 2 + Math.PI / Math.max(1, chans.length) + i * 2 * Math.PI / Math.max(1, chans.length);
      pos[id] = { x: cx + 125 * Math.cos(a), y: cy + 125 * Math.sin(a) };
    });
    var ns = 'http://www.w3.org/2000/svg';
    function svgEl(tag, attrs) {
      var e = document.createElementNS(ns, tag);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    }
    Object.keys(edges).forEach(function (k) {
      var e = edges[k], a = pos[e.from], b = pos[e.to];
      if (!a || !b) return;
      var line = svgEl('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        class: 'edge ' + (e.kind === 'channel' ? 'channel' : ''),
        'stroke-width': String(Math.min(1 + e.count * 0.5, 4)),
      });
      var title = document.createElementNS(ns, 'title');
      title.textContent = e.from + ' → ' + e.to + ' (' + e.count + ' post' + (e.count === 1 ? '' : 's') + ')';
      line.appendChild(title);
      svg.appendChild(line);
    });
    Object.keys(nodes).forEach(function (id) {
      var n = nodes[id], p = pos[id];
      if (!p) return;
      var g = svgEl('g', {
        class: 'node ' + n.kind + (n.status === 'killed' ? ' killed' : '') +
          (n.status === 'unknown' ? ' unknown' : ''),
      });
      var r = n.kind === 'coordinator' ? 24 : n.kind === 'channel' ? 14 : 17;
      var circle = svgEl('circle', { cx: p.x, cy: p.y, r: r });
      var title = document.createElementNS(ns, 'title');
      title.textContent = n.label + (n.status ? ' — ' + n.status : '');
      circle.appendChild(title);
      g.appendChild(circle);
      var t = document.createElementNS(ns, 'text', {
        x: p.x, y: p.y + r + 15, 'text-anchor': 'middle',
      });
      t.textContent = n.label;
      g.appendChild(t);
      svg.appendChild(g);
    });
  }

  function tab() {
    var h = (location.hash || '#board').slice(1);
    return h === 'members' || h === 'graph' ? h : 'board';
  }
  function showTab() {
    var t = tab();
    var views = document.querySelectorAll('[data-view]');
    for (var i = 0; i < views.length; i++) views[i].hidden = views[i].getAttribute('data-view') !== t;
    var links = document.querySelectorAll('#tabs a');
    for (var j = 0; j < links.length; j++) links[j].classList.toggle('on', links[j].getAttribute('data-tab') === t);
  }
  window.addEventListener('hashchange', showTab);
  showTab();
  renderPosts();
  renderMembers();
  renderGraph();
  var y = parseInt(store.getItem('swarm.scroll') || '0', 10);
  if (y > 0 && tab() === 'board') window.scrollTo(0, y);
  window.addEventListener('scroll', function () {
    store.setItem('swarm.scroll', String(window.scrollY || 0));
  }, { passive: true });
  select.addEventListener('change', function () {
    store.setItem('swarm.chan', select.value);
    renderPosts();
  });
  search.addEventListener('input', function () {
    store.setItem('swarm.text', search.value);
    renderPosts();
  });
  function arm() {
    setTimeout(function () {
      var a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) { arm(); return; }
      store.setItem('swarm.scroll', String(window.scrollY || 0));
      location.reload();
    }, 3000);
  }
  arm();
})();
</script>
</body>
</html>`;
}

const uiCache = new Map();
function writeUi(coordID) {
  const b = db.swarms[coordID];
  if (!b) return null;
  const file = uiFile(coordID);
  try {
    const html = renderBoardHtml(coordID, b);
    if (uiCache.get(coordID) !== html || !fs.existsSync(file)) {
      fs.mkdirSync(UI_DIR, { recursive: true });
      fs.writeFileSync(file, html);
      uiCache.set(coordID, html);
    }
    return file;
  } catch { return null; }
}

let ticking = false;
async function tick() {
  if (!ctx || ticking) return;
  ticking = true;
  try {
    for (const [coordID, b] of Object.entries(db.swarms)) {
      for (const [name, m] of Object.entries(b.members ?? {})) {
        try { await reconcileMember(m); } catch {}
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w.coordID !== coordID) continue;
        const dead = Object.values(b.members ?? {}).some((m) => m.sessionID === w.sessionID && m.status === "killed");
        if (dead) waiters.splice(i, 1)[0].resolve({ content: "(session killed while waiting)" });
      }
      try { await stallCheck(coordID); } catch {}
      writeUi(coordID);
    }
  } finally { ticking = false; }
}

function onEvent(ev) {
  if (!/session\.(step\.(ended|failed)|idle|error)/i.test(String(ev?.type ?? ""))) return;
  const sid = ev?.data?.sessionID;
  const idx = sid && db.memberIndex[sid];
  const m = idx && db.swarms[idx.coordID]?.members?.[idx.name];
  if (m) reconcileMember(m).then(() => writeUi(idx.coordID)).catch(() => {});
}

function startEngine() {
  const g = globalThis;
  g.__swarmBoardOnEvent = onEvent;
  if (g.__swarmBoardEventLoop !== true && typeof ctx.event?.subscribe === "function") {
    g.__swarmBoardEventLoop = true;
    (async () => {
      try {
        for await (const ev of ctx.event.subscribe()) {
          try { g.__swarmBoardOnEvent?.(ev); } catch {}
        }
      } catch { /* stream closed */ } finally { g.__swarmBoardEventLoop = false; }
    })();
  }
  if (g.__swarmBoardTicker) clearInterval(g.__swarmBoardTicker);
  g.__swarmBoardTicker = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  g.__swarmBoardTicker.unref?.();
}

const WORKER_RULES = (name, title, seq, chans, adder, group) => {
  const subs = chans.length ? chans.map((c) => `#${c}`).join(", ") : "(none)";
  const home = chans[0] ?? "main";
  const groupRule = group
    ? `\n- You are one of ${group.size} copies in the group @${group.base}: a post to @${group.base} is aimed at every copy, so act and reply only when the post names @${name} or matches the slice in your brief.`
    : "";
  return `You are '@${name}', a worker in swarm '${title}'. The brief is at the end of this message; the board head is #${seq}.
Channels: everyone is in #main; you are also subscribed to ${subs}. Post in #${home} by default, and in #main only for traffic the whole swarm needs.
Rules:
- Do the work with normal tools. The board is your only channel to other agents: call post_message to speak; start every post with the recipient '@<name> <text>' and @mention only whoever acts next.
- When fully done: post '@${adder} [done] <summary + evidence>'. When blocked: '@${adder} [blocked] <reason>'.
- A later message that names you, or calls your channel (@#name), is board traffic: act on it, then answer the poster via post_message, then end your turn. Ending your turn parks you; a post naming you wakes you.${groupRule}
- Do not kill members, do not rename the swarm, do not spawn your own swarm unless your brief says so.

Brief:`;
};

let ctx;

export default {
  id: "swarm-board",
  async setup(context) {
    ctx = context;
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "swarm",
        description:
          "Run the swarm board. action=add {name,brief,channels[]}: spawn worker @name on its own session. " +
          "action=add {name,brief,n} or {name,brief,tasks[]} (max 8): spawn @name-1…@name-k as one group; " +
          "@name and kill{name:'name'} reach the whole group, @name-1 one copy. " +
          "action=status: roster, channels, and the local board UI URL. action=kill {name}: stop a worker or a whole group. " +
          "action=title {title}: name the swarm. " +
          "action=channel {op:create|subscribe|unsubscribe|list|archive, channel, topic, name}: manage channels. " +
          "action=models: list runnable models. action=model {name,model 'provider/id'}: switch a member's or group's model.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["add", "status", "kill", "title", "channel", "models", "model"] },
            name: { type: "string" },
            brief: { type: "string" },
            title: { type: "string" },
            channels: { type: "array", items: { type: "string" } },
            n: { type: "integer", minimum: 1, maximum: 8, description: "spawn name-1…name-n copies" },
            tasks: { type: "array", items: { type: "string" }, maxItems: 8, description: "one slice per worker, shared instructions in brief" },
            op: { type: "string", enum: ["create", "subscribe", "unsubscribe", "list", "archive"] },
            channel: { type: "string" },
            topic: { type: "string" },
            model: { type: "string", description: "providerID/modelID" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        async execute(args, tctx) {
          const sessionID = tctx.sessionID;
          if (args.action === "title" || args.action === "add") {
            let board = db.swarms[sessionID];
            if (!board) {
              board = db.swarms[sessionID] = { title: "the swarm", seq: 0, posts: [], members: {}, channels: {} };
              save();
            }
            board.channels ??= {};
            board.members ??= {};
            if (args.action === "title") {
              board.title = args.title || board.title;
              save();
              writeUi(sessionID);
              return { content: `swarm titled '${board.title}'` };
            }
            const h = boardFor(sessionID);
            const adder = h?.who ?? "coordinator";
            const name = String(args.name || "").toLowerCase();
            if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name === "all" || name === "coordinator")
              throw new Error("name must be lowercase [a-z0-9-] and not all/coordinator");
            const targets = expandAddTargets({ name, n: args.n, tasks: args.tasks });
            const taken = targets.map((t) => t.name).filter((n) => board.members[n]);
            if (taken.length)
              throw new Error(`@${taken.join(", @")} exists; killed names cannot be reused`);
            const inherited = adder !== "coordinator" ? board.members[adder]?.channels ?? [] : [];
            const wanted = args.channels ?? inherited;
            const channels = [...new Set((Array.isArray(wanted) ? wanted : [])
              .map((c) => String(c).toLowerCase()).filter((c) => c && c !== "main"))];
            for (const c of channels) {
              const rec = board.channels[c];
              if (!rec) throw new Error(`no #${c} channel; create it first`);
              if (rec.archived) throw new Error(`#${c} is archived`);
            }
            const home = channels.find((c) => board.channels[c] && !board.channels[c].archived) ?? "main";
            const group = args.n != null || args.tasks != null ? name : null;
            const added = [];
            let failed = null;
            for (const t of targets) {
              const brief = [args.brief, t.slice && `Your slice of this task: ${t.slice}`]
                .filter(Boolean).join(" ").trim();
              try {
                const created = await ctx.session.create({ title: `[swarm ${board.title}] @${t.name}` });
                const workerID = created?.id ?? created?.data?.id;
                if (!workerID) throw new Error("session.create returned no id: " + JSON.stringify(created)?.slice(0, 200));
                const p = post(sessionID, adder, `@${t.name} ${brief || "(no brief given — ask the coordinator)"}`, home);
                board.members[t.name] = {
                  sessionID: workerID, status: "working", channels,
                  addedBy: adder === "coordinator" ? null : adder,
                  ...(group ? { group } : {}),
                };
                db.memberIndex[workerID] = { coordID: sessionID, name: t.name };
                save();
                writeUi(sessionID);
                await ctx.session.prompt({ sessionID: workerID, text:
                  WORKER_RULES(t.name, board.title, p.seq, channels, adder,
                    group && { base: group, size: targets.length }) + " " + brief });
                added.push({ seq: p.seq, name: t.name, sessionID: workerID });
              } catch (e) {
                // A member whose first prompt never landed would sit at "working"
                // forever (its session has no outcome), so say so right away.
                if (board.members[t.name])
                  board.members[t.name].status = `stopped: first prompt failed: ${String(e?.message ?? e).slice(0, 120)}`;
                save();
                failed = `${String(e?.message ?? e).slice(0, 200)}`;
                break;
              }
            }
            const head = !added.length ? "nothing added"
              : group
                ? `group @${group} on #${home}: ${added.map((a) => `#${a.seq} @${a.name}`).join(", ")} · @${group} reaches every copy`
                : `#${added[0].seq} @${added[0].name} added on #${home} (session ${added[0].sessionID})`;
            return { content: failed
              ? `${head}\nfailed at @${targets[added.length].name}: ${failed} — what is listed above stays alive. ` +
                `Spawn the rest with add{name:"<free name>", brief:…}; a member shown as stopped gets its turn back when someone posts @name.`
              : head };
          }
          if (args.action === "channel") {
            const h = boardFor(sessionID);
            if (!h) throw new Error("no swarm for this session; swarm{action:'add'} or 'title' first");
            const b = h.board;
            b.channels ??= {};
            const who = h.who;
            const op = String(args.op ?? "").toLowerCase();
            const name = String(args.channel ?? "").toLowerCase();
            if (op === "list") {
              const alive = Object.entries(b.members ?? {}).filter(([, m]) => m.status !== "killed");
              const lines = [`#main — everyone (${alive.length})`];
              for (const [n, c] of Object.entries(b.channels)) {
                const subs = alive.filter(([, m]) => (m.channels ?? []).includes(n)).map(([x]) => x);
                lines.push(`#${n}${c.archived ? " (archived)" : ""} — ${c.topic || "(no topic)"} · ` +
                  `creator ${c.creator} · ${subs.length} subscriber(s)${subs.length ? `: ${subs.join(", ")}` : ""}`);
              }
              return { content: lines.join("\n") };
            }
            if (!CHANNEL_RE.test(name) || name === "main")
              throw new Error("channel must be lowercase [a-z0-9-] and not main");
            if (op === "create") {
              if (b.channels[name]) throw new Error(`#${name} exists`);
              b.channels[name] = { topic: String(args.topic ?? ""), creator: who, at: new Date().toISOString(), archived: false };
              save();
              writeUi(h.coordID);
              return { content: `#${name} created${args.topic ? ` — ${args.topic}` : ""}` };
            }
            const rec = b.channels[name];
            if (!rec) throw new Error(`no #${name} channel`);
            if (op === "archive") {
              if (who !== "coordinator" && rec.creator !== who)
                throw new Error("only the coordinator or the channel creator can archive");
              rec.archived = true;
              rec.archivedAt = new Date().toISOString();
              save();
              writeUi(h.coordID);
              return { content: `#${name} archived; history stays readable` };
            }
            if (op === "subscribe" || op === "unsubscribe") {
              const target = String(args.name ?? who).toLowerCase();
              if (!mayMove(b, who, target)) throw new Error(`@${target} cannot be moved by @${who}`);
              if (op === "subscribe" && rec.archived) throw new Error(`#${name} is archived`);
              const m = b.members[target];
              const subs = new Set(m.channels ?? []);
              if (op === "subscribe") subs.add(name); else subs.delete(name);
              m.channels = [...subs];
              save();
              writeUi(h.coordID);
              return { content: `@${target} ${op}d #${name}` };
            }
            throw new Error("op must be create, subscribe, unsubscribe, list, or archive");
          }
          if (args.action === "status") {
            const h = boardFor(sessionID);
            if (!h) throw new Error("no swarm for this session; swarm{action:'add'} or 'title' first");
            const b = h.board;
            await Promise.all(Object.entries(b.members ?? {}).map(([, m]) =>
              reconcileMember(m).catch(() => {})));
            const roster = Object.entries(b.members ?? {})
              .map(([n, m]) => {
                const subs = ["main", ...(m.channels ?? [])].map((c) => `#${c}`).join(" ");
                return `${n}: ${m.status}${m.marker ? ` [${m.marker}]` : ""}${m.heals ? ` [heals ${m.heals}/${HEAL_CAP}]` : ""} [${subs}] (${m.sessionID})`;
              })
              .join("\n") || "(no members)";
            const chans = ["#main", ...Object.entries(b.channels ?? {})
              .map(([n, c]) => `#${n}${c.archived ? " (archived)" : ""}`)].join(", ");
            const quiet = b.posts.at(-1) ? Math.round((Date.now() - Date.parse(b.posts.at(-1).at)) / 1000) : 0;
            const file = writeUi(h.coordID);
            const open = file ? pathToFileURL(file).href : "unavailable";
            return { content: `swarm '${b.title}' — head #${b.seq} (quiet ${quiet}s)\n` +
              `coordinator: ${h.coordID}\nchannels: ${chans}\n${roster}\nopen_board: ${open}` };
          }
          if (args.action === "kill") {
            const h = boardFor(sessionID);
            if (!h) throw new Error("no swarm");
            const names = groupTargets(h.board, args.name);
            if (!names.length) throw new Error(`no member @${args.name}`);
            for (const n of names) {
              const m = h.board.members[n];
              m.status = "killed";
              try { await ctx.session.interrupt?.({ sessionID: m.sessionID, resume: false }); } catch {}
            }
            save();
            writeUi(h.coordID);
            return { content: names.length === 1 ? `@${names[0]} killed`
              : `group @${args.name} killed: ${names.join(", ")}` };
          }
          if (args.action === "models") {
            try {
              const list = await ctx.model.list();
              const arr = list?.models ?? list?.data ?? list ?? [];
              return { content: arr.map((m) => `${m.providerID ?? m.provider?.id}/${m.id ?? m.modelID}`).join("\n") || "(none)" };
            } catch (e) { return { content: "models unavailable: " + e.message }; }
          }
          if (args.action === "model") {
            const h = boardFor(sessionID);
            if (!h) throw new Error("no swarm");
            const targets = !args.name || args.name === "coordinator" ? [h.coordID]
              : groupTargets(h.board, args.name).map((n) => h.board.members[n].sessionID);
            if (!targets.length) throw new Error(`no member @${args.name}`);
            const [providerID, ...rest] = String(args.model).split("/");
            try {
              for (const target of targets)
                await ctx.session.switchModel({ sessionID: target, model: { providerID, id: rest.join("/") } });
              return { content: `@${args.name ?? "coordinator"} switched to ${args.model}` };
            } catch (e) { return { content: "model switch unsupported/failed: " + e.message }; }
          }
        },
      });

      editor.add({
        name: "post_message",
        description: "Say something on the swarm board. Prefix with @name / @all / @coordinator to wake the addressee. " +
          "channel defaults to your work channel (#main for the coordinator).",
        input: {
          type: "object",
          properties: {
            text: { type: "string" },
            channel: { type: "string", description: "channel name; omit for your default channel" },
          },
          required: ["text"],
          additionalProperties: false,
        },
        async execute(args, tctx) {
          const h = boardFor(tctx.sessionID);
          if (!h) throw new Error("this session is not on a swarm board; the coordinator must call swarm{action:'add'} first");
          const p = post(h.coordID, h.who, args.text, args.channel);
          return { content: `#${p.seq} posted in #${p.channel}` };
        },
      });

      editor.add({
        name: "read_board",
        description: "Read swarm board posts newer than a sequence number. Without channel you see #main plus your channels; " +
          "channel:'name' reads one channel (archived history included); channel:'*' reads everything.",
        input: {
          type: "object",
          properties: {
            since: { type: "integer" },
            channel: { type: "string", description: "channel name or '*' for all" },
          },
          required: ["since"],
          additionalProperties: false,
        },
        async execute(args, tctx) {
          const h = boardFor(tctx.sessionID);
          if (!h) throw new Error("not on a swarm board");
          let list;
          if (args.channel === "*") list = h.board.posts;
          else if (args.channel) {
            const ch = String(args.channel).toLowerCase();
            if (ch !== "main" && !h.board.channels?.[ch]) throw new Error(`no #${ch} channel`);
            list = h.board.posts.filter((p) => channelOf(p) === ch);
          } else list = visiblePosts(h.board, h.who);
          const fresh = list.filter((p) => p.seq > args.since);
          return { content: fresh.length
            ? fresh.map((p) => `#${p.seq} [#${channelOf(p)}] ${p.from}: ${p.text}`).join("\n")
            : `(no posts after #${args.since}; head #${h.board.seq})` };
        },
      });

      editor.add({
        name: "swarm_wait",
        description: "Sleep at zero cost until the board moves (or 60s). Pass the highest seq you have seen as since. " +
          "mentions_only:false also wakes for posts in your channels, not just @mentions.",
        input: {
          type: "object",
          properties: {
            since: { type: "integer" },
            mentions_only: { type: "boolean", description: "default true" },
          },
          required: ["since"],
          additionalProperties: false,
        },
        async execute(args, tctx) {
          const h = boardFor(tctx.sessionID);
          if (!h) throw new Error("not on a swarm board");
          const b = h.board;
          const view = {
            who: h.who,
            channels: channelsOf(b, h.who),
            mentionsOnly: args.mentions_only !== false,
          };
          const hit = b.posts.filter((p) => p.seq > args.since && wakeHit(b, view, p)).at(-1);
          if (hit) return { content: `post #${hit.seq} from ${hit.from} in #${channelOf(hit)} names you: ${hit.text} — act and post back` };
          return new Promise((resolve) => {
            const w = {
              coordID: h.coordID, sessionID: tctx.sessionID, who: h.who,
              channels: view.channels, mentionsOnly: view.mentionsOnly,
              resolve: (p) => {
                clearTimeout(t);
                resolve({ content: `post #${p.seq} from ${p.from} in #${channelOf(p)} names you: ${p.text} — act and post back` });
              },
            };
            const t = setTimeout(() => {
              const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1);
              resolve({ content: `(nothing for you since #${args.since}; head #${h.board.seq})` });
            }, WAIT_TIMEOUT_MS);
            waiters.push(w);
            if (tctx.abort) tctx.abort.addEventListener?.("abort", () => {
              const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1);
              resolve({ content: "(interrupted)" });
            });
          });
        },
      });
    });
    startEngine();
  },
};

// Deterministic bits for tests; the plugin loader only reads `default`.
export const _pure = {
  mentionedNames, mentionedChannels, markerOf, looksLikePseudoToolCall, idleNow,
  channelOf, channelsOf, isPrivileged, canSee, visiblePosts, defaultChannel,
  wakeHit, mayMove, channelForPost, boardSnapshot, renderBoardHtml,
  expandAddTargets, groupTargets, mentionHit,
};
