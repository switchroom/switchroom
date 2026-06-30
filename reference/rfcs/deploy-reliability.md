---
artifact: fleet deploy reliability
backs: always-available
relates: reference/rfcs/host-control-daemon.md
---

# Fleet deploy reliability — host-path poisoning prevention

This is the standing design record for the **defend-by-construction**
invariant that prevents a deploy from baking container-internal paths
as Docker bind-mount sources and destroying the running fleet.

Read this before touching the compose generator, the apply path, or
anything that derives a host-filesystem path for use as a bind-mount
source.

## The failure class

**Root cause (2026-06-23 outage, 5 h fleet-down):** a v0.15.56 upgrade
ran inside a helper container (`HOME=/state/agent/home`,
`SWITCHROOM_HOST_HOME` unset). The compose generator fell back to
`homedir()`, the *container* HOME, and baked that path as the leading
segment of every host bind-mount source. Docker's behaviour when a `:ro`
bind source doesn't exist: **silently auto-creates it as a root-owned
directory**. Consequences:

- `~/.switchroom/vault/` became an empty dir → vault-broker crashed
  (SQLite `unable to open`, EISDIR).
- `~/.switchroom/compose/docker-compose.yml` became a dir → all
  subsequent `docker compose` invocations failed.
- `~/.docker/cli-plugins/docker-compose` became an empty dir → the
  `docker compose` plugin was shadowed host-wide, breaking every
  compose command on the box.

Fleet stuck "Created" for 5 h; `docker compose` broken host-wide.

Earlier variant (2026-06-11/12): same class, different container root
(`/host-home`, the hostd mount point). The old guard was path-specific
(`/host-home`-only) and the 2026-06-23 vector (`/state/agent/home`)
sailed through it.

**The general class:** any deploy context that resolves the host home
from the container's ambient `HOME` (or any other in-container
filesystem root) and bakes it into compose bind-mount sources. Docker
never hard-fails on a missing `:ro` source. It auto-creates, and
the auto-created artifact is always a root-owned directory, never the
file or populated directory the container expected.

## The invariant

> **NO deploy context may derive the host home from ambient `HOME`.**
> Every path baked as a bind-mount source must originate from a
> `SWITCHROOM_HOST_HOME` value set by the caller (host shell) or by
> hostd (the blessed in-container deploy path) — never from the
> container's own `HOME` or any other in-container filesystem root.

