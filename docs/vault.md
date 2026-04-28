# Vault — Operator Guide

Switchroom's vault is an AES-256-GCM encrypted file (`vault.enc`) that stores
secrets used by agents and scheduled cron tasks.  This guide covers the
architecture, how to declare and scope secrets, Telegram commands for runtime
management, the audit log, and the threat model.

---

## Architecture

```
vault.enc (AES-256-GCM, passphrase-derived)
    │
    └── vault broker daemon  (Unix socket: ~/.switchroom/vault-broker.sock)
            │  mode 0600 — only the owner UID may connect
            │  identity via peercred + cgroup — not spoofable from userspace
            │
            ├── switchroom-<agent>-cron-0.service   (allowed, if key in secrets[])
            ├── switchroom-<agent>-cron-1.service   (allowed, if key in secrets[])
            └── (all other callers)                 → DENIED
```

The broker is a long-running user-level systemd unit
(`~/.config/systemd/user/switchroom-vault-broker.service`).  It holds the
decrypted vault in memory after a one-time passphrase unlock.  When a cron
unit makes a `get` request the broker:

1. Identifies the caller via Linux cgroup membership (cgroups are written by
   systemd as root — processes cannot move themselves between cgroups).
2. Checks the per-schedule `secrets[]` allowlist.
3. Checks the per-key scope ACL (if set via `--allow` / `--deny`).
4. Returns the value or denies with a logged reason.

Interactive calls (`switchroom vault get`) go directly to the vault file with
the user's passphrase — the broker is for cron-only access.

---

## Commands

### Initialise and populate the vault

```sh
switchroom vault init                          # create vault.enc (prompts for passphrase)
switchroom vault set <key>                     # set a secret interactively
switchroom vault set <key> --file /path/to     # read value from file (PEM, JSON, etc.)
switchroom vault get <key>                     # decrypt and print (direct, not via broker)
switchroom vault list                          # list key names (never values)
switchroom vault remove <key>                  # delete a key
```

### Broker lifecycle

```sh
switchroom vault broker unlock                 # push passphrase to broker, start serving
switchroom vault broker lock                   # wipe in-memory vault, stop serving
switchroom vault broker status                 # print JSON status (locked/unlocked, uptime)
switchroom vault broker enable-auto-unlock     # store passphrase in system credential store
```

---

## Declaring per-cron secrets

Cron tasks declare the vault keys they need in `switchroom.yaml` under
`schedule[i].secrets`.  Only listed keys are accessible to that specific cron
task — the broker denies any request for an unlisted key.

```yaml
agents:
  my-agent:
    schedule:
      - cron: "0 8 * * *"
        prompt: "Run the morning report"
        secrets:
          - reports/api-key           # only this key is accessible to cron task 0

      - cron: "0 20 * * *"
        prompt: "Send the evening digest"
        secrets:
          - digest/smtp-password      # cron task 1 can only read this key
          - digest/sender-address
```

The cron script reads the secret via the broker:

```sh
API_KEY=$(switchroom vault get reports/api-key)
```

`secrets: []` (the default) means the cron has no vault access at all.  Any
broker request from that cron task is denied.

---

## Per-key access control (ACL)

Beyond the per-cron `secrets[]` allowlist you can apply an additional per-key
scope to restrict which agents may read a key.  Set it when storing the secret:

```sh
# Only the 'reports' agent may read this key
switchroom vault set stripe/live-key --allow reports

# Everyone except the 'experiment' agent
switchroom vault set openai/api-key --deny experiment

# Combine: allow exactly two agents, deny is checked first
switchroom vault set infra/deploy-token --allow deploy --allow infra --deny sandbox
```

ACL rules (evaluated in order, fail-closed):

