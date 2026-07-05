---
job: operate the fleet from Telegram and see what a fleet operation is doing
outcome: When the operator drives a fleet-wide operation from Telegram (a rollout, an update), they can see it progress and land — phase by phase, in the chat and in a durable record — without host-side grep, and without a live pinned surface running parallel to the conversation.
stakes: A fleet rollout is the single riskiest thing the operator does, and today it goes dark: the roll writes one terminal row to a host-side log, `get_status` is blind to its phases, and nothing reaches Telegram. When a real roll (v0.16.35) half-failed, the only way to learn the outcome was to SSH in and grep. An operator who can't see a rollout land can't trust it, and can't catch a half-rolled fleet before a principal does. But the fix is one step from re-creating the retired pinned progress card — so the operability this job asks for must live in durable artifacts plus in-chat narration, never a parallel pinned mirror.
serves: hold-the-leash
invariants: [chat-is-the-single-source-of-truth, telegram-only, no-self-escalation, single-tenant]
---

# Job Spec: operate the fleet from Telegram and see what a fleet operation is doing

> A durable Job Spec. The *how* — the per-phase hash-chained audit rows written
> by hostd, `get_status`'s rollout-row read, the fire-and-forget terminal push,
> and the log-tailed narration message — lives in the code under
> `src/cli/rollout.ts`, `src/host-control/` and `telegram-plugin/gateway/`.
> That implementation churns; this job does not.

## Who this is for, read this first

