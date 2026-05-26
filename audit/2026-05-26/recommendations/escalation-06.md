# Recommendation: Escalation 6 — rfc-sub-agent-visibility:c11 (AC-4 stuck render may not be wired)

**Recommended option:** B

**Confidence:** high

## Why

The end-to-end trace is conclusive: the `markStuck` function in `fleet-state.ts` is dead production code. It is exported and tested in `tests/fleet-state.test.ts`, but no production file imports it or calls it. The only production import of `fleet-state.ts` is in `subagent-watcher.ts:44`, and it imports only `sanitiseToolArg` — not `markStuck`, `FleetStatus`, or any of the state-transition functions. `progress-card-driver.ts` does not import `fleet-state.ts` at all.

The AC-4 claim describes a per-fleet-member ↻→⚠ glyph flip with an `idle <duration>` label. That would require `FleetMember.status` to reach `'stuck'` and then a renderer to branch on that status value. Neither happens. The `FleetStatus` type includes `'stuck'`, and `markStuck` correctly transitions a member to it, but the renderer that produces the sub-agent zone (`renderSubAgent` in `progress-card.ts`) operates on `SubAgentState`, not on `FleetMember`. `SubAgentState.state` is typed as `ItemState` (`'pending' | 'running' | 'done' | 'failed'`) — there is no `'stuck'` branch, no ⚠ glyph, and no `idle <duration>` label in that renderer.

What IS wired is a different, coarser stall signal: the driver's heartbeat passes a `stuckMs` value (the age of `cs.lastEventAt`) to the card-level `render()` in `progress-card.ts`. When `stuckMs >= STUCK_THRESHOLD_MS` (2 min), the renderer inserts `⚠️ No events for <gap> — likely stuck.` as a header-level line. This is a card-wide warning, not per-fleet-member row glyph flipping from ↻ to ⚠. The `onStall` callback from `subagent-watcher.ts` routes to `progressDriver?.onSubAgentStall(...)` in `gateway.ts`, but `progressDriver` is permanently `null` (deleted in PR #1122 — see `gateway.ts:3046`), so those calls are no-ops at runtime.

The RFC itself notes that `two-zone-card.ts` was the renderer for the AC-4 fleet zone, but that file no longer exists. The current renderer is `progress-card.ts` which does not have the per-member stuck-glyph path at all.

AC-4 as specified — per-member row glyph flipping to ⚠ with `idle <duration>` — has no production implementation. The state model (`fleet-state.ts:markStuck`) exists but is unreachable from the render pipeline. Option B is the correct verdict.

## Tradeoffs of the recommendation

- Updating the RFC to mark AC-4 as partially implemented (state machinery exists, render path absent) is honest and prevents future confusion about what shipped.
- The coarser card-level `stuckMs` warning does provide _some_ stuck signal to users (at 2 min, card-wide), so the user-facing gap is narrower than it might appear — but it is not AC-4 as written.
- `markStuck` should either be connected to the render pipeline or removed; leaving it as tested-but-unreachable dead code is a maintenance liability (tests give false confidence the feature works).
- The `onStall` → `progressDriver?.onSubAgentStall(...)` call in gateway.ts is also dead (progressDriver = null). If the progress driver is ever reinstated, the wire exists at the gateway level but the renderer-side branch (`FleetMember.status === 'stuck'` → ⚠ glyph) would still need to be added.

## If you pick a different option

- **Option A (confirm wire exists):** Not viable. The trace above is exhaustive. `markStuck` is unreachable from production, `progressDriver` is null, and `renderSubAgent` has no stuck branch. There is no wire to document.

## Open question for the operator

Should `markStuck` be removed from `fleet-state.ts` (and its tests) as dead code, or is the intent to connect it in a follow-up? The answer determines whether the RFC follow-up is "add the render branch" (connect it) or "remove the dead state function" (clean up). Both are valid but they are different scopes.