1. The caller must be a recognised switchroom cron unit.
2. If the key's `deny` list contains the caller's agent slug → **denied**.
3. If the key's `allow` list is non-empty and the caller is not in it → **denied**.
4. Otherwise → **allowed** (and only if the key also appears in the cron's `secrets[]`).

Both checks must pass.  The `secrets[]` allowlist is evaluated by the broker
before the per-key scope is consulted.

---

## Telegram `/vault` commands

Agents with the switchroom Telegram plugin expose these commands at runtime:

| Command | Description |
|---|---|
| `/vault status` | Show whether the broker is running and unlocked |
| `/vault unlock` | Prompt for the passphrase and push it to the broker |
| `/vault lock` | Wipe the in-memory vault (broker continues running, locked) |
| `/vault list` | List vault key names (never values) |
| `/vault get <key>` | Retrieve a key directly from the vault file (interactive only) |
| `/vault set <key>` | Set or update a key interactively |
| `/vault delete <key>` | Remove a key from the vault |

These commands run as the user who owns the agent process.  The broker's
peercred ACL does not apply to interactive Telegram commands — they talk
directly to the vault file with the user's passphrase, the same way
`switchroom vault get --no-broker` does.

---

## Audit log

Every broker request — successful or denied — is appended to:

```
~/.switchroom/vault-audit.log
```

The file is mode `0600` (user-only).  Each line is a JSON object:

```json
{
  "ts": "2026-04-28T14:33:00.123Z",
  "op": "get",
  "key": "stripe/live-key",
  "caller": "switchroom-my-agent-cron-0.service",
  "pid": 12345,
  "cgroup": "switchroom-my-agent-cron-0.service",
  "result": "allowed"
}
```

Fields:

| Field | Type | Description |
|---|---|---|
| `ts` | ISO-8601 | Timestamp of the request |
| `op` | string | Operation: `get`, `set`, `delete`, `list`, `unlock`, `lock` |
| `key` | string? | Vault key name — **never the secret value** |
| `caller` | string | Cgroup unit name, or `pid:<n>` if unavailable |
| `pid` | number | PID of the calling process |
| `cgroup` | string? | Raw cgroup unit name if resolved |
| `result` | string | `"allowed"`, `"denied:<reason>"`, or `"error:<detail>"` |

### Grep examples

```sh
# All denied requests
grep '"result":"denied' ~/.switchroom/vault-audit.log

# All requests for a specific key
grep '"key":"stripe/live-key"' ~/.switchroom/vault-audit.log

# Requests from a specific cron unit
grep '"caller":"switchroom-my-agent-cron-0.service"' ~/.switchroom/vault-audit.log

# Use switchroom vault audit for formatted output
switchroom vault audit --denied
switchroom vault audit --key stripe/live-key
switchroom vault audit --who my-agent-cron-0
```

---

## Threat model

### What the ACL protects against

- **Misconfiguration**: a typo in one cron's `secrets[]` does not grant it
  access to another cron's keys.  Each cron task only sees keys explicitly
  listed for it.
- **Hijacked agent on this UID**: a compromised agent Claude session cannot
  read vault keys via the broker — the broker only serves systemd cron units,
  not interactive Claude processes.  The cgroup identity is set by systemd as
  root and cannot be spoofed from userspace.
- **Per-key scoping**: `--allow` / `--deny` narrows access further, so even a
  legitimate cron unit cannot read keys it is not explicitly permitted to read.

### What the ACL does not protect against

- **Root compromise**: a process running as root can impersonate any cgroup or
  read the vault file directly.
- **Host-level compromise**: kernel-level access, full-disk access, or access
  to the user's home directory bypasses all vault protections.
- **Multi-tenant**: Switchroom is a single-user system.  Multiple users on the
  same host each have separate vault files and broker sockets, but there is no
  isolation between processes running as the same UID.
- **Config edits**: anyone who can edit `switchroom.yaml` can add a key to a
  cron's `secrets[]` list, granting it broker access to any vault key.
  Anyone who knows the vault passphrase can read the vault file directly.

The vault ACL is **misconfiguration protection**, not a security boundary.
The real security boundary is the vault passphrase and the filesystem
permissions on `vault.enc` (`0600`).

---

## See also

- [`docs/vault-broker.md`](vault-broker.md) — broker ACL model deep-dive
- [`docs/scheduling.md`](scheduling.md) — full `schedule[]` configuration reference
- [`docs/configuration.md`](configuration.md) — `vault:` config block reference
- `switchroom vault doctor` — health check for common vault misconfigurations
- `switchroom vault audit` — tail and filter the audit log
