# RFC — Eliminate `claude -p` (programmatic usage) from switchroom

> Status: accepted — 2026-05-21 (Workstream A shipped in #1625;
> Workstream B in #1626). Companion to `reference/vision.md`
> (pillar 3 — *subscription-honest*). Driven by the 2026-06-15 Anthropic
> billing-policy change.

## Why this RFC

On **2026-06-15** Anthropic reclassifies `claude -p` and the Claude
Agent SDK as **"programmatic usage."** Programmatic usage runs on a
separate **$200/month Max-20x credit** plus metered overage, and
**no longer counts against subscription limits**. Subscription limits
stay reserved for *interactive* Claude Code / Cowork / chat.

Switchroom's design contract (`reference/vision.md`, pillar 3) is
**subscription-honest** — Pro/Max is the ceiling. A 9-agent always-on
fleet cannot live inside a $200/month credit. Therefore every model
call switchroom makes must be **interactive Claude Code**. Any
`claude -p` is now a programmatic surface: a recurring cost leak and a
classification liability.

**The prize is not just cost.** Remove every `claude -p` and 100% of
switchroom's model usage becomes the interactive `claude` session —
cron, webhooks, everything enters as synthesized turns *into* that
session. There is no programmatic surface left to classify. That is
the strongest possible position for the June 15 interactive-vs-
programmatic line: nothing to argue about.

## Audit (2026-05-21)

Exactly **two** real `claude -p` spawn sites remain:

| Callsite | Fires | Model |
|---|---|---|
| `src/agents/handoff-summarizer.ts:308` | every turn (handoff Stop hook) | Haiku 4.5 |
| `src/web/webhook-dispatch.ts:468` (`spawnAgentOneShot`) | per inbound web webhook | configurable |

The main agent session is interactive `claude` — unaffected. Cron was
already migrated off `claude -p` in Phase 4 (fires fold into the live
session via `inject_inbound`) — out of scope.

## Goal

**Zero `claude -p` invocations in switchroom.** Every model call is
either (a) the interactive main agent session, or (b) a synthesized
turn injected into it. Enforced by a CI guard so it stays at zero.

## Non-goals

- The main interactive `claude` session is not touched.
- No adoption of the Agent SDK.
- Cron — already migrated, out of scope.
- Re-litigating the June 15 interactive-vs-programmatic classification —
  separate track.

## Prerequisite gate

**Workstream B does not begin until the bridge-flap fix (#1616) is
released and verified flap-free across the whole fleet** — v0.13.3 cut,
rolled to all 9 agents, gateway logs confirmed clear of `bridge
reconnect race`.

Rationale: the handoff rework is the larger change and sits in a
JTBD-critical path; it must land on a known-good base, not be stacked
on an unverified flap fix. Status as of 2026-05-21: #1616 is **merged
to `main` and canary-verified on test-harness** (6 turns, 0 parasitic
bridges, 0 reconnect races). The remaining step is the v0.13.3 release
+ staggered fleet rollout.

---

## Workstream A — Webhook dispatch

### Current
`src/web/webhook-dispatch.ts` `spawnAgentOneShot` spawns
`claude -p <prompt> --model <m> --no-session-persistence` per inbound
web webhook. (It is also the open bug #1617 — the headless claude
auto-loads `.mcp.json` and spawns a parasitic bridge.)

### Target
Reuse the Phase-4 cron pattern: synthesize an `InboundMessage`
(`dispatchAsInbound`, `meta.source="webhook"`) and inject it via
`inject_inbound` IPC into the live gateway. The webhook work then runs
as a turn in the main interactive session.

### Why this is right, not new design
The webhook→agent path is structurally identical to cron→agent, which
Phase 4 already solved. webhook-dispatch is simply an un-migrated
callsite.

### Accepted behaviour change
Webhook work now appears in the agent's main session history (a real
turn) rather than an isolated `--no-session-persistence` run. This
matches cron and is desirable — the agent sees the event in context.

### Success criteria
- **SC-A1** — `src/web/webhook-dispatch.ts` contains no `spawn(…claude…)`
  and no `claude -p`. `spawnAgentOneShot` is removed or rewritten to
  inject.
- **SC-A2** — a webhook fire produces exactly one synthesized inbound
  (`meta.source="webhook"`) in the gateway log and **zero** new
  `claude` processes (process audit).
- **SC-A3** — #1617 closed: a webhook fire spawns no second bridge
  (bridge-lifecycle audit shows 0 extra bridge registrations).
- **SC-A4** — webhook-dispatch tests updated and green; a test asserts
  the no-spawn contract.
- **SC-A5** — a webhook arriving while the agent is mid-turn or offline
  buffers and is delivered on availability — no loss, same guarantee
  as cron.

### Effort
~45–60 agent-min. Independent of the gate — may proceed in parallel
with the v0.13.3 release cycle.

---

## Workstream B — Handoff summarizer (the big piece)

### Current
`src/agents/handoff-summarizer.ts` fires a Haiku `claude -p` on **every
turn** (handoff Stop hook) to regenerate `.handoff.md` + `.handoff-topic`.
The output is consumed **only at the next session start**. Per-turn
generation of a rarely-consumed artifact is the core waste.

### What the feature provides
Restart continuity — the "restart-and-know" JTBD (#27). After an agent
process restarts, the new session is seeded with the briefing so it
knows what it was doing, **including in-flight task state that may not
yet be written to `MEMORY.md`**.

### Options
- **B1 — Native `--continue`, delete the summarizer.** Launch the
  post-restart session with claude's native `--continue` (resume the
  prior session). Large sessions are handled by claude's built-in
  context compaction — *inside* the interactive (subscription) session.
  `resume_mode` already has a `continue` value; make it the default
  and delete the handoff path. Zero `claude -p`, least code.
- **B2 — Self-orient from a transcript tail.** Delete the summarizer;
  on restart, seed the new session's first turn with a bounded raw
  transcript tail and let the interactive session orient itself. More
  controlled than raw `--continue`; costs a slightly heavier first
  turn (subscription-funded).
- **B3 (rejected)** — generate the briefing once at restart instead of
  per-turn. Still a `claude -p`; does not meet the zero-`claude -p`
  goal.

### Decision
**B2 — transcript-tail self-orient** (operator, 2026-05-21).

On restart the new interactive session is seeded, on its first turn,
with a bounded raw transcript tail and orients itself in-session. No
`claude -p`; the summarization cost moves into the subscription-funded
interactive session, and the context handed forward is bounded and
controlled rather than whatever `--continue` happens to carry. B1
(native `--continue`) was considered and set aside: a raw resume
carries more stale tool/turn state than a deliberate tail, and the
restart-and-know JTBD wants a clean, bounded handoff.

### Success criteria
- **SC-B1** — no `spawn(…claude…)` / `claude -p` anywhere in
  `src/agents/handoff-summarizer.ts` (module deleted, or reduced to
  pure transcript-extraction helpers if those are reused elsewhere).
- **SC-B2** — zero `claude -p` processes over a 20-turn driven
  workload (process audit / the `/proc`-ancestry technique from
  #1613).
- **SC-B3** — the restart-and-know UAT (#27,
  `jtbd-…-after-restart-dm`) passes: the agent, after a restart,
  correctly knows what it was doing.
- **SC-B4** — **mid-task crash** scenario: an agent restarted mid-task
  resumes or explicitly acknowledges the in-flight task (the case
  `MEMORY.md`-alone would miss).
- **SC-B5** — cold-start TTFO (first turn after restart, measured per
  the #38 infra) does not regress beyond a threshold agreed at canary
  time against the v0.13.3 baseline.
- **SC-B6** — `jtbd-memory-survives-restart-dm` UAT still green.

### Effort
RFC-approved → ~90–150 agent-min + a test-harness canary.

---

## Program-level success criteria

- **SC-0** — a source scan finds no real `claude -p` spawn in `src/`
  or `telegram-plugin/` (comments / docs / tests excluded).
- **SC-1** — a **CI guard** (a test that scans source) fails the build
  if any new `spawn('claude'` / `claude -p` callsite is added. This is
  what makes "zero" durable rather than a point-in-time cleanup.
- **SC-2** — over a full UAT run + driven turns + one cron fire + one
  webhook fire, a process audit shows only interactive `claude`
  sessions — zero `-p`.
- **SC-3** — no regression in the affected JTBDs: restart-and-know
  (#27), the webhook job, memory-survives-restart.

## Sequencing

1. **Gate** — release v0.13.3 (#1616), staggered fleet rollout,
   confirm flap-free fleet-wide. *Prerequisite for B.*
2. **Workstream A** — webhook migration (small; also closes #1617).
   May run in parallel with step 1 — independent code.
3. **Workstream B** — handoff rework per the approved option (B2).
4. **SC-1 CI guard** — landed with whichever workstream merges last.

## Risks

| Risk | Mitigation |
|---|---|
| B2 transcript tail is noisier / less navigable than an LLM summary | The tail header tells the next session to reorient from it *and* its memory files; `TURN_TEXT_MAX_CHARS` + `maxTurns` bound the size |
| Cold-start TTFO regression — the tail adds tokens to `--append-system-prompt` | Bounded by `maxTurns` × `TURN_TEXT_MAX_CHARS`; canary measures first-turn-after-restart TTFO against the v0.13.3 baseline (SC-B5) |
| Webhook turns now visible in main session history | Accepted — matches cron, desirable |

## Decisions

- **B1 vs B2 for Workstream B** — resolved 2026-05-21: **B2**
  (transcript-tail self-orient). See Workstream B § Decision.
