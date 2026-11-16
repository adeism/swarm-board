// swarm-board: board tools for the `swarm` skill (swarm, post_message, read_board, swarm_wait).
// Pure V2 plugin (same shape as @dietrichgebert/ponytail): no external deps.
// Workers are real OpenCode sessions; the board is an append-log woken by @mentions.
// Tier 1: 15 s live-state reconcile, [done]/[blocked]/[stall] markers, built-in
//   stall monitor, and auto-heal for tool calls printed as text.
// shortcut: single board per coordinator session; no channels/fork/workspace/model-switch
//   semantics yet, no `n`/`tasks` batched add. Add them when the swarm actually needs them.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const FILE = path.join(os.homedir(), ".local", "share", "opencode", "swarm-board.json");
const WAIT_TIMEOUT_MS = 60_000;
const STALL_MS = 180_000;   // board quiet this long with live members => monitor [stall]
const TICK_MS = 15_000;     // reconcile live session state + heal pseudo tool calls
const HEAL_CAP = 2;         // max auto-heal prompts per worker session

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

function mentionedNames(board, text) {
  const set = new Set();
  for (const m of text.matchAll(/@([a-z0-9][a-z0-9-]*)/gi)) set.add(m[1].toLowerCase());
  return set;
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
  const mentions = mentionedNames(board, post.text);
  const wake = (sessionID) => {
    const parked = waiters.filter((w) => w.coordID === coordID && w.sessionID === sessionID);
    if (parked.length) { for (const w of parked.splice(0)) w.resolve(post); return; }
    const member = Object.values(board.members).find((m) => m.sessionID === sessionID);
    if (member) { member.status = "working"; member.marker = null; }
    ctx.session.prompt({ sessionID, text:
      `[swarm '${board.title}' board, head #${board.seq}] ${post.text}\n` +
      `Act on it if it is for you; reply on the board via post_message to '@${post.from} ...' ` +
      `(or '@coordinator' when done), then end your turn.` }).catch((e) => {
      if (member) member.status = "stopped: " + String(e?.message ?? e).slice(0, 120);
      save();
    });
    save();
  };
  if (mentions.has("all")) wake(coordID);
  for (const [name, m] of Object.entries(board.members)) {
    if (m.status === "killed" || name === post.from) continue;
    if (mentions.has(name) || mentions.has("all")) wake(m.sessionID);
  }
  if (mentions.has("coordinator") && post.from !== "coordinator") wake(coordID);
  // waiters (swarm_wait callers) whose name matches the post resolve even when
  // the session-parked branch above already ran; do a second pass for coordinator.
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    if (w.coordID !== coordID) continue;
    const hit = w.names === "*" || [...mentions].some((n) => w.names.includes(n));
    if (hit) waiters.splice(i, 1)[0].resolve(post);
  }
}

function post(coordID, from, text) {
  const board = db.swarms[coordID];
  board.seq += 1;
  const p = { seq: board.seq, from, text, at: new Date().toISOString() };
  board.posts.push(p);
  board.posts = board.posts.slice(-500); // shortcut: cap history at 500; prune to file when it hurts
  const marker = markerOf(text);
  const member = from !== "coordinator" && from !== "monitor" ? board.members[from] : null;
  if (member && marker) { member.marker = marker; member.markerAt = p.at; }
  if (from !== "monitor") board.stalls = 0; // a human/agent reply restarts the stall window
  save();
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
    }
  } finally { ticking = false; }
}

