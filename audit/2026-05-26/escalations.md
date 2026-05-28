# Drift Audit Escalations — pilot-2026-05-26

Audit run: pilot-2026-05-26
Audited: 2026-05-26
Triage: 2026-05-27
Units: 23 | Claims audited: 193

This file contains every finding that requires an operator decision before
the corresponding fix can proceed. Fix-batch files do NOT touch these; they
are parked here.

---

## Code-violates-contract

### E1 — contract-vision:c2
**Finding:** `src/host-control/server.ts:1577` contains a live `claude -p ok`
callsite. The "deep probe" path (health-check path inside the hostd daemon)
spawns `claude -p ok` to verify the claude binary is reachable and exits 0.

**Why this is escalated:** `reference/vision.md` Pillar 3 and CLAUDE.md both
state that `claude -p` (headless/print mode) is now programmatic usage under
the 2026-06-15 policy — a constraint violation. The eliminate-claude-p RFC
(#1620) is in progress. This callsite is tracked as issue #1798 but has not
been removed.

**Question for operator:** The hostd deep probe needs a binary-reachability
check that does not use `claude -p`. What replacement is acceptable?

Options:
1. Replace with `claude --version` (exits 0 on success, no subscription
   credit, no network call). Minimal change, ships in the eliminate-claude-p
   RFC scope.
2. Replace with a static file-presence check (`test -x $(which claude)`) and
   drop the runtime invocation entirely. Faster, no process spawn, but loses
   the "binary is not broken" signal.
3. Defer until the eliminate-claude-p RFC (#1620) lands and let that RFC
   author choose the replacement. Block this finding on that PR.

---

## Outcome-not-realized clusters

### E2 — Workspace worktree provisioning never runs (Cluster A)

**Findings:**
- `jtbd-give-each-agent-its-own-workspace:c1` — auto-worktree provisioning
  claim: "When you add an agent and point it at a repo, it gets its own
  worktree automatically." `ensureBareClone` and `ensureAgentWorktree` are
  imported in `src/agents/scaffold.ts` but never called inside `scaffoldAgent`
  or `reconcileAgent`.
- `jtbd-give-each-agent-its-own-workspace:c2` — parallel build isolation claim:
  "Two agents working the same repo never conflict." No call to
  `ensureAgentWorktree` means no worktree is created; agents sharing a repo
  work in the same checkout.
- `jtbd-give-each-agent-its-own-workspace:c3` — post-reboot preservation claim:
  "After a host reboot the worktree is exactly where it was." Nothing creates
  the worktree, so there is nothing to preserve.
- `jtbd-give-each-agent-its-own-workspace:c4` — removal cleanup claim:
  "Removing an agent cleans its worktree." `destroyAgent` does not call
  `removeAgentWorktree`; worktree directories are left on disk.

**Why this is escalated:** The JTBD claims a shipped capability. The code
exists (the functions are implemented and tested in isolation) but the wiring
into `scaffoldAgent`/`reconcileAgent`/`destroyAgent` is absent. This is either
a feature that was scoped out before ship, or the wiring was dropped in a
refactor. The fix is code (not docs), and the right posture depends on whether
the operator wants to ship the wiring or retire the JTBD claim.

**Question for operator:** The worktree functions exist but are never called.
What is the correct resolution?

Options:
1. Wire `ensureBareClone` + `ensureAgentWorktree` into `scaffoldAgent` and
   `removeAgentWorktree` into `destroyAgent`. The JTBD is accurate once this
   ships. Estimated: ~30 agent-minutes for the wiring + tests.
2. Retire the JTBD claims: replace the "automatic worktree" outcome text with
   the honest current state ("agents share the repo checkout by default; you
   can manually point them at separate worktrees"). The code stays as-is.
3. Leave the functions present but mark them `@internal / not-yet-wired` in
   source, and update the JTBD to say worktree isolation is "coming in a
   future release." Intermediate posture; commits to eventual delivery.

---

### E3 — Boot card visibility gap (Cluster B)

**Findings:**
- `jtbd-restart-and-know-what-im-running:c1` — "no need to ask" claim: the
  boot card is supposed to show the running configuration so the user never
  has to query. `RenderBootCardOpts` has no fields for model, tools, or skills.
- `jtbd-restart-and-know-what-im-running:c2` — "sees what's running without
  asking" — same root cause: boot card omits model, tools, skills.
- `jtbd-restart-and-know-what-im-running:c3` — "user can tell if model changed"
  — model name is not in `RenderBootCardOpts`; a model change is invisible in
  the boot card.
- `jtbd-restart-and-know-what-im-running:c8` — "change is obvious after
  restart" — config-change visibility was moved to `/status` (PR #142). The
  JTBD still claims it's in the boot card.
- `jtbd-restart-and-know-what-im-running:c11` — UAT scenario
  `jtbd-restart-config-change-dm.test.ts` assertion `expectBootCardContains
  ('model:', ...)` cannot pass because the boot card contains no model field.
- `jtbd-restart-and-know-what-im-running:c12` — UAT assertion
  `expectBootCardContains('skills:', ...)` cannot pass; same root cause.
- `jtbd-restart-and-know-what-im-running:c15` — memory backend swap not visible
  in boot card; `/status` is the current surface.

**Why this is escalated:** PR #142 deliberately moved config-change visibility
off the boot card into `/status`. The JTBD predates that decision and was not
updated. The UAT scenarios were written against the old contract; they will
permanently fail until either (a) the JTBD is updated to reflect `/status` as
the surface, or (b) the boot card is extended to include the removed fields.

**Question for operator:** PR #142 moved model/tools/skills off the boot card.
Was that a permanent design decision or a temporary deferral?

Options:
1. Accept the PR #142 decision as permanent: update the JTBD to say "run
   `/status` to see the running configuration" and update or retire the UAT
   assertions that check for model/skills in the boot card. Docs change only.
2. Reverse PR #142 (at least partially): add model, skills, and key tools back
   to `RenderBootCardOpts` and the boot card template. The JTBD stays as-is.
   Estimated: ~45 agent-minutes for the renderer change + UAT re-run.
3. Hybrid: show a one-line config-change diff in the boot card ("model changed:
   opus-4 -> sonnet-4") only when a change is detected since the last boot, and
   defer the full config listing to `/status`. Satisfies the "change is obvious"
   JTBD claim without cluttering every boot card.

---

### E4 — Quota push gap (Cluster C)

**Findings:**
- `jtbd-track-plan-quota-live:c1` — "user can answer 'am I close?' without
  asking" — no proactive approaching-cap notification exists; user must poll
  with `/quota`.
- `jtbd-track-plan-quota-live:c2` — "approaching-cap signal before the wall" —
  the threshold-tier warning logic described in the JTBD is not implemented;
  `src/auth/broker/server.ts` has no tier-threshold detection path.
- `jtbd-track-plan-quota-live:c6` — "graduated signal" (background nudge
  escalating to louder warning) — not implemented; only the fatal credits-watch
  alarm exists.
- `jtbd-track-plan-quota-live:c7` — "window-roll recovery is automatic" — the
  window-roll reset is pull-only (triggered by the user's next message after
  the window resets, not pushed to the user).

**Why this is escalated:** All four claims describe proactive push behavior that
does not exist. The JTBD frames this as a shipped capability. The implemented
behavior is reactive: the user is told quota is exhausted when it happens; there
is no "you're at 80%, heads up" tier.

**Question for operator:** The JTBD describes proactive quota nudges. Was this
deferred intentionally or accidentally dropped?

Options:
1. Update the JTBD to describe only the actual pull-based `/quota` command and
   the fatal exhaustion alarm. Remove the approaching-cap and window-roll push
   claims. Docs change only; honest about current state.
2. Implement threshold-tier detection in the auth broker: at 80% (configurable)
   of the session window, emit a Telegram notification "Approaching quota cap —
   N tokens remaining." Estimated: ~60 agent-minutes for broker + gateway +
   UAT.
3. Partial implementation: add a soft warning to the `/quota` response ("You're
   at 85% of your session window") without any push. This satisfies the "can
   answer am I close" claim but not the proactive push claims. Update the JTBD
   to remove push claims, keep the threshold-aware pull claim.

---

### E5 — Auth slot mgmt not yet wired in gateway

**Finding:** `jtbd-talk-to-agents-from-anywhere:c7`

The gateway at `telegram-plugin/gateway/gateway.ts:13079` contains the comment:
"Phase 4c will wire this. Until then, run in terminal: switchroom auth ..." The
auth slot management commands (`/auth add`, `/auth rm`) are not yet wired into
the gateway path; users must run them on the host CLI.

**Why this is escalated:** The JTBD claims "all auth operations work from
Telegram." The gateway code explicitly says this is not finished. The comment
names a future phase ("Phase 4c") that either did not land or landed under a
different name.

**Question for operator:** Was the Phase 4c auth-from-Telegram wiring completed?
If so, is this comment stale? If not, what is the correct status?

Options:
1. If Phase 4c landed: remove the stale "run in terminal" comment from
   `gateway.ts:13079` and update the JTBD to reflect the wired state.
2. If Phase 4c did not land: update the JTBD to accurately state which auth
   operations are available from Telegram (use/list/show/rotate) and which
   require the host CLI (add/rm). The "run in terminal" comment stays in code
   as a developer hint.
3. Scope Phase 4c as a tracked issue and update both the JTBD and the code
   comment to reference the issue number, so the gap is tracked rather than
   silently present.

---

### E6 — Silence-poke success rate: 0-7% vs >80% JTBD target

**Finding:** `jtbd-know-what-my-agent-is-doing:c12`

`telegram-plugin/pending-work-progress.ts:L13-16` documents empirical data:
silence-poke success rate is 0-7% across hundreds of real fires (finn: 0/78,
clerk: 6/91, klanker: 5/158). The JTBD UAT target is >80%. `pending-work-
progress.ts` was introduced precisely because the silence-poke ladder fails
as a cross-turn mechanism.

**Why this is escalated:** This is a product-level gap. The silence-poke
mechanism works as implemented (it fires at 75s/180s/300s and reaches the
model as system-reminder piggybacked on the next tool result) but fails to
produce the intended user-visible outcome at any useful rate. The JTBD target
and the measured outcome are an order of magnitude apart.

**Question for operator:** The silence-poke success rate is measured at 0-7%.
What is the correct response?

Options:
1. Accept the current rate as a known limitation and update the JTBD: remove
   the ">80%" UAT target, replace with a description of the pending-work-
   progress fallback as the primary cross-turn visibility mechanism. The
   mechanism stays in place as a best-effort signal.
2. Rework the silence-poke delivery mechanism: instead of a system-reminder
   piggybacked on the next tool result, inject the poke as a synthesized
   inbound turn (via `dispatchAsInbound`). This reaches the model at a turn
   boundary rather than mid-tool. Estimated: ~90 agent-minutes; non-trivial
   risk of turn-ordering issues.
3. Retire silence-poke as a user-facing mechanism: replace the >80% UAT target
   with a pending-work-progress UAT (does the anchor reply update every N
   minutes during a long tool-churn?). The silent-poke code stays for
   degraded cases but is no longer the primary visibility guarantee.

---

## Low-confidence findings requiring operator triage

### E7 — migrate-schema.ts not wired into production (low confidence)

**Finding:** `jtbd-share-auth-across-the-fleet` (auditor notes, also c14 rationale)

`src/auth/migrate-schema.ts` is a shipped, tested in-place migration algorithm
(3 fixture shapes tested). The schema comments in `src/config/schema.ts:L1278-
1279` state it "runs on first apply." However, `migrateAuthSchemaFile` is not
imported from any production code path — only from its own test file. `apply.ts`
does not import it.

**Why low-confidence:** The code may have been wired after the audit was run
(the auditor flagged this as low-confidence), or the schema comment may be
aspirational. Cannot be resolved by doc inspection alone.

**Question for operator:** Does `switchroom apply` actually run the in-place
auth schema migration? If yes, which file imports `migrateAuthSchemaFile`?

Options:
1. Confirm the wiring exists (name the import site) — auditor's grep may have
   been incomplete. Update the fix-batch for `jtbd-share-auth-across-the-fleet`
   to reflect the confirmed state.
2. Confirm the wiring is absent — the migration algorithm exists but is not
   called. Add the import into `apply.ts` (or wherever `switchroom apply` runs
   config reconciliation) before the next operator upgrade, to avoid silent
   schema-incompatibility for users upgrading from pre-RFC-H installs.
3. Confirm the migration is intentionally not wired (operators are expected to
   be on new installs only) — update the schema comment to remove "on first
   apply" and update the JTBD fix-batch text accordingly.

---

### E8 — Dead zone recovery: vision-only (low confidence)

**Finding:** `jtbd-talk-to-agents-from-anywhere:c10`

The JTBD describes dead-zone recovery ("the agent detects the disconnection and
queues messages; on reconnect, any queued messages replay in order"). The
auditor found no implementation of dead-zone detection or replay in the gateway.
Confidence is low because the inbound-spool JSONL (which does survive restarts)
may partially cover this — the auditor was uncertain whether the spool + boot-
replay constitutes the described behavior.

**Question for operator:** Is the dead-zone recovery claim (c10) describing the
inbound-spool boot-replay mechanism, or a separate not-yet-built Telegram
reconnect-detection path?

Options:
1. If inbound-spool covers it: update the JTBD to cite the spool mechanism
   explicitly and note the v1 limitation (ack = delivered to bridge, not
   consumed by claude). No code change needed.
2. If it is a separate unbuilt path: update the JTBD to mark this as a future
   capability ("planned: dead-zone replay") rather than a current one.
3. If it is partially covered: rewrite the JTBD claim at the level of what
   actually exists ("messages queued in-process survive gateway restarts via
   the inbound spool; host-level network dead-zone recovery is not yet
   implemented").

---

## Manifest hygiene (operator acknowledgment requested)

### E9 — historical-prd unit must be dropped from manifest

**Finding:** `historical-prd:c1`

`reference/PRD.md` was deleted in PR #534 (commit 8bdb86cb). The manifest
lists it as a `historical` unit. The fix-batch `manifest-hygiene.md` proposes
removing it from `scripts/drift-audit/manifest.yaml`.

**This is in a fix-batch already.** Listed here so the operator formally
acknowledges the deletion and confirms no PRD equivalent document exists at a
different path that should replace this manifest entry.

**Question for operator:** Is there a replacement PRD-level document anywhere
in the repo that should be added to the manifest under a new unit_id?

Options:
1. No replacement exists — delete the manifest entry (fix-batch as written).
2. A replacement exists at a different path — update the fix-batch to point
   to the new path and update the unit_id.
3. Defer: keep the manifest entry with a `status: deleted` marker until a
   replacement is written.

---

## Cross-unit conflicts

### X1 — "remove agent" command name inconsistency

**Units involved:** `jtbd-give-each-agent-its-own-workspace:c9` and
`jtbd-extend-without-forking:c7`

Both findings touch the "remove/destroy agent" command name. The findings
land in different fix-batches:
- `jtbd-give-each-agent-its-own-workspace:c9` is in `misc-jtbd-small-drift-fixes`
  (edits `reference/give-each-agent-its-own-workspace.md`)
- `jtbd-extend-without-forking:c7` is in `misc-jtbd-small-drift-fixes` (edits
  `reference/extend-without-forking.md`)

These are two separate files in the same batch, so no conflict in the fix-batch.
However, both documents may need to use the same canonical verb (`agent destroy`
vs `agent remove`). The fix agent should verify the CLI-registered name before
editing and apply the same name in both files.

**No blocking conflict; flagged for fix agent awareness.**

### X2 — auth verb surface: principles.md and share-auth JTBD

**Units involved:** `contract-principles:c1` (in `principles-stale-examples`)
and `jtbd-share-auth-across-the-fleet:c4,c16` (in `jtbd-share-auth-stale-examples`)

Both batches update auth command examples. Files are disjoint:
- `principles-stale-examples` edits `reference/principles.md`
- `jtbd-share-auth-stale-examples` edits `reference/share-auth-across-the-fleet.md`

The fix agents must use identical verb names (e.g. `switchroom auth use <label>`,
`switchroom auth list`, `switchroom auth show`). The canonical surface is
`src/cli/auth.ts`. Fix agents should read that file before writing.

**No blocking conflict; flagged for fix agent consistency.**

---

*End of escalations — pilot-2026-05-26*
