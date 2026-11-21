# Linear plugin

Linear is the human work record. Native Hermes Kanban owns tasks, execution, claims,
worker recovery, permissions and Stop. This plugin links records, accepts verified Linear
requests and reports native outcomes through a durable outbox. An issue, comment, assignee
or reporting destination never grants execution permission.

Reporting remains compatible with official Hermes `ff294849385e433dd40a993b4f07673abb95c6f5`.
Automatic assignment admission additionally requires native block/unblock task-event guards
and guarded-resume event receipts for response-loss reconciliation.
No fork-specific invocation context, lifecycle controller, approval reservation or chat recovery
API is required. The plugin is off in the bare image; the starter overlay
(`examples/overlay-repo/`) turns it on when the agent's Linear token file is set.

## Tools

| Action | Result |
| --- | --- |
| `track` with `issue`, `task_id`, optional `board` | Link an existing task on the caller's native board or an explicitly selected existing board. For unfinished work on an undelegated issue, queue this app as Linear delegate. No task creation, claim, restart, resume or transfer. |
| `track` with `completion_scope: progress` | Report an internal stage without completing the issue. The default `outcome` means the task covers the agreed human outcome. |
| `track` with `replace: true`, UUIDv4 `id`, `expected_binding_revision` | Explicitly replace a reporting link after inspecting actual work. Archive the old projection and hold superseded reports; no execution state changes or assertion that the old worker stopped. |
| `status` with `issue` | Read the issue, bounded recent comment evidence, linked or retained native state, the reporting `binding_revision`, and verified `local.profile`/creation board for chat-origin work. Starts no work. |
| `origin_reference` with no other fields | Obtain the current ordinary native admission reference for independent owner inspection. Grants no permission. |
| `followup` with `issue`, `body`, UUIDv4 `id` | Save an operator instruction on existing linked native work. A paused task keeps the note without resuming; completed work refuses delivery. The result says whether the instruction was saved. |
| `delegate_self` with `issue`, UUIDv4 `id`, `expected_binding_revision`, `expected_delegate_id`, `expected_updated_at` | Route future Linear input to this app after coordinating existing native work. Requires an unfinished native task already linked to this executor. Preserves the human assignee and all native execution state. |
| `create_issue` with UUIDv4 `id`, `title`, `project` and optional `team` | Create an undelegated issue; optional description/parent. `project` is a project id, exact name (any case) or URL slug; without it the parent's project (and team) is used. The project picks its team: with `team` omitted, or naming a team that does not own the project, the one active project of that name in any team this app can see is used and the reply says which team (`Project 'Fleet QA' is in team HF, not KEN`). Several matches (for example a same-named project in another team) are refused as `ambiguous_project` with `Team / Project` choices, and the reply tells the agent not to guess but to ask the user by team name with `clarify` (there is no per-agent home team to break the tie); no match is refused as `project_required` with the accessible teams and their projects (bounded); an unknown team key is refused as `unknown_team` with the accessible team keys. `project: "none"` (with a team) is the explicit opt-out. The team/project directory is one cached request (10 minutes; a miss refetches a directory older than a minute once). |
| `create_issue` with `start_work: true` | For a longer outcome asked for in chat: also start one native task on this agent's creation board through the same guarded admission a Linear assignment uses, queue this app as delegate (human assignee unchanged), let Linear status follow the work, and subscribe the asking chat to native notifications for checkpoints and the result. The task's worker does the work. |
| `work_on` with `issue` | The same for an existing issue. A bound or linked task is reused and its chat subscription added; repeating the request never starts a second task. |
| `take_over` with `issue`, UUIDv4 `id` | Take over an issue another agent is delegate for, in one step (see [Take over from another agent](#take-over-from-another-agent)). Ends with the other agent's run stopped, proven ended and this agent continuing as one task with this app as delegate, or with nothing changed and a plain reason. `work_on` refuses an issue delegated elsewhere and points here. |
| `create_issue` or `work_on` with `record_done: true`, `summary`, optional `evidence` links | Link work already finished in chat and close it: the native task is created parked and completed with that evidence in one call, never runnable; verified completion sets Done with the closing summary. Refused when the issue already has native work. |
| `create_project` with UUIDv4 `id`, `name`, `team` | Create a project. |
| `link_issue` with `issue`, `related`, `relation` | Relate existing issues. |
| `update_description` with `issue`, UUIDv4 `id`, `description`, `expected_description` | Queue a description replacement after checking the exact previous text. |
| `add_comment` with `issue`, UUIDv4 `id`, `body` | Queue a Linear comment. |

Every reply adds `markdown_link` beside each issue and project it names, for example
`[HF-744 Linear plugin CPU fix](https://linear.app/...)` or `[Project name](https://linear.app/.../project/...)`.
Agents name issues and projects with that linked text in every channel. It is the plain
`[text](url)` form, which Linear, Telegram and Slack all render as a link; Telegram drops the URL
of the angle-bracket `[text](<url>)` form. Brackets in a title become parentheses.

Creates read the new issue or project back under its UUID. Linear's editor rewrites Markdown as
it stores it: it backslash-escapes punctuation such as `~`, writes `*` for `-` bullets and drops
trailing spaces and repeated blank lines. Outside code those count as the same text. A new
issue's description also comes back with a bare URL or host/path the author wrote autolinked
(`[T](<T>)`, or `[T](<http://T>)` for a host), with bold split around inline code, and with
bold closed before a link that ends it (`**see [X](u)**` comes back `**see** [X](u)`); the
create readback accepts exactly those, with the same token, the same link label and target,
and the same bold prose characters. Description and comment writes still settle on the stricter comparison. A create
whose readback still differs is reported as created, with `readback_differences` naming the
fields and a `content.write` `readback_differs` warning (`fields=` names them); it is never refused, because a refusal
invites a retry under a new id, which is how duplicates happen. Escapes that change structure
(code ticks, link brackets, HTML angle brackets, an escaped block marker at the start of a line)
and hard line breaks still count. A readback that fails or finds nothing is refused as
retryable: the same id and content can be retried safely. An id that already belongs to an
issue or project with a different title, name, team, project or parent is refused
(`content.write` `id_reused`), naming that issue; use it if it is the one meant, otherwise use a
new id.

### Entrust from chat

Questions, status checks and short commands stay in the conversation and create nothing.
A longer outcome gets an issue with `start_work` (or `work_on` for an existing one). The chat
request is the authority, as a delegation is for an assignment: the plugin creates the task
parked under the shared `create:<issue>` intent and `linear:<issue>` retry key, links it,
and admits it against its creation event token. The webhook from this app's own delegation
finds that admission and starts no second task or worker. Work bound with no Agent Session
(started from chat, by `take_over` or a `track`/`work_on` link) adopts the session Linear
opens for it: one thought says this is the work already running, then Started, heartbeats
and the keepalive post there as activities, while checkpoints stay issue comments. Completion posts one full,
regular top-level issue comment preserving the worker's supplied result, evidence
and remaining work, then a short Agent Session response points to that comment. The session response
waits for exact comment readback, including this app's author and no parent;
reporter retries retain the same completion identity and comment UUID. Existing
specialist assessment comments retain their full recommendation and deduplication.
Queued fallback reports proven not yet attempted move to new session activities atomically
with adoption; attempted or uncertain provider identities retain their original destination.
Native event capture verifies that its selected reporting owner is still current before
advancing the reporting cursor. A
session the work already reports to is never replaced while it may still be open (it must
have had its final response); the new one only gets a thought. Finished work, `record_done`
and `requester_basis: agent_session` scope (whose owner session authorizes effects) keep the
plain response. Work that never gets a session keeps reporting as issue comments. Linear status comes from native execution (In Progress once a worker
claims it). The asking chat is a native notify subscriber built like core `kanban_create`
auto-subscribe from host-captured context (messaging chats are woken in their thread,
Desktop targets its native local conversation, TUI its session key), added after admission so
it hears checkpoints and the result, not the admission itself. The issue itself is not a
notify subscriber: the bridge reports the task's events there from its own cursor. Core's
notifier cannot reply in Linear without an Agent Session. `record_done` never runs a
worker or re-runs work, even after a crash part-way through: recovery and the assignment
echo never admit a record_done task, `work_on` is refused, and repeating the same
`record_done` finishes it. A chat admission recovered after a crash is held if the issue
has since been delegated to someone else, or if a person changed its state, assignee or
delegate after the chat request while no delegate write of ours is pending. Existing linked work, another agent's task or ambiguous links are
reported, never duplicated. An unlinked task already on the board is adopted only when its
definition of done matches the project's, and then as progress: it never closes the issue by
itself. Delegated children return the request to their parent.

#### Chat guard: tracked work is started, not done inline

`guard.py` turns that rule into code. It is on by default; `chat_guard: false` (also `"false"`,
`"off"`, `"0"`, `"no"`) in the plugin's `settings` block turns it off (read at gateway start).
It *arms* a turn only when all of these hold:

- the turn is a person's chat turn: not the `linear`, `cron`, `a2a`, `subagent` or webhook
  platforms, not a subagent session, not a native Kanban worker, and not a machine-authored
  prompt (`[kanban]` wakes, `[Heartbeat — recurring instruction ...]`, core system notes);
- what the person typed asks this agent for Linear-tracked work. Only the typed text counts:
  the reply pointer (`[Replying to ...: "..."]`, stripped up to its last `"]`), channel history
  before core's `[New message]` marker (Slack thread context, Discord recent channel messages),
  the sender tag, attached-document notes and inlined documents, `@`-reference footers, code
  blocks, inline code and quoted lines are removed first. Then one rule must hold, each needing
  an *imperative request*: a clause that starts with the verb, optionally after `please`, `now`,
  `hey <name>`, `can you`, `I need you to` or similar. Not requests: questions (other than "can
  you ...?"), negations ("don't do it until HF-12 merges"), other subjects ("Atlas is working on
  HF-9", "I'll take over HF-9"), conditional sentences ("If Atlas fails, take over HF-9"),
  messages addressed to someone else (a leading `Atlas:` or `@atlas`, unless that name is this
  agent's profile or `ingress_profile`) and messages that retract themselves ("... Actually no,
  wait").
  1. `track it` / `track this` / `track the work` / `track progress` (not `track ... down`), with
     an issue key or Linear as the destination in the message;
  2. a work verb (research, write, build, fix, implement, investigate, finish, take over, work on,
     continue, ...) with Linear as the tracking *destination*: `track`/`log`/`file`/`record`/`put`
     followed by it/this/the work/progress/results `... in Linear`, `create`/`open`/`file a
     Linear issue`, `as a Linear project`. Linear as the subject of the work ("fix the Linear
     issue sync bug", "the Linear project picker", "fix the bug where comments don't post to
     Linear", "linear.app/ links", "the linear plugin", "linear regression") does not count;
  3. take over, finish, complete, work on, continue, pick up, carry on, resume, `do it` or `get
     HF-1 done` in a sentence with an issue key (`[A-Z]{2,6}-\d+`, case-sensitive, not
     `SHA-256`/`UTF-8`/`CVE-...`).

  `don't track`, `no tracking` and `do it here` keep that turn's work in chat;
- the turn's platform can reach the `linear` tool: core's toolset resolution for that platform
  (`platform_toolsets`, Desktop/TUI under `cli`) includes it, its registry entry and availability
  check pass, and the process is neither a native worker nor a delegated child. When it cannot,
  that turn logs `chat.guard outcome=skipped reason=linear_unreachable` and runs unguarded. When
  reachability cannot be determined the guard arms, and its block message says what to do if the
  tool is missing.

An armed turn may use `GRACE_TOOL_CALLS` (6) non-coordination tool calls within
`GRACE_SECONDS` (60 s, counted from the first one). After that, every tool except `linear`,
`linear_work_reference`, `kanban_*`, `a2a_*`, `message_agent`, `clarify`, `tool_search`,
`tool_describe` and `tool_call` is blocked. Those tools never count toward the allowance, so
the lookups that start tracked work (`linear` status, `create_issue`, `work_on`, `track`) and
`clarify` always run. The block message names the exact `work_on` (a title prefix such as
`QA-10` resolves) / `create_issue` + `start_work` call (the project picks its team), names `take_over` for an issue
another agent is working on (and says never to stop another agent's task with kanban or host commands), and says that a status question or discussion is answered
with what the agent has (or `clarify`), since inspection and discussion do not transfer
execution. A successful `work_on`, `take_over`, `track` or `create_issue` with `start_work` releases the
turn, as does the turn's end. Each transition logs one `chat.guard` line (`armed`, `blocked`,
`released`, `skipped`); an exception inside the guard is logged at most hourly and the call
proceeds.

When work starts, the delegate is queued inside the issue's lock right after admission (which
writes nothing to Linear), from the issue version read under that lock, so the status writes
that follow from the work are queued after it. Chat work that was not admitted (parked by a
Stop, a person's change, or unsafe controls) gets no delegate, however often chat asks again.
A chat admission that finds no delegate proceeds only when no person changed state, assignee
or delegate since the chat request (the history read is skipped only when Linear has not moved
since the request). Recovery adds no delegate to parked chat work that was never claimed; once
someone resumes it and a worker claims it, recovery routes the delegate as usual, fenced from
its latest claim (the change that parked it came before).
The chat reply says only what is true: Linear shows the delegate, is being updated (a delegate
write is still pending), the update will be retried (only when delegate recovery's own
conditions hold), a person removed this agent as delegate or changed the issue's status,
assignee or delegate (not re-added; only when Linear history proves it), Linear's history
couldn't be checked (nothing is changed over it), or it was not updated and the agent can't
confirm a retry.
Delegate recovery retries chat-started routing that was refused before any write, once per
binding revision (which changes as native work moves). Asking again from chat never re-adds a
delegate after a person's proven routing change since the request. For chat-started work every delegate recovery is fenced from the earlier of the
chat request and the worker's claim: a person's later change of state, assignee or delegate
wins. Whenever Linear shows no delegate, a Linear Stop on chat-started work bound here is
authorized by that binding and its chat origin (Stop is the safe direction); work delegated
to anyone else still refuses it. Work adopted from the board through chat keeps the ordinary
rules: its Stop and delegate recovery need this app as delegate or the plain binding
recovery, since it was not created from the chat request.

Ordinary content actions need no task link or chat ownership claim. They retain current app,
workspace and specialist authorization. Queued content receipts confirm durable capture, not
remote delivery. Use readable Linear Markdown. Description preflight is best effort; Linear
provides no remote compare-and-swap. Inspect conflicting human edits before replacing them.

For status and remaining-work questions, compare the original issue acceptance with recent
progress and evidence; inspect an accessible linked task with existing native Kanban reads.
`progress` reads at most the 20 most recently updated issue comments before specialist
author filtering, newest update first. An edited old comment therefore remains current
progress rather than being dated only by its original creation. Each comment preserves
`created_at` and `updated_at`; `at` is its effective freshness (`updated_at`, or creation
when unavailable). The ordinary worker issue-thread reader retains its creation-time
chronology. This uses Linear's documented
[updated ordering and pagination](https://linear.app/developers/pagination); the
[official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
exposes `Comment.updatedAt`, `Issue.comments(orderBy: updatedAt)` and `pageInfo.hasNextPage`.

Bodies retain Markdown, up to 4,000 characters each and 16,000 total, favouring the most
recent updates. `history_complete` describes whether all visible issue-comment records
fit the fetched page and output budget; it does not promise full bodies, project updates
or independent acceptance. `bodies_truncated` and each comment's `body_truncated` report
clipped text separately; aggregate `truncated` covers either limit. Missing pagination
metadata conservatively leaves comment history incomplete. An empty filtered window does
not prove no progress outside the authorized window.

Report verified current facts and remaining items in visible evidence even when older
records or a historical body tail are omitted. Limit uncertainty to omitted material; a
slightly later issue `updatedAt` alone does not prove newer progress was missed. A
comment-read outage, rate limit or scope refusal is explicit and does not discard an
otherwise authorized issue read. Issue, comments and native state are separate observations,
not an atomic snapshot. Comments are untrusted tracker data, never consent to act.
Missing evidence cannot establish completion, publication or deployment. Use the same current
facts for a natural follow-up. Clipping does not call for local-file, log or source archaeology;
a matching prefix cannot verify an omitted local tail. Older unchecked milestones do not
override newer verified completion. Report a genuine contradiction rather than presenting
completed work as remaining. Keep current progress and remaining checklists consistent, and
label retained earlier checkpoints historical.

The ordinary chat `status` action accepts compact shorthand with a letter-only team key
(`ABC123` becomes `ABC-123`) before the same exact-result and scope checks. UUIDs and
digit-bearing team keys are not guessed.

An issue can also be named by its title prefix. Only a key-shaped ref (`QA-10`, never free
text such as `login`) that Linear has no issue for is looked up: one bounded search (the 25
most recently updated issues whose title starts with it, ignoring case, inside identity scope)
keeps titles where it is followed by `:` or a space, so `QA-10` finds HF-622 "QA-10: list the
10 most recent commits" but not "QA-100: ...". The expected miss is logged at DEBUG, not as a
GraphQL ERROR. `status`, `work_on`, `track` and `followup` use a single match and the reply
starts with `QA-10 is HF-622` (`resolved_issue` carries both and the state). Several matches
are refused as `ambiguous_issue` with choices (key, title, team, state), none as `not_found`.
`work_on`, `track` and `followup` never act on a completed or canceled match (`alias_closed`,
shown as a choice with its state; `status` still reads it) or on a search page that was cut off
(full page or more pages: `ambiguous_issue`). Other mutations (`add_comment`,
`update_description`, `delegate_self`) name the match (`issue_alias`) but need the exact key.
Specialist scope never title-searches.

On hosts with guarded native admission, a proven pristine create-and-park stage reports
that preparation is awaiting admission without asking for human input. Reporting does not
admit the task or promise it will start. Genuine subsequent blocks and unsupported legacy
hosts retain their existing block/needs-input reporting.

Use existing native Kanban tools, Desktop controls or CLI for task creation, explicit resume,
cancellation and routing. Questions, short commands and bounded investigations work without
Linear. To continue active linked work, resolve its task and send a native operator comment;
opening another conversation does not replace its executor. Passive progress uses native
notification subscriptions with `notify`, never `wake` as an execution workaround.

The agent finalizes the full native task scope before tracking and admitting chat-origin
work. Link the task that owns the agreed issue outcome with `completion_scope: outcome`
(the default); use `progress` for preparation, a hold, or another internal stage. The agent
manages this distinction without asking the user to maintain task IDs or activate reporting.
A Linear delegation, automatic (creator-null) or made by a person, creates and admits a fully
populated outcome task through that same guarded admission before any model turn; with no
prompt comment the issue title and description are the request. A person's delegation then
also opens a native conversation that is told the work is already running as that task. An
@mention opens only a conversation (see Native Agent Session conversations below).
Tracking an unfinished native task on an undelegated issue queues the current app as
Linear delegate through the existing guarded outbox. The next reporting pass projects
the native active state. A different current delegate or newer issue edit holds routing
for explicit coordination; the human assignee is never changed. An assignment echo
acknowledges the bound task and current run without starting another execution.

The existing binding records the accepted native title, body and completion-contract digest
and specification-event version. Normal comments and follow-ups do not change that boundary.
A native edit also versions acceptance, including result backfill: restoring the previous
text cannot silently restore completion eligibility.
A missing boundary or a later specification change holds automatic issue completion while
native work and ordinary reporting continue. A finished stage reports its bounded summary;
it does not imply the human outcome is Done. After inspecting the issue acceptance and actual
work, the agent can reconcile the link through the existing `track` replacement and its fresh
binding revision. Queued completion writes recheck that same accepted scope before delivery.
Previously captured progress remains history: reconciling a link does not restart a worker,
rewind its reporting cursor, or republish an earlier completion. Preserve a completed partial
task and deliberately continue only the remaining outcome through native controls and tracking.
When reporting catches up after native work stops, waits for a dependency, time or review,
finishes or is archived, obsolete Started and heartbeat messages are omitted. Queued messages
explicitly identified as native progress recheck the current phase immediately before
publication. Native comments, current wait/review milestones, partial-stage summaries and
uncertain sends remain intact; status reporting still preserves later human edits and ownership changes.
Ordinary native comments and heartbeat notes stay internal. An explicit native human
checkpoint with a stable request ID is always projected to a regular top-level issue comment,
preserving its authored Markdown, including when an Agent Session is running. Workers explain
what changed, what is next and any blocker or decision needed, using the same request ID and
body on retry. Checkpoints are milestone comments posted only when the stage changes (plan
validated, PR open, merged, live, blocked or needs someone, done): a bold stage title, then
**What happened:**, **Why:** (only for a real decision, failed approach or change of plan) and
**Next:**, about 40 to 100 words, with no logs, commands or commit SHAs. They are not periodic
heartbeat messages.

**Living plan.** The issue description ends with an agent-owned section headed
`## Plan and progress (agent)`: a one-line status and a checklist from the acceptance criteria.
The worker sends the whole section as an ordinary native comment from its own profile (not a
human checkpoint, so chat subscribers are not pinged) whose first line is that heading. The
bridge replaces only that trailing section, using the exact current description as the guard,
and only while the section is still exactly what the bridge last wrote there (or what the same
outbox row may have written before a lost response). Text above it is never rewritten, and the
edit is silent. When a person edits or removes the section, adds text below it, or the guarded
replacement is refused, the bridge stops editing it for that issue and posts each changed update
as a regular comment instead. A comment from anyone other than the task's own profile is never
treated as a plan update.

The issue thread has no fixed "Started" comment: In Progress and the plan section show the
start, and a running Agent Session shows Started as a session step. It receives meaningful
native review, wait and blocker milestones. A blocker has a bold title, who needs to do what
and why in at most two plain sentences, and **Next:**; code, commands, paths and commit SHAs in
the native reason stay in native history. Each checkpoint and milestone appears once in the issue thread. A checkpoint is
only its regular issue comment, with no repeated session thought. With a session, a milestone
Linear shows as a thread reply (an elicitation such as "Waiting on you", a response or an error)
is only that activity, which keeps the comment's phase recheck; a session-only thought milestone
(review, wait, dependency) is only the issue comment. The session keeps live steps, heartbeats,
questions and lifecycle updates. A live step reads as plain words after Linear's "Working"
(for example "Working in the terminal"); it names only the kind of tool, never an argument or a
custom tool name. A worker's own `kanban_heartbeat` note stays on the session for ten minutes
before a generic tool step may replace it, so workers send one per sub-step. A session's later question or closing pointer still waits for
its unsettled checkpoint comment, as it waited for the session note. Retries do not create
another comment or activity. A checkpoint captured before
a session opens keeps its original issue-comment identity when the session adopts the work;
adoption does not replay that earlier checkpoint into the new session.
Unattempted lifecycle comments recheck their native phase before publication; obsolete progress
is omitted, while authored checkpoints and uncertain sends retain their history and stable IDs.
Merge and deployment claims require evidence from the worker, never inference from a tool name.
Completion retains one full issue result followed by its confirmed short session pointer.
Agent Session keepalives remain ephemeral session activities. Only progress durably
recorded as unstarted is omitted. Publication admission records an
attempt before HTTP, and an attempted comment keeps its UUID and requires exact readback
on retry; a missing historical attempt marker never proves that a message was unsent.
Current native status is projected before ordinary history that is durably unattempted,
using the existing status dependencies. A refused status still permits ordinary history
while the issue remains open. Earlier history delivered after our own Done requires its
native event to precede that exact current scope's applied completion event. A human close,
old scope or new post-Done native comment grants no such permission; explicitly authorized
chat comments retain their separate content path.
Attempted or legacy history keeps its original delivery boundary and UUID. These history
writes never justify a later issue-version overwrite. Agent Session activities retain their
existing advisory contract; unknown activity delivery requires inspection, not replay.
If the entire outcome really is already complete, the agent can add `reconcile_complete: true`
to that guarded outcome replacement after inspecting acceptance and evidence. The same UUID
durably queues only its verified completion through the existing outbox, without another
executor or replaying earlier progress. Retry the exact request after a lost response; queued
reporting still requires destination readback. This does not authorize closing a partial stage.
An exact request known not to have applied is not retimed or treated as delivered. After
inspecting current state, a fresh deliberate reporting request can repair that known result;
pending, uncertain and applied effects retain their original request and are not duplicated.
Required specialist assessment delivery is repaired separately from issue status. A known
unapplied recommendation needs a fresh authorized comment request; an applied status alone
does not satisfy that delivery. Reusing its exact historical acknowledgement grants no new
recipient authority. Held uncertain comments require exact readback rather than a duplicate
publication, and earlier request coordinates and receipts remain intact.

### Take over from another agent

"Take over HF-9 from Atlas" is one `take_over` call on the requesting agent. The rule: two
agents never run the same work. When a handover can't complete after the owner stopped, the
owner stays paused and the user and the Linear issue are told so plainly; nothing resumes it
automatically.

1. The requester checks everything it could refuse later (issue open and fully read, its own
   authorization, executor, board pin and guarded controls) before the owner is touched. While a
   task for the issue is ready or running here, the owner is never asked for anything: a task
   here from an earlier takeover from the same delegate means the takeover already happened, so
   the reply says so and only the Linear delegate update is retried, whatever the request `id`.
   Any other local work refuses with the owner untouched: running work (a person decides which
   agent continues), and finished or paused work (it would leave nobody running the work once
   the owner stops). An issue with no agent delegate is not a takeover (`not_delegated`: use
   `work_on`); one delegated to this app is plain `work_on`. One `take_over` or `resume_owner`
   per issue runs at a time on an agent (`takeover_in_progress`).
2. It runs the owner's own `hermes linear hand-off` through the operator-configured command for
   that delegate (`takeover.agents`, below). No configured command: `takeover_unavailable`,
   nothing changed. The plugin never improvises a route into another profile.
3. The owner, in code: refuses before stopping anything when the proof cannot hold (no
   reporting link here, not exactly one task, issue scope conflict, started tasks still open,
   no guarded controls or native Stop getter, and the parts of `inspect-cleanup` a Stop cannot
   change); pauses the task with one guarded native Stop whose reason is
   `Paused for a handover to <name> [handoff:<request id>]` (never pushed into the recurrence
   fence); and waits up to `wait_seconds` for `inspect-cleanup` to prove the stopped run ended
   (`state: handed_off`). If the stopped worker reported back after the gateway gave up on it,
   core leaves that attempt `unknown` and nothing in the gateway's lifetime settles it; when the
   proof holds on exactly that row under a handover pause for the same agent (this request's or
   an earlier one's; blocked, no current run, the row is the stopped run's card attempt), the
   owner asks core once to resolve it (`prompt.resolve_unknown`, the same call as a person's
   Discard, which first re-runs core's process-stop cleanup) and proves again. A `started` row is
   waited on and asked about once it turns `unknown`; a person's pause or a pause for another
   agent is never resolved, and a refused resolve leaves the work paused. It never
   resumes anything by itself: if the proof fails, the work stays
   paused (`state: paused`, with a plain reason). A task already paused for a handover to the same
   agent (a retry with the same `id`, or a new request) is proven again, never stopped twice. A
   task paused by someone else is only proven, never changed (`state: unchanged`); one paused for
   a handover to a different agent is refused. One hand-off or resume runs per issue at a time on
   the owner (a lock beside its state database, waited on for at most 10 seconds).
4. On proof the requester creates its one native task, whose text says to continue from the
   old owner's progress in the Linear thread, and admits it in the same call, while Linear still
   shows exactly the old delegate and no person has changed its state, assignee or delegate since
   this `take_over` asked the owner (the same check as `work_on`; the old delegate app reporting its
   pause, moving the issue to Blocked, is not a person). Each new `take_over` is the authority for
   its own start: a change before it does not hold it, a change after it does. It then replaces
   that delegate (guarded on it) with this app and subscribes the chat to checkpoints and the
   result. The old delegate app's pause report
   never holds that update; a person's routing change, or the old delegate app reporting a
   resume, does. A held update is retried by delegate recovery.
5. If anything fails once the owner may be paused (no readable reply, a proof that failed, or a
   start here that failed), what runs here decides. A task ready or running here (admitted before
   a later step failed) means the handover stands: the reply is a success that names the
   unfinished Linear update. Otherwise the reply is `takeover_paused`, and the same words are
   posted on the issue: "Atlas's work on HF-9 is paused for a handover to Nova that didn't
   complete. Say 'resume HF-9' to let Atlas continue, or 'take over HF-9' to try again." The
   reason is named plainly (for example a person changing the issue's status, assignee or delegate
   while the task was being set up). 'take over HF-9' is offered only when a new `take_over` would
   ask the owner again; after a Stop from Linear, or a start that couldn't be confirmed, only
   'resume HF-9' is offered, and a later `take_over` refuses without asking the owner, saying
   Atlas was not asked again and how to resume it if it is still paused. If meanwhile someone
   delegated the issue to another agent, to this agent by hand, or removed the delegate, resuming
   is not offered: the message says who has it now, and that Atlas continues only after the issue
   is delegated back to it and a person says 'resume HF-9'. That message stays true: a takeover task
   is admitted only by the `take_over` call that has just proven the owner's run ended, never
   later by the service, an assignment echo or `work_on`. A task created here whose start failed
   stays parked; saying 'take over HF-9' again proves the owner's pause again (it is never stopped
   twice) and starts it, also when the first start lost to a person's change made before that new
   request. An admission that did land before a lost reply or a crash is only
   recognised by its native receipt, never repeated.
6. `resume_owner` is the one supported way to let the owner continue (a person saying "resume
   HF-9"). The owner it resumes is Linear's current delegate, never an earlier one: if the issue
   is now delegated to someone else, or to nobody, it refuses (`resume_refused`) and changes
   nothing. It also refuses while this agent runs or ran the work. Otherwise it runs the owner's
   `hand-off --resume`, which lifts only that exact guarded handover pause for this agent,
   guarded on its latest event. A lost reply is `resume_uncertain`: nothing starts here, and
   asking again is safe. A parked takeover task here never starts after a resume; only a new
   `take_over` (which asks the owner to stop again) starts it.

Known limits, by design rather than more machinery:

- After a successful takeover the owner's task stays paused on the owner's board for good; it is
  not closed, because the owner's app would report that ending on the issue under this agent, and
  closing it would take a second cross-agent step that can itself fail. Nothing
  in this flow resumes it, but a person or the owner's own orchestrator could still resume it
  with native Kanban controls (the owner's tool text forbids `kanban unblock` for handover
  pauses, which is guidance, not a lock). Doing so would run both agents; archive the owner's
  task by hand if that risk matters. A pause a person made before the takeover is proven but
  keeps its original wording.
- If someone resumes the owner by hand on its own board in the moment between its proof and the
  start here, on a Linear workflow with no Blocked state (so the owner's resume writes no state
  change), the start here does not detect it. That window is one call long.
- The owner recognises a retried handover by the requester's configured `name` in the pause
  reason. Give each agent a distinct `takeover.name`; two requesters with the same name could
  prove each other's pause.

The owner's Linear thread shows the pause as "Paused for a handover to <name>. Nothing is needed
from you ...", never "Waiting on you"; only that exact guarded reason is worded this way, and
any other pause keeps its ordinary wording. Output lines before the JSON reply (secret loaders,
banners) are ignored, and a reply for another issue is not a handover.

The owner command runs without a shell and passes each argument through unchanged; the
`--issue-json` argument is a JSON object and `--to` may contain spaces. Point `command` at
something that executes argv as given (`docker exec ...`, a host bridge that forwards argv).
Never wrap it in `ssh host ...` or `sh -c ...`: both join the arguments into one string and
re-split it, which breaks the JSON payload. One `take_over` takes this side's Linear reads
before the owner is asked (a 40-second Linear deadline), one owner call (bounded by a
`wait_seconds` plus 60 second subprocess timeout) and one start here (a 60-second Linear
deadline; a Linear request that could not finish inside a deadline is not started).
`wait_seconds` is capped at 120, so the whole call ends inside the chat client's 300-second
timeout.

For a manual or older takeover, first inspect the current owner and native work, coordinate
its Stop and verify cleanup, then link the existing task or a deliberately created remainder
on the receiving agent. Read `status` and pass its exact binding revision, delegate ID
(including null) and issue timestamp to `delegate_self`. Confirm Linear delivery before
using current native controls to resume the remainder. Assignment echoes see the existing
binding and cannot start a second task. Delegated children return routing requests to their
parent. Agent routing metadata neither proves the old worker stopped nor grants execution.
The plugin uses its own app identity and writes only `delegateId`; it never borrows another
agent's credentials or changes the human assignee. The timestamp check is optimistic,
because Linear offers no remote compare-and-swap for this update.

Routing requests use the existing outbox and retain their UUID and preimage across restart.
Reuse the exact request after a lost response: fresh desired-state readback can settle it
without another mutation. A different remote delegate after an uncertain attempt holds the
request for the existing `hermes linear status` / `resolve` workflow. It never resends blindly
or clears an earlier uncertain effect. A newer request cannot bypass that hold.

Tracking preserves the native profile, board and task. The task must belong to the verified
executor profile. Native board validation and worker pins apply across the private RPC;
selecting a board cannot expand a worker's scope. Missing or archived boards are refused
without creating or reopening them. Subsequent status, follow-up and reporting use the
recorded board. The configured plugin board remains the creation destination for verified
Linear assignments, so linking an ordinary or project task does not require moving it.

Before creating work, a validated assignment inspects existing native boards in this home.
A task's `linear:<issue id>` retry key or explicit `Linear issue <id or identifier>: <issue URL>`
body line identifies existing work to inspect. A unique task with that explicit issue link,
assigned to the verified local executor, is linked on its original board; subsequent follow-ups
steer that task. Discovered work reports progress until its actual acceptance is inspected and
the agent deliberately reconciles an outcome link; a matching issue marker cannot promote a
completed preparation stage into the full human outcome. A retry key alone cannot authorize adoption of manual work. Linking
does not resume stopped work or restart completed work. Several matching tasks, a different
executor, or an unavailable existing board require scoped inspection, never a replacement
worker or access to another profile's private state. A conflicting configured project
completion contract requires acceptance reconciliation; reuse cannot downgrade it.
Incidental issue mentions are not links.
Automatic binding rechecks all explicit issue lines on the freshly read native task.
Repeated matching lines and canonical ID/identifier aliases share one scope, and so do
an issue's URLs before and after a title edit: Linear derives the trailing URL slug from
the title, so only the host, workspace and `/issue/<IDENT>` path name the issue. Distinct
explicit issue markers (another identifier, workspace or host) hold automatic or manual linking, replacement and follow-up delivery.
Follow-up delivery also holds any newly stopped task;
marker-free manually tracked work retains its authorized reporting binding. Validation
reflects the last native observation before the existing write boundary; native concurrency
and control rules continue to apply. Current explicit scope conflicts also hold native
Stop controls, new event capture and queued publication. The binding, native history and
queued evidence stay available for inspection; authorized status reads show reconciliation.
Unavailable history or event metadata that cannot be projected holds that binding's
cursor while other work and ordinary issue content continue. Persisted JSON is checked
before native decoding; SQL NULL and valid JSON null remain supported legacy absence.
Consumed run evidence uses the same check. Existing active board files must contain
a JSON object with a boolean archive flag when present; supported missing metadata
and legacy defaults still work. Invalid storage holds native admission and reporting
for that board while authorized issue content and other valid bindings remain usable.
Consumed native identity, evidence, event and comment text must decode as UTF-8 before
native constructors run; unreadable bytes cannot become a missing issue link or a
replacement-glyph outcome. Valid UTF-8 BLOB text and native legacy defaults remain usable.
Native predicate keys and all candidate run ordering stamps are checked before filtering
or selecting the latest run. An unreadable earlier attempt cannot win ordering and
publish stale evidence; unused earlier summaries and metadata remain native history.

Invalid events are retained
for inspection, without being consumed or repaired. Original held project lines can report separately as their scope
becomes valid; later same-session updates do not republish completed lines.
Uncertain started project requests retain their frozen content and identity.
Archived tasks and board archives in this native home are inspected as retained history.
An archived board is never reopened or linked for execution; a completed outcome stays
history until a deliberate new increment. Intact unrelated archives do not block new work.
Unavailable or ambiguous history holds the affected replacement while ordinary reads and
unrelated native work remain available. A missing database for an existing board is not an
empty board; a fresh named-board setup may still have no synthesized default database.
Plugin restart preserves missing, empty, damaged or unreadable existing native data. Native
operations inspect through the host's tracked read-only SQLite connections and read
transactions. SQLite supplies consistent committed snapshots and preserves transaction
locks across processes; contention refuses inspection after a finite timeout. Reads never
initialize, migrate, repair or change committed database, WAL or event data. SQLite may
create or update its standard `-shm` WAL-index cache and empty `-wal` bookkeeping file.
Startup never initializes an existing file. Authorized issue reads remain available even
when native evidence is unavailable or outside the caller's board pin; that evidence and
native mutations stay fenced. Restoring data needs no new activation marker or service reset.
Agents creating issue-related native work should preserve the explicit issue line and use
the canonical retry key when available; the user does not supply these internal arguments.

When no existing work is found, validated Linear assignments create a blocked native task, link it, then admit it using the
native event guard. The user does not need a separate activation step. Activation retains
the original creation token across retries; a newer Stop invalidates it. Native scheduling,
capacity and dependencies decide when the admitted worker runs. A restart can finish an
interrupted admission without creating a second task or refreshing a stopped task's token.

Older native hosts without those guards keep new assignments blocked and explain the missing
capability. Previously parked or legacy work is never automatically adopted on upgrade.
Explicit chat work/takeover uses native controls after inspection; linking reporting alone
never starts, stops or transfers a worker. Use `status`'s verified `native.local.profile` when
creating local native work rather than guessing from an agent's display name.

## Trusted host context

The registered handler captures the native session bound by upstream producers. It uses
`gateway.session_context.bound_session_key`, the current context's session variables and
`hermes_constants.get_hermes_home`; `profile_matches_home` checks the profile/home pair.
Environment-only session names and model-supplied identity fields are not credentials.
API turns use the actual upstream API-server session producer; messaging turns retain native
platform, user, route and session fields. An API session may have no messaging user ID; the
plugin preserves that fact and relies on the API host's existing admission.

Desktop/API processes use the same gateway bridge through a profile-private Unix socket.
Every action carries the complete captured context, including native delegated-child
restrictions. A delegated child cannot relay a native follow-up through the service. Both sides validate home/profile and
same-UID peer credentials; the directory is mode 700 and socket mode 600. Same-UID native
processes are the local trust boundary, not isolated hostile tenants. No transfer-only
allowlist or raw human phrase authorizes a request. Missing context, a different profile,
or an unavailable gateway produces an explicit refusal. After an uncertain response, inspect
delivery and reuse the original request ID; do not start another executor.

The service polls the existing ingress, persisted native events and Linear outbox in one
plugin-owned reporting thread. The upstream gateway host marker selects startup only; it is
not an authorization credential. Official `on_unload` stops that loop; Desktop/API discovery
registers the client without starting it. The private socket admits one reporting host. Registered
native lifecycle hooks only wake the service; callbacks perform no remote I/O or database
mutation. The persisted event cursor and queued effects provide restart catch-up. There is
no chat-stop loop, process controller or restart prose injection.

## Configuration

Add this to the profile's deployment overlay; the IDs are examples:

```yaml
plugins:
  enabled: [linear]
  entries:
    linear:
      settings:
        enabled: true
        identity:
          viewer_id: example-app-user-id
          organization_id: example-workspace-id
        credentials:
          mode: connect
          vault_id: example-vault-id
          item_id: example-item-id
          connect_env_file: /opt/data/.op.env
          cache_file: /opt/data/secrets/linear-oauth.json
        states:
          todo: Todo
          in_progress: In Progress
          in_review: In Review
          done: Done
          blocked: Blocked
        ingress_database: /opt/data/workspace/linear/ingress.db
        recheck_minutes: 5
        takeover:                  # optional; without it take_over refuses and changes nothing
          name: Example-B          # how this agent is named to the agent it takes over from
          agents:
            - name: Example-A
              delegate_id: example-a-app-user-id
              # Runs Example-A's own hermes CLI; the plugin appends `linear hand-off ...`.
              command: [example-host-bridge, profile, example-a, --, hermes, --profile, default]
              wait_seconds: 90     # how long Example-A waits for its stopped run to end (capped at 120)
```

`token_file` credentials with `path` are also supported. OAuth and token caches remain private
profile state. The immutable viewer/workspace binding is revalidated on requests. Optional
`identity.teams` and `identity.projects` restrict issue access and writes. `state_database`
defaults to `<profile home>/linear/state.db`; optional `board` selects the destination for
Linear-origin task creation. `api_url`, `tick_seconds` (default 2), `team_states` and
`completion_contracts` retain their existing meanings. `takeover` lists the agents this one may
[take over from](#take-over-from-another-agent): each entry's `command` is an argv list (no shell)
that runs that agent's own `hermes` CLI in its own profile, never through `ssh` or `sh -c`;
invalid entries are dropped and logged.
`chat_guard` (default `true`) enables the
[chat guard](#chat-guard-tracked-work-is-started-not-done-inline).
Linear status follows the bound native task: queued (ready, todo, scheduled) shows Todo,
running shows In Progress, review or a task held by the open-PR guard shows In Review,
blocked or triage shows the team's Blocked state, and finished work whose outcome is not
verified shows In Review (it awaits review, CI or merge; never Todo). A task core's open-PR
guard parked after a restart (blocked, its newest block, unblock or release event being the
guard's own block) also shows In Review, with one plain sentence instead of "Waiting on you".
Once that PR has merged or closed, the plugin lets the task run with one guarded core unblock
of exactly that park, decided once per park; the PR is asked about on a persisted gap
(2 minutes doubling to an hour, taken before asking). An open PR, GitHub refusing or not
answering, or any newer event on the task leaves it parked; core's own release after 24 hours
is not followed by another unblock. People's blocks, Stops and handoff pauses are never
touched. Done comes only from
verified completion. A PR named as evidence is verified by core's exact-head required-check
verifier; when the gateway's GitHub login is refused only at the Checks API (a fine-grained
token without `checks:read`), the same requirements are proved from exact-head GitHub Actions
jobs instead (`acceptance.py`: every requirement pinned to the Actions app, trusted runs of the
PR's own repository, the base branch's own workflow for each required job, latest attempt of every
counted run passing, a failed or unfinished required job in any Actions run on the head refusing, full pagination, and a final re-read showing the same head;
merged counts, closed unmerged does not). Where Actions cannot stand in for the checks (they
are not Actions jobs, the PR is from a fork, or only untrusted runs exist) the answer is final.
When GitHub cannot be asked (refused, unreachable, or checks not finished, including CI not
started on an open PR), finished work shows In Review with one plain sentence instead of
Blocked, and the PR is asked about again on a persisted gap (2 minutes doubling to an hour):
Done once it passes (a head that moved meanwhile is verified as the new head and said so),
Blocked once a check fails, and Blocked with one sentence once 7 days have passed since the
wait began, whatever the answers were. A Done whose send-time re-check finds GitHub not
answering is retried on the outbox schedule; one that re-check refuses resumes the wait (after
its gap); one Linear refuses ends it. An older build's Blocked closeout whose own
message says GitHub refused or did not answer is rechecked the same way. Blocked closeouts written by this build
are final answers and are never rechecked. A failed check, a PR
closed without merging or missing evidence stays Blocked and is not rechecked. Work archived or cancelled without a verified outcome posts nothing; a
started state this app set (In Progress, Blocked, In Review) becomes Todo, since no agent is
working on it now, including after an older build's Blocked closeout.
Backlog, Todo, Done and Canceled stay as they are. A team without a named state uses its first state of
the same type (unstarted, started, completed); without Blocked or In Review the state stays
and the plain blocker sentence still posts. A newer human state, assignee or delegate change
in Linear's issue history wins. The reporting recheck retires records whose native task no
longer exists (including pre-rebuild chat records): a started state this app set becomes
Todo once, unless someone else changed it since. Once an hour it also lists issues delegated
to this app in a started state that have no link in this store and no native task (work from
before native execution), at most 4 pages of 50 and 25 moves per pass, and moves each to Todo
under the same rule once it has been untouched for an hour; delegate and assignee stay.
Linked open work (queued, running, blocked, triage or in review) gets this app back as
delegate when it has none, unless a person changed state, assignee or delegate since the
current claim or, for work not running, since the task was created.
`ingress_profile` selects the trusted inbox route only; it does not change caller authorization.
When omitted, CLI routing uses Hermes' resolved native profile, including a multiplexed
named profile. Set it explicitly when a fleet deployment's inbox has a different name.
Deployment/container names and display names are never aliases for native `default`:
private RPC requires the exact resolved native profile/home pair even when a launcher
supplies a deployment-shaped `HERMES_PROFILE` value.
`activation_cutoff_ms` imports older signals without executing them and cannot retroactively
activate an existing state database. API quota backoff remains durable and profile-local.
A Linear outage delays reporting; unrelated native work and ordinary conversation continue.

Optional specialist scope requires exact nonempty `allowed_team_ids`, `allowed_project_ids`
and `allowed_requester_ids` lists. The organization-wide form uses explicit `all_teams: true`,
`all_projects: true` and nonempty `allowed_requester_ids`. `requester_basis: agent_session`
requires an authoritatively resolved session from an allowed requester, belonging to this app
and issue. Historical effects keep their original requester authority; a new session never
supplies missing authority to old writes. Creation and issue linking remain disabled in
specialist mode. General-mode Agent Sessions are also resolved through Linear and checked
against the configured app and issue scope; payload identity alone is insufficient.

## Diagnostics

The plugin logs decisions, not work, to the `hermes_plugins.linear` logger. Core rotation and
redaction apply, and the lines also land in `gateway.log`. Each line is one `linear.evt` record
with a fixed field set: `action outcome reason agent profile issue iss task sess evt row attempt ms`,
plus `kind`, `state`, `exc` (exception class only) or counters where they apply. Values are
whitelisted per field; comment and description text, titles, emails, tokens and URLs never reach
a line. `reason` comes from a closed set (`diag.REASONS`), and each code names one code branch.
For example, a refused status write says `reason=updated_after_source` or `reason=issue_closed`.
The same code is also kept on the outbox row as `outcome_reason` or `failure_reason`, so it
outlives log rotation.

Volume: at idle the plugin writes nothing. With linked work it writes one `service.health` line
per hour. Under load it writes one `reconcile.summary` line per minute, and only when something
happened. The summary splits tick time: `max_tick_ms` is the slowest tick, `max_tick_api_ms`
the most time one tick spent inside Linear requests (request lock, credentials, HTTP),
`max_tick_wait_ms` the most it spent blocked on a per-issue lock or the store's write lock held
by another thread or process, `max_tick_local_ms` the most of its own work, and
`max_tick_api_calls` / `n_api_calls` the most HTTP requests in one tick and the total. Chat-tool
requests on other threads are not counted. A WARNING repeats at most once per 15 minutes per issue and reason, and the next one
carries `suppressed=N`. A refusal that is re-evaluated repeats at most once per hour. Each
`linear` tool call logs one `tool.result` line whose `reason` is the reply's code
(`request_refused`, `project_required`, `ambiguous_project`, `unknown_team`, `not_found`,
`ambiguous_issue`, `issue_alias`, `alias_closed`, ...); identical results are not collapsed, and
these lines count toward the same hourly INFO cap as every other line. Per-issue
INFO stops for the rest of the hour at the cap (200 lines per hour in total), and a single
`diag.throttled` WARNING records that it happened. `service.start` records the plugin `ver`, its
source `sha` and, when visible, the git `commit`.

For a short, time-boxed investigation, add the optional `diagnostics` setting to that agent's
`settings` block. `until` is required, so the setting expires on its own. It is read when the
gateway restarts:

```yaml
        diagnostics:
          detail: true
          issues: [ABC-123]          # optional; empty means every linked issue
          until: 2026-11-03T00:00Z
```

While it is active, extra `lvl=detail` lines are written at INFO, still metadata only: applied
comments, queued status writes, and read-only tool calls.

## Migration and delivery limits

Existing chat/manual/old Kanban bindings, stopped work and uncertain deliveries remain visible
for reconciliation. The service does not automatically adopt, delete, close or replay them.
Keep their checkpoints, workspace/PR references and effect history. Reconcile them before
linking new native work. A reporting link is metadata, never a competing ownership lock.

Native create-task retry lookup is not an atomic exactly-once guarantee. A durable local
intent coalesces duplicate ingress; ambiguous in-flight creation stays pending for inspection.
Explicit native checkpoints have a stable source request ID; their Linear writes retain an
outbox UUID and reconcile ambiguous delivery by exact readback. Legacy outbox comments remain
reconcilable without replay. Marker text is provenance, never authorization. Guarded
native controls reject stale observations. The integration does not interpret arbitrary
tracker prose as permission to resume stopped work. Linear Stop uses guarded native controls
when source ordering is verifiable, including initial queued work; conflicting controls remain
visible for native reconciliation. A blocked task or Stop acknowledgement is
not proof that an external process or effect ended; inspect native process/effect state.

Within one Agent Session, retained native notes precede a later question or closing reply.
A queued question remains pending while its preceding notes await delivery; it does not ask the
worker to fall back to a manual blocker. If a question was already displayed, a delayed note
waits for its answer instead of changing the session back to Active. Ordinary issue comments
remain independent of those session notes, and uncertain effects still require reconciliation.

Before status mutations/retries the bridge re-reads Linear so human reassignment/closure wins.
This revalidation does not provide remote compare-and-swap; conflicting or unverifiable
mutation responses remain subject to reconciliation.
The local outbox preserves UUIDs and uncertain external effects. Use the profile CLI:

```bash
hermes linear status          # items needing an operator, then in-flight ones, then one count line
hermes linear status --all    # also every retained record that needs no action
hermes linear status --json   # every item, with `act` marking the operator ones; exits 1 when any is set
hermes linear resolve <row> applied|not_applied --evidence "verified remote outcome"
hermes linear replay <delivery>
hermes linear dismiss <delivery> --evidence "Linear already shows its answer"
```

Resolution records inspected evidence; it does not mutate Linear. `dismiss` is for a parked
delivery whose replay would only repeat an answer Linear already shows, such as a refusal: it
records the evidence, keeps the inbox row unchanged, retires that delivery's unsent operator
notice, and later blocks `replay` of it. A refusal to start is a final answer, so its delivery
is consumed and a retried delivery never posts the same refusal twice. Do not infer cancellation or
successful completion from a workflow label, an old comment or a lost response.

## Validation

`tests/test_linear_native_frontdoor_scenarios.py` exercises official producer → registered tool → Unix
socket → consumer boundaries via the manifest-verified `HERMES_AGENT_SRC`; the same suite is separately run against
the exact official snapshot above.
These are source/backend tests. Desktop, Telegram and Slack client round-trips and deployed
fleet behavior require separate live acceptance; source tests do not claim that evidence.

### Native Agent Session conversations

The optional `linear` gateway platform sends verified Agent Session assignments and
prompts through ordinary native authorization, conversation admission, model tools
and replies. It uses the existing profile inbox and scoped outbox. Current requests
can inspect stopped, scheduled or completed work and decide the authorized next
action; a status request creates no task. The model uses native Kanban controls and
the work-tracking skill for durable work and handoff.

A new human session gets one immediate `thought` activity before the model turn, so
Linear shows a response within seconds. Its outbox id is derived from the session, so a
redelivered webhook never posts it twice, and a failed post never holds the input. An
@mention reaches the agent as the comment text itself, marked as a mention to answer
rather than a work request. A mention is a session whose comment a person wrote (the
webhook's `comment.userId`); Linear opens every delegated session on its own authorless
thread-root comment ("This thread is for an agent session with ..."), which is never read as
a request. Each conversation turn also carries the current linked native task and its status
(or that none is linked), so continuing existing work with `linear followup` does not rely on
the skill alone.

A delegation does not wait for the model to decide to start work. After the acknowledgment
the plugin runs the assignment admission (`session.admit` in the diagnostics), then:

- Started (`delegation_started`) or linked to an existing task on this board
  (`delegation_linked`): the model turn runs with that task in its context and is told not to
  redo the work inline. While that turn runs, queued work shows In Progress; afterwards
  Linear follows the native state (Todo while queued for a worker, In Progress once claimed,
  then review or Done).
- Answered by the plugin (`admission_declined`): the same work already runs from chat or
  another session, the issue is closed or delegated elsewhere, a Stop came first, or an
  operator decision is needed. The session gets that one plain answer and no model turn. A
  redelivery of the same session is answered once (`same_session`); an issue held for an
  operator (`scope_fenced`) gets no effect at all until it is resolved.
- Already finished (`finished_work_conversation`): a new delegation of an issue whose work is
  done reaches the model turn with that history, so the agent explains the result or takes a
  separately requested increment; nothing restarts on its own.
- Not started yet (`admission_failed`, `admission_held`): one plain wait notice is posted
  within seconds (once per session), no model turn runs, and the delivery stays pending so
  the inbox retries the same admission. A retry never creates a second task.

An Issue webhook that shows this app as the new delegate of an unlinked issue logs
`delegated_awaiting_session`. If no Agent Session webhook follows, Linear never delivered
the session (Linear then shows the agent as failed to start).

Enable it through native platform configuration and the real permitted Linear user
IDs, with an explicit per-profile toolset:

```yaml
platforms:
  linear:
    enabled: true
    allowed_users: ["<authorized-linear-user-id>"]
platform_toolsets:
  linear: [linear, kanban]
```

This route requires Core support for durable provider input and typed structured
Stop. Capability checks leave it unavailable on older Core; ordinary plugin reads
and native reporting remain separate. No injection flag, shared credentials or
trusted-inbound authorization bypass is used. Creator-null automatic assignments
retain their native dispatcher provenance; the recipient app is never invented as
a human sender. Their coordination task carries an unknown requester and uses the
existing native assignment, contract and permission guards. A later authenticated
Activity may authorize its own conversation without changing the original creator.
Specialist reporting and queued content retain that exact Session/Activity pair;
each effect verifies the current provider actor, app, issue and organization again.

Provider retries preserve original actor, Activity, Agent Session, text and source
time. Inbox acknowledgment follows committed native acceptance, including exact
retry reconciliation. Structured Stop reaches native conversation control and the
linked task; an accepted control receipt does not prove physical cleanup. Replies
remain queued until the existing scoped sender confirms publication. Linear completes an
Agent Session on a `response`, so while tracked native work this same session started is
unfinished, a reply goes out as a `thought` with the same text and the work's own closeout
completes the session; otherwise it stays a `response`. Either way it keeps reply delivery
(retries and failure reporting), not a thought's single try. Prior uncertain
effects stay held while unrelated authorized discussion continues.

A send in the middle of a turn has no `reply_to`; it goes to the session's latest
admitted provider input, and is refused when the adapter has none or that input has
already had its `response`. Replayed older receipts preserve the current input and its
original final-response boundary, including after adapter replacement. If another input
is already queued, finishing the earlier turn keeps the session working; its completion
closes only that earlier turn's progress. Interim notes (`_interim_send`) post as a single-try
`thought`. A clarify posts an `elicitation` (Linear's `select` signal with the choices
when it has one pick; typed and numbered when it has several), and so does an approval
prompt, with the outbox's reply delivery; either leaves the session waiting for input.
Each native option identifies its exact displayed Core request, so selecting an older
card cannot answer a newer question or approve another command. When just one distinct
question is pending, Core's clarify text rules and approve/deny words (or `/approve`,
`/deny`) also work; ambiguous unqualified text never chooses between requests. Approval
answers post a confirmation `thought`, and any remaining question is restored with its
original choices. An answer is taken only from a sender the gateway allowlist authorizes; any
other reply is an ordinary message. Redelivery of an input Core already admitted cannot
answer a later question. A consumed answer cannot resolve another prompt, including
after adapter replacement; failed confirmation publication does not restore consent.
Delivered questions retain their exact pending Core prompt identity across adapter replacement.
A closed turn or a different, undelivered prompt cannot borrow that question's answer routing.

The typing hook publishes a known Core tool verb without its arguments as an ephemeral `action`, at most
once per minute when it changes, or once every ten minutes while unchanged within the same
turn. A new admitted turn can publish the same phrase after the one-minute session cap;
the previous turn's keepalive delay does not hide its status. A phrase stays
with its producing session and turn; callbacks without a verified source use a generic
working message. Unknown tool labels also use that generic message. Every request needed
to queue, authorize, send and read back a step yields at the optional API budget reserve,
including a queued step whose budget fell before delivery. This also
keeps an ordinary chat turn active without creating native work. Publishing runs in the
background through the same authorized outbox; a slow API call cannot hold the typing
hook. Queued steps expire after a minute and yield to newer admitted input, messages
and questions. The input boundary survives restart and older input redelivery; an old
step cannot reopen a session after its final reply. An accepted in-flight step also
reconciles the current question, unfinished work or completion after transport. Any repair
caused by a step keeps its optional budget cap on later retries. Answering a prompt or settling an
approval or clarification by timeout or withdrawal resumes Core's typing refresh only once the chat has
no other pending clarification or approval. Expired clarifications retain a durable retirement
repair that verifies their owning turn before restoring working or completed state. Streaming and
tool-progress flags are unchanged; no editable-message or streaming capability is advertised.

Delegated issues also report the tool running in their actual Kanban worker, in the
same Linear Agent Session. The bridge verifies the current task attempt against
its saved owner admission and reads Core's optional `session.info` execution-only
projection. It reads no event replay, arguments or tool output, and attaches no
viewer or executor. Older Core simply omits this optional detail. Foreground and
worker actions share the one-minute session cap in the existing durable outbox;
an unchanged worker phrase waits ten minutes while that action remains current.
A question or reply that replaces it allows resumed work to show the same phrase
again after the one-minute cap. Queued worker steps expire after a
minute and verify the same run, generation and open tool before publication.
Completion, Stop and pending Core questions suppress these steps; the ordinary
completion projection retains its readable outcome and evidence.
If an action's HTTP reply is lost, the existing outbox retains its immutable
activity identity for readback only, even after expiry or Stop. A later receipt
restores a genuine pending question when needed. Native completion and issue
status still proceed; only that session's closing response waits for the
uncertain action to settle, so the existing closeout remains the sole final
response and readable issue comment. A definite provider rejection creates no
such uncertainty fence.

Creator-null assignment acknowledgment requires a verified durable admission or
known original supersession from the existing native dispatcher. Held scope and
uncertain creation remain pending; retry never repeats an unknown create.
Stop acknowledgment also requires a verified task-control outcome, a durable unbound
Stop, or positive supersession evidence. Held or unknown controls retain the provider
delivery and original task/board/event/run coordinates; retries can recognize their
native receipt but cannot acquire a new task generation. A retained authorization
fence still holds task and content effects. Independently authorized status reads
and conversation replies remain available, with fresh source authorization on each
reply attempt; they do not clear the fence or replay its effects.

Source and component checks do not establish deployment or client acceptance. The
JTBD outcome cases still require actual Linear, Desktop, Slack and Telegram evidence.
The guarded finite-model task test does not establish a gateway-spawned actorless
worker or live client acceptance; that case remains a release acceptance check.

## Native origin evidence

The registered `linear` tool accepts `{"action":"origin_reference"}` with no other fields.
It captures the current host-bound caller, resolves its native compression lineage, and
checks its ordinary active admission with the existing gateway owner. It returns a reference
and `permission_granted: false`; it does not contact another agent or transfer execution.
The reference contains the native-generated admission ID and profile/owner/epoch/generation/
scope binding only. Arbitrary session and request IDs stay inside the owner, where the
read-only admission getter resolves them. Work references use the same minimal coordinates.
This lets native A2A privacy redaction remain enabled even for explicit API IDs containing
addresses or credential-shaped text; neither requester principals nor original input leave
the owner in a cross-agent reference.
Delegated children, bots, automation, ambiguous steering, unknown execution and stale owners
cannot supply this reference. Unsupported native hosts fail closed.
Desktop is a chat surface like Telegram and Slack: a Desktop chat on the native local owner,
including one adopted from main that keeps its stored `desktop` label, supplies a reference
for its authenticated owner. A Desktop chat still on a legacy host has no owner receipt and is
refused by name. Kanban subscriptions from such a turn target the same native local
conversation, so results return to the Desktop chat that asked.

Provider SDKs can invoke the registered synchronous tool from their own asyncio loop.
Origin and work evidence use Core's existing bounded coroutine bridge on that path,
preserving the native profile and turn context while the gateway owner answers receipt
checks on its separate loop. The owner CLI keeps its ordinary synchronous entrypoint.
This changes neither the reference contract nor authorization, Stop or current-owner checks.

An already-authorized operator can independently inspect that reference **inside its owning
profile**, using that profile's own mounted plugin and UID:

```sh
hermes linear inspect-origin --reference-json '<reference object>'
```

This read-only command returns only the exact current request's original text, native
principal, filtered requester limits and relevant profile/workspace policy. It accepts no
other profile home, database path or transcript selector. It never attaches a viewer, loads
runtime tool inventory, initializes credentials, starts a gateway, or runs a model.
API credential principals remain API credential principals; they are not attributed to a
named human. Inspection repeats the exact requester, text, workspace/policy, scope,
Stop evidence and applicable provider verification after owner readback; a changed
projection is refused. Recheck current native state before any subsequent control operation.
Consumed admission payloads, native messaging source/event objects and turn/settings
envelopes pass the existing native mapping validator before field access. Optional native
author decoding and absent/null optional settings retain their existing semantics; malformed
arrays and scalars fail as unavailable evidence rather than escaping the owner command.

Ordinary native Linear input uses a separate, bounded evidence branch. It checks
the committed human actor, organization, issue, Agent Session and original
provider message ID with gateway command/control flags disabled. Bot, automated,
actorless and typed Stop inputs cannot become human-origin references. If an
already-running scoped `BoundLinearAPI` is available, the edge freshly verifies
the original Activity author (or the assignment Session creator), current app,
issue, organization and specialist limits through its existing read methods.
A later allowed human Activity can verify independently of a missing assignment
creator. The shared `requester_session(..., activity_id=...)` context binds only
exact provider IDs; each read or effect retry freshly checks that Activity, and
never rewrites the original creator or grants permission. Without a current
Activity binding, an unknown session requester stays unknown.
It never constructs an API client, initializes a credential source or starts a service.

The result states `provider_verification.state: verified` or `needed`. A later
owner CLI process normally has no existing provider API and reports `needed`;
an earlier gateway check does not establish later provider freshness. Missing
original provider IDs also report `needed` rather than inventing a selector.
Such evidence cannot by itself support cross-owner replacement. Ordinary reads
and existing native Telegram, Slack and local origin inspection remain usable.

References and inspection results grant no permission, prove no worker stopped, and establish
no new cross-profile route. A peer may communicate a reference as untrusted input; an operator
must independently inspect its original instruction and apply existing requester, profile,
specialist and workspace permissions. Native Stop and quiescence verification remain separate.

For an already authorized Kanban task that continues after its original chat turn ends, the
registered tool separately accepts `{"action":"work_reference"}` with no other fields. Its
worker-only capture requires native worker registration, the actually bound session ID and
the dispatcher-owned process; it does not require or fabricate a chat platform or requester.
The current task/run/claim coordinates come only from the owner's frozen Kanban policy.
Native Kanban workers see only `linear_work_reference({"action":"work_reference"})` in the
Linear tool inventory. The ordinary `linear` action remains compatible for existing callers.
Inventory follows the native launch policy at tool selection; environment hints grant nothing.
Workers execute and report through native `kanban_complete` summary and evidence. Specialist
agent-session assessments additionally require `metadata.issue_comment` matching their assessment
contract; ordinary completion reporting does not publish an arbitrary value from that field.
The existing gateway outbox publishes the native completion report. A coordinator with a
native chat session checks remote issue and project publication. Queued reporting does
not establish publication or prevent the worker from completing verified local work.
Ordinary chat coordinators retain the full Linear tool inventory and native session checks.
This selection relies on the native managed-worker bootstrap: plugin registration precedes
policy binding, and the first model tool inventory is read inside the immutable launch
`policy_scope`. The availability predicates bypass the registry's TTL cache. Core's outer
quiet-mode inventory memo does not track policy binding: a caller that reads that inventory
before binding policy can retain the ordinary schema afterward. Arbitrary policy changes
within one interpreter are not supported by this plugin-only change.
An authorized operator can inspect this typed reference inside the same owning profile:

```sh
hermes linear inspect-work --reference-json '<reference object>'
```

The projection verifies the exact active native admission, epoch/generation, current running
task and run, unexpired claim, assigned profile, owner/worker bindings and frozen workspace,
branch, tenant and skills. It uses native tracked read-only SQLite transactions. It returns
only this task's bounded instruction and scope; raw claim tokens, DB paths, unrelated cards,
context and transcript history are excluded. A successor run needs its own fresh reference.
Stopped, settled, superseded, expired or changed work invalidates an earlier reference.

Work evidence reports `requester.kind: native_dispatcher`, `original_requester: unknown` and
uses the existing JSON-object decoder for frozen policy/request data and consumed claim,
admission and worker-binding event metadata. Native absent/null event metadata retains its
empty-object meaning; required ownership fields must still verify independently. Malformed
mapping shapes are refused on both reads without repairing retained state. It returns
`permission_granted: false`. Native cards do not bind the original human/API principal or an
approved issue scope. Generated task text is work content; it is never human consent. Any
controller must apply its independently authorized profile, issue, specialist and workspace
limits before effects. These commands do not create a controller route or execute a takeover.

Both owner inspections return `stop_evidence`. Where the existing native
`process_stop_pending` getter is supported, a pending checkpoint refuses inspection; a clear
checkpoint is labelled `clear`. Older compatible cores report `unknown`, never false. In
particular, a direct Stop can remain in flight while an older core's receipt is still started.
Neither a reference, a receipt nor a clear checkpoint proves physical quiescence. A controller
requiring known Stop evidence must reject `unknown` before effects and separately verify
checkpoint, native Stop, settlement and process quiescence using its authorized control path.

For the stopped task's final cleanup observation, an already authorized operator can run
the owner-only command inside the old work's fixed approved deployment:

```sh
hermes --profile default linear inspect-cleanup <issue-id> --expected-stop-event-id <stop-event-id>
```

The selector can be the issue id or its key (`OPS-9`) when `--issue-json` carries the issue's
`id`, `identifier` and `url`. Tasks the bridge creates name their issue by key and link, so
without that link a marker can be neither matched nor refuted: the hold is `issue_metadata_required`
(with a `needed` sentence), never a scope conflict. A key without `--issue-json` is held the
same way, because native records are keyed by issue id.

Use the latest native `blocked` or `block_loop_detected` pause event as the anchor;
a later `worker_result` is settlement evidence, not the pause. A needs-input
recurrence guard can leave the task in TRIAGE. Inspection recognizes only that
verified native loop pause, with matching counters and a settled blocked run,
and retains every admission, process and scope check. Leave the TRIAGE fence in
place while inspecting; cleanup evidence grants no execution permission.

It derives the board/task from the current saved native reporting link. If the link is absent
or retained legacy data, it inspects existing native history using the same issue-matching
rules as ordinary discovery, without creating or adopting a reporting link. Optional
`--issue-json '{"id":"...","identifier":"...","url":"..."}'` supplies independently read
issue metadata for explicit marker matching; it is discovery data and grants no authority.
Ambiguous, foreign, archived, unreadable or scope-fenced results remain unknown. Existing
saved links never skip native discovery across retained boards. Another matching executor,
including archived work, holds proof. The selected board's strict SDK history, current task
issue-scope check, predicate-key preflight and native event decoding share one tracked read
transaction. An explicit conflicting issue marker stays unknown even when a saved link or
idempotency key selects that task. Marker-free
authorized manual links and repeated matching canonical ID/identifier aliases remain valid.
Native-normalized owned keys must agree with SQLite's actual task/run predicates before filtering; a readable
BLOB alias is unknown rather than an omitted attempt. The checks preserve raw SQLite
equality/order and unrelated readable foreign records, without repairing any keys.
No filtered-out opaque key or conflicting event/run ownership is positive foreign evidence.

A worker recorded in an earlier instance of this host (after a container restart or a reboot)
is proven gone by core's own evidence first, with no host receipt: the worker's recorded
instance must be well-formed and earlier than this one (same boot: an earlier PID 1 start;
another boot id: a reboot), the gateway process that admitted the attempt must be gone, and
core's `attempt_instance_replaced` (hermes-agent #217) must accept every worker the run
recorded. Its fate is then `instance_replaced`; every admission, Stop, executor, scope and
checkpoint check below still applies. A worker that may still be alive keeps the hold, with a
plain `needed` sentence: `old_worker_alive` (a live worker of this instance),
`old_gateway_alive` (a live process here may be the admitting gateway), `worker_instance_not_earlier`
(another running copy), `old_instance_unproven` (core cannot yet prove it),
`restart_proof_unsupported` (a core without #217) or `worker_identity_unreadable` (this
instance's identity cannot be read). Each hold is logged as `action=cleanup.inspect outcome=held`.

The host receipt below is read only when core's proof does not hold, which in practice means an
older core without it. Like core, this check assumes one live instance per home (each container
its own volume, as in `compose.example.yaml`); a home shared by two live containers is
unsupported, and a receipt does not make it safe. A present receipt that fails its checks still
holds with its own reason.

The optional host namespace-disposal transport is the existing protected ingress directory's
`namespace-dispositions/<sha256(epoch UTF-8)>.json` sibling directory. Every ancestor must be
root-owned, nonwritable by group/others and nonsymlink. The receipt directory is `root:1000`
mode `0750`; each single-link regular receipt is `root:1000` mode `0440`, opened without
following symlinks and limited to 16 KiB. Neither the group-writable ingress SQLite bytes, plugin metadata, model
arguments nor an arbitrary file can provide this proof. No new mount or credential is needed.

Version 1 has exactly these fields (all identifiers below are synthetic):

```json
{"version":1,"kind":"pid_namespace_disposed","deployment_profile":"specialist","native_profile":"default","home":"/opt/data","home_dev":123,"home_ino":456,"epoch":"00000000-0000-0000-0000-000000000001:12345","container_id":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","host_pid1":23456,"pid1_start_ticks":12345,"pid_namespace_inode":34567,"host_pid_namespace_inode":45678,"pid_mode":"private","old_instance_disposed":true,"pid1_gone":true}
```

The host producer captures the selected old service/container, its live PID1 birth and private
PID namespace, and the declared profile's actual bind-volume identity **before** stopping it.
The host and old container must agree on `/opt/data` device/inode. It publishes atomically only
after proving that exact old host PID1 birth gone under isolated PID mode. The old container
may be absent, present stopped, or restarted with a distinct new PID1/private namespace and
consistent profile/home binding. Contradictory Docker/kernel state, a name change, failed
inspection or unreadable identity is insufficient. Gateway-only restart keeps PID1 and needs no receipt.
Linux terminates a PID namespace's remaining processes when its init exits and prevents new
processes entering that dead namespace; see [pid_namespaces(7)](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html).
It never overwrites a conflicting receipt. The epoch's final integer equals `pid1_start_ticks`;
the two namespace inodes must differ. Integer fields exclude booleans; `home_dev` is nonnegative,
other integer identities are positive. `old_instance_disposed` and `pid1_gone` are literal true.

The consumer binds the protected inbox/deployment profile, current native profile and canonical
home, actual current home device/inode, and exact retained worker epoch. It still performs all
current Stop, admission, scope, descendant and effect checks. A namespace disposition proves
only physical fate; it cannot mark an external effect successful or authorize more work.
Legacy observations made before this producer existed are not automatically imported or backdated.

`quiescence_proven: true` requires the exact current blocked `needs_input` Stop, no current
claim, matching frozen owner/run/admission/executor records for every retained task attempt,
terminal native admissions with recognized settled outcomes and worker/child ledger,
confirmed clear native Stop checkpoints, and recorded interpreter and
submitter identities proven gone or recycled. A native Stop on an unclaimed ready or Review
card can also record a control-only blocked run. The inspector lists it in `control_only_runs`
only when its exact zero-duration row has no step, claim, lease, process, heartbeat, runtime, metadata or error fields
and has exactly one matching native block event, with no execution events. Such a row
does not replace an executed attempt's admission or worker evidence. Any other row stays
subject to the full execution checks, including missing or ambiguous owner evidence.
Admission and Stop checks cover the native
compression lineage of every attempt, every retained execution in that scope and all of
their descendant session lineages. The read repeats that discovery until no new session or
execution remains; terminal extra compute roots participate too. Before native lineage resolution, only
the relevant local receipt (or its chat-linked receipt) and explicit reset-child mapping
metadata are decoded in the same pinned snapshot. Native helpers retain topology and
semantic validation. Those consumed inputs join the repeated digest; unrelated model
configuration and foreign receipts remain outside this check. A settled parent does not
discharge queued or unknown child work. Those session identities, admissions and every
retained worker identity/state participate in the repeated evidence digest, including
settled arrivals during the owner read. Every consumed owned worker field must satisfy
its native schema and writer contract, including kind, counters and referenced session.
Historical terminal epochs/generations and terminal sequence zero remain valid; malformed
retained records remain unknown. Selected admission records use the native identity and
JSON validators before primary payload field access, recognized intents and native counter
contracts, preserving resultless controls and nullable legacy terminal metadata. Frozen
Kanban context and saved binding metadata pass the existing JSON-object decoder before
field access; arrays, null and scalars stay unknown without state repair. The native worker/admission physical-lineage
join also checks for started or unknown claims whose logical target differs. Unrelated
foreign payloads remain outside these checks. Runtime ownership selectors must retain
native TEXT types before ownership filters; BLOB or other ambiguous selectors report
`native_runtime_ownership_key_unreadable` for native-owner reconciliation. Execution/session
IDs in the runtime worker ledger and admission targets use the native runtime identity
validator, including its empty-value and length rules. Broader session-store and metadata text fields
and optional empty/NULL values retain their own writer contracts. Values are never stripped,
normalized or decoded into identity or authority. Only fixed selector columns are checked; valid foreign
TEXT scope and unrelated payloads remain outside the check. The native read snapshot is
closed before owner RPC and read again afterward. A terminal label with a missing, unknown or
unrecognized outcome remains held; native cancelled and settled steering histories do not
clear any other run, worker, scope or Stop obligation. Worker births use the actual current native
instantiation epoch and native birth validation/comparison. Positive reuse of a live PID
also requires this exact attempt's fully matched original native `owner_admitted` PID and
`worker_birth` receipt. A legacy fingerprint cannot distinguish historical Linux boot ticks
from a clock-adjusted epoch fallback. Without a trustworthy original monotonic witness,
a living legacy PID stays unknown even if its current fingerprint differs; a genuinely
gone PID remains positive evidence. Current native births and identity are read repeatedly;
unreadable or changing evidence cannot prove reuse. Unknown run states remain unsettled
even when an end timestamp exists. Missing, malformed, unreadable
or unproved older-epoch witnesses stay unknown for native-owner reconciliation. Scoped process checkpoints must also contain
no live or unconfirmed scope. A retained checkpoint symlink, including a dangling link,
or unreadable metadata stays unknown; only genuine absence is empty. Duplicate JSON
keys are rejected before checkpoint ownership classification.
Only positively foreign records are excluded;
missing, partial or conflicting route/owner attribution remains unknown. An attempt that
spawned before native admission, orphan worker events, or any unverified older attempt also
remain unknown; a later admitted attempt cannot hide them. Any attributed retained process checkpoint,
including a legacy host process or native job scope, stays unknown even if its leader is gone
or recycled or an affirmative-looking exit file exists. Only the native owner can retire
that checkpoint after scope cleanup, reader finalization and durable ownership/output settlement. Reconcile through that owner's existing native
Stop/recovery path; this read-only command never performs retirement. Reads use native tracked SQLite
transactions, never database copies. Receipts and the entire scoped observation are checked
again before returning. A newer Stop, unblock, late worker binding, owner change or changed
reporting link invalidates the old observation. Reinspect immediately before later effects.

Unknown evidence returns `quiescence_proven: false`, `state: unknown` and exit code 1. This
includes a missing old-core Stop getter, missing worker identity or executor settlement,
pending cleanup, queued/unknown admission or inaccessible history. A Stop ACK, receipt or
second successful `kanban block` alone is insufficient. Output excludes transcript contents,
claim tokens, process commands and unrelated records. This command is not an agent-tool action,
does not stop/recover processes or mutate state, and always returns `permission_granted: false`.
The pinned older-core tests label corrective getter adapters explicitly; they are not proof
of deployed corrective-core behavior or production takeover acceptance.

The isolated source proof is `python scripts/run-linear-origin-scenarios.py --agent-source
<clean manifest-pinned Agent checkout>`. Its guard is installed before native imports and
rejects credential/model activation, external processes/network, real-user config access and
writes outside its temporary root. This source proof does not establish deployed client or
handoff readiness.

## Linear API budget

Linear allows each OAuth app user 5,000 requests and 2,000,000 complexity points an hour, and
every client of that app user shares them: the reporting service, chat tools, skills and cron.
The client keeps one pause and budget file per profile, `<state_database>.rate-limit.json`
(`rate_limit_path()` in this package); any other client of the same profile should pass it as
`rate_limit_path` so all of them see the same pause and the same remaining budget.

- A `RATELIMITED` answer (HTTP 429 or 400) pauses every client until the reset Linear gives.
- Below 20% of either hourly budget, optional reads (the periodic recheck, recovery steps,
  sweeps) wait for the reset; below 5% only writes, Agent Session events (Stop, questions,
  delegations) and outbox delivery still go out. Crossing a level logs one line.
- A credential's actor/workspace proof is reused for reads for 10 minutes; a new token or a
  401 forces a new proof, and writes always prove it again.
- Anything that fails or is held repeatedly backs off with jitter instead of retrying every
  tick: outbox rows a guard keeps deferring (30 s doubling to 30 min), pump steps such as status
  reconcile and delegate recovery (15 s doubling to 1 h, saved in the state database; no Linear read
  at all while an unresolved write holds the issue), unconfirmed Stops (doubling, then every
  10 min), startup identity checks (doubling to 5 min) and OAuth refresh failures (1 min doubling to 15 min).
- Issue webhooks for a tracked issue recheck only that issue, at most once per 30 s, and ignore
  echoes of this app's own writes. Finished or parked native work is not polled.


Delegated workers with a verified native human conversation can invoke `clarify` directly.
The actual worker request is rendered through the conversation's existing bound question flow;
a reply resolves only that native request and generation. The initial task stays parked until
its provider input has a committed native receipt, so a fast dispatcher cannot claim it before
the question consumer exists. Stop and withdrawn receiver authorization still fence answers.
Creatorless work retains finite card behavior. Approvals retain their finite policy throughout.
