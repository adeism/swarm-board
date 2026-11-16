// Pure helper + renderer tests: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { _pure as P } from "../plugins/swarm-board.js";

const at = "2026-01-01T00:00:00.000Z";
const board = {
  title: "t",
  seq: 3,
  channels: {
    parser: { topic: "lexer", creator: "coordinator", archived: false },
    ui: { topic: "screen", creator: "alpha", archived: false },
    old: { topic: "done area", creator: "beta", archived: true },
  },
  members: {
    alpha: { sessionID: "s1", status: "working", channels: ["parser"] },
    beta: { sessionID: "s2", status: "waiting (idle)", channels: ["ui"] },
    helper: { sessionID: "s3", status: "working", channels: ["parser"], addedBy: "alpha" },
    monitor: { sessionID: "s4", status: "waiting (idle)", channels: [] },
  },
  posts: [
    { seq: 1, from: "coordinator", text: "legacy post", at },
    { seq: 2, from: "alpha", channel: "parser", text: "@beta check @#ui", at },
    { seq: 3, from: "beta", channel: "ui", text: "ok", at },
  ],
};

test("mention parsing", () => {
  assert.deepEqual([...P.mentionedNames("@beta @#parser @all")], ["beta", "all"]);
  assert.deepEqual([...P.mentionedChannels("@#parser and @#UI and @beta")], ["parser", "ui"]);
  assert.equal(P.channelOf(board.posts[0]), "main");
  assert.equal(P.channelOf(board.posts[2]), "ui");
});

test("visibility", () => {
  assert.deepEqual(P.channelsOf(board, "alpha"), ["main", "parser"]);
  assert.equal(P.isPrivileged("coordinator"), true);
  assert.equal(P.isPrivileged("monitor"), true);
  assert.equal(P.isPrivileged("monitor-2"), true);
  assert.equal(P.isPrivileged("alpha"), false);
  assert.equal(P.canSee(board, "alpha", "parser"), true);
  assert.equal(P.canSee(board, "alpha", "ui"), false);
  assert.equal(P.canSee(board, "coordinator", "ui"), true);
  assert.equal(P.canSee(board, "monitor", "ui"), true);
  assert.deepEqual(P.visiblePosts(board, "alpha").map((p) => p.seq), [1, 2]);
  assert.deepEqual(P.visiblePosts(board, "beta").map((p) => p.seq), [1, 3]);
  assert.deepEqual(P.visiblePosts(board, "coordinator").map((p) => p.seq), [1, 2, 3]);
  assert.deepEqual(P.visiblePosts(board, "monitor").map((p) => p.seq), [1, 2, 3]);
});

test("default posting channel", () => {
  assert.equal(P.defaultChannel(board, "alpha"), "parser");
  assert.equal(P.defaultChannel(board, "beta"), "ui");
  assert.equal(P.defaultChannel(board, "coordinator"), "main");
  assert.equal(P.defaultChannel(board, "monitor"), "main");
  assert.equal(P.defaultChannel(board, "helper"), "parser");
  assert.equal(P.defaultChannel(board, "nobody"), "main");
  assert.equal(P.defaultChannel({ ...board, channels: { ...board.channels, parser: { ...board.channels.parser, archived: true } } }, "alpha"), "main");
});

