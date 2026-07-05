---
job: have my agent show up and act in the tools where my work already happens, as itself
outcome: When something happens in a tool the user already works in (a PR opened, a Linear issue assigned, an @-mention) the right agent shows up there, under its own identity, and does the work in that tool, not only in Telegram.
stakes: An assistant that only lives in a chat box is a side conversation. If the user has to copy work out of Linear or GitHub into Telegram and paste results back, the agent isn't on the team, it's a tool the user operates. But an agent that acts on un-gated external input is a roaming bot wearing the operator's face. Both failures are fatal, one to usefulness and one to the leash.
serves: always-available
invariants: [on-leash, no-self-escalation, single-tenant]
---

# Job Spec: act in my tools, with an identity

> This job sits at the seam between two outcomes: it extends
> *always-available* past Telegram into the tools the user already lives in,
> and it leans hard on *hold-the-leash* to keep that reach gated. The
> load-bearing distinction is the **gated-vs-roaming line** in Good / bad
> below. The *how* (the edge lock, the per-agent HMAC, the gateway-socket
> forward, the Linear app-actor OAuth) lives in the design docs linked in
> the footer. That churns, this job does not.

## The job

The user's work doesn't happen in a chat box. It happens in the PR thread, the
Linear ticket, the issue comment, the places where they already collaborate
with other people. They don't want to relay all of that through Telegram by
hand: read the ticket, paste it to the agent, copy the agent's answer back into
the ticket. They want the agent to **show up where the work is, as a named
participant** (a reviewer on the PR, the assignee on the issue, a teammate you
can `@`-mention) and act there directly, with its own identity and its own
granted permissions. Telegram stays the place the user *steers and oversees*
from. The tools become places the agent can *act in*.

The hard part is that this is the one surface where something other than the
operator can reach an agent. So the whole job hinges on the trigger being
**operator-configured and securely gated**: the operator allowlists the source,
holds the signing secret, scopes the OAuth grant, and locks ingest to the
trusted network edge. The agent acts on those gated triggers and nothing else.
"Show up in my tools" and "never roam" are the same requirement stated from two
sides.

## Good / bad

**Good looks like**

- A PR is opened or an issue is assigned in a tool the user already uses, and
  the right agent shows up *there* (a comment on the thread, an activity on
  the issue timeline) without the user relaying anything through Telegram.
- The agent acts under **its own identity** in that tool: a Linear app actor
  with its own avatar, `@`-mentionable and assignable; a reviewer identity on
  the PR. Other collaborators see a named teammate, not an anonymous bot.
- The agent only wakes on a trigger the **operator configured**: a source the
  operator allowlisted, a dispatch rule the operator wrote, an OAuth grant the
  operator scoped. Nothing else gets it to act.
- Every inbound event is **proven authentic before it can wake an agent**:
  signed by a secret the operator holds, arriving through the operator's
  trusted network edge. An unsigned or off-path request is rejected and the
  agent never sees it.
- The agent's reach in each tool is exactly the scope the operator granted.
  It can ask for more (and the user gets an Allow/Deny); it can never widen
  its own scope.
- The user oversees and steers all of it from Telegram. The tool is where the
  agent *acts*; the chat is where the user stays in the loop and on the leash.
- When the agent's standing in a tool lapses (a revoked token, an expired
  grant), the user is told plainly. The agent doesn't silently go dark in a
  channel the user assumed was live.

> [!CAUTION]
> This is the one surface where a non-operator input can reach an agent. An
> agent acting on an un-gated, unsigned, or off-path trigger is roaming
> wearing the operator's identity — it breaks `on-leash` by construction.
> Never ship it.

**Bad looks like: never ship this**

- The agent acts on an **un-gated external trigger**: a webhook with no
  signature check, a source the operator never allowlisted, an event that
  reached the receiver off the trusted edge. *This is roaming wearing the
  operator's identity, and it breaks `on-leash` by construction.* The line:
  acting on an **operator-configured, authenticated** trigger is the job.
  Acting on **anything that can reach the endpoint** is the anti-job.
