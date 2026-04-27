# Vault Broker — ACL model and access guide

## What is the vault broker?

The vault broker is a per-user daemon that holds the decrypted vault in memory
and serves secrets to authorised **switchroom cron units** over a Unix socket
(`~/.switchroom/vault-broker.sock`).  It avoids re-prompting for the vault
passphrase on every scheduled run.

The broker is **not** a general-purpose secret server.  It only serves callers
it can positively identify as a switchroom cron unit — it does not serve
interactive shells, Claude Code sessions, or arbitrary scripts.

## Who can read from the broker?

| Caller context | Broker access |
|---|---|
| systemd unit `switchroom-<agent>-cron-<N>.service` | Allowed if the requested key is in `schedule[N].secrets` |
| Interactive shell (`switchroom vault get`) | **Denied** — use `--no-broker` |
| Claude Code / agent session | **Denied** — use `--no-broker` |
| Any other caller | **Denied** |

Identity is established via Linux cgroup membership (peercred + `/proc`).
When systemd starts a cron unit it places the process in a dedicated cgroup
that it writes as root — processes cannot move themselves between cgroups, so
the unit name is unspoofable.

## Why are agents denied?

The broker's ACL is misconfiguration protection, not a security boundary
(see `docs/architecture.md`).  Allowing arbitrary agent sessions to read the
vault would mean any skill or sub-agent could exfiltrate any secret.  Cron
units receive only the keys explicitly listed in their `schedule[N].secrets`
allowlist.

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

The broker enforces this list exactly: `switchroom-myagent-cron-0.service` may
read `my-api-key` and `other-token` but nothing else.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `VAULT-BROKER-DENIED [DENIED]: caller is not a switchroom cron unit` | Running interactively or in an agent session | Add `--no-broker` |
| `broker locked and stdin is not a TTY` | Broker running but not yet unlocked | Unlock with `switchroom vault broker unlock` or wait for the next passphrase prompt |
| `broker socket not found` | Broker daemon not running | Start with `switchroom vault broker start` |
| `VAULT-FORMAT-MISMATCH` | Stored format differs from `--expect` | Re-store with correct `--format`, or convert the value |
