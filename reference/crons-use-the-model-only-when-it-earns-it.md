---
job: scheduled work should cost the minimum that does it — spend the model only when it adds value
outcome: A cron pays for a model only when the model earns it. Mechanical work (fetch an API, check a value, run a script) runs model-free at zero token cost. A cheap model runs only when light judgment helps. The full agent runs only when its memory and persona genuinely add value. All of it on the subscription, never the API or `claude -p`. The schedule the user set costs what the work needs, not a full reasoning turn per tick.
stakes: A fleet of always-on specialists runs standing schedules. If every fire is a full-context turn — even a `*/10` "is there anything new?" poll, even a "fetch the feed and post it" chore with no judgment in it — the schedules quietly drain the plan ceiling. The user added a punctual assistant and got an unpredictable token bill. Worse, reaching for `claude -p` to make those cheap fires "efficient" leaves the subscription entirely and breaks Anthropic policy. The job is to make scheduled work cheap *inside* the constraint, so "always-on" never means "always-billing."
---

## Status — PARTIALLY SHIPPED (capability), value-gate default PENDING

**Shipped (v0.15.8):** the scheduler hot-reloads the overlay (a schedule
change is live in ~30s, no restart — so a removed entry stops firing
instead of running as a zombie), and agents can author the cheaper tiers
(`schedule_add --model sonnet` → a fresh cheap cron session). The tier
*routing* (`SWITCHROOM_CHEAP_CRON`) and the event-driven path
(`reaction_dispatch`, #2291) are built.

**Not yet shipped:** the model-free **action** tier and the
**deterministic value-gate default**. Today the cheap tiers are *opt-in*
(off by default), and there is no path for a purely mechanical cron to run
**without** a model at all — so "fetch and post" chores still burn a full
turn. Until the value-gate lands, this job is *available*, not *delivered*.

## The model: value-gate the model, deterministically

One rule, applied per cron: **what does the work actually need?** The
answer picks the cheapest rung that does the job. Nothing pays for
reasoning it doesn't use.

| The cron's real work | What runs | Token cost | Compliance |
|---|---|---|---|
| Fetch an API / check a value / run a declared script / store a result | **no model** — the scheduler does it | zero | trivially compliant (no inference) |
| Detect a change, act only when something moved | **no model** to detect; one model fire **on a hit** | ~zero on no-ops | compliant |
| Light judgment — summarise, format, triage | **cheap model**, fresh minimal-context session (Tier 1) | low | interactive CLI on the subscription |
| Real judgment — needs the agent's memory, persona, recent context | **the full agent** (Tier 2) | full | interactive session |
| Triggered by an event, not a clock | **event-driven** (reaction / webhook) | zero idle | compliant |

The sharp edge: **the model is for judgment, synthesis, drafting,
decisions — not for making a routine API call.** A cron whose whole job is
"GET this endpoint and post the result" has no judgment in it, so it must
not wake a model. That is the single biggest source of wasted tokens
today, and closing it is what makes this job real rather than optional.

## How this serves the vision

**Outcome 3 — subscription-honest and predictable (*the plan is the
ceiling*).** This is the job's home. Cheap-by-default scheduled work keeps
the plan as the ceiling instead of a meter you can't forecast, and it does
so *inside* the hard constraint: every model fire is the interactive
`claude` session, never `claude -p`, never the API. Model-free fires are
better still — zero inference is zero policy surface. See
[[keep-my-subscription-honest]].

**Outcome 4 — always available, runs its schedules.** Punctual without
being expensive. The schedule the user set runs on time and costs what the
work needs. Hot-reload keeps the schedule *correct* (no zombie fires), so
"always-on" stays trustworthy. See [[survive-reboots-and-real-life]].

**Outcome 2 — you hold the leash (*never roaming*).** The cheaper triggers
stay the operator's. A model-free poll or a reaction-dispatch is still
"the schedule you set," not a loop the agent runs on its own — the
capability-gated ones (polls, secrets, egress) need an operator commit.
Determinism is part of the leash: the system, not the model's guess,
decides how a fire runs, so behaviour and cost are predictable. See
[[steer-or-queue-mid-flight]].

## How this passes the principles

- **Defaults (the load-bearing one).** *Works on a fresh setup with zero
  config?* The cheap path must be the **default**, chosen for the user, not
  a flag they learn and set. A fresh agent's mechanical crons should cost
  zero tokens without anyone configuring a tier. Shipping tiers as opt-in
  knobs *fails* this check — it is "configure-everything," which
  [[principles]] explicitly warns decays the product. The value-gate
  default is how this job passes Defaults.
- **Docs (*if they need the docs, we've failed*).** The user — and the
  agent — should not have to study a tier table to get the cheap, correct
  behaviour. The system picks it. A deterministic selector satisfies this;
  prose guidance alone does not.
- **Consistency.** One "how should this run" mental model, not a pile of
  flags (`--model`, `--context`, `kind: poll`, `reaction_dispatch`, …). The
  selector is the unifier: most users never touch a tier knob, and the few
  who override do it the same way everywhere.

## How the system decides (deterministic, model-free)

Reliability comes from taking the decision away from the model, not from
prompting it better. A pure function over observable signals —
**cadence** (how often it fires), **content** (does the prompt reference
the agent's memory / persona / recent context, or is it self-contained),
and **trigger shape** (clock vs event) — maps each entry to a tier. Same
inputs, same tier, every time; fully enumerable and testable. The agent's
`--model` hint is an **override**, never the source of truth. Roll it
**shadow-first**: log what the selector would pick versus what fires
today, plus the per-fire cost and hit-rate the audit already records,
prove the divergence is safe, then enforce. Keeping a model *out* of this
decision loop is itself part of the job — a classifier that calls a model
to decide how to save model calls is self-defeating, non-deterministic,
and off-budget.

## Anti-patterns

- **A model turn for a mechanical chore.** "Fetch the feed and post it"
  firing a full Tier-2 turn because that is the only path. The work has no
  judgment in it; it must run model-free.
- **`claude -p` to make cheap fires "efficient."** Headless print mode is
  programmatic usage, off the subscription, against policy (vision pillar
  3). The cheap path is the *interactive* session or no model at all —
  never `-p`, never the API.
- **Cheap-as-opt-in.** Leaving the expensive tier as the default and the
  cheap one behind a flag the user must discover. Fails the Defaults check;
  the good behaviour must be the default.
- **A model deciding the tier.** Asking the LLM "which tier?" reintroduces
  non-determinism, costs tokens, and weakens the leash. The selector is
  deterministic and model-free.
- **Stripping memory where it earns its keep.** Routing a cron that needs
  the agent's persona/history to a fresh Tier-1 session to save tokens, and
  getting a worse answer. Cheap is the goal *only when the model adds no
  extra value*; the gate is "does judgment/context help," not "is it
  cheaper."
- **Babysitting the principal.** A confirm-every-cron prompt in the name of
  control. Awareness (a visible "filed as Tier 1 because …") is the leash;
  a tap on every fire is the tool-call log the vision rejects.

## The verdict for this job

Done when: scheduled work is **model-free by default** unless the work
genuinely needs judgment; a **model-free action tier** exists so mechanical
crons cost zero tokens; the cheaper tiers escalate only when there is real
reasoning to do; the tier is chosen **deterministically by the system**;
and every model fire is still the interactive subscription session, never
`-p` or the API. Anything that bills the plan for reasoning a cron never
uses is the bug this job exists to kill.
