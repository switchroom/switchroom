---
title: Durable work execution
serves: entrust-ongoing-work
status: accepted-direction-implementation-unverified
last_reviewed: 2026-10-26
---

# RFC: durable work execution

## Decision record

### Context

An operator alignment interview on 2026-09-20 ratified the job and operating boundaries below. A subsequent MoA planning pass proposed a native-first delivery sequence. These are requirements and a plan, not evidence of shipped behavior. Interview evidence is single-source and directional. This record introduces the new Job Spec; it does not retarget an existing protected job, outcome, principle, or invariant.

### Decision

Linear is the primary human-facing work record and cross-gateway handoff interface for this delivery. Gateway-local Kanban owns durable execution; delegates provide bounded, ephemeral assistance. The Linear integration is off in the bare image and turned on by the starter overlay ([default-on-distribution.md](default-on-distribution.md)). Without the agent's Linear authorization the overlay renders it off, so a chat-only installation never acquires an unconfigured tracker dependency; Linear-backed coordination is claimed only when configured.

Start with one profile per gateway. Multiple specialist profiles are a future-compatible option, not a prerequisite or part of this delivery. A repository is a persistent workspace; delivery projects are finite scoped outcomes. Several projects may use one repository without sharing writer workspaces.

The principal approved autonomous end-to-end execution of authorized objectives within standing permissions, including publication, merge, and deployment where granted. Approval of a plan alone does not start implementation or authorize disruptive tests. New scope, cost, privileges, and uncertain recovery require escalation.

### Consequences

A gateway needs one accountable execution owner per deliverable and durable links among tracker item, chat origin, local task, run identity, and Git evidence. The existing integration must implement these semantics or explicitly block unsupported cases. This RFC does not authorize a new scheduler, distributed queue, dashboard, standalone ledger, or cross-container shared board.

Private rollout identities, repository assignments, budgets, and private deployment tracker URLs belong in the deployment overlay or private tracker, never this public tree.

### User clarification, 2026-10-26

The [job](../jobs/entrust-ongoing-work.md) now explicitly includes assignment in Linear and ordinary chat requests to start, continue, or take over an issue. Both lead to the same managed durable work. The agent reads the issue and inspects actual execution before choosing continuation, handoff, or new work. A current explicit takeover request authorizes that coordination within scope; it does not require a second confirmation or a special sentence.

Native Hermes Kanban owns execution, recovery, worker claims, and Stop. Linear holds human-visible outcomes and finite projects. The integration carries authorized requests, task links, and reporting. It must not introduce a second executor, scheduler, ownership authority, or shared cross-container database. Agent orchestration uses existing tools and native controls; users do not manage binding IDs, board names, activation steps, or worker handoff bookkeeping.

## Operating contract

### Ownership and interfaces

- One meaningful deliverable per tracker issue; sub-issues for independently reviewable outcomes or cross-gateway handoffs, not every tool call or delegate.
- Ongoing work with several milestones is a finite scoped project, not an oversized issue or an endless repository catch-all.
- A chat-created item records the current owner without creating another executor. A tracker-origin assignment may start work. Follow-ups steer the owner rather than relaunching it.
- The owning gateway manages local cards and dependencies. Cross-gateway handoffs use linked tracker outcomes, retaining original accountability for the overall result and receiving ownership of the handed-off deliverable.
- Current human edits and newer stop decisions must not be overwritten by stale snapshots or delayed events. Verify the integration's revision and ownership handling before claiming cross-surface synchronization.
- Authorized issue reads and work inspection remain available without an execution binding. A legacy or uncertain record can constrain an affected mutation; it must not prevent reading the issue or investigating the actual work.
- On explicit takeover, inspect live task/run state and saved progress. Continue the current agent's work, arrange a native handoff from another active agent, or start only the remaining work when no executor exists. Preserve the old task/run evidence and verify the old executor has stopped before replacement execution. Do not infer that a stale record proves either a live worker or safe takeover.
- Keep public agent identity, the local native profile/home, and the configured Linear app identity distinct. Resolve their relationship at the trusted host boundary using native semantics. A deployment label must not be mistaken for a nested filesystem profile; do not remove profile isolation or accept identity from model arguments to make reads work.

