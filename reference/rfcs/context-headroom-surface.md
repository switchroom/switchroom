---
artefact: context-headroom visibility surface
serves: jobs/restart-and-know-what-im-running.md
relates: vision.md (pillar 2 on-leash / pillar 3 predictable)
---

# Context-headroom visibility surface

Make each agent's working-context occupancy and headroom-to-compaction
visible in `switchroom status`, `switchroom doctor`, and the web
dashboard — turning the predictability won by `ENABLE_TOOL_SEARCH=true`
(v0.15.40, ~40% baseline cut) into something the operator can see and
trust.

## Why

After v0.15.40 a fresh agent sits at ~47k of a 300k cap — predictable,
but **invisible**. The operator can't see how close an agent is to a
`/compact`, or catch a context-bloated agent before it stalls mid-task.

- **Pillar 2 (you hold the leash).** The vision asks for *"awareness +
  control, not a tool-call log to babysit."* At-a-glance context headroom
  is exactly that awareness.
- **Pillar 3 (subscription-honest & predictable).** Makes "the plan is
  the ceiling" *legible* — you see the ceiling and each agent's distance
  from it, instead of inferring it.
- **Pillar 4 (always available).** A near-cap agent is about to compact
  (a visible stall); surfacing the band lets the operator act first.

Serves `jobs/restart-and-know-what-im-running.md` — the "know what's
running" awareness job. Crosses no invariant: pure observability.

## What it surfaces (per agent)

- **occupancy** — current live working-context tokens: the latest
  usage-bearing assistant turn's `input + cache_read + cache_creation`
  (the prefix the model re-reads each turn ≈ window fill). This is the
  *same* metric proactive-compaction reads (`gateway.ts:3000`), so the
  surface can never disagree with what actually triggers a `/compact`.
- **cap** — `session.max_context_tokens` (300k on this fleet; `null`
  when unset → occupancy shown without a ratio, native compaction only).
- **headroom / pct** — `cap − occupancy` and `occupancy / cap`.
- **state** — `ok` / `tight` (≥ `TIGHT_FRACTION`, default 0.8) /
  `unknown` (no snapshot yet).

Example: `marko  context 250k/300k (83% · tight)` · `clerk 47k/300k (16%)`.

## Data path (no new computation, consistency-safe)

The gateway already computes occupancy at the turn-end idle gate for
proactive-compaction. P1 writes that value (and the resolved cap) to a
snapshot at `<agentDir>/context-occupancy.json` on every idle pass —
crucially **even when no cap is configured** (proactive-compact returns
early without a cap; the snapshot must not). Host surfaces read the
snapshot (via `docker exec … cat`, the same way `status` already runs
`claude mcp list` per agent). No per-turn model cost; reads a value the
gateway already has.

## Surfaces (consistent shape, phased)

1. **P1 — gateway writer.** `context-occupancy.ts`: pure
   `buildContextOccupancy(occupancy, cap)` → snapshot + best-effort
   `writeContextOccupancySnapshot`. Called beside `maybeProactiveCompact`.
2. **P2 — `switchroom doctor`.** A "Context" section that WARNs agents in
   the `tight` band (mirrors the connection-health section). And a
   `switchroom status` per-agent context column.
3. **P3 — web dashboard.** Per-agent context gauge on the fleet view.
4. **P4 (optional) — Telegram `/status`.** A context row in the Health
   block (reuses `runAllProbes`, like `probeConnections`).

## Principle checks

- **Docs test:** `context 47k/300k (16%)` is self-explanatory. ✅
- **Defaults test:** works on a fresh install — occupancy already exists;
  cap falls back to native (shown as occupancy only). ✅
- **Consistency test:** same row/section shape as the existing health
  surfaces + the connection-health probe. ✅

## Non-goals / risk

- Does **not** change compaction behavior — pure observability.
- No new model calls; reads cached occupancy (no per-turn cost).
- Read-only; crosses no invariant (claude-native / on-leash /
  single-tenant untouched). Snapshot is best-effort: a missing/stale file
  reads as `unknown`, never an error.
