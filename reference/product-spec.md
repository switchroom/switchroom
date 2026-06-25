---
title: Switchroom product spec
status: active — the product-level layer; owns the job index
anchors: [vision.md, principles.md, invariants.md]
---

# Switchroom product spec

> The product-level layer between the anchors (vision / principles /
> invariants) and the individual job specs. It says what the product is,
> the **outcomes** it delivers, how it **functions** at a high level, and it
> **owns the list of jobs** the product serves. Job specs `serves:` one of
> the outcomes named here.
>
> The outcomes and the job index used to live inside `vision.md` and
> `reference/README.md`. They live here now: `vision.md` keeps the *why*,
> this doc carries the *what it delivers* and *how it functions*.

## The product, in one line

A switchboard for your Pro or Max: a standing team of always-on specialists
you text from Telegram, each running the unmodified `claude` CLI on your own
subscription, on your box, on your leash.

## Outcomes

Every job the product serves ladders up to exactly one of these. A change
that advances none of them is out of scope.

### `standing-team` — a standing team that knows you

Specialists, not one generalist. One bot per specialist, each with its own
persona, memory, skills, tools, and credentials. `clerk` is the canonical
one: a chief of staff that runs the calendar, watches the health data, and
fields the household asks in one voice, because it knows you across all of
it. The coding specialist is the same thesis, not an exception. Add a
specialist in ten lines of YAML; you don't fork the product. Memory serves
this outcome; it isn't the pitch.

**Signal:** continuity — you rarely re-explain. The share of turns that act
on stored context, rather than re-asking for what the agent should already
know, trends to near-zero re-onboarding.

### `hold-the-leash` — controlled, purposeful, never roaming

Agents act, but only with what you gave them. A specialist sees only the
credentials and tools you granted; it can ask for more and you get an
Allow/Deny card; it can't self-elevate or route around you. You're never in
the dark, the state reads in plain words, and you can steer or stop a turn
mid-flight. Awareness and control, not a tool-call log to babysit. (The hard
floor under this outcome is the `no-self-escalation` and `on-leash`
invariants.)

**Signal:** approval coverage — every consequential action passes an
explicit, human-only approval, each one audited and logged, behind an ACL
only a human can edit. Unapproved consequential actions: zero.

### `subscription-honest` — the plan is the ceiling

Cost is the subscription you chose, not a meter you can't forecast. Need more
throughput, pool accounts with automatic failover. One bill, the one you
already pay. (The hard floor is the `claude-native` invariant.)

**Signal:** zero off-plan callsites — every model call runs through the stock
Claude CLI on your OAuth subscription. No API-meter path, no `claude -p`
headless billing, enforced in CI.

### `always-available` — there when you want it

Each specialist is a long-running service. It survives reboots, network
drops, your laptop closing. It runs its scheduled work and it's there the
second you reach for it, anywhere your phone has signal. Available and
punctual, not autonomous.

**Signal:** always-on and reactive — no turn silently dropped, every turn
surfaces its work in Telegram, and the agent acts only on your message or a
cron you created. Median ack within seconds.

## How it functions, at a high level

One agent per specialist, each a long-running service in its own Docker
container, running the unmodified `claude` CLI authenticated with the
operator's Pro/Max OAuth. The operator talks to the fleet from Telegram. A
shared broker holds secrets; an approval kernel gates access an agent does
not already have. Schedules and beck-and-call only, never a loop of its own.
(Runtime detail lives in `CLAUDE.md` and `docs/`; this doc stays at the
outcome altitude.)

## The job index

The jobs this product serves, grouped by the outcome they ladder up to.
Each links its job spec in `jobs/`.

### standing-team
- [`run-a-fleet-of-specialists.md`](jobs/run-a-fleet-of-specialists.md)
- [`feel-like-a-colleague.md`](jobs/feel-like-a-colleague.md)
- [`give-each-agent-its-own-workspace.md`](jobs/give-each-agent-its-own-workspace.md)
- [`remember-across-sessions.md`](jobs/remember-across-sessions.md)
- [`extend-without-forking.md`](jobs/extend-without-forking.md)
- [`get-better-the-longer-they-run.md`](jobs/get-better-the-longer-they-run.md)
- [`get-from-zero-to-a-working-fleet.md`](jobs/get-from-zero-to-a-working-fleet.md)
- [`deliver-files-i-can-open.md`](jobs/deliver-files-i-can-open.md)

### hold-the-leash
- [`know-what-my-agent-is-doing.md`](jobs/know-what-my-agent-is-doing.md)
- [`restart-and-know-what-im-running.md`](jobs/restart-and-know-what-im-running.md)
- [`track-plan-quota-live.md`](jobs/track-plan-quota-live.md)
- [`steer-or-queue-mid-flight.md`](jobs/steer-or-queue-mid-flight.md)
- [`approve-what-my-agent-can-touch.md`](jobs/approve-what-my-agent-can-touch.md)

### subscription-honest
- [`keep-my-subscription-honest.md`](jobs/keep-my-subscription-honest.md)
- [`share-auth-across-the-fleet.md`](jobs/share-auth-across-the-fleet.md)
- [`crons-use-the-model-only-when-it-earns-it.md`](jobs/crons-use-the-model-only-when-it-earns-it.md)

### always-available
- [`survive-reboots-and-real-life.md`](jobs/survive-reboots-and-real-life.md)
- [`idempotent-update-and-restart.md`](jobs/idempotent-update-and-restart.md)
- [`talk-to-agents-from-anywhere.md`](jobs/talk-to-agents-from-anywhere.md)
- [`act-in-my-tools-with-an-identity.md`](jobs/act-in-my-tools-with-an-identity.md)
