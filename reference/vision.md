---
title: Switchroom product vision
source: switchroom.ai (canonical), README.md, reference/*.md JTBDs
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
being the one I needed, and nothing else fixed them:

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

Every feature serves one of these. If it doesn't, it doesn't belong.

### 1. A standing team that knows you: *specialists, not one generalist*

The headline. One bot per specialist. Each its own persona, memory,
skills, tools, credentials. `clerk` is the canonical one: a chief of
staff that runs the calendar, watches the health data, fields the
household asks, all in one voice, because it knows you across all of
it. The coding specialist is the same thesis, not an exception. It
remembers why the product is the way it is, so its pushback on a
half-formed idea from the train is worth something. Add a specialist
in ten lines of YAML. You don't fork the product.

Memory serves this. It isn't the pitch.

### 2. You hold the leash: *controlled, purposeful, never roaming*

The substantive one. Agents act, but only with what you gave them. A
specialist sees only the credentials and tools you granted it. It can
ask for more. You get an Allow or Deny card in Telegram. Only your tap
grants it. It can't self-elevate or route around you. No heartbeats:
beck-and-call plus the explicit schedules you set, never a loop of its
own. You're never in the dark, the state reads in plain words, and you
can steer or stop a turn mid-flight. Awareness and control. Not a
tool-call log to babysit.

### 3. Subscription-honest and predictable: *the plan is the ceiling*

Every agent runs the unmodified `claude` binary, OAuth straight to
Anthropic, the same flow as the desktop. No Agent SDK. No API-key
routing. No raw API. No credential interception. This is a hard
constraint, not a preference: running the native CLI on the
subscription is what keeps switchroom inside Anthropic's third-party
policy. The moment a feature reaches for the SDK or the API, it has
left switchroom.

Every model call is the interactive `claude` session, or a turn
synthesized into it. Headless `claude -p` is the same CLI, but as of
the 2026-06-15 policy it counts as programmatic usage, off the
subscription, so switchroom keeps that work in the interactive session
too.

Cost is the subscription you chose, not a meter you can't forecast.
Need more throughput, pool accounts with automatic failover. One bill.
The one you already pay.

### 4. Always available, in Telegram, done properly: *there when you want it*

Each specialist is a long-running service. It survives reboots,
network drops, your laptop closing. It runs its scheduled work and
it's there the second you reach for it, anywhere your phone has
signal. Available and punctual. Not autonomous. Telegram is the
interface, singular on purpose, not one tab of a bridge.

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
| Multi-tenant | Single-operator by design. |
| A hosted service | Self-hosted only. Your box, your tokens, your data. |
| A mobile app | Telegram is the mobile app. |

---

## Voice and tone

Plain, direct, opinionated. Reads like one person built it, because
one did. Lead with what it feels like to have the team, not the
machinery. Operator and trust details stay honest and present, never
buried, never dressed up. No filler. No hype. No em dashes. Say what
it deliberately doesn't do, no API key, no harness, no heartbeat, no
second channel. The restraint is the point.

Carries into every surface: CLI output, errors, the status the
principal sees, the setup wizard.

---

## How vision becomes verdict

The *what* and *why*. Two sibling docs turn it into a verdict on a
specific PR or design:

- **`reference/principles.md`** carries the three standards (docs /
  defaults / consistency) every change is checked against.
- **`reference/*.md` JTBDs** are the outcome-focused jobs. Each maps
  to one of the four outcomes above.

A feature lands when it (a) advances one of the four outcomes,
(b) satisfies its JTBD, (c) passes all three principle checks.
Anything else is out of scope, however clever.