test("wake rules", () => {
  const wa = { who: "alpha", channels: ["main", "parser"], mentionsOnly: true };
  const waAll = { ...wa, mentionsOnly: false };
  assert.equal(P.wakeHit(board, wa, board.posts[2]), false, "other channel is quiet");
  assert.equal(P.wakeHit(board, waAll, board.posts[2]), false, "mentions_only:false still only own channels");
  assert.equal(P.wakeHit(board, waAll, { ...board.posts[2], channel: "parser", text: "plain" }), true);
  assert.equal(P.wakeHit(board, wa, { ...board.posts[2], channel: "parser", text: "plain" }), false);
  assert.equal(P.wakeHit(board, wa, { ...board.posts[2], channel: "ui", text: "@alpha look" }), true, "name crosses channels");
  assert.equal(P.wakeHit(board, wa, { ...board.posts[2], channel: "ui", text: "@#parser?" }), true);
  assert.equal(P.wakeHit(board, wa, { ...board.posts[2], channel: "ui", text: "@#old?" }), false, "archived calls nobody");
  assert.equal(P.wakeHit(board, wa, { ...board.posts[2], channel: "ui", text: "@#ui?" }), false);
  assert.equal(P.wakeHit(board, wa, { ...board.posts[2], channel: "ui", text: "@all" }), true);
  assert.equal(P.wakeHit(board, { who: "coordinator", channels: ["main"], mentionsOnly: true }, board.posts[2]), true);
  assert.equal(P.wakeHit(board, { who: "beta", channels: ["main", "ui"], mentionsOnly: true }, { ...board.posts[2], from: "alpha", channel: "ui", text: "@#ui?" }), true);
  assert.equal(P.wakeHit(board, { who: "coordinator", channels: ["main"], mentionsOnly: true }, { ...board.posts[2], from: "coordinator" }), false, "own post is not a wake");
  assert.equal(P.wakeHit(board, wa, { ...board.posts[2], channel: "parser", from: "alpha", text: "@all" }), false, "own post is not a wake");
});

test("channel permissions", () => {
  assert.equal(P.mayMove(board, "coordinator", "beta"), true);
  assert.equal(P.mayMove(board, "alpha", "alpha"), true);
  assert.equal(P.mayMove(board, "alpha", "helper"), true);
  assert.equal(P.mayMove(board, "alpha", "beta"), false);
  assert.equal(P.mayMove(board, "beta", "helper"), false);
  assert.equal(P.mayMove(board, "alpha", "nobody"), false);
});

