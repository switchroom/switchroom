---
job: track my plan quota live, without a dashboard
outcome: The user knows where they are against their rolling subscription limits at a glance, and hears about approaching caps before they're blocked.
stakes: A user who gets silently blocked by a quota mid-task loses trust in the product. A user who has to open a dashboard to check quota has to stop to think about something that should be ambient.
serves: hold-the-leash
invariants: [claude-native]
---

# Job Spec: track my plan quota live, without a dashboard

## The job

The user is on a subscription with rolling-window quotas. They don't want to
think about those limits, they want to know when they should. The job is to
make usage visible without making it the main show, and to raise a flag
before the user hits a wall. "At a glance" is the point: no command, no
browser, no status report. The signal sits where the user already is, at a
weight matching its importance: ambient when there's headroom, a nudge when
a cap is approaching, a clear message with recovery timing when it's crossed.
Accuracy matters as much as visibility: a number that lags reality by an hour
makes the user plan around a phantom.

Because every model call is the interactive `claude` session and there is no
programmatic surface, there is exactly *one* pool to track: the interactive
subscription window. Quota stays a single-signal problem.

## Good / bad

**Good looks like**

- The user can answer "am I close to my limit?" without stopping what they're
  doing. The signal is ambient, where they already are.
- Approaching a cap produces a visible change at a point where the user can
  still act on it.
- Hitting a cap produces an honest message: blocked, why, and when it clears.
- Usage shown matches reality closely enough that the user trusts it for
  planning.
- Different plans and limits are handled correctly with zero configuration.
- The signal scales with the stakes, background when there's headroom,
  louder when there isn't, and the user sees recovery when the window rolls,
  without refreshing.

**Bad looks like: never ship this**

- Quota visible only in a separate dashboard or behind a command. If the user
  has to go looking, they won't, and they'll hit the wall.
- Silent blocking: the agent refuses to act with no explanation of why.
- Over-alerting on every small usage tick until the user mutes the product.
- Numbers stale by hours and misleading by more.
- Conflating different windows or plan limits into one blurred number.
- "You've used 87%" with no sense of whether that's routine or concerning.
- Telling the user they're blocked without telling them when they won't be.
- Recovering quota by routing off the subscription (API/PAYG/credits). The
  ceiling is the plan the user chose, never a second meter.

## Prove it

- **Weekly-cap wall is caught, on-subscription (agent)** —
  `tests/rate-limit-menu-detect.test.ts`. *Watch:* a hit weekly limit is
  detected and parked, surfacing the reset timing. *Invariant:* by default
  recovery is never "switch to usage credits". The off-subscription path is
  never taken (the load-bearing `claude-native` assertion). The one carve-out
  is an account the operator explicitly opted into overage
  (`allow_overage_accounts`): the broker confirms `overageStatus:"allowed"`
  and only then is "usage credits" selected, on the operator's own Anthropic
  credits, default-off, auto-stopping at `out_of_credits`, and still the
  unmodified interactive `claude` CLI (never API/SDK). Unflagged accounts are
  Escape-only, unchanged.
- **Cap signal reaches the user (agent)** —
  `tests/rate-limit-signal.test.ts`. *Watch:* the detected wall signals out
  to the surface the user sees, with reset timing attached. *Invariant:* a
  block is never silent; the user is told why and when it clears.
- **Usage reads honestly (CLI)** — `tests/auth-quota-util-cell.test.ts`.
  *Watch:* a near-exhausted account reads as near-exhausted, with the
  snapshot's age, and "no data" is distinct from "not exhausted". *Invariant:*
  the shown number tracks reality and never flatters a walled account.
- **Quota visible in the chat (DM/channel)** — *(coverage gap: no runnable
  scenario yet)*. *Watch:* the user sees usage ambient while normal, a nudge
  near a cap, and an honest block-with-recovery at the cap, all in the chat,
  never a dashboard. *Invariant:* the signal scales with the stakes and is
  always where the user already is.

**Fuzz corpus:** vary plan/limit shape × window type (5h rolling × 7d
weekly × Opus weekly) × utilization (headroom → near-cap → over) × wall
shape (429 vs interactive rate-limit menu) × recovery rolling. The signal
must stay honest, on-subscription, and legible across the corpus.

## Verdict

- **Done when:** the user can read where they stand against their plan at a
  glance, is warned before a cap while they can still act, gets an honest
  block-with-recovery at the cap, and is never pushed off the subscription to
  recover. Proven by the scenarios above.

## Production-readiness

- *Accuracy:* shown usage agrees closely with authoritative data; staleness
  is surfaced (snapshot age), never hidden.
- *Compliance:* a quota wall is parked on-subscription. The off-subscription
  recovery path is never selected, by construction, **except** for an account
  the operator explicitly opted into overage (`allow_overage_accounts`), where
  the broker authorizes spending the operator's own Anthropic overage credits
  while `overageStatus:"allowed"`. Default-off; auto-stops at `out_of_credits`;
  every unflagged account is Escape-only and unchanged.
