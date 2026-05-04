---
artefact: Telegram progress card
serves: `know-what-my-agent-is-doing.md`
status: design v2 — supersedes the expandable-blockquote v1
---

# Status card design (v2)

The status card is the central artefact for [know what my agent is actually
doing](know-what-my-agent-is-doing.md). v1 (expandable `<blockquote>` per
sub-agent) failed the JTBD: the parent gateway never had per-sub-agent
internal tool-call data to put inside the blockquote, so the expandable
section was effectively empty regardless of how busy the sub-agent was.
This doc specifies v2 — a two-zone card that surfaces the actual fleet
state, including background sub-agents (the explicit fix for #64).

## What the user must see at a glance

> **Is work happening — anywhere — and how long has it been going.**

Header phase reflects the union of main + foreground sub-agent +
background sub-agent activity. ✅ Done fires only when every contributor
has reached a terminal state. The user never has to ask "is it still
working?" because a stalled or background-only state is visibly distinct
from active work, and from done.

## Layout

```
<icon> <label> · ⏱ <elapsed> · <tools>t · <subs>s

PARENT
● <main-agent tool> [...]
● <main-agent tool> [...]

FLEET (N)
<icon> <role> <id6> · <tools>t · <last activity>
<icon> <role> <id6> · <tools>t · <last activity>
+ N more
```

`PARENT` is omitted if the main agent has emitted no tool calls this
turn. `FLEET` is omitted when no sub-agents have ever participated in
this turn (clean lightweight card for direct-answer turns — matches the
existing "good" render shape).

## Header

One line, ambient. Phase resolver consumes (parent state, fleet state)
and yields exactly one of:

| Glyph | Label | Condition |
|---|---|---|
| ⚙️ | Working… | Any contributor running, parent in flight |
| ⏸ | Background | Parent turn ended, ≥1 background sub-agent still running |
| ⚠ | Stalled | Parent idle AND every running fleet member idle > 60s |
| ✅ | Done | Parent `turn_end` received AND every fleet member terminal (done/failed/killed) |
| 🙊 | Ended without reply | Parent terminal AND no reply tool fired AND no captured text |
| ⚠ | Forced close | Watchdog-driven turn close; supersedes all others |

Counters: `Nt` total tool calls across all contributors (cap `99+`),
`Ns` total sub-agents that ever participated this turn (running +
terminal). Elapsed measured from parent `turn_start`.

## Parent zone

Bullets of main-agent tool calls in arrival order. Each bullet:
`● <tool-name> [<sanitised arg>]`. Cap visible bullets at the most
recent 8 with `(+ N earlier)` prefix when truncated.

## Fleet zone

One row per sub-agent. Order: most-recent-activity first. Cap at 5
visible rows; surplus collapses to `+ N more` footer.

| Glyph | Status | Meaning |
|---|---|---|
| ↻ | running | Last JSONL activity within 60s |
| ⚠ | stuck | Running but idle > 60s — visible escalation |
| ✓ | done | Sub-agent `turn_end` reached without errors |
| ✗ | failed | Sub-agent `turn_end` reached after ≥1 `isError` tool result |
| ⏸ | background | Running sub-agent dispatched with `runInBackground=true` |

Row format: `<glyph> <role> <id6> · <Nt>t · <last activity>`

- `role`: derived from the Agent tool dispatch description. Fallback:
  `subagentType` from the spawn event. Final fallback: `"agent"`.
- `id6`: first 6 chars of `agentId`.
- `last activity`: `<tool> [<sanitised arg>] (<age>)` while running;
  `<status> <relative-time>` once terminal (e.g. `done 12s ago`,
  `turn-limit 1m ago`).

Rows survive completion. They drop only when the card unpins (parent
turn fully done). Receipt principle from the JTBD doc: "the work leaves
a receipt".

### Sub-agent failure status

`session-tail.ts` does not emit a per-sub-agent ok/error signal at
turn_end (verified — the terminal event `sub_agent_turn_end` carries
only `{kind, agentId}`). Failure is **derived**: the reducer accumulates
any `sub_agent_tool_result` with `isError=true` during the sub-agent's
lifetime, and at `sub_agent_turn_end` sets the row's status to `failed`
if any error was seen, else `done`.

### Background sub-agents — the explicit fix

Background sub-agents (dispatched with `runInBackground=true`) are
pinned to the **originating** turn's card, not migrated to subsequent
turns. The card stays pinned and live-updating until every background
sub-agent on it reaches a terminal state. This is the explicit fix for
#64 (which has been open for 6 months — the gap where background
sub-agent activity was silently invisible).

