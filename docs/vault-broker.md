# Vault Broker — ACL model and access guide

The vault broker runs as the `switchroom-vault-broker` container (a
`docker compose` singleton in the `switchroom` project) and
authenticates connecting clients by the socket path the connection
arrived on (`/run/switchroom/broker/<agent>/sock`, a broker-controlled
per-agent socket), not by parsing systemd cgroups. Cron is the in-agent
`agent-scheduler` sidecar (since Phase 4 — see
[scheduling.md](scheduling.md)); there are no
`switchroom-<agent>-cron-N.service` systemd units. The ACL contract —
"only declared `secrets:`, only the scheduled run for that agent" — and
the per-agent `secrets:` allowlist drive what each scheduled task can
read.

**Scope / see also:** this is the **broker internals** doc (ACL model, path-as-identity contract, socket layout). For day-to-day operator use, see [vault.md](vault.md); for the security/threat model and auth-path selection, see [vault-security.md](vault-security.md); for boot-time auto-unlock setup and recovery, see [auto-unlock.md](auto-unlock.md).

## What is the vault broker?

The vault broker is a long-running container that holds the decrypted
vault in memory and serves secrets to authorised **switchroom agents'
scheduled runs** over a per-agent Unix socket. It avoids re-prompting
for the vault passphrase on every scheduled run.

The broker is **not** a general-purpose secret server.  It only serves a
scheduled run's declared `secrets[]` keys for the agent that owns the
socket — it does not serve interactive shells, Claude Code sessions, or
arbitrary scripts.

## Who can read from the broker?