- A misconfigured gate that **fails open**: ingest accepting events when the
  edge secret is missing, or the HMAC unverifiable. A security gate's failure
  mode is *deny*, never *allow*.
- The agent **self-grants reach**: widening its own OAuth scope, adding a
  webhook source, or wiring a new tool identity without an operator action.
  Scope flows from operator config or an operator tap, full stop.
- A **heartbeat or self-authored poll** dressed up as "showing up": the agent
  waking itself to go look at a tool on a loop it invented. Showing up is
  *event-driven from a gated trigger*, never a loop the agent runs.
- The agent acting in a tool as a **generic, anonymous bot** with no distinct
  identity, indistinguishable from the operator, or from another agent
  sharing one app credential. Each acting identity is its own.
- Treating the inbound event payload as **instructions** rather than data,
  letting a PR title or issue body steer the agent past its granted scope.
  Untrusted content is data. The leash is the operator's config.
- The agent going **silently dead** in a tool (a lapsed token, a disabled
  webhook) with no word to the user, who keeps assuming it's present.

## Prove it

> *Honest coverage note: the per-layer security and identity controls are well
> unit-tested, but there is **no runnable end-to-end scenario** today that
> drives a real external event through the edge → receiver → agent → back to
> the tool under the agent's own identity. The integration round-trip is a
> coverage gap, flagged below.*

- **Edge-gated ingest (receiver)** — `src/web/webhook-handler.test.ts`
  (*Cloudflare edge lock* + *viaGateway forward* blocks), `src/web/webhook-edge.test.ts`.
  *Watch:* a request missing the edge header is `403`'d before any work; a
  signed, on-edge request forwards to the agent. *Invariant:* `on-leash` — an
  off-path or unsigned event never reaches an agent.
- **Fail-closed gate (receiver)** — `src/web/webhook-handler.test.ts`
  (*fail-closed: requireEdge but edgeSecret null → 403*),
  `tests/webhook-verify.test.ts` (*rejects when no secret is configured*).
  *Watch:* a misconfigured lock denies every request. *Invariant:* `on-leash`
  — the gate never falls open.
- **Authentic trigger only (receiver)** — `tests/webhook-verify.test.ts`
  (HMAC match/mismatch/tamper, Bearer constant-time). *Watch:* a tampered or
  wrong-secret body is rejected `401`. *Invariant:* `on-leash` — only an
  operator-secret-signed event can wake an agent.
- **Operator-configured dispatch only (receiver)** — `src/web/webhook-dispatch.test.ts`
  (rule matching: event/action/labels/author), `src/web/webhook-gateway-record.test.ts`
  (*fires a matching dispatch rule*, *does not dispatch when no chat target*).
  *Watch:* an agent wakes only on an event matching an operator-authored rule.
  *Invariant:* `on-leash` — no rule, no wake.
- **Acts under its own identity (tool side)** — `src/web/webhook-gateway-record.test.ts`
  (*injects a verified Linear AgentSessionEvent with session id*, *does NOT
  inject when `linear_agent` not enabled*). *Watch:* the agent is woken as the
  configured Linear app actor, only when the operator enabled that identity.
  *Invariant:* `no-self-escalation` — the acting identity exists only because
  the operator provisioned it.
- **Operator-granted scope, no self-grant (tool side)** —
  `tests/linear-agent-sandbox-guard.test.ts` (*setup refuses inside a
  container*), `tests/linear-oauth-refresh.test.ts` (refresh rotates a key the
  agent may already read; revoked → surfaced, nothing written). *Watch:* an
  agent can rotate a token it was granted but cannot mint a new identity or
  grant; provisioning is a host/operator action. *Invariant:*
  `no-self-escalation` — scope flows from operator config, never the agent.