Implementation: the driver snapshots `currentTurnKey` at
`sub_agent_started` ingest time (no event-schema change required). A
new background-registry Map outside the per-turn `chats` map carries
the lifecycle so that the per-turn dispose path
(`progress-card-driver.ts:967` `subAgentCards.finalizeAll(...)`)
doesn't drop them.

If a new main-agent turn arrives while a background sub-agent is
running on a prior turn's card: the new turn gets its own card; the
prior card stays alive and updating until its background members
finish.

## Stuck escalation

Per fleet member: if `now - lastActivityAt > 60_000` while status is
`running`, row glyph flips to ⚠ and label becomes `idle <duration>`.
If every running fleet member is stuck AND parent narrative is also
idle, header phase escalates to ⚠ Stalled. Recovery: any subsequent
JSONL event from any stuck member reverts that row to ↻ and
de-escalates the header.

## What we drop from v1

- `renderSubAgentExpandable` (`progress-card.ts:1594-1681`) — entire
  function and its caller branches in `render()`.
- The `<blockquote expandable>` rendering path that produced
  unbalanced HTML when many sub-agents were active (see klanker
  gateway log lines 1329, 1382 — Telegram 400 `Can't find end tag
  corresponding to start tag "blockquote"`).
- The per-agent-cards env flag and its branches in
  `progress-card-driver.ts:832, 963, 1747, 2206`. The fleet zone
  subsumes per-agent visibility.
- `subagent-card.ts` — pending import-trace confirmation in P4.

## Render invariants (property-tested)

For any input state with fleet size 0..50 and any tool-arg shape:

1. **Balanced HTML.** Output passes a tag-balance validator. No more
   blockquote 400s.
2. **Size cap.** Output `< 4096` bytes (Telegram's hard limit on
   single message body).
3. **Idempotency.** Calling `render(state, now)` twice with the same
   inputs returns identical output.
4. **No raw secrets.** Tool args containing path-shaped tokens with
   secret-like fragments are basenamed/redacted before render.

## Data plumbing

Already in place:
- `subagent-watcher.ts` polls sub-agent JSONL transcripts at 1Hz
  (`DEFAULT_RESCAN_MS = 1000`, `subagent-watcher.ts:198`).
- Per-worker state already includes `lastActivityAt` (`:385`),
  `toolCount` (`:387`), `lastSummaryLine` (`:393`).

Required additions:
- New field `lastTool: {name, sanitisedArg}` on watcher's
  `WorkerEntry` (~2-line change at `:387`).
- New `FleetMember` struct in `telegram-plugin/fleet-state.ts`,
  populated from watcher emits.
- Driver snapshot of `currentTurnKey` at `sub_agent_started` ingest
  to support background-card pinning.

## UAT prompts

For agents building or evaluating the v2 card. From the JTBD doc's
existing UAT pattern.

- **Background dispatch and continue.** Send a request that spawns a
  background sub-agent, then immediately send a different request.
  The original card must keep updating with the background member's
  progress after the second turn replies and unpins its own card.
- **Heavy fleet.** Send a request that spawns 6+ sub-agents in
  parallel. Header counters tick. Fleet zone caps at 5 rows + N more.
  No `<blockquote>` 400 in the gateway log (verify via `tg-post`
  observability from #659).
- **Stuck detection.** Pause a sub-agent (e.g. SIGSTOP its process).
  Within 90s the row glyph flips to ⚠ and the label shows
  `idle <duration>`. If it's the only running member, header escalates
  to ⚠ Stalled.
- **Failure receipt.** Force a sub-agent to error (e.g. dispatch a
  worker with a deliberately malformed prompt). Row terminal status
  is ✗ failed with the error class visible.
- **Done semantics.** Parent reply lands but a background sub-agent
  is still running. Header MUST be ⏸ Background, never ✅ Done. After
  the background sub-agent completes, header flips to ✅ Done.

## Acceptance criteria

See the implementation issue for the full 14-AC list with 1:1 test
mapping. The ones most likely to regress:

- **AC-1** Background sub-agent visible on parent's pinned card ≥30s
  after parent reply landed.
- **AC-2** Header shows ✅ Done only when parent + every fleet member
  are terminal.
- **AC-3** Render output balanced HTML and `< 4096` bytes for any
  fleet size and tool-arg shape.

## Why we believe this design is right

- Matches the JTBD doc's "ambient | structured | narrative" framing:
  header = ambient, parent zone = structured, fleet zone = narrative
  (per sub-agent).
- The two-zone layout makes the fleet legible without burying the
  parent zone — solves the visual-dominance problem documented in the
  comparison between clerk's clean card and klanker's heavy-fleet
  card.
- Background sub-agent persistence finally implements #64 — the gap
  that has caused users to ask "what's it doing?" mid-background-work.
- Render invariants close the failure mode that produced the
  blockquote 400s in production.
