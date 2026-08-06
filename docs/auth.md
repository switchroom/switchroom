# Auth — switchroom-auth-broker

Switchroom authenticates against Anthropic via OAuth (Pro/Max
subscriptions). The **account is the unit of authentication** — one
OAuth flow per Anthropic account, then "use this account on these
agents" is configuration, not another OAuth round.

Architecture detail at [`reference/rfcs/auth-broker.md`](../reference/rfcs/auth-broker.md);
the design contract at
[`reference/jobs/share-auth-across-the-fleet.md`](../reference/jobs/share-auth-across-the-fleet.md).
This doc is the operator-facing summary.

## Mental model

```
  ~/.switchroom/accounts/
    me@example.com/
      credentials.json   ← canonical OAuth state, broker-owned
      meta.json          ← last refresh, quota state

  switchroom-auth-broker  ← the only writer of every credentials.json
    refresh loop          ← one POST per account, never per-agent
    quota state           ← per-account, fanned out on 429
    per-agent UDS         ← /run/switchroom/auth-broker/<name>/sock

  per-agent mirror
    ~/.switchroom/agents/<name>/.claude/.credentials.json
                          ← broker writes, claude reads (dotfile).
                          ← atomic rename, mode 0600, chowned to per-agent UID.
```

The agents and consumers are clients of the broker. They never
refresh tokens themselves and never write credentials files.

## CLI surface

```bash
# Add an Anthropic account (one OAuth flow). First-time setup: use
# --via-claude. This drives claude through its native OAuth flow in a
# tmux session, gets you the broader scope set that `claude server:`
# mode requires, and ingests the resulting credentials.json into the
# broker. The alternative --from-oauth path runs `claude setup-token`
# which mints scope=user:inference only — won't work for agents.
switchroom auth add me@example.com --via-claude       # one OAuth flow, broader scope
switchroom auth add work --from-agent clerk           # seed from an existing agent
switchroom auth add stage --from-credentials path/    # import a credentials.json
switchroom auth add legacy --from-oauth               # narrow-scope, --print-only use cases

# See the state of the fleet
switchroom auth list
switchroom auth show                                  # full fleet + agents + consumers
switchroom auth show ziggy                            # one agent

# Move the fleet to a different account
switchroom auth use work                              # fleet-wide; takes effect on next agent refresh-read
switchroom auth rotate                                # cycle to next non-exhausted in fallback_order

# Manage accounts
switchroom auth rm stage                              # refused if it's the only account

# Edge case: per-agent override
switchroom auth agent override klanker work
switchroom auth agent override klanker --clear        # back to fleet active

# Diagnostics
switchroom auth refresh                               # force a refresh tick (broker decides which accounts need it)
switchroom auth refresh me@example.com                # force a refresh tick for one
```

## YAML schema

```yaml
# switchroom.yaml
auth:
  active: me@example.com                # fleet-wide active account
  fallback_order:                       # ordered cycle list for `auth rotate`
    - me@example.com
    - work
    - personal
  proactive_failover_pct: 95            # optional: soft-avoid tier threshold
                                        # (unset = tier off, behavior unchanged)
  consumers:                            # non-agent peers (hindsight, etc.)
    - name: hindsight
      account: me@example.com
      uid: 11000                        # optional, defaults to 0

agents:
  ziggy: {}                             # inherits fleet active
  clerk:
    admin: true                         # gates /agents, /restart, /update,
                                        # AND the admin /auth verbs
  klanker:
    auth:
      override: work                    # opt-out (edge case)
  workbot:
    auth:
      override: work                    # pin to the work account…
      strict: true                      # …never borrow another account
      exclusive: true                   # …and nobody else may use it
```

The schema is intentionally minimal in the common case — most agents
need no `auth:` block.

## Strict pins and exclusive accounts

A plain `override:` is a **routing preference, not a suicide pact**:
when the pinned account hard-walls, the broker serves the agent from
`fallback_order` until the wall clears (see "Quota / 429 handling").
That is right for load-balancing pins, and wrong for accounts that
must never cross a billing or compliance boundary — e.g. an
employer-provided subscription that only one agent may consume, and
that must never quietly burn your personal quota (or vice versa).

Two opt-in hardening flags close each direction. Both require
`override:` and are yaml-only (edit `switchroom.yaml`, then restart
the broker via `switchroom apply` / `agent restart`):

