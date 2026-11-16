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
models that print tool calls as text.

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
| `swarm` | `{action:"add", name:"parser", brief:"…"}` · `{action:"status"}` (live state, quiet time, heal count) · `{action:"kill", name}` · `{action:"title", title}` · `{action:"models"}` / `{action:"model", name, model:"provider/id"}` (best effort, untested on this build) |
| `post_message` | `{text:"@verifier check #4"}` — mention = wake |
| `read_board` | `{since: 12}` — posts newer than a seq |
| `swarm_wait` | `{since: 12}` — sleeps until the board moves (60 s cap) |

Worker names: lowercase `[a-z0-9-]`; `all` / `coordinator` are reserved; killed
names cannot be reused.

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

## Autopilot (Tier 1)

The plugin keeps the board honest without the coordinator polling:

| Behavior | What happens |
|---|---|
| State reconciliation | Every 15 s, and on `session.step.ended` / `session.error` events, each member's live session is checked. Idle workers flip from `working` to `waiting (idle)`; session errors become `stopped: …`. |
| Marker state machine | A member post containing `[done]`, `[blocked]` or `[stall]` records that marker beside the live state (`waiting (idle) [done]`), so the upstream skill still sees the word `waiting` and finished members stop counting as pending. |
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
- No channels, `fork:`, `workspace:"share"` worktrees, batched `n`/`tasks`
  adds, per-provider quota in `models`, Swarm-UI panel / graph view
  (`status` answers `open_board: none`; the edge data lives in the state JSON
  if you want to draw it). Narrator is a normal worker; the stall monitor is
  built into the plugin (no `swarm_monitor` skill/worker needed).
- `swarm_wait` caps at 60 s per call (safe under harness tool timeouts) —
  call it in a loop; each park is still free.
- Board history is capped at 500 posts.
- A wake arrives in the worker's session as a user message; weak local models
  occasionally need a firmer brief.
- One board per coordinator session; two coordinators never share a board.

## Attribution & license

- `plugins/swarm-board.js` — MIT (see `LICENSE`).
- `skills/swarm/SKILL.md` — the upstream Antigravity-compatible swarm skill
  text (not authored here); redistributed unmodified. Check its upstream
  licensing before republishing this repo.

## Troubleshooting

- Tools missing after copying: look for `msg="loading plugin" id=swarm-board`
  in `~/.local/share/opencode/log/opencode.log`, then `/reload` or
  `opencode service restart`.
- Full reset: stop the server, delete `swarm-board.json`, restart.
