---
job: scheduled work should cost the minimum that does it — spend the model only when it adds value
outcome: A cron pays for a model only when the model earns it. Mechanical work (fetch an API, check a value, run a script) runs model-free at zero token cost. A cheap model runs only when light judgment helps. The full agent runs only when its memory and persona genuinely add value. All of it on the subscription, never the API or `claude -p`. The schedule the user set costs what the work needs, not a full reasoning turn per tick.
stakes: A fleet of always-on specialists runs standing schedules. If every fire is a full-context turn — even a `*/10` "is there anything new?" poll, even a "fetch the feed and post it" chore with no judgment in it — the schedules quietly drain the plan ceiling. The user added a punctual assistant and got an unpredictable token bill. Worse, reaching for `claude -p` to make those cheap fires "efficient" leaves the subscription entirely and breaks Anthropic policy. The job is to make scheduled work cheap *inside* the constraint, so "always-on" never means "always-billing."
serves: subscription-honest
invariants: [claude-native, on-leash]
---

# Job Spec: scheduled work spends the model only when it earns it

> A durable Job Spec. The *how* (the tier rungs, the deterministic
> value-gate selector, the model-free action tier, the cron-session
> identity) churns; this job does not.

## The job

A fleet of always-on specialists runs standing schedules. The job is to
make each scheduled fire cost what its *work* needs and no more: a purely
mechanical chore (fetch an endpoint, check a value, run a declared script)
runs model-free at zero token cost; light judgment runs on a cheap model;
real judgment that needs the agent's memory and persona runs the full
agent. The system decides which — deterministically, from observable signals
— so behaviour and cost are predictable and the user never configures a
tier. The model is for judgment, synthesis, drafting, decisions; it is never
woken to make a routine API call. And every model fire is the interactive
subscription session — never `claude -p`, never the API.

## Good / bad

**Good looks like**

- A `*/10` "anything new?" poll and a "fetch and post" chore cost zero
  tokens — they run model-free; only a real change escalates to the model.
- The cheap path is the *default*, picked by the system on a fresh setup
  with zero config — the user never learns or sets a tier flag.
- When light judgment helps (summarise, format, triage), a cheap session
  runs; the full agent fires only when its memory or persona genuinely adds
  value.
- The schedule the user set runs on time and costs what the work needs; the
  plan stays the ceiling, predictable, not a meter the user can't forecast.
- The user can see why a fire ran the way it did ("filed as cheap because
  …") without being asked to approve each tick.
- A removed or changed schedule stops firing promptly — no zombie fires
  burning tokens after the user edited the schedule.

**Bad looks like — never ship this**

- A full reasoning turn for a mechanical chore — "fetch the feed and post
  it" waking the full agent because that is the only path.
- Reaching for `claude -p` (or the SDK / API) to make cheap fires
  "efficient" — that leaves the subscription and breaks policy. The cheap
  path is the interactive session or no model at all.
- Cheap-as-opt-in: the expensive tier as default and the cheap one behind a
  flag the user must discover. The good behaviour must be the default.
- A model deciding its own tier — that reintroduces non-determinism, costs
  tokens, and weakens the leash. The selector is deterministic and
  model-free.
- Stripping memory where it earns its keep — routing a cron that needs the
  agent's persona/history to a bare cheap session and getting a worse
  answer to save tokens.
- A self-authored loop or a fire with no operator schedule behind it — the
  cheaper triggers are still "the schedule you set," never the agent
  roaming.
- A confirm-every-cron tap in the name of control. Awareness is the leash;
  a tap on every fire is the tool-call log the vision rejects.

## Prove it

- **Cheap cron is the interactive session, never `-p`** —
  `tests/cheap-cron-session-render`. *Watch:* the cron-session launcher is
  interactive `claude` and shares the broker OAuth creds (same
  subscription). *Invariant:* `claude-native` — a cheap fire never becomes a
  headless or off-subscription call.
- **The selector decides the tier, not the model** —
  `tests/cheap-cron-session-render` (`scheduleNeedsCronSession` /
  fresh-vs-cheap routing). *Watch:* the same schedule signals map to the
  same tier every time; the model never picks. *Invariant:* `on-leash` — the
  system, not the model's guess, decides how a fire runs.
- **Cheap session isolates without starving** — `tests/cheap-cron-trim-resources`.
  *Watch:* the cron session gets its own liveness/identity but shares state
  where memory earns its keep, and never mutates the main config.
  *Invariant:* cheap is chosen only when the model adds no extra value.
- **A changed schedule stops firing promptly** — `tests/scaffold.hot-reload-stable`.
  *Watch:* a schedule edit takes effect without a restart; a removed entry
  stops firing instead of running as a zombie. *Invariant:* `on-leash` —
  agents fire only the schedule currently set.
- **Model-free fire of a mechanical cron (end-to-end)** — *(coverage gap: no
  runnable scenario yet)*. *Watch:* a "fetch and post" cron completes its
  fire at zero token cost and escalates to the model only on a real change.
  *Invariant:* the plan is never billed for reasoning a cron never uses.

**Fuzz corpus:** vary cadence (`*/10` … daily) × content (self-contained vs
references memory/persona) × trigger (clock vs event) × outcome (no-op vs
change/hit) × schedule edit (add / remove / live-reload). The invariants
must hold across the corpus: deterministic tier, model-free on mechanical
no-ops, interactive-session-only on any model fire, no zombie fires.

## Verdict

- **Done when:** scheduled work is model-free by default unless it genuinely
  needs judgment, the tier is chosen deterministically by the system, and
  every model fire is the interactive subscription session — proven by the
  guards above. Billing the plan for reasoning a cron never uses is the bug
  this job exists to kill.

## Production-readiness

- *Compliance:* every cron model fire is the interactive `claude` session;
  zero `claude -p` / SDK / API callsites on the scheduled path.
- *Determinism:* the tier selector is a pure function of observable signals
  — same inputs, same tier, fully enumerable, no model in the decision loop.
