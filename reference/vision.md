---
title: Switchroom product vision
source: switchroom.ai (canonical), README.md, reference/*.md JTBDs
audience: anyone deciding whether a feature, PR, or release belongs in switchroom
---

# Switchroom — product vision

> **A switchboard for your Pro or Max.**
> Opinionated Telegram UX for Claude Code, on the subscription you
> already pay for.

Switchroom turns your Claude Pro or Max subscription into a fleet of
always-on specialist agents you talk to from Telegram. One Linux box,
one Telegram forum, one bot per agent, every session officially
authenticated through the same OAuth flow you use on the desktop. No
API keys. No harness. No second invoice.

It is **not** a general-purpose LLM orchestrator, **not** a multi-channel
bridge, **not** a hosted service, **not** multi-tenant. It does one
thing: makes Telegram the best possible interaction surface for Claude
Code. Unashamedly.

---

## Why it exists

> *"I loved OpenClaw + Telegram. I wanted my Claude subscription. And
> the UX done properly. So I built this."*

Two existing options, two failures:

- **OpenClaw + Telegram** — great UX, but it pings the Anthropic API on
  your own key. You signed up for "use your subscription," not "buy
  API credits on top of your subscription."
- **Claude Code's built-in Telegram channel** — uses the subscription
  correctly, but it's an MVP black box. Send a message, wait, eventually
  something comes back. What did the agent actually do? No idea.

Switchroom is the third option: subscription-honest *and* the UX done
properly.

---

## The four outcomes

Every feature should serve one of these. If it doesn't, it doesn't
belong.

### 1. Visibility — *see every step, pinned to the chat*

The headline UX. Every time an agent starts work, a **progress card**
pins into its Telegram topic and updates in place as tools execute.
Each Read, Bash, Edit, Grep is visible as it happens, with elapsed
time so you can tell if something's stuck. Sub-agent work surfaces in
the same card. When the agent finishes, the card flips to Done and
unpins.

No silent gaps. No ghosts. No squinting into a black box.

### 2. Multi-agent fleet — *specialists, not one generalist*

One bot per agent. Each agent is a real `claude --channels` session
with its own SOUL.md (who it is), CLAUDE.md (what it does), memory
collection, skills, tools, and OAuth credentials. A health coach is
not the same process as an executive assistant is not the same process
as a coding agent. You add a new specialist by editing ten lines of
YAML, not by forking the product.

Sub-agents (Opus plans, Sonnet implements) compose inside each
specialist without leaving the topic.

### 3. Subscription-honest — *your Pro or Max is the ceiling*

> *"Not a harness. Doesn't patch the CLI, doesn't intercept the
> protocol, doesn't forge tokens."*

Switchroom is scaffolding and lifecycle management. It creates
directories, generates systemd units, manages OAuth, routes Telegram
messages — and gets out of the way. Each agent runs the unmodified
`claude` binary, authenticated directly with Anthropic. No Agent SDK,
no API-key routing, no credential interception. Fully compliant with
Anthropic's April 2026 third-party policy.

One bill. The one you already pay.

### 4. Always-on — *runs while you sleep or work offline*

Agents are systemd user units inside tmux sessions. They survive
reboots, network drops, and your laptop closing. Scheduled tasks fire
as systemd user timers. Token refresh runs unattended for weeks. The
fleet comes back on its own after a cold boot.

Telegram IS the mobile interface. Anywhere your phone has signal, your
fleet is reachable.

---

## Who it's for

- **Solo developers** who want Claude in Telegram across devices,
  without giving up their subscription.
- **Home-lab operators** comfortable with `systemd`, YAML, and a Linux
  box they already own.
- **Founder-operators** running a personal fleet of specialists —
  health coach, executive assistant, coding agent, research agent —
  each with its own persona and persistent memory.

Built for people who already run things themselves. Configuration over
code. Native Linux. Transparency over abstraction.

---

## What it isn't

| Not… | Because… |
|---|---|
| A harness or wrapper | Switchroom never intercepts auth or inference. The `claude` CLI is the runtime. |
| A multi-provider orchestrator | We don't care about OpenAI, Gemini, Llama, or model swapping. |
| A multi-channel bridge | Not Slack, not Discord, not Teams. Telegram, done properly. |
| Multi-tenant | Single-operator by design. |
| A hosted service | Self-hosted only. Your box, your tokens, your data. |
| A mobile app | Telegram IS the mobile app. |

---

## Voice and tone

Technical, direct, opinionated. Speaks to builders with agency.
Casual punctuation, assumes infrastructure literacy. Emphasises what
the product *doesn't* do as much as what it does — because the
absences (no harness, no API key, no fork, no Docker requirement) are
the differentiation.

This voice carries into the product surface: CLI output, error
messages, progress cards, setup wizard. Switchroom should sound like
one person built it (because one person did) — not like a committee
shipped a kit.

---

## How vision becomes verdict

This document is the *what* and *why*. Two sibling documents turn it
into a verdict on any specific PR or design:

- **`reference/principles.md`** — the three load-bearing standards
  (docs / defaults / consistency) every change is checked against.
- **`reference/*.md` JTBDs** — outcome-focused jobs the product must
  do (e.g. `know-what-my-agent-is-doing`, `survive-reboots-and-real-life`,
  `keep-my-subscription-honest`). Each maps to one of the four
  outcomes above.

A feature lands when it (a) advances one of the four outcomes,
(b) satisfies its JTBD, and (c) passes all three principle checks.
Anything else is out of scope, however clever.
