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
> allowed / is this still switchroom"* gate in the verdict rule. A change
> that breaks one is out of scope, full stop — not a redesign, not a
> follow-up.
>
> Job specs name the invariants they must never cross in their
> `invariants:` frontmatter, by the slugs below.

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
`claude` CLI and Anthropic — **iff** all four hold:

1. **OAuth forwarded unchanged.** It passes the operator's Pro/Max OAuth
   credential through untouched — the subscription stays the funding *and*
   the identity. The gateway issues **no** `ANTHROPIC_API_KEY`, SDK, or
   raw-API call to Anthropic on the operator's behalf.
2. **No alteration of Claude's operation.** It must not inject, rewrite, or
   strip anything that changes the model selected, the request parameters,
   or Claude's behaviour. Its only permitted writes to the stream are
   **content-safety guardrails** (PII redaction/blocking on message
   content). Observation — token/cost metering, logging, tagging — is
   unrestricted.
3. **Opt-in, default OFF.** No agent routes through a gateway unless the
   operator turns it on, and a gateway outage **fails open** to the direct
   subscription path (availability is never sacrificed to the proxy).
4. **Non-Anthropic is a separate path.** Other models routed through the
   same gateway are off-subscription, separately billed, and **not** covered
   by the subscription-native guarantee — they are a distinct,
   clearly-labelled route.

This is subscription-native by construction: it is still the unmodified CLI
authenticating with the subscription OAuth; the gateway is operator
infrastructure observing and safeguarding the operator's *own* traffic.
Aligns with the [Anthropic AUP](https://www.anthropic.com/legal/aup) and
[Claude Code acceptable-use](https://code.claude.com/docs/en/legal-and-compliance).
The `no protocol interception` clause above bars a *harness over* the CLI
that fakes or reshapes the model exchange — it does **not** bar an operator
metering+safety proxy that forwards the exchange faithfully.

## `no-self-escalation`

Every access decision — a secret, a tool, an MCP server, a host action —
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

Single **tenant** by design — one deployment on one operator's box, with
their tokens and data. Not a multi-tenant SaaS. The deployment is the trust
boundary.

Inside that one tenant you may run **multiple trusted users**: the operator
assigns Telegram user IDs to agents in `switchroom.yaml` (most agents serve
one user, some serve several). Everyone the operator wires in is
**implicitly trusted** — this is not an authorization model for mutually
distrusting parties, and who may drive an agent is exactly that per-agent
user assignment, nothing finer.

Even within that trust, agents **should isolate memory per user and respect
user memory privacy** — one user's memories should not bleed into another
user's recall context. This is a best-effort *should*, not a hard wall, and
it serves two ends at once: privacy among trusted users, and **token
efficiency** (surfacing another user's irrelevant memories just wastes
recall budget). The operator who owns the tenant keeps full visibility; the
isolation is *between the users they configured*, never from the operator.

- **By-construction test:** does this assume more than one **tenant**
  (deployment), or expose one tenant's data to a *different* tenant? If yes,
  it is out. Multiple trusted **users** inside one tenant — including
  per-user memory isolation — is in scope, not a violation.

## `telegram-only`

One channel, Telegram, done properly. Not a multi-channel bridge across
Slack, Discord, or Teams. Auxiliary services (e.g. voice transcription) are
opt-in helpers, not second channels.

- **By-construction test:** does this add a second human-facing chat
  channel? If yes, it is out.

## `chat-is-the-single-source-of-truth`

Status and progress never live in a surface running *parallel* to the
conversation. The chat itself is the single source of truth for what an
agent is doing; framework UI (a reaction, a fallback message) is a safety
net, never a second state mirror. We crossed this line once (the pinned
progress card) and retired it (#1122); it is now a line, not a tradeoff.

- **By-construction test:** does this add a card, pinned widget, or status
  surface that mirrors conversation state in parallel? If yes, change the
  prompt so the model communicates instead. See the "chat IS the artifact"
  sub-principle in `principles.md` and `know-my-agent-is-doing`'s design
  artifact `rfcs/conversational-pacing.md`.
