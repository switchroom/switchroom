---
title: Switchroom copy kit
source: vision.md (canonical), product-spec.md (four outcomes), live LinkedIn copy, external evidence brief 2026-06-23
audience: anyone writing public-facing copy (landing page, posts, decks, README)
---

# Switchroom: the copy kit

How we say it. Ready-to-lift language for any surface.

Every block traces to a `reference/product-spec.md` outcome, noted per
pillar. The design contract owns *what we build*; this owns *how we talk
about it*. If the two ever conflict, the contract wins and this gets fixed.

Voice follows `vision.md`: plain, direct, opinionated. Lead with what it
feels like to have the team, not the machinery. No em dashes, no hype, no
filler. Say what it deliberately doesn't do. The restraint is the point.

---

## Tagline

**A switchboard for your Pro or Max.**

Secondary kicker / standfirst: *A team of always-on assistants you text.
On a leash.*

## Standfirst (the elevator version)

Switchroom turns the Claude subscription you already pay for into a team
of always-on assistants you text on Telegram. Each one has a name,
remembers you, owns its patch, and does the actual work. They stop and
ask before anything with consequences, and only your tap says go.

## What it is

Switchroom turns your Claude subscription into a team of always-on
assistants you talk to on Telegram. Not coding bots. A chief of staff, a
writing partner, whatever job you give them. Each is a specialist with its
own name, memory, and tools.

It feels like texting a person who knows you, not poking at a black box.
Each assistant remembers you and actually does the work. You never need to
know there's Claude Code under the hood. My wife doesn't 😉.

---

## The four pillars

### 1. A real team, not a chatbot
*Outcome `standing-team`.*

One specialist per job, each with its own name, memory, skills, tools, and
credentials. `clerk` is the one to picture: a chief of staff that runs the
calendar, watches the health data, and fields the household asks in one
voice, because it knows you across all of it. Add a specialist in ten
lines of config. You don't fork the product. It feels like a colleague who
knows your context, not a chat window that forgets you every session.

### 2. On a leash
*Outcome `hold-the-leash`.*

Your assistants don't roam. They act only on what you ask or the schedules
you set, and only with the credentials and tools you granted. Anything
extra is a card in Telegram, Allow or Deny, and only your authenticated tap
grants it. No agent can self-elevate or route around you.

And you're never in the dark. State reads in plain words, not a tool-call
log to babysit. If you want to change course, you steer or stop a turn
mid-flight and it listens. Awareness and control, by design.

### 3. Always there, the second you reach for it
*Outcome `always-available`.*

Each specialist is a long-running service, not a script you launch. It
survives reboots, network drops, your laptop closing. It runs its
scheduled work and it's there the moment you text, anywhere your phone has
signal. Available and punctual, never autonomous.

### 4. The rest of your Claude subscription
*Outcome `subscription-honest`.*

It runs on the Pro or Max plan you already pay for, the same login as the
desktop. No API meter, no second invoice, no setup project.[^overage] It
works out of the box, on your own machine, on your terms.

[^overage]: The plan is the ceiling by default. An operator can opt a
specific account into overage (their own Anthropic-funded credits,
default-off, auto-stops when they run out) or route an agent through their
own metering gateway. Either way it stays the unmodified `claude` CLI on
the same OAuth subscription, never an API key or SDK. See
`reference/invariants.md`.

---

## How it's different (the wedge)

### It asks first

Most agent tools are built to act first. They're pitched to run
unsupervised, and one day one helpfully does something you never asked
for. Switchroom is built the other way. It asks first. Agents only move on
your say-so or a schedule you set. Every credential, skill, and tool is a
deliberate grant you approve. The control isn't a setting. It's the design.

### Telegram, done properly

Not a bridge spread thin across Slack, Discord, Teams. One channel,
opinionated, excellent. That focus buys real craft: replies render as rich
Telegram markdown, so tables, code blocks, quotes, and expandable detail
land natively on your phone instead of a wall of plain text. One channel
done properly beats five done thinly.

---

## Social hooks / post openers

- Claude Code is great at your desk. You're not always at your desk.
- You wouldn't give a new hire your passwords on day one. Why give an AI agent the keys?
- My wife runs her week through an AI chief of staff. She has no idea it's Claude Code underneath. That's the point.
- Every AI agent tool is coding-shaped. Most of life isn't code.
- An always-on assistant that acts without asking is a liability. One that asks first is a teammate.
- Five chat apps done half-well, or one done properly? We picked one.

---

## Boilerplate (the one-paragraph "about")

Switchroom turns your Claude Pro or Max subscription into a team of
always-on, Telegram-native assistants. Each is a named specialist that
remembers you and does real work, but stops and asks before anything with
consequences. You're never in the dark, and you can steer or stop it
mid-flight. It runs the unmodified Claude CLI on the plan you already pay
for, self-hosted on your own machine. Open source. Always on. On a leash.

---

## Evidence behind the claims

The pains each pillar names are externally supported. Cite the theme, not
a fabricated stat. Full brief and sources: external evidence brief,
2026-06-23.

- **Pillar 1 (team).** People want always-on assistants in the apps they
  already use (52% comfortable relying on personal AI assistants for
  everyday tasks, Zendesk/YouGov 2025). Today's agent tooling is
  coder-shaped (84% of agent use is software development, Stack Overflow
  2025). The "it forgets me" frustration is widely voiced (qualitative, no
  clean stat).
- **Pillar 2 (leash).** Our strongest, best-sourced ground. 90% of agents
  are over-permissioned (Obsidian 2025); 53% of enterprises report agents
  exceeding their remit (CSA 2025); OWASP ranks prompt injection the #1 LLM
  risk and prescribes human-in-the-loop for high-impact actions; PwC 2025
  names "lack of trust in agents," not the tech, as the top adoption
  barrier.
- **Pillar 3 (always there).** Reliability, "just works, always on," is a
  baseline expectation for anything that stands in for a person's
  attention (qualitative). Stated as an experience benefit, not an uptime
  SLA.
- **Pillar 4 (subscription).** Self-hosted alternatives are an assembly
  project (competitor reviews concede 10 to 20 hours of setup). The
  flat-plan, no-meter benefit is stated as a benefit, not a price
  comparison.

**Do not overclaim.** No fabricated "X% require human-in-the-loop" stat.
No public Claude subscriber count. Competitor incidents are directional
colour, not customer-facing copy, until traced to a primary source.
</content>
