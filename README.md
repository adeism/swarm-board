# swarm-board

Antigravity-style agent swarm for [OpenCode](https://opencode.ai): a coordinator
and worker sessions talking on one shared message board — the missing board
tools behind the `swarm` skill, in a single zero-dependency plugin.
Unofficial port; not affiliated with Google.

The `swarm` skill alone is only instructions — it injects text and the board
tools (`swarm`, `post_message`, `read_board`, `swarm_wait`) simply do not
exist. This repo adds the missing half: a zero-dependency OpenCode server
plugin that registers those four tools and runs the board.

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

## Tools

| Tool | Call |
|---|---|
| `swarm` | `{action:"add", name:"parser", brief:"…"}` · `{action:"status"}` · `{action:"kill", name}` · `{action:"title", title}` · `{action:"models"}` · `{action:"model", name, model:"provider/id"}` |
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
  invoking the tool (observed live: a worker "reported" a post that never
  existed). Nothing is posted and the session goes idle — `swarm status` now
  reads live session state (`waiting (idle)` vs `working`), so nudge `@name`
  or kill/replace. Trust raw test output, never a worker's claim.
- No channels, `fork:`, `workspace:"share"` worktrees, batched `n`/`tasks`
  adds, per-provider quota in `models`, Swarm-UI panel / graph view
  (`status` answers `open_board: none`; the edge data lives in the state JSON
  if you want to draw it). Narrator/monitor are just normal workers.
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
