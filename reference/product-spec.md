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

## North Star

> One number the whole product is judged on. If it moves, we're winning. If it
> stalls, nothing else matters. The four outcome Signals below are its drivers.
> They decompose it, they don't compete with it.

- **Metric:** Trusted Unsupervised Turn Rate (TUTR).
- **Definition:** Of every consequential turn the fleet handles in a rolling
  30-day window, the share that land clean on all four counts:
  - **Unsupervised.** It finished without you babysitting it. No re-onboarding,
    it acted on what it already knows about you.
  - **Trusted.** It took no consequential action you didn't approve, and made
    no off-plan model call.
  - **Observable.** You could see what it was doing in plain words.
  - **Steerable.** You could steer it or stop it mid-flight and it listened.

> [!IMPORTANT]
> On the Observable count: if you had to ask the agent for status, that turn
> failed.

  A turn fails TUTR if it trips any one of the four. "Consequential" means a
  turn that does or changes something, not a pleasantry.
- **Now → Target:** baseline TBD (instrument first), then north of 95% once
  there's a baseline to set the date against.
- **Why this one:** The vision is a standing team that knows you, acts on your
  leash, costs only the plan you pay for, and is there when you reach for it. We
  win when work gets done that you trust, without re-explaining it or watching
  over it. TUTR is that sentence made countable. It only climbs when all four
  outcome Signals hold at once.

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
- [`run-a-fleet-of-specialists.md`](jobs/run-a-fleet-of-specialists.md) — count of active specialists kept on the fleet 90+ days
- [`feel-like-a-colleague.md`](jobs/feel-like-a-colleague.md) — share of turns answered in-persona without a re-introduction
- [`give-each-agent-its-own-workspace.md`](jobs/give-each-agent-its-own-workspace.md) — cross-agent context/credential bleed incidents, target zero
- [`remember-across-sessions.md`](jobs/remember-across-sessions.md) — share of turns acting on stored context vs re-asking (re-onboarding rate)
- [`extend-without-forking.md`](jobs/extend-without-forking.md) — share of new specialists added via config only, no product fork
- [`get-better-the-longer-they-run.md`](jobs/get-better-the-longer-they-run.md) — repeat-correction rate on the same task, trending down
- [`get-from-zero-to-a-working-fleet.md`](jobs/get-from-zero-to-a-working-fleet.md) — time from clean box to first useful turn
- [`deliver-files-i-can-open.md`](jobs/deliver-files-i-can-open.md) — share of file deliverables the principal opens without rework

### hold-the-leash
- [`know-what-my-agent-is-doing.md`](jobs/know-what-my-agent-is-doing.md) — share of turns whose state reads in plain words without a log dive
- [`restart-and-know-what-im-running.md`](jobs/restart-and-know-what-im-running.md) — share of restarts that surface an accurate running-state summary
- [`track-plan-quota-live.md`](jobs/track-plan-quota-live.md) — quota-surprise events (hit a limit unforecast), target zero
- [`steer-or-queue-mid-flight.md`](jobs/steer-or-queue-mid-flight.md) — share of in-flight steer/stop requests honoured before the action lands
- [`approve-what-my-agent-can-touch.md`](jobs/approve-what-my-agent-can-touch.md) — unapproved consequential actions, target zero
- [`see-my-whole-fleet-from-one-screen.md`](jobs/see-my-whole-fleet-from-one-screen.md) — share of fleet whose live status is visible from one view

### subscription-honest
- [`keep-my-subscription-honest.md`](jobs/keep-my-subscription-honest.md) — off-plan callsites, target zero (CI-enforced)
- [`share-auth-across-the-fleet.md`](jobs/share-auth-across-the-fleet.md) — auth-exhaustion turns recovered by failover, target ~100%
- [`crons-use-the-model-only-when-it-earns-it.md`](jobs/crons-use-the-model-only-when-it-earns-it.md) — share of cron fires routed to the cheapest tier that does the job

### always-available
- [`survive-reboots-and-real-life.md`](jobs/survive-reboots-and-real-life.md) — turns silently dropped across reboots/network drops, target zero
- [`idempotent-update-and-restart.md`](jobs/idempotent-update-and-restart.md) — update/restart operations completing cleanly and idempotently, target ~100%
- [`talk-to-agents-from-anywhere.md`](jobs/talk-to-agents-from-anywhere.md) — median ack latency from Telegram message to acknowledgement
- [`act-in-my-tools-with-an-identity.md`](jobs/act-in-my-tools-with-an-identity.md) — share of external-tool actions attributable to a named agent identity
