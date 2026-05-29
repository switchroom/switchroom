# Status-ask rate → zero — cause-class catalog

> **Retirement note (2026-05-29).** The L3 silence-poke *ladder* this
> catalog was written against no longer exists. The model-targeted
> nudges (ack at 10s, soft at 75s, firm at 180s) and the 60s
> user-visible awareness ping were retired once the live-updating
> reply/draft took over the acknowledgement + progress beats — see
> `reference/conversational-pacing.md` for the current design. Only the
> **300s framework fallback + unwedge** survives. Consequently the
> cause classes that describe the ladder are now historical: **CC-3**
> (soft poke wire path) and **CC-5** (`subagentDispatchActive` leak)
> describe mechanisms that have been deleted, and the soft/firm halves
> of **CC-4** are moot — only the 300s wording still applies. The
> dated progress log and final report below are left intact as an
> accurate record of the 2026-05-13 work; read them as history, not as
> current state.

**Goal** (week of 2026-05-13): drive `inbound_status_query` to zero by closing the gaps between the conversational-pacing redesign (#1122) and what is actually exercised by tests.

The JTBD anti-signal lives in `reference/know-what-my-agent-is-doing.md` § "Signs it's working":

> The user never feels the need to ask "status?", "what are you doing?", "still there?", "any update?". If they do, the product is failing at its core job.

PostHog tracks this as `inbound_status_query` (primary lagging KPI). The classifier lives in `telegram-plugin/inbound-classifier.ts`. The three-layer model that should keep the rate at zero is documented in `reference/conversational-pacing.md`:

| Layer | Owns | Implementation |
|---|---|---|
| L1 Ambient | 👀→🤔→🔥→👍 reaction lifecycle on the user's inbound | `telegram-plugin/status-reactions.ts` |
| L2 Conversational | Paced `reply` calls + `disable_notification` mid-turn | `profiles/_shared/telegram-style.md.hbs` |
| L3 Safety net | 300s framework fallback + unwedge (the 75s/180s nudge ladder was retired — see banner) | `telegram-plugin/silence-poke.ts` |

Every cause class below is a way the three layers can fail in production *without breaking any current test*. The catalog is what informs the PR series.

## Existing coverage (so we don't duplicate)

UAT scenarios (`telegram-plugin/uat/scenarios/`):

- `jtbd-status-query-dm.test.ts` — asserts "status?" inbound doesn't crash the agent (classifier safety, not the underlying cause).
- `jtbd-soft-commit-dm.test.ts` — TTFO < 30s on slow prompts (L2 soft commit).
- `jtbd-rapid-followup-dm.test.ts` — steering vs. queued classification.
- `silent-end-recovery-dm.test.ts` — `silent_end_recovered` path (#1129/#1131).
- `bg-sub-agent-dispatch-dm.test.ts` — background sub-agent narrates completion (#1108 unskipped after RFC).
- `subagent-watcher-no-rerun-dm.test.ts` — sub-agent watcher doesn't loop.
- `reactions-trigger-turn-dm.test.ts` — bot reaction triggers synthetic turn.
- `fuzz-random-prompts-dm.test.ts`, `fuzz-extended-dm.test.ts`, `fuzz-human-style-dm.test.ts` — probabilistic fuzz (no crash, no ghosting, no credential leak).

Unit tests (`telegram-plugin/tests/`):

- `silence-poke.test.ts` — tick semantics (soft / firm / fallback / subagent override / kill switch).
- `status-reactions.test.ts` — debounce, terminal states.
- `inbound-classifier.test.ts` — regex patterns.

Two known-stale scenarios:

- `reactions-dm.test.ts` — `describe.skip` with rationale "the card renders INSTEAD of reactions." The card was deleted in #1126; rationale no longer applies.
- `progress-card-dm.test.ts` — gated by `progress_card.delay_ms: 1000` config override. That block was removed from the schema in #1122 PR3 (`src/config/schema.ts:474` documents the removal). The scenario is unrunnable in principle.

## Cause classes

Each entry: ID, name, layer, failure shape, evidence, smallest UAT that would pin it, fix-class.

### CC-1 — Reaction lifecycle stuck on intermediate emoji

- **Layer:** L1 ambient.
- **Failure shape:** User sends a slow turn. Reaction goes 👀 → 🤔. Turn finishes, but the reaction never advances to 👍 (debounce dropped the terminal, or the terminal `setDone()` errored silently). User scans the chat, sees their last inbound still wearing 🤔, asks "you done?". Counts as `inbound_status_query`.
- **Evidence:** `status-reactions.ts:292` clears terminal emoji `['👍', '👀', '✍']` on shutdown — implies they can persist past intent. `active-reactions-sweep.ts` exists specifically to clean up leftovers. No real-Telegram UAT asserts the terminal reaction lands within a turn-end deadline.
- **Smallest UAT:** Driver sends a slow DM, waits for bot reply, asserts within 5s of bot's final outbound the reaction on the driver's inbound is in `done` set (`👍 / 💯 / 🎉`).
- **Fix class:** UAT scenario + possibly a `lastReactionEmoji` invariant check in the gateway turn-end hook.

### CC-2 — Mid-turn updates ping the device (notification fatigue)

- **Layer:** L2 conversational.
- **Failure shape:** The prompt instructs the model to pass `disable_notification: true` on mid-turn replies. If the model forgets — or if a code path in `telegram-plugin/gateway/gateway.ts` drops the flag — every mid-turn pings. User mutes the bot, then can't tell working from done, then asks "are you alive?".
- **Evidence:** `profiles/_shared/telegram-style.md.hbs:10` is prompt-level — no enforcement at the wire. `telegram-plugin/silence-poke.ts` framework fallback explicitly **does** ping (intentional), but the model-driven mid-turn replies must not.
- **Smallest UAT:** Slow multi-step prompt; observe inbound updates via mtcute; assert that all bot messages except the final have `silent=true` or equivalent notification suppression. Currently no real-Telegram UAT asserts notification flags.
- **Fix class:** UAT scenario; if it fails, harden the gateway to default mid-turn to silent regardless of model omission.

### CC-3 — Silence-poke soft never reaches the model end-to-end

- **Layer:** L3 safety net.
- **Failure shape:** Unit tests (`silence-poke.test.ts`) prove the timer arms a poke at 75s. The `consumeArmedPoke` chokepoint at `gateway.ts:onToolCall` should drain it into the next tool-result envelope. If `onToolCall` is bypassed (rare tool-result code paths, MCP framing change, race during shutdown), the poke arms but never lands → user sees no update at 75s → asks "still there?".
- **Evidence:** No UAT exercises a real 75s+ silent tool-churn period and asserts the model emits a recovery reply. Unit tests cover the state machine but not the wire path.
- **Smallest UAT:** Drive a long-running prompt that consumes 90s of tool churn before its first outbound. Assert the bot emits a brief mid-turn `reply` between 75–110s (window covers the 5s poll + 15s success window). Capture `silence_poke_succeeded` event from local PostHog JSONL.
- **Fix class:** UAT scenario; if the poke is armed but doesn't land, follow the trace through `gateway.ts:onToolCall` and add a regression unit test.

### CC-4 — Framework fallback wording goes stale

- **Layer:** L3 safety net.
- **Failure shape:** At 300s the gateway sends a user-visible `"still working… (no update from agent in N min)"` or `"still thinking…"`. `formatPokeText` and the fallback message generator pin "wording is load-bearing" (`silence-poke.ts:68`). A future refactor that changes wording without updating callers (or that flips "thinking" / "working" selection) breaks the user's mental model — they read the framework fallback as the agent talking, then ask "wait, you ARE working right?".
- **Evidence:** No UAT pins the exact wording. Unit test `silence-poke.test.ts` covers the fallback metric but not the text.
- **Smallest UAT:** Force a 300s wedge (mock tool that sleeps indefinitely), assert the user-visible message contains the literal phrase `(no update from agent in` and the wording is `working` or `thinking` per recent thinking events.
- **Fix class:** Scenario + a wording snapshot test.

### CC-5 — Sub-agent dispatch leaves `subagentDispatchActive` stuck across turns

- **Layer:** L3 safety net.
- **Failure shape:** `subagentDispatchActive` extends soft threshold to 300s. The flag clears on `endTurn`. If `endTurn` is skipped (turn dies abnormally, gateway crashes between turn_end signal and silence-poke-state cleanup), the next turn boots with the extended threshold — silent for 5 min where it should poke at 75s. User asks "you stuck?".
- **Evidence:** `silence-poke.ts:235` `endTurn` is idempotent + drops state, but only called from the turn-end signal chain. A wedged turn that bypasses turn-end could orphan state.
- **Smallest UAT:** Spawn a sub-agent, simulate gateway-side turn-abort mid-flight, send a fresh prompt, assert the new turn's silence-poke fires at the normal 75s threshold (not 300s).
- **Fix class:** Scenario + possibly an `endTurn` call from the silent-end recovery path (#1131 area).

### CC-6 — Stale UAT scenarios mask actual regressions

- **Layer:** harness hygiene.
- **Failure shape:** `progress-card-dm.test.ts` references a config block that doesn't exist; the scenario can never run. `reactions-dm.test.ts` is `describe.skip` with rationale that no longer applies (card-vs-reaction conflict resolved by deleting the card). Both occupy mind-share, reviewer attention, and CI runtime without exercising anything.
- **Evidence:** `src/config/schema.ts:474` removed `progress_card`. `reactions-dm.test.ts:25-34` skip rationale references the (now deleted) card.
- **Smallest fix:** Delete `progress-card-dm.test.ts`. Rewrite `reactions-dm.test.ts` to assert the post-card reaction lifecycle (it can run now).
- **Fix class:** Refactor.

### CC-7 — Classifier misses subtle variants

- **Layer:** L1+L2 (the surface that should never need to fire).
- **Failure shape:** The classifier regex catches "status?", "still there?", etc. Real users also type: "you crashed?", "did you forget me?", "anything happening?", "everything ok in there?". These are status-asks in spirit but don't hit the KPI counter — the rate looks lower than reality.
- **Evidence:** `inbound-classifier.ts:21-32` — 10 patterns, all conservative. Comment explicitly: "false positives are worse than misses, because a wrong-positive would noise up the very KPI."
- **Smallest fix:** Inventory real-world variants from production hindsight (out of scope without prod access); meantime, expand the unit test coverage to lock the current set.
- **Fix class:** Deferred — needs production data to extend safely.

### CC-8 — Boot card silenced on operator update vs. silent on a real crash

- **Layer:** post-restart visibility (related JTBD `restart-and-know-what-im-running.md`).
- **Failure shape:** Clean-shutdown marker (#1139/#1141/#1142) silences the boot card on operator-driven restarts. If the marker is stamped erroneously (or the freshness window of 5 min is too generous on a slow boot), the card stays silent after a real crash → user sees the agent come back with no acknowledgement → asks "did you crash?".
- **Evidence:** Marker freshness window was extended to 5 min in #1142 specifically because operator restarts can take that long. A crash during a planned update window would inherit the silence.
- **Smallest UAT:** Stamp marker → simulate crash (not clean shutdown) → boot → assert boot card renders.
- **Fix class:** Scenario; the fix (if needed) is a "crash vs. clean" discriminator orthogonal to the marker timestamp.

## Phase B — top 3 picks

Picking by `frequency × severity × confidence-it's-still-broken`:

| Pick | Cause | Why this one |
|---|---|---|
| **PR 1** | CC-6 (stale scenarios) + CC-1 (reaction terminal lands) bundled | Zero-risk cleanup unblocks honest coverage of the L1 ambient layer. Stale tests harm review velocity. |
| **PR 2** | CC-3 (silence-poke soft end-to-end) | The L3 safety net is the floor under the whole design. Unit tests cover state; the wire path is unexercised. |
| **PR 3** | CC-2 (disable_notification on mid-turn) | Quietly degrades L2 if it ever breaks. No real-Telegram UAT asserts notification flags. |

CC-4 (fallback wording) is added as a wording-snapshot unit test inside PR 2 — cheap to bundle since the same harness work loads PostHog events.

CC-5 (subagent flag leak) is deferred to a follow-up PR — it requires a controlled abort path that's intrusive to mock at the UAT level.

CC-7 and CC-8 are catalogued and parked.

## Phase D — fuzz expansion

After PRs 1–3 ship, extend `fuzz-extended-dm.test.ts` (the second-pass fuzz from #1132/#1134) with:

- **Timing perturbation:** vary `delay_ms` (1s / 3s / 10s) on inbound dispatch to surface order-sensitive races between reaction debounce and turn-end emit.
- **Sub-agent timing:** dispatch a Task tool, then perturb the wait between dispatch and child-result by 5s/30s/120s. Asserts the extended 300s soft threshold actually applies during the wait but the normal 75s applies after the child returns.
- **Prompt-pattern fuzz:** fire each of the 10 status-ask regex variants directly to confirm the classifier metric fires and the agent reply doesn't loop.

Fuzz extensions land as a single follow-up PR (PR 4) once 1–3 are green.

## Progress log

(updated as PRs ship)

- **2026-05-13** — catalog drafted.
- **2026-05-13** — PR #1144 merged: CC-6 (delete stale `progress-card-dm.test.ts`) + CC-1 (real L1 reaction lifecycle UAT in `reactions-dm.test.ts`).
- **2026-05-13** — PR #1146 merged: CC-3 (silence-poke wire-path UAT in `silence-poke-soft-dm.test.ts` — forces 90s silent tool churn, asserts first reply lands in [70s, 200s] window).
- **2026-05-13** — PR #1147 merged: CC-2 (mid-turn `disable_notification` UAT in `midturn-silent-dm.test.ts` + `ObservedMessage.silent` exposure on the harness type).
- **2026-05-13** — PR #1148 merged: catalog doc lands on `main` for future agents to reference; classifier-variants fuzz block adds to `fuzz-extended-dm.test.ts` covering CC-7 at the fuzz level.
- **2026-05-13** — this PR (Goal #2 — fuzzy UAT breadth): `fuzz-status-ask-dm.test.ts` adds breadth probes across CC-1 (5 reaction-lifecycle variants), CC-2 (4 mid-turn pacing variants), CC-3 (2 silence-poke-ladder variants — 80s soft, 200s firm), CC-7 negatives (8 near-miss prompts). Each cause class now has one dedicated regression-locked scenario + a fuzz block exercising the same invariant across many prompt shapes.

## Final report (2026-05-13)

Three cause classes pinned by executable UAT scenarios, one stale scenario deleted, one harness-type extension shipped. All four PRs went through the fresh-reviewer protocol before merge.

| Cause class | PR | Surface |
|---|---|---|
| CC-1 reaction lifecycle stuck | #1144 | UAT `reactions-dm.test.ts` |
| CC-2 mid-turn updates ping | #1147 | UAT `midturn-silent-dm.test.ts` + `ObservedMessage.silent` |
| CC-3 silence-poke wire path | #1146 | UAT `silence-poke-soft-dm.test.ts` |
| CC-6 stale scenarios | #1144 | Cleanup |
| CC-7 classifier (fuzz path) | this PR | `fuzz-extended-dm.test.ts` — variants block |

**Left unaddressed (parked):**

- **CC-4 framework-fallback wording.** ~~Cheap to add as a snapshot unit test in a follow-up; deferred because the wording lives in `silence-poke.ts:formatPokeText` and the load-bearing piece (the wire path) is now covered.~~ **Addressed:** `formatFrameworkFallbackText` extracted from the gateway's `onFrameworkFallback` callback into `silence-poke.ts` alongside `formatPokeText`. Both functions now have inline snapshot tests in `silence-poke.test.ts` § "wording snapshots (CC-4)" — 6 cases covering soft, firm, working-at-300s, thinking-at-300s, derived-minutes, and the 1-min floor.
- **CC-5 subagent flag leak.** ~~Requires a controlled gateway-abort path that's intrusive to mock at UAT level. Deferred until the silent-end-recovery code (#1131) gets a wider rework — the same path would need the `endTurn` call.~~ **Investigated:** the catalog claim doesn't hold up. `startTurn` (`silence-poke.ts:133-145`) calls `state.set(key, ...)` unconditionally with `subagentDispatchActive: false`, so the next turn's startTurn wipes any stale flag regardless of whether the prior turn's `endTurn` ran. The state Map is also process-local, so a gateway restart clears it entirely. Added a defensive regression test in `silence-poke.test.ts` § "subagent dispatch extension" (`startTurn overwrites stale subagentDispatchActive when endTurn was skipped`) that pins the invariant — if a future refactor changes `state.set` to a merge (read-modify-write), the test breaks immediately. **Related real bug surfaced during investigation, NOT addressed here:** silence-poke state for an aborted turn (e.g. context-exhaustion bail at `gateway.ts:4851-4864`) lingers in the Map without `endTurn`. The 300s framework fallback can fire for an already-aborted turn, producing a user-visible "still working…" for a turn the gateway internally considers dead. The fix is adding `silencePoke.endTurn(key)` to the context-exhaust path — recommended as a follow-up issue, scoped at the gateway level rather than silence-poke itself.
- **CC-7 (full coverage extension).** This PR's fuzz block covers the existing regex set. Extending the classifier itself with new variants needs production hindsight access to avoid false positives. Out of scope without prod read access.
- **CC-8 boot card silenced on real crash.** ~~A scenario can be written but the marker semantics interact with #1142's freshness window — likely worth its own PR rather than bundling here.~~ **Addressed:** `boot-card-reason-to-render.test.ts` pins the integration `determineRestartReason → renderBootCard` across 7 cases. The load-bearing failure mode (operator marker stamped erroneously / stale beyond the 5-min window → real crash) renders the `⚠️ Restart crash recovery` row + a container-log next-step hint (`docker logs --tail 100 switchroom-<agent>` on the v0.7+ Docker runtime; the legacy non-docker fallback emits a `journalctl` hint — see `boot-card.ts` runtime branch); happy-path operator restarts within the window render the bare `✅` ack with no crash row. Inline snapshots pin the exact strings; negative assertions guard against accidentally rendering the crash row on a `graceful` reason.

**Suggested next Goal:** *Measure `inbound_status_query` in production over the next two weeks. For every fire, attach the silence trail (PostHog `turn_ended.longest_silent_gap_ms` + the silence-poke event chain for that turn) and open one regression-RCA issue per cause-class hit.* This converts the test-locked design into a measured outcome — the catalog above is the priors; production data tells us whether they hold.
