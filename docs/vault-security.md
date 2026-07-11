# Vault security model

How agents and operators access vault secrets, and which path to use when.

This document is the canonical reference. Skill authors and operators reading
this should leave with a clear answer for "I'm in situation X — which auth path
do I use, and what do I have to set up?"

**Scope / see also:** this is the **security model** (auth paths, threat model, what the ACL does and doesn't protect). For day-to-day operator use (declaring secrets, Telegram commands, audit log), see [vault.md](vault.md); for broker ACL internals and the path-as-identity contract, see [vault-broker.md](vault-broker.md); for boot-time auto-unlock, see [auto-unlock.md](auto-unlock.md).

## Three auth paths

The vault broker accepts three distinct authorization paths for read (`get` /
`list`) and write (`put`). Each is appropriate in different contexts:

| Path                       | Read         | Write (rotate) | Write (new key) | Where it runs        |
|----------------------------|--------------|----------------|-----------------|----------------------|
| Capability grant (token)   | ✅           | ✅ (write-grant)| ✅ (write-grant) | Agents, cron, scripts |
| Path-as-identity (UDS)     | ✅ (cron ACL)| ✅             | ❌              | Agents, cron         |
| Operator passphrase        | ✅           | ✅             | ✅              | Operator on host, gateway |

### 1. Capability grant (`switchroom vault grant`)

The canonical path for **autonomous agents** and **scheduled jobs**.

The operator mints a token once, with a tightly-scoped set of allowed keys and
an optional expiry:

```bash
# Read-only access to two named keys, 30-day expiry
switchroom vault grant clerk --keys google-cal-refresh-token,google-cal-access-token --duration 30d

# Write access to any key matching a glob (issue #969 P1b)
switchroom vault grant clerk --write 'google-cal-access-token' --duration 30d

# Combined: read + rotate the same key
switchroom vault grant clerk --keys google-cal-refresh-token --write google-cal-access-token --duration 30d
```

The token is written to `~/.switchroom/agents/<agent>/.vault-token` (mode 0600).
The broker client reads it automatically when the calling process sets
`SWITCHROOM_AGENT_NAME=<agent>` (compose does this for agent containers).

A grant is the **whole authorization story**: no passphrase needed, no env
var, no host shell. The cron unit / skill script just calls `switchroom vault
get <key>` or `switchroom vault set <key>` and the broker checks the token.

Audit log entries for grant-based access carry `method:"grant"` and the
`grant_id` so revocations can be traced back to the operator action that
minted them.

### 2. Path-as-identity

The per-agent socket path. Per-agent UDS sockets at
`/run/switchroom/broker/<agent>/sock` are chowned to the agent's UID, and the
broker parses the agent name from the bind path. Access is gated by the
**per-agent union** of schedule-declared secrets
(`agents.<agent>.schedule[*].secrets[]` in switchroom.yaml) — there is no
per-cron-index isolation (issue #1192; see [vault-broker.md](vault-broker.md)).

Use this when:
- Cron-fired tasks need a fixed set of secrets known at deploy time.
- You want the secret allowlist in version control alongside the cron schedule.

Does NOT allow new-key creation. Agents can rotate (write) keys they can
already read.

### 3. Operator passphrase

The path for **operator-driven actions** from a host shell or the Telegram
gateway. The broker is unlocked once (auto-unlock from `/etc/machine-id`, or
interactively via `switchroom vault broker unlock`); after that, it holds the
passphrase in memory so it can re-encrypt on writes.

Two surface forms:

- **`switchroom vault set <key>`** run interactively on the host with the
  passphrase typed at the prompt (or set via `SWITCHROOM_VAULT_PASSPHRASE`).
  Direct file IO; the broker is bypassed.
- **Broker passphrase attestation** (issue #969 P1a). The Telegram gateway
  forwards the operator's passphrase as a `passphrase` field on the PUT
  request when the user taps an approval card (`vault_request_save`). The
  broker validates against its loaded passphrase and authorizes the call as
  operator-attested. This is what powers the one-tap save-from-Telegram flow.

Audit log entries for passphrase-attested writes carry `method:"passphrase"`.

## Decision flow

```
Is this an autonomous agent or scheduled job?
├─ Yes → use a capability grant.
│        (operator mints once with `vault grant`; agent / cron carries it
│         transparently via .vault-token).
│
├─ No, this is the operator at a host shell.
│        → use `switchroom vault set <key>` directly (the broker daemon
│          stays out of the way for first-time provisioning).
│
└─ No, this is a Telegram-driven flow.
         → use the `vault_request_save` MCP tool (#969 P1a). The user
           taps an approval card; the gateway runs the write under
           operator-passphrase attestation.
```

## Deprecation note: `SWITCHROOM_VAULT_PASSPHRASE` env var

Some legacy skills document `SWITCHROOM_VAULT_PASSPHRASE` as a prerequisite —
exported so the CLI can decrypt the vault directly without prompting. **This
is the wrong pattern for agent-side skills** going forward:

- It puts the master passphrase in every agent process's environment, where
  any subprocess can read it via `/proc/<pid>/environ`. Agents launch many
  subprocesses (claude, MCP servers, skill scripts).
- It bypasses the broker's audit log entirely — accesses are invisible to
  `vault audit log`.
- It defeats the ACL model: a grant scoped to two keys is meaningless if the
  caller also has the master passphrase.

Migration:
1. Operator: `switchroom vault grant <agent> --keys <X,Y> [--write <Z>] --duration <ttl>`.
2. Remove `SWITCHROOM_VAULT_PASSPHRASE` from the skill's host prerequisites.
3. Ensure the agent's `SWITCHROOM_AGENT_NAME` env is set (compose does this
   automatically; standalone scripts must set it).
4. The CLI's `vault get` / `vault set` will pick up `~/.switchroom/agents/
   <agent>/.vault-token` transparently.

`SWITCHROOM_VAULT_PASSPHRASE` is still honoured for backwards compatibility
and for operator-host workflows (vault doctor, vault sweep, setup wizard).
A runtime deprecation warning is emitted when the env var is consumed inside
an agent sandbox (`SWITCHROOM_RUNTIME=docker`) where a grant should be used
instead.

## See also

- `src/vault/broker/server.ts` — the broker's PUT/GET handlers and the order
  in which auth paths are tried.
- `src/vault/grants.ts` — grant schema, `validateGrant` / `validateGrantForWrite`.
- `telegram-plugin/gateway/gateway.ts` — the `vault_request_save` tool +
  `vrs:` callback flow.
- Issue #968, epic #969 — the original gap that motivated P0–P3.
