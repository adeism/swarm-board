# Group adds (`n` / `tasks`) — design

Date: 2026-11-16 · Status: shipped (2026-11-16) · Scope: small change

> The human partner delegated the remaining choices ("pilihkan yg terbaik"), so the
> calls below are mine and are listed in **Implemented as**.

## Intent and why

The upstream `swarm` skill tells a coordinator: when the user asks for many agents
or a sharded pool, pass `tasks` (one slice per worker, shared instructions in
`brief`) or `n` (homogeneous copies) to `add`, spawning `<name>-1`…`<name>-k` in
one call, with `@<name>` and `kill{name:"<name>"}` addressing the whole group and
`@<name>-1` a single copy (`SKILL.md:123-126`). Our plugin does not implement it,
so a coordinator that follows the skill gets a schema error
(`additionalProperties: false`). This closes that gap. No new protocol is
invented: the shape comes from the skill text.

## Goals

- `add{name, brief, n:k}` → members `name-1`…`name-k`, same brief.
- `add{name, brief, tasks:[…,"slice per worker"]}` → same naming, each member's
  brief is `brief` + its own slice.
- `@name` addresses the whole group (wakes every copy, `read`/prompt rules
  unchanged); `@name-2` addresses that one copy.
- `kill{name:"name"}` kills the whole group; `kill{name:"name-2"}` one copy.
- Partial failure is reported, not hidden.

## Non-goals

- No `fork:` (this OpenCode build has no `session.fork` — probed live 2026-11-16),
  no `workspace:"share"/"branch"`, no narrator, no per-group quota in `models`.
- No group-level marker or stall accounting: markers, heals and stall silence stay
  per member, exactly as today.
- No UI change: group members are ordinary rows in Members and nodes in Graph.

## Anti-goals

- A group that looks like one member to the board (the whole point is separate
  sessions and separate `[done]` reports).
- Silent partial spawns: "added 5 workers" when only 3 exist.

## Constraints

- One file, zero dependencies, same `export default { id, setup }` shape; helpers
  stay in `_pure` for tests (`plugins/swarm-board.js:1017`).
- Names: existing rule `^[a-z0-9][a-z0-9-]*$`, `all`/`coordinator` reserved,
  killed names never reused — group members are normal members, so all of it applies.
- State file stays plain JSON; old boards (no `group` field) must keep working.

## Approaches considered

1. **Chosen: a `group` field on the member record.** Members spawned by `n`/`tasks`
   carry `group: "<base>"`; addressing = exact name **or** `group` match. Explicit
   `add{name:"marker-1"}` stays a lone member, so `@marker` does not wake it by
   accident. Cheap, explicit, testable, and old members simply have no `group`.
2. Infer the group from the name pattern `^base-\d+$`. Zero state, but two
   unrelated members (`marker` and a hand-added `marker-1`) would start waking each
   other, and a killed group member would still match by name. Rejected.
3. A separate `groups` map on the board. One more structure to keep in sync with
   `members` for something a single field already expresses. Rejected.

## Decided behaviour

- **Validation, before anything spawns.** `n` and `tasks` are mutually exclusive.
  `n` is an integer 2-8; `tasks` is 1-8 non-empty strings (cap 8: my call — a local
  server runs a handful of sessions, and one `add` that spawns 30 would just make
  everyone wait). Both `n`/`tasks` absent → today's single `name`. Every target
  name must be free, otherwise the whole call fails with nothing spawned.
- **Spawn loop.** Sequential, per member: board post `@name-i <brief + slice>` in
  the member's first channel, `session.create`, `session.prompt` with the existing
  `WORKER_RULES`, `save()`, `writeUi()`. Sequential (not `Promise.all`) is my call:
  it keeps post order readable and avoids a thundering herd on a local server; k ≤ 8.
- **Failure.** The loop stops at the first failure and the tool *returns* (does not
  throw) `added: @p-1, @p-2 · failed at @p-3: <message> · retry with add{name:"p-3"}`.
  Members already spawned stay alive and on the board.
- **Group wake.** `deliver()` and `wakeHit()` resolve a mention token to
  "exact member OR member whose `group` equals the token" through one new `_pure`
  helper, so prompts, parked waiters and `@all` keep the rules they have today
  (`@all` already reaches everyone, group or not).
- **Kill.** Same helper: one token → the set of members to kill; output lists each.
- **Member awareness.** When a member has a `group`, `WORKER_RULES` adds one line:
  the group exists, `@<group>` posts are for all copies, so reply only when the
  post names your copy or your slice. (The brief is what distinguishes the slices.)
- **Status.** Unchanged format; group members appear as their own lines
  (`parser-1: waiting (idle) [done] …`), which is what the skill's stall/heal loop
  already parses.

## Left to the builder

Exact wording of the added `WORKER_RULES` line and the README bullets; test names.

## Evidence expected

- `_pure` tests extended: `expandAddTargets` naming/validation (n, tasks, both,
  cap, taken names), group addressing (exact vs group vs unrelated `-1`),
  `wakeHit` through a group mention, kill expansion.
- One live check: `add{n:2}` on a test board, `status`, `@base` wakes both copies,
  `@base-1` wakes one, `kill{name:"base"}` kills both.

## Implemented as (my calls)

- **`n` is 1-8**, not 2-8: `n:1` spawns `<base>-1` and still forms a group (so
  `@base` reaches it). The cap of 8 is enforced twice — by the tool schema and in
  code (`GROUP_CAP`), so a caller bypassing the schema still cannot spawn 30.
- **No retry, no stagger.** The local engine was down/restarting during both live
  failures; a 20 s retry would not have helped, and 4 concurrent probe requests
  returned 200 (the 1-slot engine queues). Adding either would be speculative.
- **Failed first prompt is recorded immediately** (`stopped: first prompt failed: …`)
  instead of leaving a member that never got `WORKER_RULES` sitting at `working`
  forever (its session has no outcome to reconcile).
- **`action:"model"` accepts a group name** and switches every copy — the same
  token→members rule, one loop.
- **Tests moved into the repo** (`test/pure.test.mjs`, `node --test`, zero deps):
  the shipped plugin is the test target, so the README's claims stay checkable.
- Kept the single-member return format (`#12 @x added on #main (session …)`) so
  existing README evidence and the skill's expectations still match.