### Parallelism and workspaces

- Independent authorized issues and projects run concurrently within an explicit per-gateway budget covering workers and delegates. Priority affects admission; genuine dependencies and resource conflicts require serialization.
- Separate worker and delegate caps are not proof of a shared bound. Inspect launch paths and enforce a conservative aggregate bound or report the missing mechanism. Numeric defaults remain deployment proposals until validated.
- Keep delegation flat initially. Delegates receive bounded context, scope, acceptance criteria, and evidence expectations. Their material results are persisted to the owning card/repository and surfaced through the owner.
- Parallel coding writers require successful workspace isolation and approved base ancestry. Automatic worktree failure must not silently permit shared writes; uncommitted parent changes are not assumed to appear in child worktrees.
- Integration operates on the actual reviewed commits. Review must be performed by a separate fresh-process reviewer, never the author. The reviewer may use the same profile's configured identity and granted provider route; distinct credentials or personas are not required. A separate session qualifies only if it satisfies the fresh-process boundary.

### Authorization, maintenance, and completion

- Each repository has an explicit maintenance remit. The initial narrow remit permits failing-CI and broken-test repair without weakening coverage or security checks. Dependency/security updates are proposals; applying upgrades, features, broad refactors, and schema changes needs an approved objective initially.
- Routine steps inside granted scope do not introduce stage-by-stage human approvals. Required checks, permissions, and independent review still apply.
- Establish destination-specific acceptance at the start. Merge-only work needs the merged result and required checks; deployment work needs deployment and a live check; investigation work needs findings and evidence delivered. An open PR is not deployment or completion.
- Preserve configured provider routes and credential boundaries. Do not introduce fallback spending or new personas as a side effect of enabling delegation.

### Recovery and cancellation

- Persist progress, decisions, canonical work identity, branch/commit/worktree references, evidence, and next action at meaningful checkpoints. Transcripts alone are not a handoff.
- After restart, reconcile ownership, existing processes, repository state, PR/CI state, and external actions before resuming authorized work. Do not assume every running record is dead or blindly replay consequential actions.
- Persist pause/cancel before stopping descendants and reconciling them. A restart must not reactivate intentionally stopped work. Report any unresolved descendant explicitly.
- Use bounded recovery attempts. An ambiguous action outcome, uncertain ownership, or repeated recovery failure becomes a visible blocker, not unlimited retry.
- Retain recoverable Git work and durable evidence before workspace cleanup. Backups and mounted databases do not prove usable recovery by themselves.

### Reporting

The work tracker receives meaningful milestones, blockers, review outcomes, and completion evidence. The origin chat receives acknowledgement, significant changes, decisions, final result, and bounded periodic updates during long work. Routine tools and individual delegate completions remain internal unless material.

Notification recovery must replay unsent durable milestones without rerunning completed work or mirroring every message to every interface. Interval and retention policies remain deployment decisions; no unsupported delivery guarantee is claimed.

## UX outcome review, 2026-10-26

**Verdict: the current simplification is a useful reduction in machinery, but does not yet satisfy the job.** Review basis: the original upstream-native simplification plan and public plugin source at `b12dddd32e2c1b11a8461fabd00f7f899df4ab16`, including `plugins/linear/{transport,chat,bridge}.py`, the shipped behavior notes, and the existing native scenario tests. This is a source/plan review; it is not fresh acceptance of every deployed channel.

