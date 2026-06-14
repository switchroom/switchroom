# RFC: `ask_peer` — operator-allowlisted, visible cross-agent handoff

Status: Draft v1
Author: Ken (via Claude pair-design)
Date: 2026-06-14

## 1. Summary

Add a way for one agent to **ask another agent a question and get the
answer back** — without merging their memory and without either agent
silently reaching into the other. A leader/EA agent (canonically
`clerk`) calls a new MCP tool `ask_peer(agent, question)`; the question
is delivered into the target agent's live session as a synthetic turn;
the target answers **in its own scope and voice**; the reply is routed
**back to the caller** (which synthesises it for the operator) **and is
visible to the operator** the whole time.

`ask_peer` is gated by an **operator-written per-pair allowlist**
(`agents.<caller>.peers.ask_allow: [<targets>]`). An agent can never add
itself to another's allowlist — the gate lives in config the agent
cannot write (`reference/access-model.md`: *"an agent can request more
access, but it can never author its own authorization. Every grant is
written by the operator, in a place the agent cannot write"*).

This RFC deliberately **rejects** the alternative of giving an agent
read access to another agent's hindsight memory bank (see §7).

## 2. Motivation

The operator runs a fleet of specialists (`reference/run-a-fleet-of-specialists.md`):
`clerk` (EA), `gymbro` (fitness), `finn` (banking), `lawgpt` (legal),
`marko` (marketing), etc. Today the **operator is the only router**: to
get a fitness fact into an EA-driven plan, Ken has to ask gymbro himself
and relay it. The friction is real and grows with the fleet.

The job is **cross-agent handoff**, which the design contract already
names as the sanctioned shape (`run-a-fleet-of-specialists.md`,
Anti-patterns / UAT): *"Need a thing that crosses two specialists. The
user should be able to route it without the agents silently reaching
into each other."* `ask_peer` turns "the user routes it" into "the user
*pre-authorised* a route the leader can take, and still sees every
crossing" — which is the same leash, less manual relaying.

## 3. Non-goals

- **Not** shared/pooled memory. Each agent keeps its own bank and its own
  view of the user (`run-a-fleet-of-specialists.md` bans "shared memory
  across all agents").
- **Not** silent autonomous coordination. Every `ask_peer` exchange is
  surfaced to the operator; nothing happens in the dark
  (`reference/vision.md` pillar 2, "you hold the leash").
- **Not** a generic agent RPC / tool-call bus. The target answers as a
  conversational turn in its own persona; the caller does not drive the
  target's tools.
- **Not** privilege transfer. The target runs with **its own** tools,
  vault grants, and scope. `ask_peer` never lets the caller borrow the
  target's credentials — if gymbro can't read a key, neither can a
  question routed through it.

## 4. Design

### 4.1 The tool

A new MCP tool on the already-scaffolded `agent-config` server (same
server that hosts `peers_list`):

```
ask_peer(agent: string, question: string, wait_seconds?: number) -> { reply: string } | { status: "no_reply" | "denied" | "unknown_agent" }
```

- `agent` MUST be in the caller's `peers.ask_allow` allowlist, else the
  tool returns `denied` without contacting anyone.
- `question` is free text. It is delivered as the target's inbound, not
  executed as a command.
- The call is **async with a bounded wait**: it returns when the target's
  reply lands or `wait_seconds` (default ~120s, capped) elapses
  (`no_reply` — the caller can try again or tell the operator).

### 4.2 Routing (reuses existing rails)

The plumbing is mostly already there:

- **Out:** the gateway already routes a synthetic inbound to any agent by
  name — `ipcServer.sendToAgent(agentName, inbound)` +
  `dispatchAsInbound` (the cron / webhook / Linear path,
  `src/scheduler/dispatch.ts`). The `ask_peer` question is delivered the
  same way, tagged `meta.source = "peer_ask"`,
  `meta.ask_from = <caller>`, `meta.ask_id = <correlation-id>`.
- **Reply (the new part):** the target's turn produces a reply. The
  gateway recognises that this turn answers a `peer_ask` (via the
  correlation id threaded through the turn) and routes the reply **back
  to the caller** as a second synthetic inbound (`meta.source =
  "peer_reply"`, same `ask_id`). The caller's `ask_peer` call, parked on
  the correlation id, resolves with the reply.
- **Correlation:** a small gateway-side map `ask_id -> {caller, target,
  parked_resolver, deadline}`. This is the one genuinely new subsystem
  (today's inbound path is fire-and-forget with no reply-to).

### 4.3 Visibility (the leash)

Both legs are operator-visible, not just logged:

- The **question** posts into the **target's** topic ("🔁 clerk asks: …")
  so the operator sees clerk reached into gymbro.
- The **reply** is what clerk synthesises back to the operator in clerk's
  own turn ("I checked with gymbro — …"), per the
  `conversational-pacing.md` "hand back delegations with synthesis" beat.

So a cross-agent crossing is never invisible: the operator can read it in
plain words and, because the target is a normal turn, can `!`-interrupt
or steer it.

### 4.4 The gate

```yaml
agents:
  clerk:
    peers:
      ask_allow: [gymbro, ziggy]   # operator-written; clerk cannot add to this
```

- Default: **empty** (no agent can `ask_peer` anyone — batteries-included
  safe default, `reference/principles.md` defaults test).
- The target may *also* opt out of being asked
  (`agents.<target>.peers.askable: false`) so a sensitive specialist is
  unaskable even if someone lists it.
- Honors any future `memory.isolation: strict` intent: a strict agent is
  `askable: false` by default.

## 5. Worked example

1. Ken → clerk: "Plan my taper week before the marathon."
2. clerk recognises the training load is gymbro's: `ask_peer("gymbro",
   "What's Ken's current weekly mileage and any flags for a taper?")`.
3. gymbro's topic shows "🔁 clerk asks: …"; gymbro answers from **its own**
   Garmin/coaching context.
4. The reply routes back; clerk replies to Ken: "Checked with gymbro —
   you're at ~45km/wk, HRV's been low this week, so here's a conservative
   taper…"

clerk never saw gymbro's bank; gymbro decided what to share; Ken saw the
whole crossing.

## 6. Security / boundary analysis

| Concern | Mitigation |
|---|---|
| Agent self-elevates to reach a peer | Allowlist is operator-only config; tool returns `denied` otherwise (access-model invariant). |
| Caller borrows target's credentials | None transferred — target answers with its own scope; a key the target lacks stays unreadable. |
| Sensitive specialist leaks | Not in any `ask_allow` + `askable: false` (lawgpt/finn/marko walled by default). |
| Silent coordination | Both legs operator-visible; interruptible. |
| Delegation loop (A asks B asks A …) | Per-turn `ask_depth` cap (e.g. 1) carried in `meta`; `peer_ask`-sourced turns may not themselves `ask_peer`. |
| Target down / slow | Bounded `wait_seconds` → `no_reply`; caller tells the operator rather than hanging. |
| Prompt-injection via the question | Question is delivered as ordinary inbound text the target reasons about — same trust level as any operator message; the target's existing guardrails apply. |

## 7. Alternative considered and rejected: cross-agent memory read

Give the caller a second, read-only hindsight MCP entry pointed at the
target's bank (`X-Bank-Id: <target>`, write tools denied).

Rejected as the primary mechanism because:

- It is the **named anti-pattern** — `run-a-fleet-of-specialists.md`:
  *"Shared memory across all agents. Every specialist should have its own
  view of the user."* and `remember-across-sessions.md` bans *"conflating
  … different specialists into one undifferentiated memory pool."*
- **All-or-nothing per bank** — it can't distinguish a safe summary from a
  confidential detail, so the most-useful targets (lawgpt = estate case,
  finn = banking, gymbro = health) are exactly the ones it would leak.
- **Silent** — the caller ingests another agent's memory with no operator
  visibility (fails the leash).
- **Lower value** — returns stale extracted facts, can't act, and can't
  give the live answer `ask_peer` does.

A narrower variant — a curated **shared "team board"** bank that agents
*publish* select facts to (the source mediates), read by the leader — is
contract-acceptable and complementary. It serves *passive awareness of
standing facts* where `ask_peer` serves *live answers + delegation*. It
is out of scope here but noted as a possible companion (the unused
`memory.shared_collection` field is the existing hook).

## 8. Principle checks (`reference/principles.md`)

- **Docs test:** the chat teaches it — "I checked with gymbro" is
  self-explanatory; no docs needed to understand a crossing happened.
- **Defaults test:** empty allowlist out of the box; the capability is
  dormant until the operator lists a pair. No dangerous default.
- **Consistency test:** reuses `peers_list` (same server), the
  `inject_inbound` transport, the approval/visibility surface, and the
  "hand back with synthesis" pacing beat — same shapes as adjacent
  features.

## 9. Phasing

- **Phase 0 (shipped, this workstream):** `clerk` soul `Boundaries` —
  router-advisor behaviour using the existing `peers_list`. clerk names
  who owns a domain and offers to route, and is told never to reach into
  another agent's memory/vault/state. Zero new capability; immediate
  value; establishes the boundary in-persona.
- **Phase 1:** `ask_peer` request/reply with the allowlist gate +
  visibility, behind a config flag, canaried `clerk → gymbro` (a
  non-sensitive pair) before any sensitive agent is ever listed.
- **Phase 2 (optional):** the shared "team board" companion for standing
  facts, if Phase 1 shows awareness (not just delegation) is also wanted.

## 10. Open questions

1. **Reply attribution.** Does the question post in the target's topic as
   "clerk asks" (chosen above) or silently? Visible is safer for the
   leash; confirm it isn't noisy in practice.
2. **Wait semantics.** Block the caller's turn on the reply (simpler, but
   ties up the caller) vs. resume the caller via a follow-up synthetic
   when the reply lands (more like real delegation, more moving parts).
   Lean follow-up-synthetic to match the existing async inbound model.
3. **Depth/rate caps.** Is `ask_depth = 1` (no transitive asks) plus a
   per-turn ask count enough, or do we need a fleet-wide rate limit?
4. **Target persona for the answer.** Should the target know it's
   answering a peer (so it can be terse/structured) vs. answering the
   operator? Probably yes — `meta.ask_from` lets its prompt adapt.

## 11. Effort estimate (agent-minutes)

- Tool + allowlist schema + gate: ~30 min
- Reply-correlation map + `peer_reply` routing in the gateway: ~60 min
  (the genuinely new part)
- Visibility surfaces (question-in-target-topic, synthesis hand-back): ~30 min
- Tests (gate, correlation, timeout, loop-cap, no-credential-transfer) +
  a live mtcute `clerk → gymbro` UAT: ~60 min

Bounded, single-workstream. The risk is concentrated in the
reply-correlation seam; everything else reuses hardened rails.
