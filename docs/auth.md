# Auth — switchroom-auth-broker

Switchroom authenticates against Anthropic via OAuth (Pro/Max
subscriptions). The **account is the unit of authentication** — one
OAuth flow per Anthropic account, then "use this account on these
agents" is configuration, not another OAuth round.

Architecture detail at [`docs/rfcs/auth-broker.md`](rfcs/auth-broker.md);
the design contract at
[`reference/share-auth-across-the-fleet.md`](../reference/share-auth-across-the-fleet.md).
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
```

The schema is intentionally minimal in the common case — most agents
need no `auth:` block.

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

### Full surface

| Chat command | Equivalent CLI verb |
|---|---|
| `/auth show [<agent>]` | `switchroom auth show [<agent>]` |
| `/auth list` | `switchroom auth list` |
| `/auth add <label>` | `switchroom auth add <label> --from-oauth` (chat-native OAuth flow) |
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