test("posting channel validation", () => {
  assert.equal(P.channelForPost(board, "alpha"), "parser");
  assert.equal(P.channelForPost(board, "alpha", "main"), "main");
  assert.equal(P.channelForPost(board, "alpha", "ui"), "ui");
  assert.throws(() => P.channelForPost(board, "alpha", "old"), /archived/);
  assert.throws(() => P.channelForPost(board, "alpha", "nope"), /no #nope/);
  assert.throws(() => P.channelForPost(board, "alpha", "BAD"), /bad channel/);
});

test("group add targets: naming and validation", () => {
  assert.deepEqual(P.expandAddTargets({ name: "p" }), [{ name: "p", slice: "" }]);
  assert.deepEqual(P.expandAddTargets({ name: "p", n: 3 }), [
    { name: "p-1", slice: "" }, { name: "p-2", slice: "" }, { name: "p-3", slice: "" },
  ]);
  assert.deepEqual(P.expandAddTargets({ name: "P", tasks: [" lexer ", "tests"] }), [
    { name: "p-1", slice: "lexer" }, { name: "p-2", slice: "tests" },
  ]);
  assert.equal(P.expandAddTargets({ name: "p", n: 8 }).length, 8);
  assert.throws(() => P.expandAddTargets({ name: "p", n: 1.5 }), /n must be/);
  assert.throws(() => P.expandAddTargets({ name: "p", n: 0 }), /n must be/);
  assert.throws(() => P.expandAddTargets({ name: "p", n: 9 }), /capped|n must be/);
  assert.throws(() => P.expandAddTargets({ name: "p", n: 2, tasks: ["a"] }), /not both/);
  assert.throws(() => P.expandAddTargets({ name: "p", tasks: [] }), /non-empty/);
  assert.throws(() => P.expandAddTargets({ name: "p", tasks: ["a", "  "] }), /every task/);
  assert.throws(() => P.expandAddTargets({ name: "p", tasks: Array(9).fill("x") }), /capped/);
});

test("group addressing", () => {
  const gb = {
    members: {
      "p-1": { group: "p" }, "p-2": { group: "p" },
      solo: {}, marker: {}, "marker-1": {},
    },
  };
  assert.deepEqual(P.groupTargets(gb, "p"), ["p-1", "p-2"]);
  assert.deepEqual(P.groupTargets(gb, "p-1"), ["p-1"]);
  assert.deepEqual(P.groupTargets(gb, "marker"), ["marker"], "a hand-added marker-1 is not the group");
  assert.deepEqual(P.groupTargets(gb, "nope"), []);
  assert.deepEqual(P.groupTargets({ members: { q: {}, "q-1": { group: "q" } } }, "q"), ["q", "q-1"]);
  assert.equal(P.mentionHit(gb, new Set(["p"]), "p-2"), true);
  assert.equal(P.mentionHit(gb, new Set(["p-1"]), "p-2"), false);
  assert.equal(P.mentionHit(gb, new Set(["marker"]), "marker-1"), false);
});

test("a group mention wakes every copy", () => {
  const gb = {
    channels: {},
    members: {
      "g-1": { group: "g", channels: [] }, "g-2": { group: "g", channels: [] }, other: { channels: [] },
    },
  };
  const p = { seq: 1, from: "coordinator", channel: "main", text: "@g help", at };
  assert.equal(P.wakeHit(gb, { who: "g-1", channels: ["main"], mentionsOnly: true }, p), true);
  assert.equal(P.wakeHit(gb, { who: "g-2", channels: ["main"], mentionsOnly: true }, p), true);
  assert.equal(P.wakeHit(gb, { who: "other", channels: ["main"], mentionsOnly: true }, p), false);
  assert.equal(P.wakeHit(gb, { who: "g-1", channels: ["main"], mentionsOnly: true }, { ...p, from: "g-1" }), false, "own post");
});

test("a stale instance cannot overwrite a newer board", () => {
  const mem = { swarms: { a: { seq: 45, posts: [] }, b: { seq: 2 } } };
  const disk = { swarms: { a: { seq: 38, posts: [] }, b: { seq: 5 } }, memberIndex: {} };
  assert.deepEqual(Object.keys(P.newerBoards(disk, mem)), ["b"], "only the board the disk is ahead on");
  assert.deepEqual(Object.keys(P.newerBoards({ swarms: mem.swarms }, {})), ["a", "b"], "empty memory adopts everything");
  assert.deepEqual(P.newerBoards({ swarms: {} }, mem), {}, "nothing on disk to adopt");
});

test("snapshot and html escaping", () => {
  const evil = {
    ...board,
    title: "</title><script>alert('t')</script>",
    posts: [{ seq: 4, from: "alpha", channel: "parser", text: "</script><script>alert('p')</script>", at }],
  };
  const snap = P.boardSnapshot("ses_test", evil);
  assert.equal(snap.title, evil.title);
  assert.equal(snap.posts[0].text, evil.posts[0].text);
  assert.equal(snap.posts[0].channel, "parser");
  assert.deepEqual(snap.channels.map((c) => c.name), ["main", "parser", "ui", "old"]);
  assert.equal(snap.channels.find((c) => c.name === "old").archived, true);
  assert.equal(snap.channels.find((c) => c.name === "ui").subs, 1);

  const html = P.renderBoardHtml("ses_test", evil);
  assert.ok(html.includes('data-tab="board"'));
  assert.ok(html.includes('data-tab="members"'));
  assert.ok(html.includes('data-tab="graph"'));
  assert.ok(html.includes("auto-refresh every 3 s"));
  assert.ok(html.includes("Content-Security-Policy"));
  assert.ok(!html.includes("</script><script>alert"), "raw closing script injected");
  assert.ok(html.includes("\\u003c/script"), "escaped tag present");
  const m = html.match(/<script id="board-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, "data block found");
  const parsed = JSON.parse(m[1]);
  assert.equal(parsed.title, evil.title);
  assert.equal(parsed.posts[0].text, evil.posts[0].text);
  assert.equal(parsed.posts[0].channel, "parser");
  assert.equal(parsed.channels.find((c) => c.name === "old").archived, true);
});

test("legacy board without channels still renders and defaults to main", () => {
  const legacy = { title: "old swarm", seq: 0, posts: [], members: { a: { sessionID: "s", status: "working" } } };
  const lhtml = P.renderBoardHtml("ses_legacy", legacy);
  const lm = lhtml.match(/<script id="board-data" type="application\/json">([\s\S]*?)<\/script>/);
  const ldata = JSON.parse(lm[1]);
  assert.deepEqual(ldata.channels.map((c) => c.name), ["main"]);
  assert.deepEqual(ldata.members[0].channels, ["main"]);
});