- **Never dies silently (oversight)** — `tests/linear-oauth-refresh.test.ts`
  (revoked refresh token classified and surfaced), `tests/wedge-watchdog.test.ts`.
  *Watch:* a lapsed credential is reported, not swallowed. *Invariant:* a
  lapsed tool identity is always spoken, never a silent dead channel.

**Coverage gap — the missing end-to-end:** there is no UAT scenario
(`telegram-plugin/uat/scenarios/`) that drives a real edge-gated webhook into a
live agent and asserts a visible action *back in the tool* under the agent's
identity. The layers are proven in isolation; the full path is not.
*(coverage gap: no runnable scenario yet, needs a `jtbd-act-in-tools-*` driver
exercising edge → ingest → wake → Linear-actor activity.)*

**Fuzz corpus:** vary source (github × linear × generic) × auth state (valid
signature × tampered body × wrong secret × missing secret) × network path
(through-edge × direct-to-origin, with edge-lock on/off) × dispatch match
(matching rule × no rule × matching but no chat target) × identity state
(provisioned actor × not-enabled × revoked/expired token) × payload-as-data
(benign × prompt-injection in title/body) × replay (fresh delivery × duplicate
delivery id). The invariants must hold across the corpus: only an
operator-gated, authenticated, on-edge, rule-matched event ever wakes an
agent; the gate fails closed; the agent never widens its own scope; a lapsed
identity is always surfaced.

## Verdict

- **Done when:** an operator-configured, authenticated event arriving through
  the trusted edge makes the right agent show up *in the tool* under its own
  identity and act there, while an un-gated, unsigned, off-path, or
  un-matched event never moves the agent at all, and the user can see and
  steer the whole thing from Telegram. Proven across the auth/path/identity
  corpus above (and, once built, the end-to-end driver that closes the gap).

## Production-readiness

> This job carries real stakes: it is the only surface where a non-operator
> input can reach an agent, and it puts the agent's name on actions in the
> user's real tools. The security bar is part of the outcome, not a footnote.

- *Authenticity:* every accepted event is signed by an operator-held secret
  (HMAC for github/linear, Bearer for generic), verified constant-time;
  unverifiable → reject, never best-effort.
- *Network provenance:* with the edge lock on, only requests carrying the
  Cloudflare-injected header are accepted; a request reaching the origin by
  any other path is `403`'d before signature work.
- *Fail-closed:* a missing/empty/unreadable gate secret denies all traffic. A
  misconfigured control denies; it never silently opens.
- *Replay resistance:* duplicate deliveries (e.g. provider retries) are deduped
  before they can fan out a second action.
- *Least privilege of the receiver:* the one internet-facing component runs
  with no docker socket and no added capabilities; the per-agent forward is
  peercred-gated to the agent and operator UIDs.
- *Scope discipline:* each acting identity holds exactly the OAuth scope the
  operator granted; tokens self-rotate in-container but the agent can never
  mint a new identity or widen a grant. `single-tenant` — one operator's
  tokens and identities, never shared across tenants.

## Related

- [`approve-what-my-agent-can-touch`](approve-what-my-agent-can-touch.md) --
  how the operator grants the identity and scope this job acts under.
- [`share-auth-across-the-fleet`](share-auth-across-the-fleet.md) -- the
  credential plane behind the per-agent acting identities.
- [`know-what-my-agent-is-doing`](know-what-my-agent-is-doing.md) -- seeing
  and steering the tool-side action from Telegram.

---

> **Implementation:** the *how* lives in `docs/webhook-ingest.md` and
> `docs/linear.md` (the shipped surfaces), with the design rationale in
> `reference/rfcs/webhook-cloudflare-edge-lock.md` (the edge gate),
> `reference/rfcs/webhook-via-gateway-socket.md` (the single-writer forward to the
> in-container gateway), and the Linear app-actor OAuth flow in `docs/linear.md`.
> Those churn; this job outlives them.
