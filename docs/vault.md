# Vault — Operator Guide

Switchroom's vault is a directory (`~/.switchroom/vault/`) holding an
AES-256-GCM encrypted store (`vault.enc`) that keeps secrets used by
agents and scheduled tasks.  This guide covers the architecture, how to
declare and scope secrets, Telegram commands for runtime management, the
audit log, and the threat model.

**Scope / see also:** this is the **operator guide** (declare secrets, Telegram commands, audit log, day-to-day use). For the security/threat model and which auth path to use when, see [vault-security.md](vault-security.md); for broker ACL internals and the path-as-identity contract, see [vault-broker.md](vault-broker.md); for boot-time auto-unlock setup and recovery, see [auto-unlock.md](auto-unlock.md).

> ## v0.7.12 layout change
>
> As of **v0.7.12**, the canonical vault path is
> `~/.switchroom/vault/vault.enc` (parent-dir bind-mount enables
> atomic-rename writes from the broker container — closes #954).
> Legacy `~/.switchroom/vault.enc` becomes a symlink during the
> auto-migration on `switchroom apply`. **Operator action: none.**
>
> **Backup tooling:** if you back up `~/.switchroom/vault.enc` with
> rsync / restic / tar in their default modes, they'll start backing
> up the symlink instead of the file content. Either:
>
> - Update your backup path to `~/.switchroom/vault/vault.enc`, or
> - Pass `--copy-links` (rsync) / `-L` (tar) / equivalent.
>
> **Symlink sunset:** v0.7.12 creates / v0.7.13 warns / v0.7.14
> removes. Update backup tooling before v0.7.14 to avoid silent
> drops.
>
> **Recovery from divergence:**
> [`docs/operators/state-e-recovery.md`](operators/state-e-recovery.md)
>
> **Rollback to v0.7.11:**
> [`docs/operators/rollback-v0.7.12.md`](operators/rollback-v0.7.12.md)

---

## Architecture

```
~/.switchroom/vault/vault.enc (AES-256-GCM, passphrase-derived)
    │
    └── switchroom-vault-broker  (Docker compose singleton)
            │  per-agent Unix socket: /run/switchroom/broker/<agent>/sock
            │  mode 0600, chowned to the agent UID at bind time
            │  identity = the bind path (path-as-identity), not a wire payload
            │
            ├── agent-<name>  (scheduled run)  (allowed, if key in secrets[])
            └── (all other callers)            → DENIED
```

The broker is a long-running Docker container — a `docker compose`
singleton in the `switchroom` project, not a systemd user unit.  It
holds the decrypted vault in memory after a one-time passphrase unlock
(or machine-bound auto-unlock).  Compose binds one socket per agent at
`/run/switchroom/broker/<agent>/sock`; the broker derives the calling
agent's identity from that **bind path** via `socketPathToAgent`
(`src/vault/broker/peercred.ts`) — never from systemd cgroups, and
never from anything the caller sends on the wire.  When a scheduled
run makes a `get` request the broker:

1. Parses the agent name from the socket the connection arrived on
   (path-as-identity; the path is broker-controlled at bind time).
2. Checks the per-schedule `secrets[]` allowlist.
3. Checks the per-key scope ACL (if set via `--allow` / `--deny`).
4. Returns the value or denies with a logged reason.

Cron is the in-agent `agent-scheduler` sidecar (since Phase 4 — see
[scheduling.md](scheduling.md)); there are no
`switchroom-<agent>-cron-N.service` systemd units.  Interactive calls
(`switchroom vault get`) go directly to the vault store with the user's
passphrase — the broker is for scheduled (non-interactive) access.

---

## Commands

### Populate the vault

Create the encrypted vault store first with `switchroom vault init` (or
the `switchroom setup` wizard does it for you); both prompt for a
passphrase. `switchroom vault set` requires an existing store and
errors with `Vault file not found` if you skip init.

```sh
switchroom vault init                          # create the encrypted vault store (prompts for passphrase)
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

## Admin-only credentials

Some credentials are sensitive enough that you want them approved **only by
you** — not by another operator you've added to `allowFrom`, and never by an
agent on a silent auto-mint path. List them under `vault.broker.adminOnlyKeys`:

```yaml
vault:
  broker:
    approvalAuth: telegram-id      # fleet default (single-factor)
    adminOnlyKeys:
      - stripe/*                   # whole namespace
      - microsoft/ken-tokens       # exact key
      - billing-api-key
```

Entries are exact key names or `*` globs (`*` matches any run of characters,
including `/`; matching is case-sensitive). For any key that matches:

- **Only the admin operator may approve it.** The admin is the first entry in
  `access.allowFrom` (the owner). A grant-approval tap from any other allowFrom
  member is rejected — the card stays open for the owner.
- **It is always minted with your vault passphrase, never posture.** Even when
  the fleet default is `approvalAuth: telegram-id` (single-factor, no passphrase
  prompt for normal grants), approving an admin-only key prompts you to reply
  with the vault passphrase. The broker **refuses** to mint an admin-only key
  via posture attestation, so an agent — even one on `postureMintAgents` —
  cannot self-grant it. The passphrase is the unforgeable proof that it's you:
  `claude` shares the gateway's broker socket and can forge a Telegram tap, but
  it does not have the passphrase.

Posture may **retain** an admin-only key the agent already holds (the gateway
unions a newly-approved key with the agent's existing grant when it re-mints) —
it just can't **add** a new one without the passphrase.

> Heads-up under auto-unlock: with `approvalAuth: telegram-id` you normally
> never type the passphrase. Admin-only keys are the exception — approving one
> requires the passphrase you set when the vault was created. If you've
> forgotten it, grant the key on the host instead:
> `switchroom vault grant <agent> --keys <key> --duration 30d`.

`adminOnlyKeys`, per-cron secret ACLs, agent `admin:` flags, and the approval
posture (`vault.broker.approvalAuth` / `postureMintAgents`) all **hot-reload on
the broker side** — `switchroom apply` SIGHUPs the running `switchroom-vault-broker`
so config edits take effect with no broker restart (the broker re-reads
`switchroom.yaml` in place; the decrypted vault is preserved). Restart is only
needed for the **gateway** half (the Telegram `/vault` surface re-reads config at
agent restart) and for changes the broker treats as restart-only: `vault.path`
and the auto-unlock settings. If `apply` can't reach Docker, the fallback is
`docker restart switchroom-vault-broker`.

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
  "caller": "agent:my-agent",
  "pid": 12345,
  "agent_name": "my-agent",
  "result": "allowed"
}
```

**Identity model vs. the `caller` string.** The ACL decision is *not*
made from `caller`/`cgroup`.  As described in [Architecture](#architecture)
above, the broker derives the calling agent's identity from the
per-agent bind socket path via `socketPathToAgent` — path-as-identity,
never cgroup membership.  The trusted, ACL-relevant identity in the
record is `agent_name` (derived from that bind path).

On a v0.7+ docker deployment the `caller` field is the human-readable
`agent:<name>` form of that same path identity, and `cgroup` is omitted
— there is no systemd unit in-container, cron runs in-process inside the
agent's `agent-scheduler` sidecar.  The legacy
`switchroom-<agent>-cron-N.service`-shaped `caller`/`cgroup` strings
appear only on pre-v0.7 systemd-mode hosts, where peercred can still
resolve a cgroup unit.  Either way, `caller`/`cgroup` are
**informational forensic context only** — never an ACL input.

Fields:

| Field | Type | Description |
|---|---|---|
| `ts` | ISO-8601 | Timestamp of the request |
| `op` | string | Operation: `get`, `set`, `delete`, `list`, `unlock`, `lock` |
| `key` | string? | Vault key name — **never the secret value** |
| `caller` | string | Human-readable caller: `agent:<name>` (docker, path-as-identity), `operator`, or the legacy `<unit>.service` / `pid:<n>` fallback. **Not** used for ACL |
| `pid` | number | PID of the calling process |
| `cgroup` | string? | Legacy cgroup unit name; set only on systemd-mode hosts, omitted on docker. Not an ACL input |
| `agent_name` | string? | Agent slug derived from the bind socket path — the trusted identity used for the ACL decision (path-as-identity) |
| `result` | string | `"allowed"`, `"denied:<reason>"`, or `"error:<detail>"` |

### Grep examples

```sh
# All denied requests
grep '"result":"denied' ~/.switchroom/vault-audit.log

# All requests for a specific key
grep '"key":"stripe/live-key"' ~/.switchroom/vault-audit.log

# Requests from a specific agent (trusted, path-derived identity)
grep '"agent_name":"my-agent"' ~/.switchroom/vault-audit.log

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
  read vault keys via the broker — the broker only answers a scheduled run's
  `secrets[]`-listed keys, not arbitrary interactive Claude requests.  The
  caller's agent identity is the bind path of the per-agent socket, which
  the broker controls at bind time (chowned to the agent UID, mode 0600) —
  it cannot be forged by a wire payload.
- **Per-key scoping**: `--allow` / `--deny` narrows access further, so even a
  legitimate cron unit cannot read keys it is not explicitly permitted to read.

### What the ACL does not protect against

- **Root compromise**: a process running as root can impersonate any cgroup or
  read the vault file directly.
- **Host-level compromise**: kernel-level access, full-disk access, or access
  to the user's home directory bypasses all vault protections.
- **Multi-tenant**: Switchroom is single-tenant, not multi-tenant. Trusted
  users *within* a tenant share its vault by design — there is no per-user
  vault isolation (they're implicitly trusted; see the `single-tenant`
  invariant). Separate OS users on the same host each get separate vault
  files and broker sockets, but processes running as the same UID are not
  isolated from each other.
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
