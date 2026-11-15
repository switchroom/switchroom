---
title: Entrust ongoing work without losing control
job: entrust-ongoing-work
serves: works-your-projects
outcome: A principal can assign or take over approved work through Linear or chat, steer the same durable work across supported interfaces, and receive a verified result after interruptions without reconstructing progress or authorizing the same work twice.
stakes: full
invariants:
  - no-shared-credentials
  - one-agent-change-is-local
  - built-published-deployed-are-different
  - no-off-plan-model-call
  - public-image-has-no-deployment-identity
---

# Job Spec: entrust ongoing work without losing control

`serves:` retargeted from `there-when-you-reach` to `works-your-projects` by the 2026-11-15 amendment in [../rfcs/switchroom-positioning.md](../rfcs/switchroom-positioning.md). The job statement is unchanged.

## The job

**Struggling moment:** When work begins in Linear or a chat and later outlasts that conversation, the principal cannot easily tell who is working, continue with another agent, or recover after a restart. They get bookkeeping refusals instead of an agent checking the actual work.

**Job story:** When I assign an outcome in Linear or ask an agent in chat to work on or take over an issue, I want the agent to check existing work and manage its execution, so I can collaborate wherever I am without coordinating workers or losing durable progress.

**User clarification, 2026-10-26:** Linear assignment and requests in Telegram, Slack, or Desktop are equal entry points. An explicit request to take over an issue authorizes coordination within the requested scope. Inspect actual active work before deciding how to proceed; do not refuse inspection because of an old owner or a missing tracking link. The user wants fewer steps and reliable longer-running work, with meaningful outcomes and projects visible in Linear.

## The experience

1. **Entrust from Linear:** delegate an issue to a configured Hermes agent. The agent acknowledges, checks for existing execution, and begins or continues the authorized work. Assignment must not leave the user with an unexplained blocked task or a separate activation ceremony. Capacity and genuine dependencies can delay execution; the agent explains the wait.
2. **Entrust from chat:** ask an agent to do work or take over an issue in ordinary language. It reads the issue and checks the actual task and worker state. It continues existing work, arranges an authorized handoff, or starts the remaining work when no executor exists. Ask which issue or outcome only when genuinely ambiguous; do not ask the user to repeat the takeover instruction as permission.
3. **Continue wherever convenient:** discuss, change direction, or request progress from another supported surface. Opening that conversation does not itself stop work or launch another worker. Instructions reach the existing executor; authorized progress recipients receive meaningful updates.
4. **Work on longer outcomes:** the agent maintains the appropriate Linear issue and finite project, including milestones, dependencies, blockers, and evidence. Internal steps remain native execution details. Short questions and bounded commands need no issue. If short work grows, checkpoint the completed part and continue only the remainder durably.
5. **Interrupt and return:** after a worker or gateway restart, the agent reconciles actual work and external results and continues within the original scope. The user does not reconstruct the plan or repeat completed actions.
6. **Stop or finish:** Stop reaches the actual work, remains effective after restart, and reports unresolved effects honestly. An explicit authorized resume or takeover can continue stopped work after inspection; a delayed event cannot. Completion means the agreed outcome reached its destination, with evidence in Linear and the conversation.

### What takeover means

Inspection, discussion, and tracking do not themselves transfer execution. After an explicit work/takeover request:

| What the agent finds | Expected experience |
| --- | --- |
| This agent already has active work | Continue that work and apply the new instruction; no second executor. |
| Another agent has active work | Arrange a handoff through supported native controls and authorized agent communication. Preserve the checkpoint and wait for the old executor to stop before replacement execution. The user need not relay the checkpoint between agents. |
| Work is queued or recoverable | Inspect the existing task, priority, dependencies, and recovery state; keep one execution rather than creating another card. |
| Work is stopped or blocked | Inspect the reason and current instruction. An explicit authorized resume/takeover can proceed when its prerequisites are satisfied; preserve any newer Stop. Report a specific remaining blocker. |
| No active execution exists, including a stale or legacy record | Reconcile saved progress and effects, then start only the authorized remainder. Preserve history; an old label alone is not a blanket refusal. |
| The outcome is already complete | Explain the result. Start a separately requested increment only when there is new authorized work. |
| A previous effect or owner cannot be verified | Continue inspection and unaffected work. Hold only the operation that risks duplicate execution or an uncertain effect, and state the fact needed to resolve it. |

One executor is accountable for a given execution scope at a time. Independently scoped project deliverables can run concurrently; takeover does not require moving every internal task into a single worker.

## Today's alternatives

Today the principal follows separate chat threads, manually translates progress into a tracker, restarts interrupted work, or remains present to prevent mistakes. The bar is less supervision without losing the direct control those workarounds provide. A second mandatory interface to maintain would not beat that alternative.

## The bet

This job assumes principals will delegate ongoing work when its ownership, decisions, progress, and completion remain trustworthy across interruptions and interfaces. If they still prefer to supervise every step after those properties are proven, the proposed autonomy is not the progress they hired.

## Measures of success

Mechanism: durable ownership and reconciled progress let the principal leave execution without reconstructing context. Leading indicators: work resumes without human reconstruction; steering changes the existing work rather than creating a competing execution; delivered results match the agreed destination.

The job metric is the share of interrupted approved outcomes recoverable without reconstruction or duplicate effects. It rolls into **works-your-projects** and its readable-issue rate, supporting trusted unsupervised turns. The cross-surface and restart cases must still meet **there-when-you-reach**'s bar. Baseline and target are unmeasured; instrumentation belongs in the RFC.

