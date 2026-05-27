---
job: log into Anthropic once per account, not once per agent
outcome: One `claude setup-token` per Anthropic account covers every agent, sub-agent, hook, summarizer, and cron that account is enabled on. Refresh, quota state, and fallback all live at the account level. The user manages accounts; switchroom routes them to consumers.
stakes: When auth is per-agent, six agents on one Pro subscription means six OAuth flows, six independent refresh cycles, six places quota state can drift, and six 401-storms when the user adds a seventh agent. The user starts to feel the fleet — and asks why "one subscription" demands six logins.
---

## Status — SHIPPED (RFC H)

**This is built and is the current model.** The `switchroom-auth-broker`
daemon (`src/auth/broker/`) is the sole writer of every
`credentials.json`; authentication is per **Anthropic account**, not
per agent; the fleet shares one `auth.active` and quota / fallback
state fans out across every consumer in seconds. Operator surface:
`switchroom auth add|list|show|use|rotate|rm` (CLI) and `/auth
show|use|rotate` (Telegram). See [`docs/auth.md`](../docs/auth.md) for
the operator guide and `src/auth/broker/protocol.ts` for the wire
protocol.

> **Read the body below as the *pre-RFC-H problem statement*, not a
> description of current behaviour.** Present-tense passages like
> "Today, every agent has its own private OAuth slot pool", "the user
> runs `claude setup-token` six times", and any "no migration shipped"
> language describe the world *before* this RFC and are **false as of
> the v0.7+ broker rollout**. They are retained as design history — the
> reasoning that motivated the account-as-unit model — not as an
> open to-do list.

# The job

The user pays Anthropic for a subscription. That subscription is the
unit they care about: it has a bill, a quota, an expiry, and an account
identity ("ken@example.com"). Switchroom's job is to make that
subscription drive the fleet — not to make the user manage one fictional
copy of it per agent.

Today, every agent has its own private OAuth slot pool. Six agents
sharing a Pro subscription means the user runs `claude setup-token` six
times against the same Anthropic identity, ends up with six separate
access tokens, and watches six independent refresh cycles. When the
account hits the 5-hour cap, only the agent that tripped it knows;
the other five blunder into the same wall a few seconds later, each
discovering the exhaustion separately. When the user adds a seventh
agent, it's another OAuth flow.

The unit is wrong. The unit should be **the Anthropic account**. The
agents are consumers of accounts, not owners of them. One login per
account, then "use this account on these agents" is configuration.

This change also closes a class of subprocess-auth bugs that have bitten
the fleet repeatedly. Claude Code strips `CLAUDE_CODE_OAUTH_TOKEN` from
every subprocess it spawns — Stop hooks, handoff summarizers, sub-agents,
cron-launched `claude -p` all fall back to reading
`<agent>/.claude/.credentials.json`. Today switchroom maintains a
fragile dance between `.oauth-token` (env-injected for the parent
process) and `.credentials.json` (read by everyone else). Make
`.credentials.json` the only mechanism, owned by one writer, and the
class of bugs goes away.

## Signs it's working

- Adding a second, third, or sixth agent to the same Anthropic account
  does not require any OAuth flow. The user runs `switchroom auth use
  <label>` (to set the fleet account) and restarts the agent; no new
  OAuth flow is needed.
- The user can answer "which Anthropic accounts am I logged into and
  which agents use each?" with one command. The answer fits on a screen.
- A sub-agent dispatched from a main agent is authenticated against the
  same account as its parent. The user does nothing to make this happen.
- A cron-scheduled task fires through the agent's session and uses the
  same account as the main process — same broker-managed credential, no
  401s, no env-var hand-offs.
- When an account hits the 5-hour cap, every agent using that account
  fails over to the next account in the fleet fallback order within
  seconds — not on each agent's next inbound message individually.
- An agent's auth state survives a 24h+ idle gap. The next message after
  a long quiet doesn't 401, because the broker kept the credential file
  fresh whether the agent was awake or not.
- Removing an account is a single explicit action, refused while it is
  the fleet active account or the override target for any agent. No
  orphaned tokens left behind.
- The user can audit "which agent is using which account right now" and
  the answer matches what the agent's own claude process reports. No
  divergence between switchroom's view and reality.

## Anti-patterns: don't build this

