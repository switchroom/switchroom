# Recommendation: Escalation 10 — give-each-agent-its-own-workspace:c7,c8,c11 (cluster tied to Escalation 2)

**Recommended option:** Defer-to-Escalation-2 — mirror its resolution exactly, with one always-on action: mark the boot-card "dirty since <ts>" sub-claim of c8 as separately unimplemented regardless of Escalation 2's outcome.

**Confidence:** high

## Why

**On c7 (fast-forward on clean session start):** The ff logic is fully implemented in `src/repos/agent-worktree.ts` L210-238. On a clean worktree, `ensureAgentWorktree` runs `git fetch origin` followed by `git merge --ff-only origin/<defaultBranch>` and logs the result to stderr. The implementation is correct and complete. However, `ensureAgentWorktree` is imported but never called from `scaffold.ts` or any production reconcile path — confirmed by the grep: `scaffold.ts` imports `ensureAgentWorktree` (line 248) and `WorktreeState` (line 252) but does not call either. The ff-to-main therefore never executes on session start. The claim is implemented but unwired. If Escalation 2 = A (wire provisioning), c7 becomes testable and should be verified post-wiring before removing the vision-only flag. If Escalation 2 = B (remove), c7 must also be removed — the ff logic would be dead code in a feature that no longer ships. If Escalation 2 = C (document incomplete), c7 should receive the same "not wired" disclaimer.

**On c8 (dirty-tree policy: leave alone + boot-card warning):** The "leave alone" half is fully implemented at `src/repos/agent-worktree.ts` L196-208: `isWorktreeDirty` detects uncommitted changes via `git status --porcelain`, and on dirty detection `ensureAgentWorktree` returns `{ dirty: true, dirtyCommit: sha }` without touching the worktree. The "boot card surfaces `<repo>: dirty since <ts>` as a one-line warning" sub-claim is not implemented. A review of `telegram-plugin/gateway/boot-card.ts` shows the `RenderBootCardOpts` interface has no `worktrees` or `dirtyWorktrees` field, `renderBootCard` renders no such row, `runAllProbes` has no worktree probe, and the `ProbeKey` union has no `repos` or `worktrees` entry. The `WorktreeState.dirtyCommit` field exists in the module but is never consumed by any caller outside of `agent-worktree.ts` itself. The boot-card "dirty since <ts>" surface is entirely absent and would require adding a probe, a render slot, and a clock for the "since <ts>" timestamp — none of which exist. This sub-claim of c8 is separately unimplemented from the dirty-detection logic. The "leave alone" half follows Escalation 2's resolution like c7; the "boot card surfaces" half needs its own disclaimer or implementation work regardless of Escalation 2's outcome.

**On c11 (sub-agent nesting in worktrees end-to-end):** The JTBD text at `reference/give-each-agent-its-own-workspace.md` lines 40-43 and 111-114 states that sub-agents dispatched from inside an agent's worktree create their own nested worktree off the parent's HEAD, "exactly as today." A code search of `src/` finds no implementation of this nesting behavior in agent-worktree.ts or any callers — there is no `ensureSubAgentWorktree`, no "parent HEAD" resolution, and no sub-agent worktree dispatch path. The claim "existing pattern" refers to the documented sub-agent architecture, but that architecture (sub-agents creating worktrees off their parent's HEAD) is not implemented as code today. This claim is vision-only independently of Escalation 2: even if Escalation 2 = A wires main-agent worktree provisioning, sub-agent nesting requires additional implementation. Under Escalation 2 = A, c11 should be flagged as "next step after c2/c3 provisioning ships." Under Escalation 2 = B or C, c11 should also be removed or disclaimed respectively.

The independent always-on action: the boot-card "dirty since <ts>" sub-claim of c8 should be disclaimed as unimplemented in the JTBD regardless of what Escalation 2 decides, because it requires boot-card work that is separate from the provisioning wiring question.

## Tradeoffs of the recommendation

- Deferring to Escalation 2 keeps c7 and the "leave alone" part of c8 in sync with the provisioning decision, avoiding a divergent audit trail where c7 is removed while its underlying code is wired.
- Calling out the boot-card "dirty since <ts>" gap independently is correct because it is a separate implementation surface (probe + renderer change) even if provisioning ships — it would not become true automatically by wiring `ensureAgentWorktree`.
- Flagging c11 as separately unimplemented is also independently justified: sub-agent nesting is further out than main-agent provisioning regardless of how Escalation 2 resolves.
- This recommendation produces three distinct outcomes for the three claims rather than one uniform treatment, which adds audit complexity — but that accurately reflects three genuinely different implementation states.

## If you pick a different option

- **Treat all three as one cluster and follow Escalation 2 uniformly (Option Esc2-all):** Simpler audit trail, but leaves the boot-card gap and sub-agent nesting gap undisclaimed even if Escalation 2 = A ships. An operator reading the JTBD after wiring ships would see c8's boot-card claim and c11's nesting claim as verified when neither was tested.
- **Mark all three vision-only independently of Escalation 2 (Option vision-only-unconditional):** Defensively correct today. Risk: if Escalation 2 = A ships quickly, this creates churn re-verifying and re-clearing c7 and the "leave alone" half of c8 separately from the provisioning PR.

## Open question for the operator

The "dirty since <ts>" timestamp in c8's boot-card warning requires knowing when the worktree first became dirty (not just that it is dirty now) — `WorktreeState.dirtyCommit` captures the HEAD SHA but not a wall-clock timestamp. Should this sub-claim be revised in the JTBD to "dirty at <sha>" (which the current implementation could surface) instead of "dirty since <ts>" (which would require a new dirty-timestamp tracking mechanism)?
