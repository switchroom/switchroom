# Fix batch: prune dead-pointer findings in sub-agent-visibility-rfc.md

**Scope:** `reference/sub-agent-visibility-rfc.md` only.
**Verdict pattern:** dead-pointer (5), drift-major (2), drift-minor (1).
**Estimated edits:** medium (~50 lines -- deleting dead references and updating status notes).

## Findings in this batch

### Finding 1 -- rfc-sub-agent-visibility:c2

- **File:** `reference/sub-agent-visibility-rfc.md` L18-L23
- **Quote:** "Two narrow defects remain open as ordinary tracked follow-ups... Bug 6 (bg `sub_agent_turn_end` never fires for some Claude Code bg dispatches -> card can stay on Background until heartbeat ceiling) and Bug 7 (driver-side parent-tool-use correlation race)."
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** "Bug 6 and Bug 7 are moot. The progress-card-driver was deleted in PR #1122 PR3 before these could be fixed. The cross-turn visibility problem they addressed is now handled by pending-work-progress.ts (#1445) and subagent-handback (#1720)."
- **Evidence:** `telegram-plugin/gateway/gateway.ts` L2976-L2981 -- `progressDriver` is permanently null; `telegram-plugin/gateway/gateway.ts` L15490-L15498 -- explicit deletion notice.
- **Rationale:** The driver mechanism these bugs targeted no longer exists. Leaving open bugs for a deleted mechanism is misleading.

### Finding 2 -- rfc-sub-agent-visibility:c3

- **File:** `reference/sub-agent-visibility-rfc.md` L83-L84
- **Quote:** "`telegram-plugin/progress-card-driver.ts:1855,1921` -- driver registers fleet members on `sub_agent_started` ..."
- **Verdict:** dead-pointer
- **Proposed action:** delete
- **Proposed text:** Remove this line entirely. The file `progress-card-driver.ts` does not exist in the active source tree (only in the npm snapshot in node_modules). The line numbers are dead references.
- **Evidence:** File does not exist in `telegram-plugin/`; exists only in `node_modules/@switchroom-ai/telegram-plugin/`.
- **Rationale:** Dead pointer to a deleted file.

### Finding 3 -- rfc-sub-agent-visibility:c4

- **File:** `reference/sub-agent-visibility-rfc.md` L85
- **Quote:** "`telegram-plugin/progress-card-driver.ts:1108` -- deferred-completion gate"
- **Verdict:** dead-pointer
- **Proposed action:** delete
- **Proposed text:** Remove this line entirely.
- **Evidence:** Same as c3; `gateway.ts` L3046 -- `const progressDriver: any = null`.
- **Rationale:** Dead pointer. The gate is permanently absent.

### Finding 4 -- rfc-sub-agent-visibility:c5

- **File:** `reference/sub-agent-visibility-rfc.md` L86-L87
- **Quote:** "`telegram-plugin/two-zone-card.ts` -- fleet zone renders every member (cap 5 + 'N more')"
- **Verdict:** dead-pointer
- **Proposed action:** delete
- **Proposed text:** Remove this line entirely. `two-zone-card.ts` does not exist anywhere in the active source tree.
- **Evidence:** File not found under `telegram-plugin/`; `cap()` and `FleetMember` in `fleet-state.ts` are dead code in production (not imported from active code paths).
- **Rationale:** Dead pointer to a deleted file.

### Finding 5 -- rfc-sub-agent-visibility:c6

- **File:** `reference/sub-agent-visibility-rfc.md` L88-L89
- **Quote:** "`telegram-plugin/subagent-watcher.ts` -- 1Hz JSONL polling, drives `sub_agent_tool_use` -> fleet member's `lastTool`/`lastActivityAt` updates."
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** "`telegram-plugin/subagent-watcher.ts` -- 1Hz JSONL polling. Writes sub-agent activity to a SQLite DB (`bumpSubagentActivity`, `recordSubagentStall`); used by subagent-handback and pending-work-progress paths. No longer drives a FleetMember data model (that belonged to the deleted progress-card-driver)."
- **Evidence:** `telegram-plugin/subagent-watcher.ts` L44 -- imports only `sanitiseToolArg` from fleet-state.ts (not FleetMember, not hasLiveBackground).
- **Rationale:** The file exists but the claimed behavior (updating fleet member lastTool/lastActivityAt) is the deleted driver's data model, not the current one.

### Finding 6 -- rfc-sub-agent-visibility:c7

