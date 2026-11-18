# swarm-board

Antigravity-style agent swarm for [OpenCode](https://opencode.ai): a coordinator
and worker sessions talking on one shared message board — the missing board
tools behind the `swarm` skill, in a single zero-dependency plugin.
Unofficial port; not affiliated with Google.

The `swarm` skill alone is only instructions — it injects text and the board
tools (`swarm`, `post_message`, `read_board`, `swarm_wait`) simply do not
exist. This repo adds the missing half: a zero-dependency OpenCode server
plugin that registers those four tools and runs the board.

Tier 1 autopilot is included: live-state reconciliation, a `[done]/[blocked]/[stall]`
marker state machine, a built-in `[stall]` monitor, and auto-heal for local
models that print tool calls as text. Tier 2 adds channels and a static local
board UI (Board / Members / Graph) with no server and no extra dependency. Tier 3
adds group adds: `n`/`tasks` spawn several copies in one call, and `@group` /
`kill{name:"group"}` reach all of them.

| Repo file | Goes to (global OpenCode config dir) |
|---|---|
| `plugins/swarm-board.js` | `~/.config/opencode/plugins/swarm-board.js` |
| `skills/swarm/SKILL.md` | `~/.config/opencode/skills/swarm/SKILL.md` |

```sh
# macOS / Linux
cp plugins/swarm-board.js       ~/.config/opencode/plugins/
cp -r skills/swarm              ~/.config/opencode/skills/

# Windows (PowerShell)
Copy-Item plugins\swarm-board.js $env:USERPROFILE\.config\opencode\plugins\ -Force
Copy-Item skills\swarm           $env:USERPROFILE\.config\opencode\skills\ -Recurse -Force
```

No `opencode.json` entry needed — `~/.config/opencode/plugins/` is
auto-discovered and hot-reloads. Confirm with
`Select-String -Path ~/.local/share/opencode/log/opencode.log -Pattern 'id=swarm-board'`,
or just run `@swarm`.

## How it works

```
your session (coordinator)          board = append-log with seq numbers
  swarm add ──► worker session @parser   #4 @parser <brief>
  swarm_wait ◄── sleeps at zero cost     #5 parser: @coordinator [done] ...
  read_board ◄── pulls only what it wants (#5..#5)
```

- **Workers are real OpenCode sessions** (`session.create`) — own conversation,
  own context window, own tools. 3 workers ≠ sharing the coordinator's window.
- **`@mentions` wake sessions.** A post naming a sleeping member resolves its
  parked `swarm_wait` or re-prompts it if it ended its turn. `@all` wakes
  everyone; `@coordinator` wakes the coordinator.
- **Channels split attention, not access.** `#main` carries cross-area traffic;
  `@#parser` wakes only workers subscribed to `#parser`. See
  [Channels](#channels).
- **Parked = free.** A waiting session sends no requests (0 tokens). Waking
  re-sends its history (prefill cost, not money — relevant on local servers).
- **State persists** to `~/.local/share/opencode/swarm-board.json`
  (one board per coordinator session). Posts survive a server restart; worker
  sessions do not resume on their own — post `@name` to revive one.
- **The plugin is also the monitor.** A 15 s tick reconciles live session
  state, applies `[done]/[blocked]/[stall]` markers, and posts a `[stall]`
  notice after 3 quiet minutes — see [Autopilot](#autopilot-tier-1).

## Tools

| Tool | Call |
|---|---|
| `swarm` | `{action:"add", name:"parser", brief:"…", channels:["parser"]}` — one worker · `{action:"add", name:"parser", brief:"…", n:3}` or `{…, tasks:["lexer","parser"]}` — a group `parser-1…parser-k`, max 8 · `{action:"status"}` (roster incl. channels, quiet time, heal count, `open_board` URL) · `{action:"channel", op:"create"\|"subscribe"\|"unsubscribe"\|"list"\|"archive", channel, topic?, name?}` · `{action:"kill", name}` (a group name kills every copy) · `{action:"title", title}` · `{action:"models"}` lists runnable ids · `{action:"model", name, model:"provider/id"}` switches a member (a group name switches every copy) · `{action:"cleanup"}` removes retired worker sessions and prunes empty boards. Verified on this build; the board shows the live `provider/id`. See [Model per worker](#model-per-worker-one-model-vs-a-mix) |
| `post_message` | `{text:"@verifier check #4", channel:"parser"}` — mention = wake; `channel` defaults to your work channel |
| `read_board` | `{since:12}` (your view) · `{since:12, channel:"parser"}` (one channel) · `{channel:"*"}` (everything) |
| `swarm_wait` | `{since:12}` — waits for your name / `@all` / `@#your-channel`; `{mentions_only:false}` also wakes for plain posts in your channels (60 s cap) |

Worker names: lowercase `[a-z0-9-]`; `all` / `coordinator` are reserved; killed
names cannot be reused. Channel names use the same pattern, except `main`.

## Groups (`n` / `tasks`)

When the work is homogeneous or shardable, spawn several copies in one call:
`add{name:"parser", brief:"…", n:3}` gives `@parser-1`…`@parser-3` the same brief;
`add{name:"parser", brief:"…", tasks:["lexer","parser"]}` gives each copy its own
slice (`Your slice of this task: lexer`) on top of the shared brief. Max 8 workers
per call; `n` and `tasks` are mutually exclusive.

- **`@parser` reaches the whole group**: every copy is woken, and
  `kill{name:"parser"}` kills all of them at once
  (`group @parser killed: parser-1, parser-2`).
- **`@parser-1` reaches that copy only.** Each copy is told it is one of N, so it
  acts when the post names its own name or matches its slice.
- Markers, heals and stall silence stay per copy: `status` lists `parser-1:` and
  `parser-2:` as separate lines, so one finished shard reads `[done]` on its own.
- Group copies are ordinary members everywhere else (channels, helpers that inherit
  the adder's channels, `monitor` privileges).
- All names are checked **before** the first session is created, so a call with one
  taken name spawns nothing. If a spawn fails midway, the tool returns what was
  added and which copy failed instead of throwing.

## Channels

A board starts as one channel, `#main`. Channels keep area chatter out of the
other areas' inboxes. They are an attention filter, not an access-control
boundary: the state file and UI are local and show every channel.

- **Create, then assign.** `swarm{action:"channel", op:"create", channel:"parser",
  topic:"lexer and parser"}`, then `swarm{action:"add", name:"lexer", brief:"…",
  channels:["parser"]}`. The brief is posted in the worker's first channel, which
  is also where its `post_message` goes by default. A helper added by a worker
  inherits the adder's channels unless `channels` says otherwise.
- **Move with `subscribe` / `unsubscribe`** (`channel` + `name`). The coordinator
  may move any worker; a worker may move itself and the helpers it added. A new
  subscription changes where future `@#channel` calls wake it; `read_board` still
  returns the channel's full history.
- **`list`** shows each channel's topic, creator and subscribers; **`archive`**
  stops new posts but keeps history readable. `status` shows every member's
  channels.
- **Default views.** A member sees `#main` plus its subscriptions; the
  coordinator and a worker named `monitor` see every channel. An explicit
  `read_board{channel:"parser"}` can read any existing channel, and
  `channel:"*"` reads everything; subscriptions shape the default view and
  wakes, not secrecy.
- **`@name` crosses channels.** `@all` is still everyone. `@#parser` wakes every
  subscriber of `#parser` (and the coordinator) from any channel, including
  workers waiting for mentions only. `@#main` is refused (that is `@all`); an
  unknown or archived channel wakes nobody.
- **Waiters.** A member wakes for its own name, `@all`, or `@#` of a channel it
  joined. `swarm_wait{mentions_only:false}` also wakes for plain posts in the
  member's channels. The coordinator waits on every post.

## Board UI (Tier 2, static)

Posts, ticks and `status` refresh one self-contained HTML file:

```
~/.local/share/opencode/swarm-board/<coordinator-session>.html
```

`swarm{action:"status"}` returns it as `open_board: file:///…`. Open it in any
browser; there is no server, no network request and no dependency (the file is
written only when the snapshot changes).

- **Board** — newest first, channel filter and text filter (kept in
  `sessionStorage`), `[done]` / `[blocked]` badges, and the sender's model as a
  small muted `provider/id` label.
- **Members** — coordinator plus live state, marker, heal count, **model**,
  channels and session id; the session column is hidden below 640 px.
- **Graph** — SVG mention graph from the last 200 posts (solid = `@name`,
  dashed = `@#channel`).
- Auto-reload every 3 s. The active tab is in the URL hash and filters survive
  the reload; while a filter input is focused, the reload waits.
- Board text is inserted with `textContent`; the embedded JSON escapes `<`, so a
  post containing `</script>` cannot break out.
- Read-only snapshot: no buttons, no live socket, no narrator. It shows all
  channels, including archived ones.
- Minimal Matrix styling: near-black background, neon-green monospace text, no
  animated background. Still one self-contained file, no network request.

Tier 2 live check (same server, 2026-11-16):

```
#28 coordinator → #alpha          post_message{channel:"alpha"}
#30 @scout added on #alpha        add{channels:["alpha"]}; brief landed in #alpha
#31 scout → #alpha                member default post; @coordinator [done]
#32 coordinator → #main           "@#alpha second ping"
#33 scout → #alpha                woken by @#alpha, not @all; [done]
    status → scout: waiting (idle) [done] [heals 1/2] [#main #alpha]
    open_board → file:///…/ses_….html

UI in Chromium: 33 posts, 10 members, 4 channels, 0 console errors;
    channel filter #alpha → 4/33, text filter "scout" → 3/33; Members and
    Graph tabs render. scout needed one auto-heal before it posted.
#beta / #gamma archived: posting rejected, read_board history still works;
    @#main refused; posting to an unknown channel rejected.
```

Tier 3 live check (same server, 2026-11-16, groups):

```
#35 group @grp on #main: #35 @grp-1, #36 @grp-2   ← add{name:"grp", n:2}
#40 grp-1: @coordinator [done] grp-1 awake
#41 grp-2: @coordinator [done] grp-2 awake         ← @grp woke both copies
#42 coordinator: @grp-1 …                          (only that copy addressed)
#43 grp-1: @coordinator [done] grp-1 solo          ← grp-2 stayed quiet
    kill{name:"grp"} → group @grp killed: grp-1, grp-2
    add{name:"slice", tasks:["count the files in src/","count the lines in README.md"]}
        → #44 @slice-1 … Your slice of this task: count the files in src/
          #45 @slice-2 … Your slice of this task: count the lines in README.md
    add{n:9} → rejected by the tool schema; add{n:2, tasks:[…]} → "pass either n or
        tasks, not both"; add{name:"grp", n:1} → "@grp-1 exists; killed names cannot
        be reused" (nothing spawned)
```

## Usage

Invoke the skill and state the goal — the agent becomes coordinator and follows
the skill: split work per file/target, `add` one worker per independent piece,
post rules and asks on the board, park in `swarm_wait`, verify, `kill`, report.

Handoff etiquette (what makes the graph non-star-shaped):

```
@lexer the API you need is at src/api.rs:40
@verifier the result is in #12 — audit it
@coordinator [done] parser green, 142/142 tests pass
```

Mention only whoever acts next; reference posts by `#seq` instead of
copy-pasting reports (keeps the coordinator's context small).

## Swarm vs subagent bawaan OpenCode

Both create child sessions with their own context, but **built-in subagents are
the better default for most tasks**. Reach for a swarm only when you need one of
the "swarm" capabilities below.

| Need | Built-in subagent (`general`, `explore`) | Swarm board |
|---|---|---|
| Relationship | Child session (`parentID`), reports to parent inbox on idle | Standalone session; reports manually via `post_message` + `[done]` |
| Message direction | Parent ↔ child only; a child cannot message another child | Peer-to-peer: `@author`, `@verifier`, `@#channel` |
| Long idle | Still a background child, reports each completed round | `swarm_wait` parks at 0 tokens, woken by `@mention` |
| Scale | One agent per `subagent` call | `n`/`tasks` up to 8 workers + channels to split attention |
| Trace | Parent inbox, tied to the session | Persistent board + HTML/Graph UI; posts survive a server restart |
| Monitor | None | Automatic `[stall]` notices, auto-heal for tool calls printed as text |
| Session tidiness | Child stays under its parent | Root sessions — clean up with `kill` / `cleanup` |

**Use a subagent** for 1–3 independent tasks, a read-only/permission-restricted
agent (`explore`), or whenever you want to avoid coordination overhead.
**Use a swarm** for peer handoffs (verifier → author directly), work with long
idle periods, more than four workers that need channels, or a large audit that
needs a shared trace. The skill is also labelled "(Preview & Quota Heavy)": the
coordinator must not do the work itself, so there is a real orchestration cost.

## Model per worker: one model vs a mix

Workers are separate sessions, so each one can run a different model. By default
a new worker inherits the model of its OpenCode **agent** (`build`), which need
not be the coordinator's model — in a live check here the coordinator ran
`opencode/hy4-flash-free` while every worker ran
`local-router/Qwen3.8-Flash-Next`.

List what is available first:

```
swarm{action:"models"}     # provider/id list, e.g. local-router/Qwen3.8-27B-NInfer
```

### A. One model for the whole swarm

Set the same `provider/id` on every member after adding them:

```
swarm{action:"add", name:"writer",   brief:"Draft the module."}
swarm{action:"add", name:"reviewer", brief:"Review the draft."}
swarm{action:"model", name:"writer",   model:"opencode/hy4-flash-free"}
swarm{action:"model", name:"reviewer", model:"opencode/hy4-flash-free"}
```

For a group, one call switches all copies:
`swarm{action:"add", name:"scan", brief:"…", n:3}` then
`swarm{action:"model", name:"scan", model:"opencode/hy4-flash-free"}`.

### B. Different models per worker

Give each role the model that suits it:

```
swarm{action:"add", name:"planner", brief:"Break the task into pieces."}
swarm{action:"add", name:"coder",   brief:"Implement each piece."}
swarm{action:"add", name:"critic",  brief:"Audit the result."}
swarm{action:"model", name:"planner", model:"openrouter/anthropic/claude-sonnet-5.5"}
swarm{action:"model", name:"coder",   model:"openai/gpt-5.3-codex"}
swarm{action:"model", name:"critic",  model:"local-router/Qwen3.8-27B-NInfer"}
```

Then hand out the work as usual (`post_message` / `@mention`), park in
`swarm_wait`, and verify on the **Members** tab: the Model column shows the live
`provider/id` of every member, and each post header is labelled with the model
that produced it.

### Copy-paste prompts

Instead of calling the tools yourself, paste one of these into OpenCode and let
the coordinator translate it into the `add` / `model` / `post_message` calls
above.

One model for everyone:

```
@swarm Build a small URL shortener with tests. Use ONE model for every agent:
opencode/hy4-flash-free. Add a coder and a reviewer, post the briefs on the
board, park in swarm_wait, verify with your own tests, then kill the workers.
```

Mixed models:

```
@swarm Audit this repo. Use a different model per role: planner =
openrouter/anthropic/claude-sonnet-5.5, coder = openai/gpt-5.3-codex, critic =
local-router/Qwen3.8-27B-NInfer. Split work per file, coordinate on the board,
verify with first-party evidence, then kill everyone.
```

Verified on this build (2026-11-18): `swarm{action:"model", name:"msame",
model:"opencode/hy4-flash-free"}` returned `@msame switched to
opencode/hy4-flash-free`, and the session API then reported
`model: {id:"hy4-flash-free", providerID:"opencode"}`; a second worker switched
to `local-router/Qwen3.8-27B-NInfer`. The switch applies to the **next**
inference — messages already in a session keep the model that generated them.
The board reads the current model from `session.get` on the 15 s tick, so a
recent switch can take one tick (or the next post) to appear.

One-model demo (same session, later): two workers `onedraft` and `onecheck` were
both switched to `opencode/hy4-flash-free`; their sessions then reported
`hy4-flash-free @ opencode`, and board posts #20/#21 were both labelled
`opencode/hy4-flash-free` — the whole swarm on one model, verified end to end.

## Autopilot (Tier 1)

The plugin keeps the board honest without the coordinator polling:

| Behavior | What happens |
|---|---|
| State reconciliation | Every 15 s, and on V2 `session.step.ended` / `session.execution.*` / `session.idle` events, each member's live session is checked. Idle workers flip from `working` to `waiting (idle)`; execution failures become `stopped: <reason>` (incl. quota retry hints). Boards with no live member are skipped entirely — one `session.get` per member per tick, not one for the model plus one for state. |
| Marker state machine | A member post containing `[done]`, `[blocked]` or `[stall]` records that marker beside the live state (`waiting (idle) [done]`), so the upstream skill still sees the word `waiting` and finished members stop counting as pending. A later `@name` that wakes a parked waiter clears the marker and flips the member back to `working`. |
| Built-in stall monitor | If the board is quiet for 3 min, workers are still pending, and the coordinator is parked or idle, the plugin posts `@coordinator [stall] quiet … silent: …` from `monitor`. That post resolves a parked `swarm_wait` immediately. Capped at 3 consecutive stalls; any non-monitor post resets the window. |
| Auto-heal | An idle worker whose last text looks like a literal tool call (`<tool_call>`, `<function=…>`) gets one correction prompt per idle transition, max 2 per session; then `needs help (heal cap)`. |

A worker named `monitor` (or `monitor-N`) disables the built-in stall posts, so
a custom `swarm_monitor` worker can take over. This repo intentionally does
**not** ship `swarm_monitor`: a parked worker cannot run a timer, so the plugin
*is* the monitor. The upstream skill skips its monitor step when that skill is
not installed.

Live checks on the same server (2026-11-16):

```
#27 marker2: @coordinator [done] marker2: state machine re-check
    swarm status → marker2: waiting (idle) [done] [heals 2/2]
    (auto-heal: this worker also emitted tool-call XML twice; cap enforced,
    correction prompts visible in its session history)

#24 monitor: @coordinator [stall] quiet 1m since #23 (coordinator); silent: sleepy
    posted while the coordinator was parked in swarm_wait; the wait returned
    this exact post — no polling

state file, read without calling status:
    idler: working → waiting (idle)   ← 15 s tick / event reconcile
```

The stall check ran with a temporary 10 s threshold; production is 3 min.

## Real transcript (fresh run, local 262 K model, English briefs)

```
> swarm add {name:"builder", brief:"write slug.js to spec …"}     #15 @builder added
> swarm add {name:"checker", brief:"QA: wait to be mentioned …"}  #16 @checker added

  builder writes slug.js … then stops without posting. Its post_message call
  came out as literal XML text, so nothing reached the board.

> swarm status        → builder: waiting (idle)        ← live session state
> post_message "@builder you skipped the protocol …"   #17   (wakes the idle worker;
                                                              local model flubs again)
> post_message "@checker file exists, start now …"     #18
    checker writes check.js (node:assert), runs `node check.js`:
  #19 checker: @builder [approved] ALL PASS: 7/7 spec assertions green
  #20 checker: @coordinator [done] QA green, slug.js untouched.

  coordinator's own node asserts (not a console round-trip): 7/7 PASS
  swarm kill ×2 → builder, checker terminated
```

Earlier run, same plugin (`stats.js`, Indonesian briefs):

```
  #11 coordinator: @penulis [fase-2] add modus() …   ← worker had already posted [done]
  #13 penulis:     @coordinator [done] fase-2 …      ← woke from the mention, did phase 2
```

What both runs prove: the board routes wakes (`@mention` → parked or idle session),
workers do the real work in their own windows, and the coordinator can verify
with first-party evidence (its own tests, not a worker's claims). What failed in
run two is the local model's tool-calling, not the board — see Limitations.

## Limitations (deliberately small)

- Local models occasionally print a tool call as **literal XML text** instead of
  invoking the tool. Tier 1 detects it when the worker goes idle and sends up to
  2 correction prompts; if the model still refuses, the member shows
  `needs help (heal cap)` — nudge `@name` or kill/replace. Trust raw test output,
  never a worker's claim.
- No `fork:` or `workspace:"share"/"branch"` semantics on `add` (the V2 APIs
  `session.fork` / `worktree.create` exist, but a worker needs a fresh context
  with only its brief — forking a warm coordinator history would be huge, and
  this machine's worktree discovery is unreliable). `swarm{action:"model"}`
  switches the session model and is verified; it does not validate
  quota/availability — a bad id only shows up at the next inference.
  The stall monitor is built into the plugin (no `swarm_monitor` skill/worker
  needed). (`n`/`tasks` groups are implemented — see [Groups](#groups-ntasks).)
- No narrator (`swarm_narrator`): its upstream UI/protocol is not shipped here.
  A narrator worker would be a normal member; the static UI covers the overview.
- The UI is a read-only static file that reloads every 3 s: no streaming, no
  buttons, no history beyond the 500-post cap. It shows every channel. Channels
  reduce wakes; they are not an access-control boundary.
- `read_board{channel}` is explicit and unrestricted by subscription;
  subscriptions only decide the default view and which `@#` calls wake a member.
- `swarm_wait` caps at 60 s per call (safe under harness tool timeouts) —
  call it in a loop; each park is still free.
- Board history is capped at 500 posts.
- A wake arrives in the worker's session as a user message; weak local models
  occasionally need a firmer brief.
- One board per coordinator session; two coordinators never share a board.
- A member whose first prompt never lands (the inference backend was down when
  `add` ran) is recorded as `stopped: first prompt failed: …` rather than left
  looking busy. A post naming it retries, or `kill` it and add it again.

## Tests

`node --test` (Node 22+, no dependencies): mention and channel parsing,
visibility and defaults, wake rules, group naming/validation/addressing,
V2 event mapping and error strings, and the HTML snapshot escaping. The plugin
is the test target, so a green run means the shipped file —
`plugins/swarm-board.js` — behaves as described. The current working tree passes
**16/16** tests. Swarm worker sessions are removed on `kill`;
`swarm{action:"cleanup"}` removes every retired worker session across all owned
boards (killed / `stopped:` / `[done]` / `[blocked]`) so the OpenCode session
list does not fill up. A coordinator cleans all its boards; a worker cleans only
its own board.

## Attribution & license

- `plugins/swarm-board.js` — MIT (see `LICENSE`).
- `skills/swarm/SKILL.md` — the upstream Antigravity-compatible swarm skill
  text (not authored here); redistributed unmodified. Check its upstream
  licensing before republishing this repo.

## Troubleshooting

- Tools missing after copying: look for `msg="loading plugin" id=swarm-board`
  in `~/.local/share/opencode/log/opencode.log`, then `/reload` or
  `opencode service restart`.
- Repeated hot-reloads (copying the plugin several times, or editing it many
  times in a row) can leave several plugin instances with stale in-memory
  boards writing to the same `swarm-board.json`: sequence numbers collide,
  `kill` looks reverted in the UI, and phantom `[stall]` posts appear. Fix with
  `opencode service restart` (optionally delete `swarm-board.json` first for a
  full reset). `swarm{action:"cleanup"}` writes tombstones for the boards it
  prunes, so a stale instance cannot resurrect them on its next save.
- Full reset: stop the server, delete `swarm-board.json`, restart.
