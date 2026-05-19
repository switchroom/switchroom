---
title: Switchroom product vision
source: switchroom.ai (canonical), README.md, reference/*.md JTBDs
audience: anyone deciding whether a feature, PR, or release belongs in switchroom
---

# Switchroom — product vision

> **A switchboard for your Pro or Max.**
> Your standing team. Specialists who remember you, own their patch,
> and act, while you get on with life.

Switchroom turns your Claude Pro or Max subscription into a small team
of always-on specialist assistants you talk to from Telegram. One box
you already own, one Telegram forum, one bot per specialist. Each is a
real person to you: it has a name, a job it owns, a memory of you that
builds over time, and the tools and skills to actually do the work. You
text it like you would text a competent assistant. It does the thing,
and it asks you first on anything that matters.

It is **not** a general-purpose LLM orchestrator, **not** a
multi-channel bridge, **not** a hosted service, **not** multi-tenant,
and **not** an autonomous agent that roams on its own. It is the
opinionated version of one idea, done properly: a personal team that
lives in Telegram and stays on your leash.

---

## Why it exists

> *"I loved OpenClaw + Telegram. I wanted my Claude subscription. And
> the UX done properly. So I built this."*

The use case came from OpenClaw. Always-on assistants you talk to in a
chat app, each with a personality and a job, was a genuinely good idea
and OpenClaw is where it clicked. Three things kept it from being the
thing actually needed, and nothing else had fixed them:

- **Run it on the subscription, properly.** It should use the Claude
  Pro or Max plan already paid for, the same OAuth as the desktop app,
  compliant with Anthropic's third-party policy, and cost a predictable
  amount. Not an API meter. Not a second invoice.
- **Stay on the leash.** Assistants given broad standing access will,
  trying to be helpful, eventually do something expensive or
  irreversible. Access to credentials, tools, and skills has to be
  granted deliberately and approved by a human, with no way for the
  agent to route around it.
- **Telegram, done properly.** Not a bridge spread thin across Slack,
  Discord, WhatsApp, and Teams. One channel, opinionated, excellent.

So this got built. It is not pitched as a moat. It is the version of a
use case worth loving, made to work the way it should.

---

## The four outcomes

Every feature should serve one of these. If it doesn't, it doesn't
belong.

### 1. A standing team that knows you — *specialists, not one generalist*

The headline. One bot per specialist, each a real `claude` session
with its own SOUL.md (who it is), CLAUDE.md (what it does), memory,
skills, tools, and credentials. `clerk`, the canonical example, is a
chief of staff: it handles the calendar, watches the health data,
fields the household requests, and answers in one voice because it
knows you across all of it. A coding specialist is the same thesis,
not an exception: it remembers why the product made the choices it
did, so its pushback on a half-formed idea from the train is
load-bearing, not just syntactically valid. You add a specialist by
editing ten lines of YAML, not by forking the product.

*Memory is an implementation detail in service of this, not a selling
point.* Switchroom gives each specialist its own semantic memory bank
and keeps it from fighting Claude's native memory. That is a sound
fit, not a differentiator.

### 2. You hold the leash — *controlled, purposeful, never roaming*

The substantive one. Agents act, but only with what you gave them. An
approval kernel and per-agent ACLs mean a specialist sees only the
credentials and tools you granted it. It can ask for more when more
would help, you get an Allow or Deny card in Telegram, and only your
tap grants it. It cannot self-elevate or work around you. There are
deliberately **no heartbeats**: agents are at beck and call and run
the explicit scheduled tasks you set, they do not loop autonomously.
And you are never in the dark, the state is always legible in plain
words, and you can steer or stop a turn mid-flight. Awareness and
control, not a tool-call log to supervise.

### 3. Subscription-honest and predictable — *the plan is the ceiling*

Each agent runs the unmodified `claude` binary, authenticated directly
with Anthropic over the same OAuth as the desktop app. No Agent SDK,
no API-key routing, no credential interception, compliant with
Anthropic's April 2026 third-party policy. Cost is the subscription
you chose, not a meter you can't forecast. Need more capacity, pool
several accounts with automatic failover. One bill. The one you
already pay.

### 4. Always available, in Telegram, done properly — *there when you want it*

Each specialist is a long-running service. It survives reboots,
network drops, and your laptop closing. It does its regular scheduled
work and is there the moment you reach for it, from anywhere your
phone has signal. Available and punctual, not autonomous. Telegram is
the interface, opinionated and singular on purpose, not one tab of a
multi-channel bridge.

---

## Who it's for

Two different people, do not conflate them:

- **The principal** — the person the team serves. Could be you in
  non-coding mode, could be someone non-technical in your house. They
  never see a server. They text an assistant that knows them, gets
  things done, and checks before anything that matters. The bar: one
  even a non-technical partner likes working with.
- **The operator** — the person who stands it up. Comfortable with a
  Linux box, YAML, and an OAuth flow. Runs it once, then mostly lives
  as a principal too.

Technical to stand up. Human to live with. Both halves stay honest;
neither is hidden behind the other.

---

## What it isn't

| Not… | Because… |
|---|---|
| A harness or wrapper | Switchroom never intercepts auth or inference. The `claude` CLI is the runtime. |
| A multi-provider orchestrator | We don't care about OpenAI, Gemini, Llama, or model swapping. |
| A multi-channel bridge | Not Slack, not Discord, not Teams. Telegram, done properly. |
| An autonomous agent | No heartbeats. Beck-and-call plus explicit schedules, on your leash. |
| Multi-tenant | Single-operator by design. |
| A hosted service | Self-hosted only. Your box, your tokens, your data. |
| A mobile app | Telegram is the mobile app. |

---

## Voice and tone

Plain, direct, opinionated. It should read like one person built it,
because one person did, not like a committee shipped a kit. Lead with
what it feels like to have the team, not with the machinery. Keep the
operator and trust details honest and present, never buried, never
dressed up. No corporate filler, no hype, no em dashes. Emphasise what
the product deliberately does *not* do, no API key, no harness, no
heartbeat, no second channel, because the restraint is the point.

This voice carries into every product surface: CLI output, error
messages, the status the principal sees, the setup wizard.

---

## How vision becomes verdict

This document is the *what* and *why*. Two sibling documents turn it
into a verdict on any specific PR or design:

- **`reference/principles.md`** — the three load-bearing standards
  (docs / defaults / consistency) every change is checked against.
- **`reference/*.md` JTBDs** — outcome-focused jobs the product must
  do. Each maps to one of the four outcomes above.

A feature lands when it (a) advances one of the four outcomes,
(b) satisfies its JTBD, and (c) passes all three principle checks.
Anything else is out of scope, however clever.
