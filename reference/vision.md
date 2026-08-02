---
title: Switchroom product vision
source: switchroom.ai (canonical), README.md, reference/jobs/*.md JTBDs
audience: anyone deciding whether a feature, PR, or release belongs in switchroom
---

# Switchroom: product vision

> **A switchboard for your Pro or Max.**
> Your standing team. Specialists who remember you, own their patch,
> and act, while you get on with life.

Your Claude subscription becomes a small team of always-on assistants
you text from Telegram. One box you own. One bot per specialist. Each
has a name, a job it owns, a memory of you, and the tools to do the
work. You text it like you'd text a good assistant. It does the thing.
It asks first on anything that matters.

Not a general-purpose orchestrator. Not a multi-channel bridge. Not a
hosted service. Not multi-tenant. Not an agent that roams on its own.
One idea, done properly: a personal team that lives in Telegram and
stays on your leash.

---

## Why it exists

> *"I loved OpenClaw + Telegram. I wanted my Claude subscription. And
> the UX done properly. So I built this."*

The use case came from OpenClaw. Always-on assistants in a chat app,
each with a personality and a job. Good idea. Three things stopped it
being the one I needed, and nothing else fixed them.

- **On the subscription, properly.** The Claude plan I already pay for,
  the same OAuth as the desktop. Compliant. Predictable cost. Not an
  API meter. Not a second invoice.
- **On the leash.** Give an assistant broad standing access and one day
  it helpfully does something irreversible. Credentials, tools, skills:
  granted deliberately, approved by a human, no way around it.
- **Telegram, done properly.** Not a bridge spread thin across Slack,
  Discord, Teams. One channel. Opinionated. Excellent.

So I built it.

---

## The four outcomes

Every feature serves one of these. If it doesn't, it doesn't belong. The
*why* of each lives here in one line. The full definition, how the product
functions to deliver them, and the jobs that ladder up to each live in
[`product-spec.md`](product-spec.md).

1. **A standing team that knows you** — specialists, not one generalist.
2. **You hold the leash** — controlled, purposeful, never roaming.
3. **Subscription-honest and predictable** — the plan is the ceiling, unless
   the operator explicitly opts a specific account into overage (their own
   Anthropic-funded credits; default-off, auto-stops when the credit runs out).
   The claude-native invariant is unaffected: overage is still the unmodified
   interactive `claude` CLI on the same OAuth subscription, never API/SDK.
   An operator MAY also opt an agent into routing through their own metering
   gateway (self-hosted LiteLLM) for usage tracking + content-safety
   guardrails: still the unmodified CLI on the same OAuth, forwarded
   unchanged, fail-open. See the claude-native gateway carve-out in
   [`invariants.md`](invariants.md).
4. **Always available, in Telegram, done properly** — there when you want it.

The hard constraints under these (claude-native, no-self-escalation,
on-leash, single-tenant, telegram-only) are the lines we won't cross by
construction: [`invariants.md`](invariants.md).

---

## Who it's for

Two people. Don't conflate them.

- **The principal.** The person the team serves. You in non-coding
  mode, or someone non-technical in your house. Never sees a server.
  Texts an assistant that knows them and checks before anything that
  matters. The bar: one even a non-technical partner likes.
- **The operator.** Stands it up. Fine with a Linux box, YAML, an
  OAuth flow. Runs it once, then mostly lives as a principal too.

Technical to stand up. Human to live with. Both halves honest. Neither
hidden.

---

## What it isn't

| Not… | Because… |
|---|---|
| A harness or wrapper | Switchroom never intercepts auth or inference. The `claude` CLI is the runtime. |
| A multi-provider orchestrator | No OpenAI, Gemini, Llama, or model swapping for inference. Auxiliary services (e.g. voice transcription via Whisper) are opt-in helpers, not Claude replacements. |
| A multi-channel bridge | Not Slack, not Discord, not Teams. Telegram, done properly. |
| An autonomous agent | No heartbeats. Beck-and-call plus explicit schedules, on your leash. |
| Multi-tenant | Single-tenant by design — one operator's deployment. Multiple *trusted* users within that one tenant are supported; serving *separate* tenants is not. |
| A hosted service | Self-hosted only. Your box, your tokens, your data. |
| A mobile app | Telegram is the mobile app. |

---

## How vision becomes verdict

The *why*. Three anchors and a product layer turn it into a verdict on a
specific PR or design:

- [`principles.md`](principles.md) — the three standards (docs / defaults /
  consistency) every change is checked against.
- [`invariants.md`](invariants.md) — the lines we won't cross by
  construction.
- [`product-spec.md`](product-spec.md) — the four outcomes (in full) and the
  job index. The per-job **job specs** (`reference/jobs/*.md` with `job:`
  frontmatter) each `serves:` one outcome.

> [!IMPORTANT]
> A change lands when it (a) advances one of the four outcomes, (b) satisfies
> its job spec (proven by its outcome UAT), (c) passes all three principle
> checks, and (d) crosses no invariant. Anything else is out of scope, however
> clever.
