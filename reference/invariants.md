---
title: Switchroom invariants
status: the third anchor — lines we won't cross by construction
audience: anyone designing, building, reviewing, or releasing switchroom
---

# Switchroom invariants

> The third anchor, beside [`vision.md`](vision.md) (the *why*) and
> [`principles.md`](principles.md) (the *built-well* standards).
>
> Invariants are different from principles. A principle is a quality
> standard you check a change against, and two principles can be in tension
> so you trade them off. An **invariant is a line we will not cross by
> construction**, however useful a feature seems. It is the *"are we even
> allowed / is this still switchroom"* gate in the verdict rule.
>
> Job specs name the invariants they must never cross in their
> `invariants:` frontmatter, by the slugs below.

> [!CAUTION]
> A change that breaks one of these invariants is out of scope, full stop.
> Not a redesign, not a follow-up.

## `claude-native`

Every agent runs the **unmodified `claude` CLI**, authenticated with the
operator's Pro/Max OAuth. No `ANTHROPIC_API_KEY`, no API keys of any kind,
no Agent SDK, no raw Anthropic API, no protocol interception, no custom
inference runtime. No new `claude -p` callsite (headless print mode is
programmatic usage off the subscription as of the 2026-06-15 policy). Model
work is the interactive session or a synthesized turn injected into it.

- **By-construction test:** does this path call a model any way other than
  the interactive `claude` CLI on the subscription? If yes, it is out.
- **Why it's an invariant, not a preference:** the native CLI on the
  subscription is what keeps switchroom inside Anthropic's third-party
  policy. It's a compliance boundary. See `keep-my-subscription-honest.md`.

### Operator-controlled gateway carve-out

A gateway the operator runs (e.g. self-hosted LiteLLM) MAY sit between the
`claude` CLI and Anthropic, **iff** all four hold:

1. **OAuth forwarded unchanged.** It passes the operator's Pro/Max OAuth
   credential through untouched: the subscription stays the funding *and*
   the identity. The gateway issues **no** `ANTHROPIC_API_KEY`, SDK, or
   raw-API call to Anthropic on the operator's behalf.
2. **No alteration of Claude's operation.** It must not inject, rewrite, or
   strip anything that changes the model selected, the request parameters,
   or Claude's behaviour. Its only permitted writes to the stream are
   **content-safety guardrails** (PII redaction/blocking on message
   content). Observation (token/cost metering, logging, tagging) is
   unrestricted.