function onEvent(ev) {
  if (!/session\.(step\.(ended|failed)|idle|error)/i.test(String(ev?.type ?? ""))) return;
  const sid = ev?.data?.sessionID;
  const idx = sid && db.memberIndex[sid];
  const m = idx && db.swarms[idx.coordID]?.members?.[idx.name];
  if (m) reconcileMember(m).catch(() => {});
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

const WORKER_RULES = (name, title, seq) =>
`You are '@${name}', a worker in swarm '${title}'. The coordinator brief is at the end of this message; the board head is #${seq}.
Rules:
- Do the work with normal tools. The board is your only channel to other agents: call post_message to speak; start every post with the recipient '@<name> <text>' and @mention only whoever acts next.
- When fully done: post '@coordinator [done] <summary + evidence>'. When blocked: '@coordinator [blocked] <reason>'.
- A later message that names you is board traffic: act on it, then answer the poster via post_message, then end your turn. Ending your turn parks you; a post naming you wakes you.
- Do not kill members, do not rename the swarm, do not spawn your own swarm unless your brief says so.

Brief:`;

let ctx;

export default {
  id: "swarm-board",
  async setup(context) {
    ctx = context;
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "swarm",
        description:
          "Run the swarm board. action=add {name,brief}: spawn worker @name on its own session. " +
          "action=status: roster + board head. action=kill {name}: stop a worker. " +
          "action=title {title}: name the swarm. action=models: list runnable models. " +
          "action=model {name,model 'provider/id'}: switch a member's model.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["add", "status", "kill", "title", "models", "model"] },
            name: { type: "string" },
            brief: { type: "string" },
            title: { type: "string" },
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
              board = db.swarms[sessionID] = { title: "the swarm", seq: 0, posts: [], members: {} };
              save();
            }
            if (args.action === "title") {
              board.title = args.title || board.title;
              save();
              return { content: `swarm titled '${board.title}'` };
            }
            const hit = boardFor(sessionID);
            const name = String(args.name || "").toLowerCase();
            if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name === "all" || name === "coordinator")
              throw new Error("name must be lowercase [a-z0-9-] and not all/coordinator");
            if (board.members[name]) throw new Error(`@${name} exists; kill it first (killed names cannot be reused)`);
            const created = await ctx.session.create({ title: `[swarm ${board.title}] @${name}` });
            const workerID = created?.id ?? created?.data?.id;
            if (!workerID) throw new Error("session.create returned no id: " + JSON.stringify(created)?.slice(0, 200));
            board.members[name] = { sessionID: workerID, status: "working" };
            db.memberIndex[workerID] = { coordID: sessionID, name };
            save();
            const p = post(sessionID, "coordinator", `@${name} ${args.brief || "(no brief given — ask the coordinator)"}`);
            await ctx.session.prompt({ sessionID: workerID, text: WORKER_RULES(name, board.title, p.seq) + " " + (args.brief || "") });
            return { content: `#${p.seq} @${name} added on session ${workerID}` };
          }
          if (args.action === "status") {
            const h = boardFor(sessionID);
            if (!h) throw new Error("no swarm for this session; swarm{action:'add'} or 'title' first");
            const b = h.board;
            await Promise.all(Object.entries(b.members).map(([, m]) =>
              reconcileMember(m).catch(() => {})));
            const roster = Object.entries(b.members)
              .map(([n, m]) => `${n}: ${m.status}${m.marker ? ` [${m.marker}]` : ""}${m.heals ? ` [heals ${m.heals}/${HEAL_CAP}]` : ""} (${m.sessionID})`)
              .join("\n") || "(no members)";
            const quiet = b.posts.at(-1) ? Math.round((Date.now() - Date.parse(b.posts.at(-1).at)) / 1000) : 0;
            return { content: `swarm '${b.title}' — head #${b.seq} (quiet ${quiet}s)\ncoordinator: ${h.coordID}\n${roster}\nopen_board: none (board is text; use read_board)` };
          }
          if (args.action === "kill") {
            const h = boardFor(sessionID);
            if (!h) throw new Error("no swarm");
            const m = h.board.members[args.name];
            if (!m) throw new Error(`no member @${args.name}`);
            m.status = "killed";
            save();
            try { await ctx.session.interrupt?.({ sessionID: m.sessionID, resume: false }); } catch {}
            return { content: `@${args.name} killed` };
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
            const target = !args.name || args.name === "coordinator" ? h.coordID
              : h.board.members[args.name]?.sessionID;
            if (!target) throw new Error(`no member @${args.name}`);
            const [providerID, ...rest] = String(args.model).split("/");
            try {
              await ctx.session.switchModel({ sessionID: target, model: { providerID, id: rest.join("/") } });
              return { content: `@${args.name ?? "coordinator"} switched to ${args.model}` };
            } catch (e) { return { content: "model switch unsupported/failed: " + e.message }; }
          }
        },
      });

      editor.add({
        name: "post_message",
        description: "Say something on the swarm board. Prefix with @name / @all / @coordinator to wake the addressee.",
        input: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        async execute(args, tctx) {
          const h = boardFor(tctx.sessionID);
          if (!h) throw new Error("this session is not on a swarm board; the coordinator must call swarm{action:'add'} first");
          const p = post(h.coordID, h.who, args.text);
          return { content: `#${p.seq} posted` };
        },
      });

      editor.add({
        name: "read_board",
        description: "Read swarm board posts newer than a sequence number.",
        input: {
          type: "object",
          properties: { since: { type: "integer" } },
          required: ["since"],
          additionalProperties: false,
        },
        async execute(args, tctx) {
          const h = boardFor(tctx.sessionID);
          if (!h) throw new Error("not on a swarm board");
          const fresh = h.board.posts.filter((p) => p.seq > args.since);
          return { content: fresh.length
            ? fresh.map((p) => `#${p.seq} ${p.from}: ${p.text}`).join("\n")
            : `(no posts after #${args.since}; head #${h.board.seq})` };
        },
      });

      editor.add({
        name: "swarm_wait",
        description: "Sleep at zero cost until the board moves (or 60s). Pass the highest seq you have seen as since.",
        input: {
          type: "object",
          properties: { since: { type: "integer" } },
          required: ["since"],
          additionalProperties: false,
        },
        async execute(args, tctx) {
          const h = boardFor(tctx.sessionID);
          if (!h) throw new Error("not on a swarm board");
          if (h.board.seq > args.since)
            return { content: `board moved: #${args.since + 1}..#${h.board.seq}; run read_board` };
          const names = h.who === "coordinator" ? "*"
            : [h.who, "all", "coordinator"]; // members wake for their name, @all, or traffic the coordinator must relay
          return new Promise((resolve) => {
            const w = { coordID: h.coordID, sessionID: tctx.sessionID, names, resolve: (p) => {
              clearTimeout(t);
              resolve({ content: `post #${p.seq} from ${p.from} names you: ${p.text} — act and post back` });
            }};
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
export const _pure = { mentionedNames, markerOf, looksLikePseudoToolCall, idleNow };