- **One credentials file shared between agents via symlink.** Claude (and
  switchroom's refresher) writes credentials via tempfile + atomic
  rename. Renaming onto a symlink replaces the symlink with a regular
  file and orphans the underlying target. Other agents stop seeing
  refreshes. The "share via inode" instinct is wrong here.
- **One credentials file shared via hard link or bind mount.** Same
  atomic-rename trap. Sharing a file across paths cannot survive an
  atomic-rename writer; the only safe sharing is "one writer, many
  copies."
- **`CLAUDE_CODE_OAUTH_TOKEN` env injection as the primary auth path.**
  Claude strips it from every subprocess. Anything that runs after the
  initial fork — Stop hooks, sub-agents, summarizers, crons — falls back
  to disk anyway. Designing around the env path means designing for the
  rare case and leaving the common case to luck.
- **Per-agent OAuth refresh.** Multiple processes refreshing the same
  account against Anthropic's single-use refresh-token endpoint is a
  race the loser silently fails. A correct design has exactly one
  refresher per account.
- **Per-agent quota state.** When account A is rate-limited, all agents
  using account A are rate-limited. Tracking it per-agent means each
  agent re-discovers the wall independently and the fallback is
  uncoordinated.
- **Account creation as a side effect of a per-agent login command.**
  That conflates "I'm setting up my Anthropic account" with "I'm wiring
  this agent to an existing account." The two operations should be
  distinct verbs at the CLI surface. (The old `switchroom auth login
  <agent>` did both, and the cost was the per-agent OAuth flow.)
- **Silent token sharing across accounts.** If the user has two
  Anthropic accounts (work + personal), the product must keep them
  visibly separate. Don't fall through one to the other on quota
  exhaustion unless the user explicitly listed both as preferences.
- **A new long-running daemon when the existing broker pattern would
  do.** Switchroom already has a `vault-broker` for similar
  "one-writer-many-readers" problems. A new auth-broker should be the
  same shape, not a new kind of process. The vault broker's *rotation*
  flow is the closest existing precedent: a single writer (the broker
  process) holds the canonical credential, `op:put` writes a new value
  atomically under flock, and every reader picks up the new bytes on
  the next fetch. The auth-broker fans rotation out a step further
  (per-agent mirror) but the threading-and-locking story is the same
  — see `docs/vault.md` § "Atomic rotation" and the v0.7.12 layout
  notes for the on-disk shape that makes the rotation safe.

## Decisions

These are the choices switchroom makes on the user's behalf, so the
user doesn't have to:

1. **The Anthropic account is the unit of authentication.** It has a
   user-chosen label (`work-pro`, `personal-max`), an email, a
   subscription type, and one canonical `.credentials.json`. Stored at
   `~/.switchroom/accounts/<label>/`. An account is created by
   `switchroom auth add <label>` (which runs a one-time OAuth flow and
   stores the result globally). It is removed by `switchroom auth rm
   <label>`, refused while it is the fleet active or an agent override
   target.

2. **Agents are consumers, not owners.** Agents inherit the fleet-wide
   active account by default; no per-agent config is needed for the
   common case. An edge-case override looks like:

   ```yaml
   agents:
     foo: {}                       # inherits fleet active (common case)
     klanker:
       auth:
         override: work            # pinned to a specific account
   ```

   Fallback ordering is fleet-wide (`auth.fallback_order`), not
   per-agent. (The pre-RFC-H `auth.accounts: [...]` per-agent list is
   migrated away automatically on `switchroom apply`.)

3. **`<agentDir>/.claude/.credentials.json` is a passive mirror.** It
   is a copy of the active account's canonical credentials, refreshed
   by the broker, not by claude. No symlinks. No bind mounts. Just an
   atomic-write copy whose only writer is `switchroom-auth-broker`.

4. **`switchroom-auth-broker` is the only writer.** A long-running
   container in the same shape as `switchroom-broker` (vault). Owns:
   - the global `~/.switchroom/accounts/<label>/credentials.json` files,
   - the OAuth refresh loop (one POST per account, regardless of how
     many agents use it),
   - quota state per account (single source of truth for "is this
     account exhausted right now"),
   - fanout: when an account refreshes, every enabled agent's mirror
     gets atomically rewritten,
   - failover: when an account is marked exhausted, every enabled
     agent's mirror gets swapped to that agent's next preferred account.

5. **Drop `CLAUDE_CODE_OAUTH_TOKEN` injection in `start.sh`.** The env
   var was only useful for the parent claude process and was redundant
   with the credentials file every other consumer reads. Removing it
   eliminates a code path and a class of subprocess-strip bugs.

6. **Drop the per-agent slot pool entirely.** The
   `<agentDir>/.claude/accounts/<slot>/` directory tree, the `active`
   marker, the `.oauth-token` file, the legacy mirror, and the slot-name
   validation primitives all go away. Their job is replaced by the
   fleet-wide active account plus the broker's single-mirror semantics.
   (The legacy per-agent slot-pool module is retained for back-compat
   and migration paths only; it is not the active runtime path.)

7. **Ephemeral consumers (one-shot crons, ad-hoc workers) talk to the
   broker.** A small Unix-socket IPC, same shape as the vault-broker
   protocol: `GET /credentials?account=<label>` returns the current
   credentials JSON. The caller writes it to a tmpfs path and points
   `CLAUDE_CONFIG_DIR` at it. No need to provision a persistent agent
   directory.

8. **Quota events propagate at the account level.** When a request to
   account A returns 429 from any consumer, the broker marks account A
   exhausted with a reset time. All agents currently using A are
   immediately failed over to their next preferred account. When A's
   reset time passes, the broker clears the mark; agents that prefer A
   over their current fallback drift back on next idle.

9. **The broker's death is degraded, not catastrophic.** If
   `switchroom-auth-broker` is down, agents continue running on
   whatever's already in their `<agentDir>/.claude/.credentials.json`.
   No refreshes happen until it comes back. Token lifetime is 8 hours;
   the broker can be down for hours without a user-visible outage. On
   restart, the broker re-syncs from the global account files (source
   of truth) and resumes the loop.

10. **No migration CLI verb shipped.** There is no `switchroom auth
    migrate` command. However, an in-place YAML upgrade algorithm runs
    automatically on `switchroom apply`, converting the old per-agent
    `auth.accounts: [...]` list shape into the current `override:`
    key where appropriate. The legacy per-agent slot-pool code is
    retained for back-compat during migration. Operators upgrading a
    live fleet do not need to manually delete per-agent slot directories;
    `switchroom apply` handles the schema migration. The design surface
    is clean for all new installs from day one.

11. **The same shape on the CLI and in Telegram.** Both surfaces speak
    "accounts," not "slots." Telegram's `/auth use work-pro` swaps the
    agent to that account; `/auth list` shows accounts and which agent
    is using which. The slot vocabulary disappears from the user-facing
    surface; if any internal language still uses "slot," it is a bug
    surfaced in review.

12. **First-run does the right thing automatically.** A first-time user
    runs `switchroom setup`, picks an agent, and is taken through one
    OAuth flow that creates a `default` account *and* sets it as the
    fleet active in the same gesture. The two-verb model
    (`auth add` + `auth use`) is the deliberate shape for the second,
    third, and Nth account — not a regression of the first one.
    The fast path is one command for the common case; the explicit verbs
    surface only when the user actually has multiple accounts or agents
    to compose.

## What this enables

- The user adds six agents to one Anthropic account by running OAuth
  once and editing six lines of YAML. Today this is six OAuth flows.
- A user with two accounts (`work-pro`, `personal-max`) can fluidly
  weight which agents prefer which, without re-authenticating anything.
- Quota events on a shared account propagate in seconds. The first
  agent's 429 is the last agent's 429, not the first of N independent
  rediscoveries.
- Sub-agents, Stop hooks, handoff summarizers, and cron-scheduled tasks
  work the same way the main agent does — they all read the same
  refreshed credentials file. No subprocess-fork auth bugs.
- An agent that has been quiet for a week is still authenticated when
  the user pings it on Sunday morning. The broker kept its file fresh.
- Adding a one-shot worker outside any agent's directory ("transcribe
  this single voice memo using my account") is a broker query away. No
  need to provision a fake agent.
- The product can finally answer "what am I logged into?" with a list
  the user recognises (their Anthropic accounts) instead of a tree of
  per-agent slots they never created consciously.

## UAT prompts

Use these to evaluate whether an implementation truly delivers the job:

- "Add a second agent that uses an Anthropic account you already have
  set up. Did you have to do anything beyond editing `switchroom.yaml`
  and running one CLI command?"
- "Read the output of `switchroom auth show`. Does it show your accounts
  and which agents use each, on one screen?"
- "Have one agent's main turn dispatch a sub-agent that itself spawns a
  Stop-hook subprocess. Did all three pick up the same fresh token
  without re-authenticating?"
- "Run a cron-scheduled task in one of your agents' sessions. Did it
  succeed without 401, with no env-var fiddling?"
- "Drive one Anthropic account to its 5-hour cap. Did every other agent
  using that account fall over to its next preferred account within
  seconds?"
- "Stop `switchroom-auth-broker`. Do agents still respond for the next
  hour as long as their existing tokens are valid? Restart it. Does it
  resume refreshes without losing state?"
- "Migrate from a per-agent-slot install. Run `switchroom apply` first
  (it performs the in-place schema upgrade). Did you have to
  re-authenticate any account, or did the existing tokens carry over?"
- "Try to remove an account that is still the fleet active or an agent
  override target. Did the CLI refuse with a clear message telling you
  what to change first?"

## See also

- [`keep-my-subscription-honest.md`](keep-my-subscription-honest.md) —
  the parent JTBD this serves: subscription-as-the-ceiling. Account-as-
  unit makes that promise tangible at the CLI.
- [`track-plan-quota-live.md`](track-plan-quota-live.md) — quota
  visibility benefits directly: account-level state means the chat-
  surface quota signal can be stated in user terms ("your work-pro
  account has 18 minutes left in the window") rather than per-slot.
- [`run-a-fleet-of-specialists.md`](run-a-fleet-of-specialists.md) —
  the multi-agent fleet promise; "one Pro subscription drives N
  specialists" is what this design operationalises.
- [`survive-reboots-and-real-life.md`](survive-reboots-and-real-life.md)
  — the broker's "degraded, not catastrophic" failure mode is the
  recovery story this job inherits.
- [`docs/vault-broker.md`](../docs/vault-broker.md) — the existing
  one-writer-many-readers daemon that the auth-broker is shaped after.