3. **Opt-in, default OFF, availability preserved.** No agent routes through a
   gateway unless the operator turns it on. A gateway problem never silences
   the fleet, but the recovery is split by cause (the two-mode boot contract,
   shipped for interactive sessions in `profiles/_base/start.sh.hbs`; cron
   sessions are ported to the same contract in #2981):
   - **Missing virtual key** (no per-agent key in the vault): **fail open** to
     the direct subscription path. There is nothing to authenticate to the
     proxy with, so routing env is stripped and the agent talks to Anthropic
     directly on the forwarded OAuth — loudly logged as untracked/unguarded.
   - **Proxy unreachable with a key present**: **keep routing and warn** — do
     NOT fall open. Routing env is left pointed at the proxy so traffic
     self-heals the moment it recovers (the socat forwarder reconnects
     per-connection), rather than silently going untracked on a transient blip.
   Failing open on an unreachable-but-keyed proxy was removed (#2940): silent
   untracked traffic violates the cost-tracking side of this carve-out.
4. **Non-Anthropic is a separate path.** Other models routed through the
   same gateway are off-subscription, separately billed, and **not** covered
   by the subscription-native guarantee. They are a distinct,
   clearly-labelled route.

This is subscription-native by construction: it is still the unmodified CLI
authenticating with the subscription OAuth; the gateway is operator
infrastructure observing and safeguarding the operator's *own* traffic.
Aligns with the [Anthropic AUP](https://www.anthropic.com/legal/aup) and
[Claude Code acceptable-use](https://code.claude.com/docs/en/legal-and-compliance).
The `no protocol interception` clause above bars a *harness over* the CLI
that fakes or reshapes the model exchange. It does **not** bar an operator
metering+safety proxy that forwards the exchange faithfully.

## `no-self-escalation`

Every access decision (a secret, a tool, an MCP server, a host action)
flows from operator-authored config or an operator tap, enforced where the
agent can't rewrite it. An agent can ask for more; it can never grant itself
more.

- **By-construction test:** can an agent reach a credential, tool, or host
  action without operator config or an operator tap? If yes, it is out.
- **Detail contract:** [`access-model.md`](rfcs/access-model.md).

## `on-leash`

No heartbeats, no self-authored loops, no roaming. Agents act on
beck-and-call plus the explicit schedules the operator set, and nothing
else.

- **By-construction test:** does this make an agent act without an operator
  message or an operator-set schedule firing? If yes, it is out.

## `single-tenant`

Single **tenant** by design: one deployment on one operator's box, with
their tokens and data. Not a multi-tenant SaaS. The deployment is the trust
boundary.

Inside that one tenant you may run **multiple trusted users**: the operator
assigns Telegram user IDs to agents in `switchroom.yaml` (most agents serve
one user, some serve several). Everyone the operator wires in is
**implicitly trusted**. This is not an authorization model for mutually
distrusting parties, and who may drive an agent is exactly that per-agent
user assignment, nothing finer.

Even within that trust, agents **should isolate memory per user and respect
user memory privacy**: one user's memories should not bleed into another
user's recall context. This is a best-effort *should*, not a hard wall, and
it serves two ends at once: privacy among trusted users, and **token
efficiency** (surfacing another user's irrelevant memories just wastes
recall budget). The operator who owns the tenant keeps full visibility; the
isolation is *between the users they configured*, never from the operator.

- **By-construction test:** does this assume more than one **tenant**
  (deployment), or expose one tenant's data to a *different* tenant? If yes,
  it is out. Multiple trusted **users** inside one tenant (including
  per-user memory isolation) is in scope, not a violation.

## `telegram-only`

One channel, Telegram, done properly. Not a multi-channel bridge across
Slack, Discord, or Teams. Auxiliary services (e.g. voice transcription) are
opt-in helpers, not second channels.

- **By-construction test:** does this add a second human-facing chat
  channel **for the people the team serves**, a bridge to WhatsApp, Signal,
  Slack, Discord, Teams, or the like? If yes, it is out. This invariant is
  about the *principal's* channel: there is exactly one, Telegram, done
  properly. It is **not** a ban on operator/admin tooling.

### Scope: the admin console is not a channel

An **operator/admin** management console (e.g. a Hermes-Desktop client pointed
at a Switchroom adapter) is **out of this invariant's scope**: it is admin
tooling for the person who runs the box, not a chat channel for the people the
team serves. `telegram-only` stays strictly true: it governs *principal*
channels, and the admin console is not one.

The console MAY let the operator send a turn to one of their own agents from
outside Telegram. To stay admin tooling (and not quietly become a second
channel or a hidden conversation), it must hold all four:

1. **Operator/admin audience only.** Authenticated, single-tenant, never
   reachable by a principal as *their* way to talk to an agent. It is the
   operator's workshop view, not a second front door for the people the team
   serves. (Same "audience is the whole line" reasoning that keeps an operator
   surface clear of `chat-is-the-single-source-of-truth`.)
2. **One canonical record.** Every operator turn and the agent's reply
   **mirror into that agent's Telegram thread.** The console is another way
   *in*, never a separate conversation the Telegram thread can't see, so
   there is still exactly one record, and `chat-is-the-single-source-of-truth`
   holds.
3. **Same path, not a parallel runtime.** The operator turn is injected
   through the existing synthesized-inbound path (the cron / `inject_inbound`
   pattern), landing as an ordinary turn in the one agent session. No second
   agent loop, no second inference path.
4. **Approvals stay on Telegram.** The console never gains an
   approve/deny/grant action; the human-validated Telegram tap remains the
   sole approval surface (`no-self-escalation`). A console that wires
   approvals is out.

The line that *would* cross `telegram-only` is a **principal-facing** bridge:
giving the people the team serves a second way to chat (WhatsApp, Signal, a
public web chat). That is still out. The detail contract for the admin console
is [`rfcs/fleet-dashboard.md`](rfcs/fleet-dashboard.md).

## `chat-is-the-single-source-of-truth`

Status and progress never live in a surface running *parallel* to the
conversation. The chat itself is the single source of truth for what an
agent is doing; framework UI (a reaction, a fallback message) is a safety
net, never a second state mirror. We crossed this line once (the pinned
progress card) and retired it (#1122); it is now a line, not a tradeoff.

**One sanctioned exception — the silent pin of an already-rendered status
message.** The #1122 removal assumed the status message stays visible in the
live conversation window. That assumption no longer holds: the speed of modern
answers, more background workers, and much longer-running turns mean the
conversation moves on quickly in the feed and the user loses sight of in-flight
work. Work now routinely outlives the visible feed — fast turns scroll it away,
concurrent background workers stack up, long-running turns run past the fold. To
keep in-flight work in view when that happens, the framework MAY pin a status
message **that is already rendered in the chat** — specifically the existing
per-turn status message and the existing `🛠 Worker` background-worker message —
and auto-unpin it when that work completes. The pin MUST be silent
(`disable_notification: true`). This carries no new content: it re-surfaces a
message the conversation already owns.

This is the ONE exception, and it is narrow by construction. It does **not**
reopen bespoke cards. It does NOT permit: a new card/widget/status surface
rendered solely to be pinned; a notification-generating pin; or any pinned
surface that renders content not already present in the chat. Pinning a message
the feed already holds is fine; rendering a second, parallel surface is still the
retired line.

- **By-construction test:** does this pin a message the conversation *already*
  rendered (per-turn status / `🛠 Worker`), silently, and auto-unpin it on
  completion? That is the sanctioned exception. Does it instead add a card,
  pinned widget, or status surface that mirrors conversation state in *parallel*,
  or render new content solely to pin it? If yes, that is still the retired line
  — change the prompt so the model communicates instead. See the "chat IS the
  artifact" sub-principle in `principles.md` and `know-my-agent-is-doing`'s design
  artifact `rfcs/conversational-pacing.md`.
