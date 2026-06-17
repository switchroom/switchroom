---
job: log into Anthropic once per account, not once per agent
outcome: One `claude setup-token` per Anthropic account covers every agent, sub-agent, hook, summarizer, and cron that account is enabled on. Refresh, quota state, and fallback all live at the account level. The user manages accounts; switchroom routes them to consumers.
stakes: When auth is per-agent, six agents on one Pro subscription means six OAuth flows, six independent refresh cycles, six places quota state can drift, and six 401-storms when the user adds a seventh agent. The user starts to feel the fleet — and asks why "one subscription" demands six logins.
serves: subscription-honest
invariants: [claude-native]
---

# Job Spec: log into Anthropic once per account, not once per agent

> A durable Job Spec. The *how* (the single-writer auth-broker, the
> per-agent credentials mirror, the account store and fanout/failover loop)
> churns; this job does not.

## The job

The user pays Anthropic for a subscription. That subscription is the unit
they care about: it has a bill, a quota, an expiry, and an account identity
("ken@example.com"). The job is to make that *account* drive the fleet — not
to make the user maintain one fictional copy of it per agent. Agents are
consumers of accounts, not owners of them: one login per account, then "use
this account on these agents" is configuration.

> We used to give every agent its own private OAuth slot pool — six agents
> on one subscription meant six `claude setup-token` runs, six refresh
> cycles, and six independent rediscoveries of the same quota wall. We
> changed the unit to the Anthropic account; the job underneath is
> unchanged.

## Good / bad

**Good looks like**

- Adding a second, third, or sixth agent to an account the user already set
  up needs no new OAuth flow — just naming the account and a restart.
- The user can answer "which Anthropic accounts am I logged into, and which
  agents use each?" with one command, and it fits on a screen.
- A sub-agent, Stop hook, handoff summarizer, or cron fires against the same
  account as its parent — no re-auth, no 401, no env-var hand-offs.
- When an account hits its cap, every agent on that account fails over to
  the next account within seconds — not one inbound at a time.
- An agent quiet for a week is still authenticated on the next ping; the
  credential was kept fresh whether or not the agent was awake.
- Removing an account is one explicit action, refused while it is the fleet
  active or any agent's override target, with no orphaned tokens left behind.
- The product can answer "what am I logged into?" with a list the user
  recognises (their accounts), and it matches what the agent's own claude
  process reports.

**Bad looks like — never ship this**

- A per-agent OAuth flow for each agent sharing one subscription — the
  per-login storm this job exists to kill.
- Sharing one credentials file across agents via symlink, hard link, or
  bind mount: an atomic-rename writer orphans the target and other agents
  stop seeing refreshes. The only safe sharing is one writer, many copies.
- Per-agent OAuth refresh racing the single-use refresh endpoint, or
  per-agent quota state so each agent rediscovers the wall independently.
- Falling through one account to another on exhaustion unless the user
  explicitly listed both as preferences — two accounts must stay visibly
  separate.
- Conflating "set up my Anthropic account" with "wire this agent to an
  existing account" into one verb, dragging the per-agent login back in.
- Any path that reaches a model on something other than the operator's
  subscription credential.

## Prove it

- **Account is the unit of auth (store)** — `tests/auth-account-store`.
  *Watch:* accounts resolve under one per-account dir, credentials and quota
  state round-trip, and health reflects token freshness + exhaustion.
  *Invariant:* authentication is keyed to the Anthropic account, not the
  agent.
- **One writer, many fresh mirrors** — `tests/auth.credentials-file-success`,
  `tests/auth.stale-token-fix`. *Watch:* a credential write is captured
  correctly and a stale token is never accepted as fresh. *Invariant:*
  `claude-native` — every consumer reads a current subscription credential,
  never an expired or API token.
- **Broker health + per-agent fanout** — `tests/doctor-auth-broker`.
  *Watch:* drift, threshold violations, and active-account are surfaced;
  per-agent sockets are present. *Invariant:* exactly one refresher per
  account; mirrors fan out from it.
- **Heal without re-auth** — `tests/auth-heal-cli`. *Watch:* an expired
  token is diagnosed and healed against the real credentials file without a
  fresh OAuth flow. *Invariant:* an agent quiet across a long idle gap comes
  back authenticated.
- **One-login-per-account (Telegram / CLI surface)** — *(coverage gap: no
  runnable scenario yet)*. *Watch:* adding an agent to an existing account
  needs only config + one command; `auth show` lists accounts and consumers
  on one screen. *Invariant:* no per-agent OAuth flow exists.

**Fuzz corpus:** vary account count (1 / 2 / N) × consumer type (main /
sub-agent / hook / summarizer / cron) × event (refresh / 5h-cap / weekly-cap
/ broker-down-then-up) × idle gap. The invariants must hold across the
corpus: one refresher per account, every consumer current, failover within
seconds, no orphaned or stale credentials.

## Verdict

- **Done when:** one login per account drives the whole fleet — every
  consumer authenticated, quota and failover account-level, no per-agent
  OAuth storm — proven by the guards above.

## Production-readiness

- *Reliability:* the broker's death is degraded, not catastrophic — agents
  run on existing valid tokens until it returns and re-syncs from the
  account store.
- *Concurrency:* exactly one OAuth refresher per account; no two processes
  race the single-use refresh endpoint.