Operationally: deploys must run from the **HOST shell** (which sets
`SWITCHROOM_HOST_HOME` via `apply`'s env-preservation chain) or from
**hostd** (which sets `SWITCHROOM_HOST_HOME` at dispatch time). Never
via an ad-hoc `docker run <agent-image> switchroom update` or
`docker exec <agent> switchroom apply` that mounts the operator home
writable or leaves `SWITCHROOM_HOST_HOME` unset.

## Layered defenses (defence-in-depth)

### 1. Generation guard — `assertPlausibleHostHome`

`src/agents/compose.ts:assertPlausibleHostHome` is called at compose
**generation time** with the `homePrefix` that will be baked into every
bind-mount source. It maintains `CONTAINER_ROOT_PREFIXES`, a list of
in-container filesystem roots (`/state`, `/run`, `/proc`, `/sys`,
`/dev`, `/tmp`, `/host-home`), and throws on any prefix that is or
starts with one of those, AND on any non-absolute path. The only
pass-through besides a real host path is the legacy `${HOME}` literal
(resolved by Docker at `up` time on the host, never by the generator).

This generalises the old `/host-home`-only guard to the whole class.
It fires before any file is written, so the fleet is never poisoned.

### 2. Fail-closed resolver — `resolveHostHomeForCompose`

`src/cli/write-compose.ts:resolveHostHomeForCompose` is the single
callsite that determines the host home passed to the generator. It is
strictly fail-closed:

1. `SWITCHROOM_HOST_HOME` set and non-empty → validate via
   `assertPlausibleHostHome`, use it. (The blessed path.)
2. Running inside a container + `SWITCHROOM_HOST_HOME` unset → **THROW**.
   Never falls back to `homedir()` (the container HOME, the poison).
3. Running on the host shell + `SWITCHROOM_HOST_HOME` unset → `homedir()`.
   Safe because `homedir()` on the host shell IS the real operator home.

The same resolver governs the mount-source seeder in `apply.ts` that
creates any missing host-side bind-source directories, so that path
can't silently create them under a container root either.

### 3. Sudo self-elevation env preservation

`src/cli/apply.ts:SELF_ELEVATE_PRESERVED_ENV` is the single source of
truth for env vars passed across the `sudo` boundary. It explicitly
includes `SWITCHROOM_HOST_HOME` (and `SWITCHROOM_HOSTD_CONTEXT`).
Without this, the blessed value set by the caller would be stripped by
sudo's secure environment and the resolver would fall through to
`homedir()`, which under sudo is `/root`, not the operator home.

### 4. Pre-flight bind-source validator — `preflight-mounts.ts`

`src/cli/preflight-mounts.ts:validateBindSources` parses the generated
compose file's host bind sources and `stat`s each one before `docker
compose up` is called. A source that is:

- **missing** → abort (would be auto-created by Docker)
- **wrong type** (a file where a dir is expected, or vice versa, the
  exact signature of a prior auto-dir poisoning) → abort

This is the last-resort catch: even if the generation guard and
resolver both fail, the deploy aborts loudly rather than poisoning the
host. The abort message names the offending paths and points at
`switchroom host repair-mounts` for recovery.

### 5. Atomic compose write + `.bak` backup

`write-compose.ts:writeComposeFile` writes the compose via a
`<composePath>.tmp` → `rename` swap (atomic on POSIX), and keeps the
prior compose as `<composePath>.bak`. A crash mid-write never leaves a
truncated compose. If a subsequent deploy poisons the compose, the
`.bak` is the prior known-good file the operator (or `update`'s
health-gated rollback path) can restore from.

### 6. Recovery — `switchroom host repair-mounts`

If the fleet is already poisoned (auto-dir artifacts exist on the host),
`switchroom host repair-mounts` identifies and removes the spurious
root-owned directories so a subsequent `switchroom apply` from the host
shell can regenerate a clean compose. `switchroom doctor` detects
the poisoned-state signature (expected files are directories) and
surfaces the repair command.

## Residual gap — out-of-repo deploy wrappers

The defenses above are all in-process (the `switchroom` CLI). An
out-of-repo helper script or Coolify action that does:

```
docker run --rm \
  -v ~/.switchroom:/state/home \
  <agent-image> switchroom update
```

bypasses all of them: the container has no `SWITCHROOM_HOST_HOME`,
`isContainerContext()` returns true, and the CLI throws, but only if
the script is using a version of switchroom that has this fix. A
pre-fix image would silently poison the host.

**Resolution:** any out-of-repo deploy wrapper MUST be repointed to
dispatch through hostd (which sets `SWITCHROOM_HOST_HOME` correctly)
or through the host shell CLI directly. Never via `docker run
<agent-image> switchroom …` with the operator home or `~/.docker`
mounted writable. This is a configuration/ops obligation, not something
the in-process guards can enforce.

## Summary of code pointers

| Defense | File | Symbol |
|---|---|---|
| Generation guard | `src/agents/compose.ts` | `assertPlausibleHostHome` |
| Fail-closed resolver | `src/cli/write-compose.ts` | `resolveHostHomeForCompose` |
| Sudo env preservation | `src/cli/apply.ts` | `SELF_ELEVATE_PRESERVED_ENV` |
| Pre-flight validator | `src/cli/preflight-mounts.ts` | `validateBindSources`, `formatPreflightError` |
| Atomic write + backup | `src/cli/write-compose.ts` | `writeComposeFile` |
| Recovery | `src/cli/host.ts` | `repairMounts` |