| User outcome | Current plan/implementation | UX verdict and smallest next step |
| --- | --- | --- |
| Read an issue from a normal conversation | `capture_context` checks the bound profile against the native home before every tool action. The producer can bind a deployment label while the service resolves its native executor as `default`. | **Fails the demonstrated container case.** Align caller/service profile resolution using trusted native host identity. Reproduce the real container layout and actual messaging/API producer paths; keep foreign-profile refusal. |
| Assign an agent in Linear and let it work | `Bridge._start` creates a task with `initial_status="blocked"` and requires a separate native activation. Creation idempotency and queued Stop ordering have known native limits. | **Incomplete.** Admission must safely reach execution from the authorized assignment without another user step, while preserving a concurrent/newer Stop. Do not hide an automatic unblock in a retry loop. |
| Ask an agent in chat to work on an issue | `create_issue` makes an undelegated issue; `track` only links an existing own-profile task. Normal native task creation is available separately. | **Partial.** The agent should compose native task controls and issue tracking, first checking for existing work. Keep that orchestration in the agent's normal workflow; do not add a parallel chat execution engine. |
| Take over an existing issue here | `require_task` accepts only the local verified executor. `track` does not transfer work, and existing/uncertain bindings can refuse replacement. The plan says to use supported handoff but does not specify a demonstrated route. | **Incomplete.** Establish a supported end-to-end inspection and handoff path through existing native controls and authorized agent communication. Local refusal is a boundary result for the agent to resolve, not a reason to stop inspecting the issue. No direct reads of another container's private state. |
| Steer the same work from another surface | `followup` writes a native operator comment for linked active work; stopped/completed work is reported without restart. | **Partial.** Retain this mechanism and prove the actual worker consumes the instruction. A saved comment is not proof that work followed it. Verify Linear-to-chat, chat-to-Linear, and chat-to-chat routes. |
| Stop, restart, and resume deliberately | The plugin avoids unsafe activation and limits cancellation to verifiable run ordering. Queued cancellation and assignment/handoff races remain capability gaps. | **Incomplete.** Native Stop must remain authoritative throughout admission, handoff, and recovery. Unsupported ordering is a scoped visible blocker, not a complete assignment UX. |
| Follow longer work and projects in Linear | Native events feed a durable outbox; agent guidance routes meaningful outcomes to projects. | **Direction fits.** Reuse it. Prove a multi-outcome project and notification catch-up; do not add another project store or mirror every internal task. |
| Keep working around a narrow failure | Unlinked content operations are independent of old execution claims; uncertain conflicting description writes remain held. | **Direction fits.** Keep reads/discussion available and hold only affected effects or conflicting execution. A reporting outage must not become a general execution outage. |
| Trust the completed release | Source tests and rollout checks prove parts; full real-channel outcome acceptance remains unverified. | **Not accepted end to end.** Tool registration, matching bytes, a healthy gateway, and a queued report each prove less than the user job. Use the job's outcome cases as the release gate. |

### Keep the implementation small

- **One native execution path.** Both entry points converge on existing Kanban tasks and native controls. The agent decides the route from the user's request and current state; the plugin does not classify phrases or own execution.
- **One human work record.** Reuse the configured Linear issue/project and the existing task link. Internal native steps do not automatically become Linear issues.
- **Reuse existing delivery state.** Keep the current ingress, reporting cursor, outbox, and uncertain-delivery reconciliation. No new daemon, workflow ledger, generic retry framework, transfer ticket, or second lock service.
- **Use the least invasive layer that completes the outcome.** First fix the demonstrated caller/service identity mismatch and missing agent workflow. If safe activation, Stop, or handoff needs a native primitive that is absent, specify and test the smallest native change at that boundary, preferably upstream. The earlier "no new Core work" constraint cannot turn a blocked assignment into accepted UX. It also does not justify rebuilding the removed private lifecycle/custody framework.
- **Keep user decisions at user level.** Ask only for genuinely ambiguous work or a material scope/access decision. Routine authorized continuation and takeover coordination do not need repeated permission. Preserve newer Stop, specialist permissions, and uncertain effects.
- **Choose one route before implementing handoff.** Inspect the available native and agent-communication interfaces, then document and exercise that route. Avoid adding several overlapping takeover APIs. If none can quiesce the old worker and admit the new one safely, name that precise capability gap before promising transfer.

## Revised delivery sequence

Acceptance of this RFC does not itself authorize implementation execution, disruptive testing, publication, deployment, or runtime rollout; those require separately granted execution scope.