## Good / bad

**Good looks like:**

- Either Linear delegation or an ordinary chat request leads to the same managed work, without a second setup step.
- A takeover request gets a live work check and an actionable outcome, not a refusal based solely on an old owner or tracking record.
- The principal can see what is owned, progressing, waiting, or complete without asking each worker.
- A decision made through one supported interface governs the same work reached through another.
- Independent work progresses together while genuine dependencies and permissions remain enforced.
- Interrupted work recovers safely; stopped work stays stopped; uncertainty becomes an actionable blocker.
- Completion includes evidence that the requested result reached its intended destination.

**Bad looks like:**

- An assignment only creates a blocked card and the user has to activate it elsewhere.
- A valid issue read fails because the container's agent name and native profile name differ.
- The agent refuses to inspect work, asks for magic wording, or makes the user shuttle context between agents.
- Parallel workers duplicate ownership, overwrite each other's changes, or turn retries into repeated external actions.
- A second interface starts another executor instead of steering the existing one.
- The principal must move every internal task or approve routine steps already within the agreed remit.
- Agents expand maintenance into unapproved product work or spend outside granted model routes.
- **Silent failure:** the record says complete, but the result was not delivered, the cancellation was lost, or the work never resumed after an interruption.

## What the job requires

**Must be able to:**

- Read an authorized issue and inspect live work without requiring an execution claim or new task.
- Accept an assignment or an explicit chat work/takeover request, resolve existing execution, and coordinate its continuation without duplicate workers.
- Preserve an accountable owner, authorized scope, decisions, evidence, and a recoverable next action for ongoing work.
- Reconcile actual execution and external effects before continuing after interruption.
- Apply steering and stop requests to the owned work and its descendants without exceeding permissions.
- Expose meaningful progress and exceptions while retaining detailed internal evidence.
- Verify results at the destination agreed when the work began.

**Won't:**
- Require the principal to manage internal worker bookkeeping.
- Turn a saved record or a passing component test into a claim of recovered or delivered work.
- Share credentials or collapse independently isolated agents into a common execution identity.
- Infer authorization for new scope, privileges, or spending from task persistence.

## Prove it

**Evidence status: not yet outcome-validated.** Component scenarios exist, but they do not establish the end-to-end experience below. The following are required acceptance cases, not claims of passed client tests. The [delivery RFC](../rfcs/durable-work-execution.md) owns implementation and evidence links; it must replace these gaps with real paths and results before capability completion.

| Outcome case | What must be observed | Status |
| --- | --- | --- |
| Linear assignment | Delegate an authorized issue; observe acknowledgement and native execution without a second activation. Duplicate delivery and reconnect preserve the same work. | To validate |
| Chat-origin work, each of Telegram, Slack, and Desktop | Give a longer outcome; the agent creates/reuses appropriate Linear tracking and starts one native execution. A short question remains a normal conversation. | To validate on each surface |
| Takeover, each chat surface | Request takeover of an existing issue with active same-agent work, active other-agent work, no live worker, and retained legacy history. Observe actual inspection, continuation or handoff, preserved evidence, and no overlapping replacement. | To validate on each surface |
| Cross-surface follow-up | Start from Linear and follow up in chat; start from chat and follow up through Linear and a different chat surface. The instruction reaches the existing work, with no duplicate worker or requirement to return to the origin. | To validate across claimed routes |
| Stop and explicit resume/takeover | Stop running and queued work, including during initial assignment and handoff; restart; send delayed events. Stopped work stays stopped. A later authorized request resumes only after inspecting current state. | To validate on each claimed interface |
| Interruption and uncertain effects | Interrupt a worker and gateway, including after a consequential action but before acknowledgement. Reconcile actual processes and destination state; recover without human reconstruction, duplicate effects, or a false completion claim. | To validate |
| Project continuity | Deliver several scoped outcomes in one finite project. Progress, dependencies, blockers, and final evidence stay visible without exposing every internal task or requiring the user to reconcile trackers. | To validate |
| Narrow failure and reporting catch-up | With an old uncertain effect, a notification outage, or another active owner, authorized reads/discussion and unrelated work still succeed. Reporting catches up without relaunching work or repeating milestones. The response identifies any affected operation and next action. | To validate |

Linear cases apply when the optional integration is configured. Each case must preserve the job's listed invariants; proof includes unchanged neighbouring agents, credential isolation, granted model routes, and a verified destination result. Recovery must leave tools usable on every claimed surface.

Fuzz dimensions: duplicate and out-of-order instructions, notification outages, stale ownership, process death, permission denial, ambiguous remote outcomes, shared-resource conflicts, and missing recovery evidence. Assertions must include unaffected neighbouring agents and unchanged credential boundaries.

## Verdict

Done when the principal can leave approved ongoing work, steer or stop it through every claimed interface, and receive the verified destination result after interruption without reconstructing progress, duplicate consequential actions, or lost control. Each claimed surface needs its own outcome evidence.

## Abandon signal

We named the wrong job if trustworthy continuity and control are available but principals still reject leaving execution to the agent because their desired progress requires continuous participation.

## Production-readiness

Bound resource admission and retries; preserve evidence through cleanup; contain changes to the named agents; retain stop decisions across restarts; fail closed on uncertain ownership or side effects. Do not silently broaden billing routes. Recovery proof must include usable tools, not only surviving data.

## Related

- [Product spec](../product-spec.md)
- [Delivery RFC and ratification record](../rfcs/durable-work-execution.md)
