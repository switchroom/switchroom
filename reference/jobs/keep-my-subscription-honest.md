---
job: keep my subscription the only thing I'm paying for
outcome: The agents run on the user's Claude Pro or Max subscription, transparently and compliantly. No hidden API billing, no side-door tokens, no Anthropic API keys. Opt-in third-party service keys (e.g. OpenAI Whisper for voice transcription) are stored in the vault and clearly opt-in.
stakes: If the product quietly routes to paid API or mixes billing models, the user loses trust and the product loses its licence to operate.
serves: subscription-honest
invariants: [claude-native]
---

# Job Spec: keep my subscription the only thing I'm paying for

> A durable Job Spec. The *how* (the interactive-session-only spawn
> contract, the CI lint guards, the vault for opt-in third-party keys)
> churns; this job does not.

## The job

The user pays Anthropic for a subscription. They chose that plan knowing
what it costs and what it covers. The agents are an extension of that
relationship, not a way around it. The job is to keep the product honest
about what it uses, who pays, and under what terms, so the user can say in
one sentence what they're paying for, and have the product's actual
behaviour match.

> As of 2026-06-15 Anthropic split subscription usage in two: *interactive*
> Claude Code draws the subscription; *programmatic* usage (the Agent SDK
> and headless `claude -p`) draws a separate credit, off the subscription.
> "Mixing billing models" stopped being hypothetical and became a policy
> line. The job underneath is unchanged: every model call is the
> interactive `claude` session; cron, webhooks, and handoffs are delivered
> *into* that one session. There is no programmatic surface to quietly draw
> a different pool, so "the subscription is the only thing I'm paying for"
> stays literally true.

## Good / bad

**Good looks like**

- The user can state what they pay for and what the product uses in one
  sentence, and the two answers match.
- There is no second billing surface the user didn't ask for. Hitting a
  plan limit is said honestly; nothing is spent elsewhere.
- The product is clear about which plans it supports and what it does when
  a plan can't run a feature: it says so, rather than reaching for the API.
- Opt-in third-party features (e.g. voice transcription) that need their
  own key are clearly labelled extensions, with the key in the vault, never
  implied to be subscription-native.
- A user auditing the product from a cold read confirms what's used and who
  pays in under a minute, with no surprises.
- Plan changes (upgrade, downgrade, cancel) are absorbed gracefully; the
  product adapts without the user unpicking secrets, and never bills around
  them.

> [!CAUTION]
> A headless `claude -p`, an Agent SDK call, or a raw Anthropic API call
> anywhere in a code path is a `claude-native` violation. Both `-p` and the
> SDK are *programmatic* usage off the subscription — route every model call
> through the interactive session.

**Bad looks like: never ship this**

- Any *silent* or unintended fallback to a second billing surface when the
  subscription is rate-limited. (The one sanctioned exception is **overage**:
  an account the operator *explicitly* opted into `allow_overage_accounts` may
  continue on the operator's own Anthropic overage credits when Anthropic
  reports `overageStatus:"allowed"`: default-off, auto-stops at
  `out_of_credits`, and still the unmodified interactive `claude` CLI on the
  same OAuth subscription, never API/SDK. What's banned is the *silent,
  un-opted-in* switch, not this opt-in carve-out.)
- A headless `claude -p`, an Agent SDK call, or a raw Anthropic API call
  anywhere in a code path. Both `-p` and the SDK are *programmatic* usage
  off the subscription. Route model work through the interactive session.
- Asking the user for an Anthropic API key to unlock a core feature. Either
  the subscription supports it or it doesn't.
- Proxying or caching subscription auth in a way that bends the terms, or
  marketing that implies subscription support when the real path is API.
- Hiding usage so the user can't tell what's billed where.
- Breaking when the user's plan legitimately changes instead of adapting.

## Prove it

- **No headless model spawn (build-wide)** — `tests/bridge-flap-regression-guard`.
  *Watch:* the build fails if any source file spawns `claude` without
  `--strict-mcp-config`; the codebase carries zero headless spawners.
  *Invariant:* `claude-native` — no model call is ever headless `claude -p`.
- **Dashboard stays subscription-honest** — `tests/web-subscription-honest-guard`.
  *Watch:* the lint gate exits 0 on the tree AND trips on a synthetic SDK /
  raw-API / `--print` violation. *Invariant:* `claude-native` — no surface
  reaches a model except the interactive CLI on the subscription.
- **Real CLI flag contract** — `tests/claude-cli-contract`. *Watch:* the
  flags agent boot depends on still exist on the installed binary; runs for
  real in the nightly latest-claude canary. *Invariant:* agents boot on the
  unmodified `claude` CLI, no harness over it.
- **Weekly-cap menu defaults to Escape; only opted-in accounts may take
  overage** — `tests/rate-limit-menu-detect`, `tests/wedge-watchdog`,
  `src/auth/broker/server.test.ts`. *Watch:* on a weekly-quota wall the
  watchdog sends **only `Escape`** by default, never a keystroke that picks
  "usage credits". The sole exception is an account the operator explicitly
  flagged in `allow_overage_accounts`: the **broker** (the single audited
  spend-authority) confirms `overageStatus:"allowed"` (not `out_of_credits`,
  no active 429 mark), and only then does the watchdog select "usage credits".
  With no account flagged, the broker signal is always false and the behaviour
  is byte-identical to Escape-only. *Invariant:* a quota wall never *silently*
  switches the user off-subscription; overage is opt-in, default-off, on the
  operator's own Anthropic credits, and still the unmodified `claude` CLI.
- **Opt-in third-party key, the honest exception (DM)** — `voice-inbound-dm`.
  *Watch:* voice transcription works via an opt-in Whisper key from the
  vault, clearly an auxiliary helper, never a Claude replacement.
  *Invariant:* the only non-subscription cost is an explicit,
  operator-opted-in third-party helper stored in the vault.
- **Subscription-only audit (Telegram)** — *(coverage gap: no runnable
  scenario yet)*. *Watch:* a fresh subscription-only install runs everything
  advertised as subscription-supported, and an in-chat audit confirms what's
  used and who pays. *Invariant:* `claude-native` — no API key required for
  any core path.

**Fuzz corpus:** vary spawn callsite (boot / cron / webhook / handoff /
sub-agent) × quota state (healthy / 5h-cap / weekly-cap) × plan
(Pro / Max / changed mid-use) × surface (CLI / dashboard / Telegram). The
invariant must hold across the corpus: every model call is the interactive
subscription session, and a limit is never routed around with paid credit.

## Verdict

- **Done when:** the user pays for nothing but their subscription, can
  confirm that in under a minute, and the product refuses every shortcut
  that would split the billing model, proven by the guards above.

## Production-readiness

- *Compliance:* zero headless `claude -p` / SDK / raw-API callsites,
  enforced by build-failing CI guards, not convention.
- *Reliability:* a plan limit (5h or weekly) degrades to honest failure or
  account failover, never to API, and never to paid credit *except* for an
  account the operator explicitly opted into overage (default-off, auto-stops
  at `out_of_credits`, on the operator's own Anthropic credits via the
  unmodified `claude` CLI).

## Related

- [scheduled work spends the model only when it earns it](crons-use-the-model-only-when-it-earns-it.md) — the cron side of the same subscription-honest boundary.
- [update once and trust the whole stack](idempotent-update-and-restart.md) — why every restarted process boots on the unmodified interactive CLI.