1. **Make ordinary inspection work:** correct profile/home identity at the real host boundaries. An authorized issue read must work from each claimed chat surface, including a container whose deployment label differs from its native filesystem profile. Reject real cross-profile attempts and preserve specialist scope.
2. **Complete the native admission/control path:** inspect current native activation, queued/running Stop, recovery, and handoff capabilities. Resolve only the demonstrated missing primitive. Prove assignment plus concurrent Stop cannot produce a delayed unwanted worker. Do not keep the separate-activation workaround as the target experience.
3. **Connect both entry points:** implement the normal agent workflow for Linear assignment and explicit chat work/takeover. Read issue and live work first; continue, hand off, or start only the remainder. Reuse native controls and reporting. Inspect existing work without migration or takeover by inference; an explicit current takeover request is different from automatic adoption.
4. **Exercise whole journeys:** apply the job's outcome cases through real Linear and authenticated Telegram, Slack, and Desktop paths, with verified worker consumption and final delivery. Include active other-agent takeover, stopped/legacy work, duplicates, outages, a restart, delayed events, and a multi-outcome project. Reuse existing component scenarios for race and crash cases rather than building another test platform. Keep source tests, outcome UAT, and production-readiness evidence distinct.
5. **Release and close honestly:** use the established reviewed immutable release and scoped delivery paths. Verify the actual running behavior and neighbouring agents; account for paused operational automation and retained uncertainty. Close the outcome only when the user journeys and their stated acceptance pass. Release plumbing, repeated image bakes, or deployment drift are not substitutes for missing product behavior.

This sequence is implementation guidance, not permission to activate work, stop a live worker, or perform an external effect during a documentation review. Preserve existing authorizations and current human decisions.

## Capability and proof gaps

All outcome evidence below is **to validate**. Source inspection and historical audits may narrow implementation work but cannot mark these cases passed. The implementing change must add exact test commands/paths and real evidence before claiming the capability.

| Requirement | Required evidence |
| --- | --- |
| Single owner across chat and configured Linear | Duplicate assignment and follow-up do not spawn competing execution; current instructions win |
| Assignment reaches execution | A configured Linear agent assignment starts or continues authorized work without separate user activation; capacity/dependency waits are explained |
| Chat takeover after inspection | Same-agent continuation, active other-agent handoff, and inactive/legacy takeover preserve evidence with no overlapping replacement; an old owner record does not prevent reads |
| Native identity works in the deployed layout | Actual messaging/API producers reach the tool with the correct native home/profile even when the deployment uses a different label; foreign profiles stay denied |
| Bounded parallel work | Independent tasks overlap, dependencies gate, and observed aggregate activity stays within the approved bound |
| Safe workspaces | Expected commit ancestry; isolated writers; failed isolation blocks unsafe work |
| Durable resume | Interrupted authorized work reconciles actual processes, Git and remote actions before continuation |
| Persistent stop | Active descendants stop or remain explicitly unresolved; restart does not undo pause/cancel |
| Ambiguous external effects | Crash between action and acknowledgement causes reconciliation or blocker, not blind replay |
| Delivery catch-up | Lost notifications recover without duplicate work or repeated milestone spam |
| Evidence survives cleanup | Commits, artifacts, findings and checkpoint references remain available |
| Honest completion | Fresh review, required CI and intended destination verification support the Done claim |
| Surface parity and isolation | Every claimed chat/tracker surface passes separately; unrelated gateways and credentials remain unaffected |

Proposed numeric ceilings, provider behavior, trace completeness, and restart success remain unmeasured until executed. Component-green is not outcome-green, and neither is production-readiness.

## Rollback and operability

Stop new admissions, persist the stop decision, reconcile active workers and external actions, then revert only compatible policy/code where authorized. Preserve current database volumes, links, Git evidence and artifacts. Do not overwrite recent progress with an old image or blindly restore an old database. A source revert does not reverse an external merge or deployment; those need their own authorized recovery.

Operators must be able to identify the exact failed boundary and next action from the owning work record. Unresolved gaps stay visible; they do not become silent best-effort guarantees.

## Product contract checks

- **Outcome:** advances `there-when-you-reach` through continuity and the linked job; control also supports `on-a-leash` without changing its definition.
- **Principles:** agents do the work, humans grant scope; fewer surfaces to supervise; native mechanisms before new machinery; evidence over success claims.
- **Invariants:** no shared credentials, no neighbouring-agent disturbance, no conflation of built/published/deployed, no off-plan model calls, no private deployment identity in this tree.
- **Not shipped:** this accepted direction does not assert an implemented capability or add default-enabled integration behavior.
