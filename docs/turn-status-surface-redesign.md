# Turn lifecycle & status-surface redesign

**Status:** proposal (June 2026). Authored from a four-track code audit of
`telegram-plugin/` at HEAD of `fix/config-pin-write-ebusy-fallback`.
**Goal:** replace the accreted "agent is working" papercut stack with a small
number of single-authority subsystems — durable, simple, reliable — *without*
losing any lesson the papercuts encode.

---

## 1. Why this exists

The "agent is working" UX (live activity feed, background worker feed, typing,
silence handling, sub-agent surfacing) has grown one incident-fix at a time
since ~2026-05. Each darkening / wedge / silent-turn bug got its own flag, its
own clock, and sometimes its own surface. It works most of the time, but it is
a papercut stack:

- **~9 distinct "working" surfaces** (foreground feed, feed-reopen, foreground
  sub-agent nesting, background worker feed, legacy inbound relay, two typing
  loops, 👀 reaction, cross-turn "still working (Nm)" ticker, silence-poke), plus
  a dormant answer-stream lane. The pinned progress card was removed (#1126).
- **4 separate tool-label formatters** that must agree but are maintained apart.
- **~15 silence/stall flags** across **4 independent subsystems** with no shared
  clock or model, parsed by **3 different ms-parsers** with inconsistent `=0`
  semantics, and several stale "default off / canary" comments that no longer
  match config.

The latest user-visible symptom (a productive foreground turn going dark) is not
a single bug — it is what this structure produces.

---

## 2. Current reality (audited, with cites)

All paths under `telegram-plugin/`. `gateway.ts` = `gateway/gateway.ts`.

### 2.1 Turn state is split across an eager map and a lazy atom
- `currentTurn` (module atom, `gateway.ts:2024`) — set **lazily** on the
  `enqueue` session event (`:10155`, the *only* set site). Drives feed / typing /
  silence-poke.
- `activeTurnStartedAt` (`Map`, `:1411`) — set **eagerly** on inbound receipt
  (`:12739`). Buffer/queue gate.
- These two lifetimes intentionally diverge and **can drift**: a synthetic turn
  can leave an `activeTurnStartedAt` entry that no `turn_end` ever clears
  (`:1411-1425` comment). This skew is the root of the dangling-gate wedge class
  (#1556, gymbro/klanker 2026-05-20).
- Clear paths are plural: `endCurrentTurnAtomic` (`:2937`, four `turn_end`
  branches), silence-poke fallback (`:5481`), disconnect sweep (`:6199`). Several
  documented races: late-fire (`:5282`, ~90% of fallback events), late-`text`
  drop (`:10436`, #1664), #1067 re-attribution.

### 2.2 Four label formatters; the live feed uses only one
- `computeLabel` — `hooks/tool-label-pretool.mjs:94`, the PreToolUse hook →
  writes `tool-labels-<session>.jsonl` → `tool-label-sidecar.ts` (250ms poll) →
  the **live feed** (`gateway.ts:10337`). **This is the only path the live
  foreground feed reads.**
- `describeToolUse` — `tool-activity-summary.ts:84` — used by the **sub-agent
  watcher** (`subagent-watcher.ts:807`) and drafts.
- `toolLabel` — `tool-labels.ts:154` — session-tail / draft rendering.
- Sub-agent tools never touch the sidecar; they go through `describeToolUse` off
  the sub-agent's own JSONL — a **fourth, parallel** path.
- **Three self-call filters with different membership**: `isTelegramSurfaceTool`
  (`tool-names.ts:45`, reply/stream_reply/edit_message/react only),
  `computeLabel` server-suppress (`mjs:191`, whole `switchroom-telegram` server),
  `describeToolUse` server-suppress (`tool-activity-summary.ts:84`). A tool
  filtered by one but not another behaves inconsistently across surfaces.
- **The dark-turn mechanism**: the live feed opens only via `tool_label`. If
  `computeLabel` returns `null` (empty label), no row is written; if that is the
  turn's first/only tool, **the activity message is never sent and the turn reads
  as pure silence** (`mjs:244`, gateway feed-open at `:10405`). This is exactly
  what bit the new UAT until the workload was given a labelled tool.

### 2.3 Silence / liveness / stall — four subsystems, no shared model
1. **silence-poke** (`silence-poke.ts`) — one clock; at 300s sends a user-visible
   "still working…" and **unwedges** (nulls `currentTurn`). Defer-in-flight holds
   it (bounded by a 900s hard ceiling).
2. **feed heartbeat + reopen** (`gateway.ts:1703`, `feed-reopen-gate.ts`) — ticks
   the live message every 6s; reopens a fresh feed after an ack.
3. **worker-activity feed** (`worker-activity-feed.ts`) — background sub-agents.
4. **subagent-watcher stall/synthesis** (`subagent-watcher.ts`) — adaptive
   60s/300s stall + 300s terminal-synthesis for stalled sub-agents.

Redundancies / conflicts (audited):
- `SILENCE_LIVENESS_PRODUCTION` (reset the clock on any feed render) and
  `SILENCE_DEFER_INFLIGHT_TOOLS` (let the clock hit 300s but defer the unwedge)
  are **both ON fleet-wide and target the same marko incident** — belt and
  suspenders that overlap for all but the narrow "in-flight tool, no feed render"
  case.
- silence-poke's "unwedge" and subagent-watcher's "terminal-synthesis" are **two
  independent force-close mechanisms** with no shared code, clock, or naming; a
  long foreground sub-agent is governed by both at once.
- worker feed and the cross-turn "still working (Nm)" ticker can **double-surface**
  the same background work (different env gates, no cross-gate).
- `parseEnvMs` silently ignores `=0` (`subagent-watcher.ts:458`), so the stall
  flags **cannot be disabled by env** — surprising and inconsistent with the
  `=0`-honouring kill-switches.

### 2.4 Comment / build drift
- `SILENCE_DEFER_INFLIGHT_TOOLS` is described as "default off / canary on marko"
  in code and YAML comments, but is set **`=1` fleet-wide** (`switchroom.yaml:282`).
  Only `gateway.ts:5240` notes the promotion; everything else is stale. (Fixed in
  the doc-comment commit accompanying this work.)
- The **#2461 `stepCount`/`labeledToolCount` logic is NOT in HEAD** — the deployed
  build reportedly contains it but source does not. This is a real source/build
  drift: a fresh build from source would regress that fix. Must be reconciled
  before anything else.

---

## 3. Root cause

Two questions have **no single source of truth**:

1. **Is a turn alive, and which one?** — split across `currentTurn`,
   `activeTurnStartedAt`, `claudeBusyKeys`, `activeStatusReactions`, the silence
   clock, worker-feed handles, and watcher entries.
2. **What is the agent doing, and where do I show it?** — split across 4 label
   formatters and 9 independently-gated surfaces.

Every wedge, dark turn, and double-surface traces to **drift between duplicated
authorities**. The fix is not another flag; it is collapsing the duplication.

---

## 4. The governing principle: consolidate behind the incident net

Each papercut encodes a real lesson — marko status-dark (2026-06-05), the
late-fire race (2026-05-23), gymbro/klanker dangle (2026-05-20), Tasmania
synth-terminal (2026-06-03), clerk ENOENT spam, the stale-handback replay
regression, etc. **A naive "simplify" that drops them reintroduces the bugs.**

So the order is fixed:

1. **First, encode every incident as a test** (UAT or unit). The audit's
   archaeology (§E of the silence catalog) is the list. The new
   `jtbd-foreground-feed-visibility-dm` / `-thinkgap-dm` UATs are the first two
   threads of this net.
2. **Then consolidate**, one authority at a time, each change gated by the net.

This is what makes the result durable rather than another layer.

---

## 5. Target architecture — four single authorities

### 5.1 `TurnRegistry` — one turn state machine
Replace the `currentTurn` atom + `activeTurnStartedAt` map + scattered
busy/reaction maps with one registry keyed by `chatKey`, holding an explicit
state per turn: `RECEIPT → ENQUEUED → ACTIVE → ENDING → DONE`, a timestamp, and
the subscriber set. **Receipt and enqueue become two states of one entity, not
two maps that can drift** — this dissolves the dangling-gate class. One atomic
transition function; turn-end always purges (make `endCurrentTurnAtomic` the
only clear path).

### 5.2 `ActivityBus` — one event stream, one formatter, one filter
One label formatter (merge `computeLabel` + `describeToolUse` + `toolLabel`),
**which never returns null for a real tool** (worst case `"Working…"`) so the
feed always opens. One self-call filter list. Every tool event — main turn *and*
sub-agent (foreground/background) — flows as one `{turnId, agentId, toolName,
label, ts}` event. The sidecar already carries `agent_id` but the feed ignores
it; key on it so sub-agents use the same path instead of a parallel JSONL parse.
Fixes: divergent labels, the empty-label dark-turn, the three-filter mismatch,
and the sub-agent coverage gap in one move.

### 5.3 `Liveness` — one clock, one force-close
One per-turn clock fed by the ActivityBus (any event = alive). Collapse
`LIVENESS_PRODUCTION` + `DEFER_INFLIGHT` into a single rule: *alive iff an
activity event landed within N s OR a tool is in-flight.* One threshold, one
ceiling, one parser. Merge silence-poke's unwedge and the watcher's
terminal-synthesis into one "force-close wedged work" operating on the
TurnRegistry (parent) and its sub-entries (sub-agents).

### 5.4 `SurfaceRenderer` — one renderer decides where to paint
Given turn state + ActivityBus, one renderer chooses the destination: inline
foreground feed, nested under parent, or standalone worker message — by context,
not 9 separately-gated paths. Collapse the worker-feed/ticker double-surface into
one rule. Typing and 👀 become thin derived signals of turn state, not
independent loops.

---

## 6. Migration — phased, each step shippable and UAT-gated

- **Phase 0 — reconcile drift (low risk, do first).** Resolve the #2461
  source/build mismatch (decide canonical, restore in source). Delete stale
  comments and the redundant `WORKER_ACTIVITY_FEED` YAML override. Unify the
  three ms-parsers. No behaviour change; pure de-risking.
- **Phase 1 — unify labeling (highest bang/buck).** One formatter + one filter,
  never-null. Sub-agents onto the sidecar (`agent_id`). Gated by the new
  feed-visibility UAT + a new "every tool/MCP surfaces" UAT.
- **Phase 2 — unify turn-state (`TurnRegistry`).** Riskiest; the eager/lazy
  collapse. Gated by incident regression tests (dangling-gate, late-fire,
  late-text, sibling-purge).
- **Phase 3 — unify liveness + force-close.** Retire redundant flags; one clock.
- **Phase 4 — unify the surface renderer.** Collapse double-surfacing; derive
  typing/👀 from turn state.

Each phase lands behind the growing regression net and is independently
revertible.

---

## 7. Incident regression list (must stay green through the migration)

From the audit archaeology — each becomes a test before its subsystem is touched:

- marko status-dark: a productive foreground turn never goes dark.
- late-fire race: a reply in the final ~50ms of the silence window does not emit
  a spurious "still working" nor pollute the wedge counter.
- dangling-gate (gymbro/klanker): a synthetic/silent turn never leaves an
  `activeTurnStartedAt` entry that blocks future inbound.
- Tasmania synth-terminal: a normal ~15-20s sub-agent tool does not trip
  terminal-synthesis and delete its live feed.
- stale-handback replay: a dead prior-session worker is not replayed at boot.
- feed-open coverage: any tool/MCP call (including the turn's first) opens the
  feed; no empty-label drop.
- sub-agent surfacing: foreground-nested, background-worker, and orphaned
  (outlives parent) sub-agents each surface.

---

## 8. Open questions (need sign-off before implementation)

1. **Appetite / sequencing:** phased (recommended — Phase 0+1 first, ship, then
   reassess) vs a larger single refactor.
2. **#2461 canonical source:** is the deployed build's `stepCount` logic the one
   we keep (restore to source), or was it intentionally dropped?
3. **Surface trims:** are the legacy inbound relay (#5) and the dormant
   answer-stream lane still wanted, or can the redesign delete them outright?
4. **Flag retirement:** confirm we can collapse `LIVENESS_PRODUCTION` +
   `DEFER_INFLIGHT` into one knob and drop the redundant ones.