- **File:** `reference/sub-agent-visibility-rfc.md` L90
- **Quote:** "Heartbeat re-flushes the card every N seconds while live, so the elapsed counter ticks."
- **Verdict:** dead-pointer
- **Proposed action:** delete
- **Proposed text:** Remove this line entirely. The pinned card heartbeat was deleted with the card in PR #1122. The current cross-turn surface is `pending-work-progress.ts` which appends " -- still working (Nm)" to the anchor reply.
- **Evidence:** `telegram-plugin/gateway/gateway.ts` L15490-L15498 -- deletion notice.
- **Rationale:** Dead pointer to deleted functionality.

### Finding 7 -- rfc-sub-agent-visibility:c8

- **File:** `reference/sub-agent-visibility-rfc.md` L109-L111
- **Quote:** "AC-4 -- Stuck escalation. If a fleet member emits no JSONL event for > 60s, its row glyph flips from to with label `idle <duration>`. If every running member is stuck, header escalates to Stalled."
- **Verdict:** dead-pointer
- **Proposed action:** delete
- **Proposed text:** Remove or replace with a note: "AC-4 is moot -- the progress card that would have rendered these glyphs was deleted in PR #1122 PR3. Stall detection still fires in subagent-watcher.ts but has no user-visible rendering surface. See issue #1445 for the cross-turn replacement."
- **Evidence:** `gateway.ts` L3046 -- `progressDriver: any = null`; `subagent-watcher.ts` onStall callback exists but no-ops through the null driver.
- **Rationale:** The AC describes deleted rendering behavior.

### Finding 8 -- rfc-sub-agent-visibility:c9

- **File:** `reference/sub-agent-visibility-rfc.md` L112-L113
- **Quote:** "AC-5 -- Heavy fleet HTML safety. 6+ parallel sub-agents -- render output is balanced HTML, < 4096 bytes, fleet zone caps at 5 rows + '+ N more'."
- **Verdict:** dead-pointer
- **Proposed action:** delete
- **Proposed text:** Remove or replace with a note: "AC-5 is moot -- the fleet zone renderer (two-zone-card.ts) was deleted in PR #1122 PR3. No fleet HTML is currently sent to Telegram."
- **Evidence:** `two-zone-card.ts` does not exist; `cap()` function in `fleet-state.ts` is dead code.
- **Rationale:** The AC describes deleted rendering behavior.

### Finding 9 -- rfc-sub-agent-visibility:c11

- **File:** `reference/sub-agent-visibility-rfc.md` L288-L293
- **Quote:** "After Bugs 1-5 merged + the agent image rebuilt + apply re-run, five of six assertions pass in the UAT scenario"
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** Replace with: "The UAT scenario (`bg-sub-agent-dispatch-dm.test.ts`) tests a pinned progress card that was deleted in PR #1122 PR3. The scenario's `expectPinnedCard`/`waitForCardPhase` assertions would fail immediately in a live run because no pinned card is ever produced. The scenario file documents this as currently red."
- **Evidence:** `telegram-plugin/uat/scenarios/bg-sub-agent-dispatch-dm.test.ts` L67-L100 -- STATUS comment says "currently red -- surfaces two real production bugs... Both bugs are real and live on main."
- **Rationale:** The progress log claims 5/6 pass; the scenario file says it is red. And even if fixed, the scenario tests deleted infrastructure.

### Finding 10 -- rfc-sub-agent-visibility:c12

- **File:** `reference/sub-agent-visibility-rfc.md` L309-L315
- **Quote:** "Phase 6 fix candidates... option 1 with a longer post-stall window (e.g. 5 min)"
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** Add a note at the top of this section: "Note: the stall-terminal synthesis (Bug 6 option 1) was wired into gateway.ts (`onStallTerminal` at L16106) but `progressDriver?.ingest(...)` no-ops because progressDriver is null. This fix path has no user-visible effect and the open 'Bug 6' question is moot."
- **Evidence:** `gateway.ts` L16095-L16131 -- `onStallTerminal` exists but no-ops through null driver.
- **Rationale:** The fix was partially implemented but its target (the progress card) was deleted.

## Out of scope for this batch

- Edits to `telegram-plugin/uat/scenarios/bg-sub-agent-dispatch-dm.test.ts` -- this is production test code, not a reference doc. Out of scope for the drift-audit fix pass.
- Edits to `telegram-plugin/fleet-state.ts` to remove dead `cap()` / `FleetMember` code -- that is a code cleanup task, not a doc drift fix.