- **`strict: true`** — the agent never borrows. While the pinned
  account is walled or exhausted, the broker keeps serving the pin;
  the agent rides out the window surfacing the normal 429/quota
  cards instead of silently failing over onto fleet accounts. The
  `mark-exhausted` fleet roll skips strict agents (their mirror
  keeps the pin's credentials).
- **`exclusive: true`** — nobody else borrows the account. The
  loader rejects config that routes it elsewhere (`auth.active`,
  `fallback_order`, another agent's `override`, a consumer pin), and
  the broker refuses the hot paths at runtime: `auth use <label>` /
  `/auth use` onto it, `auth agent override <other> <label>`, and
  failover candidate selection all skip it for anyone but the owner.

Because the flags bind to the yaml-declared account,
`auth agent override` refuses to move or clear a strict/exclusive
pin over the socket — edit the yaml and restart the broker instead.
A persisted `/auth use` swap that predates an `exclusive:` flag is
dropped at broker boot (yaml wins), so marking an account exclusive
retroactively revokes any earlier fleet-wide swap onto it.

Use both together for full two-way isolation: one agent on the work
account, the work account on one agent, no leakage in either
direction.

## Filename conventions

Two on-disk credential files with deliberately different names:

- **Global account store** at `~/.switchroom/accounts/<label>/credentials.json`
  (no dot). Switchroom's internal canonical record per account.
  Read/written by the broker only.
- **Per-agent mirror** at `~/.switchroom/agents/<name>/.claude/.credentials.json`
  **(with dot — this is Claude Code's own dotfile convention)**. The
  broker atomically writes this every refresh and on every `auth use`;
  the agent's `claude` process reads it directly. Same shape as the
  global file; only the name (and owner UID, mode 0600) differs.

The dot prefix on the per-agent file is load-bearing: Claude Code
2.x reads `<CLAUDE_CONFIG_DIR>/.credentials.json` (verified against
the binary's string table). Writing to the non-dot path is invisible
to claude — agents would silently lose authentication on first
restart. Pinned by a test at `src/auth/broker/server.test.ts`
("writes the per-agent mirror to .credentials.json").

## Refresh windows

The broker refreshes a token **when its remaining lifetime is below
60 minutes** (`REFRESH_THRESHOLD_MS = 60 * 60 * 1000` —
`src/auth/account-refresh.ts:60`). This is the same threshold the
pre-RFC-H per-agent refresher used; the broker simply takes over
the loop.

Claude's own built-in OAuth refresh fires **only when the token has
≤5 minutes remaining**. The 55-minute gap is the load-bearing
invariant for the single-writer story:

- The broker refreshes first and atomically rewrites
  `credentials.json`.
- Claude reads the new bytes on its next disk-read.
- Claude never decides to refresh against the same file because its
  window doesn't open until 55 minutes after the broker's already
  done.

If a future Claude release narrows that window, the broker's
runtime assertion catches it. On every refresh tick, the broker
compares the on-disk `expiresAt` against its own last-write. A
mismatch indicates Claude refreshed under the broker's feet —
broker logs `THRESHOLD_VIOLATION <label>` and increments
`list-state.accounts[].threshold_violations`. The fix is to bump
the broker threshold ahead of Claude's; the assertion makes the
regression visible.

Claude version range tested against: as of v0.7.x of switchroom
(May 2026), Claude Code's threshold is ≤5min. This doc is
re-pinned on every Claude version bump that touches token
handling.

## Mid-turn account swap semantics

A running `claude` process picks up a broker mirror rewrite —
token refresh OR account swap — **on its next API request, without
a restart**. Verified against claude 2.1.205's embedded source: the
request path calls the CLI's ensure-fresh-token routine before
building auth headers, and that routine `stat()`s
`<CLAUDE_CONFIG_DIR>/.credentials.json`; when `mtimeMs` differs
from the last-seen value it clears the in-memory token caches, so
the next read pulls the new bytes off disk. The broker's atomic
rewrite (write + rename) always bumps mtime, so a fleet roll is
seamless for in-flight sessions: the turn keeps going and the next
request rides the new account.

Two boundaries to keep honest:

- **An already-in-flight HTTP request finishes (or fails) on the
  old token.** The re-read is per-request, not per-byte. That is
  exactly why the gateway's `fleet-fallback-resume` restart exists:
  when a mid-turn 429 has already KILLED a turn, only a restart's
  boot-resume path can replay it. Proactive broker rolls (the
  fleet-quota probe) never restart anything — running sessions
  don't need it (`tests/broker-roll-no-restart-invariant.test.ts`).
- **The mechanism is a claude implementation detail**, not a
  documented contract. It is pinned against the installed binary by
  `tests/claude-credentials-midturn-reread.test.ts` (self-skips
  where claude isn't installed; runs in the nightly latest-claude
  canary). If a future release drops the mtime watch, that test
  reds and every swap becomes restart-required — revisit failover
  messaging before bumping the pin.

## Quota / 429 handling

The broker maintains per-account quota state in
`~/.switchroom/state/auth-broker/quota.json`:

```jsonc
{
  "me@example.com": { "exhausted_until": 1809484700000 }
}
```

When any consumer (agent or hindsight) hits a 429, it calls the
broker's `mark-exhausted` verb. The broker:

1. Sets `exhausted_until` for the caller's bound account.
2. Walks every agent currently using that account.
3. Looks up each agent's next-non-exhausted account from
   `fallback_order` and atomically rewrites their per-agent mirror
   to the new account's credentials.

Quota events propagate in **seconds** rather than per-agent
rediscoveries.

When `exhausted_until` passes, the broker clears the mark. Agents
that *prefer* the cleared account (it's first in their effective
preference order) drift back on next idle.

### 429 throttle tier — short throttles stay put

Not every 429 is a wall. Anthropic also emits transient burst
throttles whose wording affirms the ACCOUNT's own rate limit ("would
exceed your account's rate limit") and usually names a reset minutes
away. Failing the whole fleet over for a 3-minute throttle is churn,
so those take a lighter tier. Server-side transient wordings ("Server
is temporarily limiting requests", 529 overload) are deliberately
excluded — they stay on the calm rate-limited path, since an
account-scoped mark would bench the wrong thing for a server-wide
condition.

- Reset within the retry-in-place threshold (default **5 minutes**,
  override with `SWITCHROOM_THROTTLE_RETRY_IN_PLACE_MAX_MS`): the
  gateway calls the broker's `mark-throttled` verb — the ledger entry
  gains `throttled_until`, nothing rolls, the account stays fully
  eligible. One lightweight notice (per account, cooldown-deduped
  locally AND fleet-wide via the broker's claim verb) tells you it's a
  throttle, not a wall, and when it resets; the dead turn is retried
  automatically after the reset (jittered so agents sharing the
  account don't stampede, and never while a newer live turn is
  running). No parseable reset → a conservative 60-second wait.
- Reset beyond the threshold: the same mark-exhausted + fleet
  failover mechanics as a wall, with the parsed reset as the mark
  expiry and an honest "rate limit" headline. The rate-limit trigger
  is trusted over the utilization probe here — a rate-limited account
  typically probes healthy, which must not self-cancel the swap.
- Genuine wall wording: the normal quota-exhausted path, unchanged.
- Escalation guard: 3 transient 429s on the same account inside 10
  minutes trigger one live quota probe; only a probe that corroborates
  a real wall converts the throttle into mark-exhausted + roll. The
  raising gateway announces that roll (covers pinned accounts too).
  Re-marks within 5 seconds of the previous hit only refresh
  `throttled_until` — they add no escalation hit and can trigger no
  probe, so a simultaneous multi-agent burst counts once.

Cron fires are throttle-aware: the scheduler's quota preflight
soft-defers a fire while the agent's effective account is throttled
and retries just past `throttled_until`.

### LiteLLM-proxy-local 429s — never account state

When an agent routes through the LiteLLM gateway (docs/model-routing.md),
a 429 can also originate from the proxy's OWN rate limiters — a
`tpm_limit`/`rpm_limit` cap on a deployment or virtual key, or the
router cooling every deployment down. That request never reached
Anthropic, so the condition says nothing about the account.

Every terminal 429 is therefore classified three ways
(`classify429Detail`, `telegram-plugin/throttle-tier.ts`):

- **account-scoped** — Anthropic's explicit account-affirming wording
  ("would exceed your account's rate limit"). Takes the throttle tier
  above (broker `mark-throttled` / failover).
- **litellm-local** — wording only LiteLLM's limiters emit
  ("Deployment over user-defined ratelimit", "No deployments available
  for selected model", or the v3 limiter's descriptor-agnostic pair
  "Rate limit exceeded for …" + "Limit type: …" — the canonical
  matcher, with per-signal source provenance, is
  `isLitellmProxyLocal429` / `litellmProxyLocal429Signals` in
  `telegram-plugin/model-unavailable.ts`). Takes the calm rate-limited
  path: **no broker mark, no failover, no throttle tier**. Marking the
  account for a proxy-local cap would bench a healthy subscription.
- **generic-transient** — everything else in the rate-limit family
  (server-side 429/529 wording). Calm path, unchanged.

Tie-break when both wordings appear in one body (the pass-through
wrapping a forwarded upstream error): **account-scoped wins** — LiteLLM
never emits Anthropic's account wording itself, so its presence means
the account throttle genuinely fired upstream.

The user-facing surface for a `litellm-local` 429 is a dedicated calm
notice — "🚦 Fleet token limiter engaged" — instead of the generic
rate-limited card (which reads like an Anthropic problem). The copy
names the fleet limiter (LiteLLM `tpm_limit`/`rpm_limit`), says
explicitly it is NOT an Anthropic account limit, and that the turn
retries with no action needed. It is debounced per agent: one notice,
then further litellm-local 429s are counted silently for a cooldown
window (default 15 min, tunable via
`channels.telegram.litellm_notice.window_ms` in switchroom.yaml); the
first notice after the window expires says "throttled N more times
since the last notice". A notice only ever fires on an actual throttle
event — a quiet agent posts nothing. State machine + copy:
`telegram-plugin/litellm-local-notice.ts`; wiring:
`telegram-plugin/gateway/litellm-local-notice-wiring.ts`. Each SENT
notice also emits a `litellm_local_429_notice` runtime metric carrying
the absorbed count.

Each classified event emits one `rate_limit_429_classified` runtime
metric (PostHog + `runtime-metrics.jsonl`, see docs/posthog.md)
carrying the classification, the action taken (throttle / failover /
calm), and any parseable limit/reset detail — fired before the notice
cooldown so every hit is counted. Correlating `account-scoped` fires
against fleet token throughput is the evidence base for the follow-up
this classifier unblocks: enabling LiteLLM `tpm_limit` caps on the
fleet, where caps absorb bursts proxy-side (`litellm-local` fires,
calm) instead of burning Anthropic account throttles.

### Soft-avoid tier — proactive preference before the wall

`auth.proactive_failover_pct` (optional, e.g. `95`) adds a third
eligibility state between eligible and blocked: **soft-avoid**. An
account is soft-avoided when a fresh quota probe shows its 7-day
utilization at/above the pct, or its 5h utilization at/above
`min(pct + 3, 98)`. Soft-avoid is a *preference ranking* on the
serving/failover path only:

- The broker prefers a fully-eligible fallback account over a
  soft-avoided one (`fallback_order` walk, roll-target selection).
- When *every* healthy candidate is soft-avoided, the broker serves the
  least-utilized one and does **not** roll — the tier can never shrink
  availability or produce a false "all accounts blocked".
- The hard wall is untouched: blocked still means 99.5% utilization or
  an unexpired exhaustion mark. Attribution (`mark-exhausted`) never
  follows the preference, so a soft-avoid can never mismark an account.
- Hysteresis: enter at pct, exit only below pct-5 (both windows) or
  when the window resets — a probe oscillating 94↔96 does not flap the
  preference.
- Accounts serving past the wall via `allow_overage_accounts` are never
  soft-avoided.

Unset (the default) disables the tier entirely; the broker behaves
exactly as it did before the field existed.

## Drift detection

The broker is the **sole writer** of every
`~/.switchroom/accounts/<label>/credentials.json`. It records the
sha256 of every file it writes in
`~/.switchroom/state/auth-broker/sha-index.json`.

On boot, the broker verifies every account-store credentials file
against the index. A mismatch is a hard error — the broker logs
`DRIFT_DETECTED <label>` and exits non-zero. The compose
healthcheck fails, agents (which `depends_on: condition:
service_healthy`) stay in `created` state until the operator
recovers.

Recovery procedure: see
[`docs/operators/auth-broker-drift.md`](operators/auth-broker-drift.md).

## Authorization model

| Verb                  | Who can call                            |
| --------------------- | --------------------------------------- |
| `get-credentials`     | any agent / consumer (own account only) |
| `list-state`          | any agent / consumer                    |
| `mark-exhausted`      | any agent / consumer (own account only) |
| `mark-throttled`      | any agent / consumer (own account only) |
| `set-active`          | admin                                   |
| `refresh-account`     | admin                                   |
| `add-account`         | admin                                   |
| `rm-account`          | admin                                   |
| `set-override`        | admin                                   |

Admins are:
- **The host operator** — connects via the operator socket at
  `/run/switchroom/auth-broker/operator/sock`, chowned to the
  operator UID at bind time (mode 0600). No sudo required.
- **Admin agents** — any agent with `admin: true` in
  `switchroom.yaml`. **Same flag** that gates `/agents`, `/restart`,
  `/update`, `/logs`, etc. (the fleet-management slash commands from
  PR #1258). One knob, not two — set `admin: true` on an agent and
  it becomes the full fleet control panel: ops verbs AND auth verbs.

Consumers cannot be admins. A consumer name that collides with an
agent name is caught at schema validation time regardless of the
agent's admin flag.

## Telegram surface

The `/auth` chat command mirrors the CLI verb set (RFC H §
"Same shape on the CLI and in Telegram"). Read verbs (`show`,
`list`, `help`) are open to any agent; mutating verbs are
admin-gated against the per-agent `admin: true` flag.

### Quota-emergency recovery — LLM-free

The most important property: every verb runs in the gateway's
deterministic chat handler. **No agent claude process is invoked.**
When every account on the fleet is quota-exhausted and the LLM is
unreachable, the operator can still add a fresh account, swap to
it, and unblock the fleet — entirely from chat:

1. `/auth add <label>` — bot spawns `claude setup-token`, replies
   with the authorize URL, and intercepts the code you paste back
   (deleted from chat history on completion). On success the new
   account is registered with the broker; the fleet active is
   unchanged.
2. `/auth use <label>` — switches the fleet to the new account.

`/auth cancel` aborts an in-flight `/auth add`.

**Google / Microsoft accounts add over Telegram too (issue #2582).** The
Drive/Graph loopback OAuth flow is fully relayable — no SSH port-forward,
no keyboard:

- `/auth google add <email> [--replace] [--write] [--calendar]`
- `/auth microsoft add <email> [--replace] [--org-mode]`

The agent runs the loopback flow in its own container, relays the consent
URL to chat, and you approve on your phone. The redirect to `127.0.0.1`
fails to load — expected — so you paste the full address-bar URL
(`?code=...&state=...`) back into chat; the gateway validates `state` and
hands the code to the waiting listener. The pasted URL is redacted from
history on completion. `/auth google cancel` / `/auth microsoft cancel`
abort. Run it against the agent that should hold the grant
(`google/client-secret` is admin-only and can't be minted to the root
agent).

### Full surface

| Chat command | Equivalent CLI verb |
|---|---|
| `/auth show [<agent>]` | `switchroom auth show [<agent>]` |
| `/auth list` | `switchroom auth list` |
| `/auth add <label>` | `switchroom auth add <label> --from-oauth` (chat-native OAuth flow) |
| `/auth google add <email>` | `switchroom auth google account add <email>` (Telegram-native loopback relay) |
| `/auth microsoft add <email>` | `switchroom auth microsoft account add <email>` (Telegram-native loopback relay) |
| `/auth cancel` | (chat-only: aborts an in-flight `/auth add`) |
| `/auth use <label>` | `switchroom auth use <label>` |
| `/auth rotate` | `switchroom auth rotate` |
| `/auth rm <label>` | `switchroom auth rm <label>` (two-step confirm in chat) |
| `/auth refresh [<label>]` | `switchroom auth refresh [<label>]` |
| `/auth agent override <agent> <label\|clear>` | `switchroom auth agent override <agent> [<label>]` |
| `/auth help` | `switchroom auth --help` |

These replace the v0.7-era `/auth dashboard` UI (deleted in this
release; it was a 1100-LOC in-place promote UI built on the
per-agent slot model that's no longer needed).

## Ephemeral consumers (hindsight et al.)

A non-agent container that needs OAuth credentials (e.g. a
hindsight instance using the `claude-code` LLM provider — it calls
the Anthropic API under the consumer's OAuth identity for its own
summarization / recall) is declared in `switchroom.yaml`:

```yaml
auth:
  consumers:
    - name: hindsight
      account: me@example.com
      uid: 11000
```

On the next `switchroom apply`, the broker binds
`/run/switchroom/auth-broker/hindsight/sock`, chowned to the
declared UID (mode 0600). The hindsight compose project
(SEPARATE from switchroom's compose project — needs its own
`docker compose -p hindsight`) bind-mounts the named volume into
its own container at `/run/switchroom/auth-broker/`, then runs an
entrypoint shim that calls `get-credentials`, writes the result
to a tmpfs dotfile, **spawns a background refresh sidecar**, and
exec's the hindsight server.

> **The consumer container's runtime UID must match
> `auth.consumers[<name>].uid`.** The broker chowns the socket to
> that UID at mode 0600; if the hindsight container ran as a
> different UID, the entrypoint would EACCES on connect. The
> bundled `switchroom-hindsight` image pins UID 11000 in its
> Dockerfile (`usermod -u 11000 hindsight`) to match the
> `HINDSIGHT_DEFAULT_UID` constant in `src/setup/hindsight.ts`
> and the default value the setup wizard writes. Custom consumer
> images must do the same pin or operators must set
> `auth.consumers[].uid` to whatever the container runs as.

The entrypoint refresh sidecar is required because the broker
refreshes its canonical credentials every ~60 min, and the
consumer's tmpfs copy is divorced from that file. Without a
refresh loop, the tmpfs `.credentials.json` would go stale on
the broker's first refresh and hindsight would 401 after the
access token expired (~5h later). The sidecar re-runs the same
NDJSON fetcher every `SWITCHROOM_HINDSIGHT_REFRESH_S` seconds
(default 1800 = 30 min, ahead of the broker's 60-min cadence).

The bundled `switchroom-hindsight` image (built from
`docker/Dockerfile.hindsight`, published to
`ghcr.io/switchroom/switchroom-hindsight`) ships with this shim
pre-installed. Its compose snippet:

```yaml
services:
  switchroom-hindsight:
    image: ghcr.io/switchroom/switchroom-hindsight:latest
    container_name: switchroom-hindsight
    ports:
      - "8888:8888"
      - "9999:9999"
    environment:
      - HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE=1000
      - HINDSIGHT_API_LLM_PROVIDER=claude-code
    volumes:
      - switchroom-hindsight-data:/home/hindsight/.pg0
      - auth-broker-hindsight-sock:/run/switchroom/auth-broker
    tmpfs:
      - /run/claude-creds:rw,mode=0700
    restart: unless-stopped

volumes:
  switchroom-hindsight-data:
  auth-broker-hindsight-sock:
    external: true  # bound by the switchroom-auth-broker singleton
```

The entrypoint shim
(`docker/hindsight-entrypoint.sh`) waits up to 60s for the broker
socket, then fetches credentials via NDJSON:

```sh
node -e '
  const net = require("net"), fs = require("fs"), crypto = require("crypto");
  const sock = net.connect("/run/switchroom/auth-broker/sock");
  const id = crypto.randomUUID();
  sock.write(JSON.stringify({ v: 1, op: "get-credentials", id }) + "\n");
  sock.on("data", buf => {
    const { ok, data, error } = JSON.parse(buf.toString());
    if (!ok) { console.error(error); process.exit(1); }
    fs.writeFileSync("/run/claude-creds/.credentials.json",
      JSON.stringify(data.credentials, null, 2), { mode: 0o600 });
    process.exit(0);
  });
'
export CLAUDE_CONFIG_DIR=/run/claude-creds
exec "$@"
```

Note the dotfile (`.credentials.json`) — claude reads the dotfile
name, not the bare form. The credentials live on tmpfs only; the
auth-broker remains the single writer of OAuth state on disk.

On 429, the consumer calls `mark-exhausted`; the broker fails over
switchroom agents on the same account too (quota state is shared).
The hindsight image's `HINDSIGHT_API_LLM_PROVIDER` is pinned to
`claude-code` (the upstream subscription-honest provider) — no
OpenAI / Anthropic API key is required or accepted.

## Degraded mode

If the broker is down, agents continue running on whatever bytes
are already in their per-agent `.credentials.json`. Token lifetime
is 8h; the broker can be down for hours without a user-visible
outage. On restart, the broker re-syncs from the account store and
resumes the refresh loop.

The compose `depends_on: condition: service_healthy` only blocks
agents *at first boot* — if the broker was up and is now down,
agents keep going.