This is an **operator** job (`vision.md`'s two people). A fleet rollout is an
operator action taken from an admin agent's Telegram thread. It is NOT a
principal surface: a principal never rolls the fleet and never needs to watch
one. That distinction is load-bearing — it is why the narration here stays a
normal operator-DM message and never grows into a standing status widget.

This job is the **rollout/fleet-op** sibling of two existing jobs, and it must
stay consistent with both:

- [`see-my-whole-fleet-from-one-screen`](see-my-whole-fleet-from-one-screen.md)
  locates fleet status in **durable artifacts** (history, audit, sessions),
  read-only, and explicitly forbids "a live, pinned, parallel progress mirror
  of a turn". This job obeys the same rule: a rollout's status lives in the
  durable audit log (the source of truth) and an in-chat narration message —
  never a parallel pinned surface.
- [`know-what-my-agent-is-doing`](know-what-my-agent-is-doing.md) answers "what
  is happening" **in the chat, by the framework/model speaking** — the
  invariant's own prescribed remedy. This job's narration is exactly that: a
  plain message the operator can scroll to, edited in place as the roll
  progresses.

## The job

The operator kicks off a fleet-wide operation (today: `rollout` / `rollback`,
reachable via `mcp__hostd__rollout` from an admin agent, or `switchroom rollout`
host-side). It runs staggered across N agents with a canary gate. The operator
wants to know, without leaving Telegram and without SSH: did apply succeed, did
the canary pass, which agent are we on (`N/M`), did it land, and if it stopped —
where and on which agent. And a week later they want the same answer from a
durable record, not a memory of a chat message that scrolled away.

## Good / bad

**Good looks like**

- Every phase transition of the roll (apply, canary start/pass/fail, per-agent
  start/done with `N`/`M`, persist-pin, hostd/web deferred, terminal) is
  written as a **durable, append-only, hash-chained audit row** carrying the
  `request_id` and the target pin. The durable log is the source of truth.
- `get_status` for the roll's `request_id` returns its **latest** state — the
  current phase while in flight, and the terminal outcome (rolled agents,
  failed step, failed agent, prior pin) when done — reconstructable from the
  durable log even if the daemon restarted mid-roll.
- On the terminal row, the operator gets **one ordinary Telegram message** in
  their DM saying the roll landed (✅) or stopped (❌ with the step/agent). A
  normal message, not a card, not a pin.
- The in-chat narration (when present) is **one ordinary message edited in
  place** through the phases — `applying → canary → agent N/M → … → ✅/❌` — that
  reads as a normal message the operator can scroll back to.
- The narration surface **pulls** from the durable rows, but be precise about
  the restart guarantee: it holds ephemeral in-memory state for the live roll
  (the message_id it edits + the last-applied seq). A hostd restart mid-roll
  loses that, so it **re-posts a fresh narration message** rather than
  seamlessly re-editing the original — the in-chat surface may duplicate on
  restart. What is fully durable is the roll's *status*: `get_status(request_id)`
  reconstructs the true state from the per-phase rows regardless of any
  narration re-post. (Durable status recovers fully; in-chat narration may
  re-post on restart.)
- Narration emits/edits are **fire-and-forget, idempotent + monotonic by
  sequence, frozen on the terminal row, debounced, and 429-aware** — and never
  block or fail the roll. The roll's correctness never depends on a chat send
  resolving.
- The surface is **bound to a hostd-attested in-flight `request_id`**: a
  shape-only client message can't paint a forged "✅ rolled" surface.

**Bad looks like: never ship this**

- A **pinned progress card** for the rollout, or any bespoke widget/status bar
  rendered solely to be pinned. That is the retired #1122 card wearing a
  rollout hat, and it crosses `chat-is-the-single-source-of-truth`. The one
  sanctioned pin (silently pinning a status message *already* in the chat) is
  narrow and is NOT this.
- A rollout that goes dark: one terminal row, `get_status` blind to phases,
  nothing in Telegram — the pre-#2726 state that made a half-failed roll
  discoverable only by host-side grep.
- A chat send / pin / edit that can **block or fail the roll** (e.g. inheriting
  the approval card's up-to-61-minute wait). Availability of the fleet op is
  never sacrificed to a chat surface.
- A narration surface driven by an **unauthenticated** client message — a
  forged terminal "✅ rolled to vX" is worse than silence.
- A second approval path, a cross-agent leak (surfacing another agent's
  rollout to a non-admin agent), or any principal-facing entry point. Rollout
  stays admin/operator-gated; the narration lands only in the operator's chat.

## Prove it

- **Durable phase trail** — every phase transition appends a hash-chained audit
  row with `request_id` + pin; the terminal row is distinct and a phase row can
  never be mistaken for the terminal sentinel. *Invariant:* the durable log is
  the source of truth; a phase row is lexically disjoint from the terminal one.
- **Un-blind get_status** — a `get_status` on the roll's `request_id` returns
  the current phase in flight and the terminal outcome when done, including
  reconstructed-from-log after a daemon restart. *Invariant:* rollout rows are
  read, not just `update_apply` rows.
- **Terminal ping** — the terminal row pushes exactly one ordinary operator-DM
  message. *Invariant:* it is a normal message (no pin, no card), fire-and-
  forget, and a failing push never fails the roll.
- **Narration, not pin** — the in-chat narration is one ordinary message edited
  in place, pulled from the durable rows, monotonic + frozen-on-terminal +
  debounced. *Invariant:* no parallel pinned surface; recovery is a log re-read;
  bound to a hostd-attested request_id.

## Verdict

- **Done when:** the operator can start a fleet rollout from Telegram, watch it
  progress phase by phase (in-chat narration + `get_status`), and learn its
  terminal outcome both as a normal Telegram message and from a durable
  hash-chained audit record — with no host-side grep, and with no surface that
  runs parallel to (or pinned above) the conversation.

## Production-readiness

- *Compliance:* no Anthropic API/SDK path; the narration is framework messaging,
  not model work. Cross-checked against `no-self-escalation` (rollout stays
  admin/operator-gated; the narration adds no approval path).
- *Availability:* every chat effect is fire-and-forget; the roll's correctness
  and completion never depend on a chat send. A gateway outage degrades to the
  durable log, never a stalled roll.
- *Boundary:* operator-only, in the operator's own chat. It never becomes a
  principal surface and never becomes a live parallel progress mirror — the two
  ways this job would fail even if every feature worked (mirrors the CAUTION in
  `see-my-whole-fleet-from-one-screen.md`).

## Related

- [`see-my-whole-fleet-from-one-screen`](see-my-whole-fleet-from-one-screen.md) --
  the read-mostly operator console; this job is the act-on-it counterpart.
- [`idempotent-update-and-restart`](idempotent-update-and-restart.md) -- the
  update/restart operations whose progress this job narrates.
- [`know-what-my-agent-is-doing`](know-what-my-agent-is-doing.md) -- the same
  answered-in-the-chat, never-a-parallel-surface discipline, per turn.

> [!CAUTION]
> If the rollout status becomes a pinned parallel surface, this job has failed
> even if it shows every phase perfectly. Durable artifact + in-chat narration
> is the whole design; a live pinned mirror is the retired line.

---

> **Implementation:** the per-phase audit rows + `get_status` un-blinding + the
> terminal push live in `src/cli/rollout.ts` and `src/host-control/`; the
> log-tailed in-chat narration relays through the gateway IPC path in
> `telegram-plugin/gateway/`. Those churn; this job outlives them.