| Caller context | Broker access |
|---|---|
| Scheduled run for `agent-<name>` (via that agent's bound socket) | Allowed if the requested key is in the UNION of that agent's `schedule[*].secrets` (per-agent, not per-cron-entry — see below) |
| MCP-server launcher for `agent-<name>` (via that agent's bound socket) | Allowed if the requested key is in any of the agent's effective `mcp_servers.<name>.secrets` |
| Interactive shell (`switchroom vault get`) | **Denied** — use `--no-broker` |
| Claude Code / agent session | **Denied** — use `--no-broker` |
| Any other caller | **Denied** |

### Identity-bound ACL exceptions

The broker grants four classes of identity-bound keys to an agent under its own peercred (path-as-identity), in addition to the schedule.secrets allowlist:

1. **Agent's own `bot_token`** — the gateway reads `agents.<name>.bot_token` (per-agent override) or falls back to `telegram.bot_token` (global). The ACL grants exactly that resolved key to the owning agent.
2. **Google OAuth client credential** — `google_workspace.google_client_secret` (and `_id`) when the agent has `gdrive` MCP enabled. Gated by the same `shouldEmitGdriveMcp` predicate the scaffold uses, so the broker and scaffold can't disagree. See [google-workspace.md](google-workspace.md).
3. **Google account slot tokens** — `google:<account>:<field>` keys, gated by `google_accounts.<account>.enabled_for[]` per RFC G §4.4.
4. **User-declared MCP-server secrets** — any key listed in the agent's effective `mcp_servers.<name>.secrets[]` (post-cascade). Generalises the gdrive special-case to every operator-declared MCP launcher. See [configuration.md § Wiring an MCP server that needs vault secrets](configuration.md#wiring-an-mcp-server-that-needs-vault-secrets) for the operator-facing how-to. Added in v0.13.42.

These four exceptions are checked **before** the schedule.secrets allowlist; an MCP-only agent (no cron schedule) still serves its MCP secrets correctly because the exceptions short-circuit the "no schedule → deny all" early return.

Identity is **path-as-identity**: compose binds one socket per agent at
`/run/switchroom/broker/<agent>/sock`, chowned to that agent's UID at
mode 0600 at bind time. The broker derives the calling agent's name from
that bind path via `socketPathToAgent` (`src/vault/broker/peercred.ts`).
Because the path is broker-controlled — never sent by the caller — it
cannot be forged from userspace.

## Why are agents denied?

The broker's ACL is misconfiguration protection, not a security boundary
(see `docs/architecture.md`).  Allowing arbitrary agent sessions to read the
vault would mean any skill or sub-agent could exfiltrate any secret.  An
agent's scheduled runs receive the keys listed across its
`schedule[*].secrets` allowlists — as a **per-agent union**.

### ACL granularity is per-AGENT, not per-cron-entry

Since the in-container scheduler landed (Phase 4), every one of an agent's
crons runs inside that agent's single session/container. The broker sees
only the agent's socket — never which schedule entry fired — so the ACL
grants a key when it appears in **any** of the agent's `schedule[*].secrets`
lists. There is **no** per-cron-index isolation: if `schedule[0]` declares
`bank/token` and `schedule[1]` declares `cal/token`, both of that agent's
crons can read both keys. This was an explicit, documented change (issue
#1192): the old per-cron-index gate keyed on a `switchroom-<agent>-cron-<i>.
service` systemd cgroup that the in-container scheduler no longer produces,
so it was dead code. If two crons must not share a secret, split them into
separate agents. `switchroom doctor` emits a WARN when an agent declares 2+
schedule entries with divergent `secrets[]` sets, so the non-isolation is
visible.

> The CLI's denial string and some legacy ACL internals still say
> "switchroom cron unit" — that vocabulary predates the Phase 4
> cron-fold-in. It now means "a scheduled run dispatched by the
> in-agent `agent-scheduler` sidecar", identified by the per-agent
> socket bind path.

Agent sessions are expected to receive secrets as environment variables
injected by the cron job itself, not by querying the broker at runtime.

## The `--no-broker` escape hatch

For one-off interactive reads — debugging, scripting, manual key inspection —
pass `--no-broker` to bypass the broker entirely and decrypt the vault file
directly with your passphrase:

```sh
switchroom vault get my-key --no-broker
```

This prompts for the vault passphrase (or reads `SWITCHROOM_VAULT_PASSPHRASE`
from the environment) and reads the vault file directly.  It does not require
the broker to be running.

## Recognising a broker denial in script output

When a script or sub-process calls `switchroom vault get` and the broker
denies the request, the CLI writes a clearly-prefixed error to **stderr**:

```
VAULT-BROKER-DENIED [DENIED]: caller is not a switchroom cron unit; use 'switchroom vault get --no-broker' for interactive access
Hint: run 'switchroom vault get --no-broker <key>' for interactive (non-cron) access.
```

Exit code is **2** for an ACL denial, **3** for a locked broker.

Scripts that capture subprocess output should grep stderr for the
`VAULT-BROKER-DENIED` prefix to detect and surface this error rather than
swallowing it.

## Format hints (`--format` / `--expect`)

Vault entries can carry an optional format annotation set at write time:

```sh
# Store a PEM private key and annotate it
switchroom vault set my-key --format pem < key.pem

# Store a 32-byte raw seed (base64-encoded)
switchroom vault set my-key --format base64-raw-seed < seed.b64
```

Allowed format values: `pem`, `base64-raw-seed`, `base64`, `json`, `string`
(default).

At read time, consumers can declare what they expect:

```sh
switchroom vault get my-key --expect pem
```

If the stored format does not match `--expect`, the CLI writes a
`VAULT-FORMAT-MISMATCH` warning to stderr and continues (warn-and-proceed).
Pass `--strict-format` to turn the mismatch into a hard exit-4 failure.

## Configuring secrets for cron access

In `switchroom.yaml`, list the vault keys each scheduled run is allowed to
read:

```yaml
agents:
  myagent:
    schedule:
      - cron: "0 8 * * *"
        prompt: "Run the daily job"
        secrets:
          - my-api-key
          - other-token
```

The broker grants `myagent` read access to `my-api-key` and `other-token`
(and nothing else it isn't otherwise granted). Note the grant is per-AGENT:
if `myagent` declares a second `schedule` entry with different `secrets`,
every one of `myagent`'s crons can read the union of both lists — the ACL
does not isolate by schedule index (see "ACL granularity is per-AGENT"
above).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `VAULT-BROKER-DENIED [DENIED]: caller is not a switchroom cron unit` | Running interactively or in an agent session | Add `--no-broker` |
| `broker locked and stdin is not a TTY` | Broker running but not yet unlocked | Unlock with `switchroom vault broker unlock` or wait for the next passphrase prompt |
| `broker socket not found` | Broker daemon not running | Start with `switchroom vault broker start` |
| `VAULT-FORMAT-MISMATCH` | Stored format differs from `--expect` | Re-store with correct `--format`, or convert the value |
