# Updating the bundled Claude CLI

switchroom pins an **exact** Claude CLI version into every image so the whole
fleet runs one auditable, deterministic runtime. The version is written down in
**three** places and they must always agree (#1978 — a skew between the agent
bundle and the hindsight reflection bundle can reintroduce the thinking-block
failure class):

- `docker/Dockerfile.base` → `ARG CLAUDE_CODE_VERSION`; propagates to agent /
  broker / kernel / auth-broker / hostd (all `FROM ${BASE_IMAGE}`)
- `docker/Dockerfile.hindsight` → `ARG CLAUDE_CODE_VERSION` (installs claude
  separately — it does **not** derive from the base image)
- `dependencies.json` → `.claude.cli`, the pinned-dependency manifest
  `detectDrift()` (`src/manifest.ts`) compares against what a container
  actually runs, surfaced by `switchroom doctor` and `switchroom versions`. A
  stale value here makes every host report a phantom fleet-wide CLI drift.

Lockstep is enforced deterministically by
`scripts/check-claude-cli-lockstep.mjs` (part of `npm run lint`), which reds if
any of the three disagrees. The floor half of the contract — every pin at or
above the #1978 fix version — is asserted in
`tests/doctor-claude-cli.test.ts`.

A CLI bump is the one change where every *required* CI check can pass while the
runtime silently breaks — the build checks only prove the binary **installs and
runs**, not that its **behaviour** (turn delivery, hooks, injected/cron turns,
stream/subagent formats) is still compatible. So updates follow a deliberate
path with two regression layers.

## The regression layers

| Layer | What it proves | Where | Gating? |
|---|---|---|---|
| Image builds (`build-base`/`-dependents`/`-hindsight`) | the pinned version installs + `claude --version` runs in every image | required CI | ✅ |
| **Flag contract** (`tests/claude-cli-contract.test.ts`) | every CLI flag agent-boot depends on still exists in the installed binary's `--help` | `vitest` (self-skips when claude absent) + the canary | ✅ (self-skips) |
| **Nightly latest canary** (`ci-claude-latest-canary.yml`) | `claude@latest` still installs in the base context **and** passes the flag contract — *before* you bump | scheduled, informational | ❌ (alert) |
| **Behavioural UAT** (`ci-uat.yml`) | a real inbound → claude → reply round-trip (and restart/inject scenarios) still work | `uat-host` self-hosted runner | ❌ until wired |

The nightly canary answers "**is latest safe to bump?**" automatically: it goes
red in the Actions tab the night a new version drops a flag switchroom needs or
breaks install. The behavioural UAT is the only thing that proves a real turn
still works — and it needs a self-hosted runner with subscription creds (below).

## Routine update procedure

1. **Check the canary.** If `ci-claude-latest-canary` is green, latest installs
   and keeps every flag switchroom needs. Read its job summary for the
   pinned-vs-latest delta.
2. **Bump the pin — all three locations, same PR.** Edit the
   `CLAUDE_CODE_VERSION=` default in **both** `docker/Dockerfile.base` and
   `docker/Dockerfile.hindsight`, **and** `.claude.cli` in `dependencies.json`,
   to the new version. One line each, all identical. Run
   `npm run lint:claude-cli-lockstep` to confirm before pushing — leaving one
   behind is the classic miss, and it is silent without that check.
3. **PR → review → merge.** The `build-*` checks rebuild every image on the new
   pin; the flag contract runs where claude is present; `lint` enforces the
   three-way lockstep.
4. **Release** (version bump + CHANGELOG) → tag → `docker-images` rebuilds all
   images.
5. **Canary on `test-harness` first** — pin it to the new release, restart, and
   verify `claude --version` *inside* the container reports the new version.
6. **Behavioural check** — if the `uat-host` runner is wired, ci-uat round-trips
   prove it. If not, do the manual canary: send a DM **and** a group message to
   the test bot and confirm it replies (this catches injection/permission
   regressions like the 2.1.166 cross-session-messaging hardening, which the
   build checks are blind to).
7. **Staggered fleet roll** + recreate singletons + **recreate hindsight**
   (manual `docker run` — see the hindsight recreate note below).

## Wiring the `uat-host` runner (makes the behavioural gate automatic)

Once registered, `ci-uat.yml` runs the real round-trip UAT (`fuzz-*`,
`inbound-no-drop`, and on the operator host `jtbd-*`) on every relevant change —
turning the manual canary in step 6 into an automatic gate, and unlocking
"track latest as long as CI passes."

**switchroom is a PUBLIC repo, so the runner is SANDBOXED** — a runner is a
code-execution surface for fork PRs and must never sit unprotected next to the
vault/fleet. The provided runner runs as a **container** with: non-root user,
`no-new-privileges`, mem/pids caps, **no docker socket, no host mounts**, and a
**bridge network (egress only)** — it reaches Telegram + GitHub but cannot touch
the host's `127.0.0.1` fleet/vault. The host-mutating `jtbd-restart` scenarios
self-skip there (no sudo); only the network-only round-trips run — exactly the
boundary we want.

One command does the whole setup (build the image; push the 4 `TELEGRAM_*`
secrets + `UAT_GATE_ENABLED` from `.env`; set fork-PR approval to
all-external-contributors; register + run the container):

```bash
scripts/setup-uat-runner.sh
```

(See `docker/Dockerfile.uat-runner` + `docker/uat-runner-entrypoint.sh` for the
image; runner config persists in the `uat-runner-data` volume, so the container
survives restarts without re-registering.)

Then **confirm a green ci-uat run** and **add `ci-uat` to the required checks**
ruleset (`gh api repos/switchroom/switchroom/rulesets/16470166` → append the
`ci-uat` context to `required_status_checks`, preserving `bypass_actors: []` +
`enforcement: active`). Now a CLI bump can't merge unless a real turn still
works.

> Security floor for a public-repo runner — all set by the script, do not
> weaken: fork-PR approval = `all_external_contributors`; the runner has **no**
> docker socket and **no** host mounts. Re-verify after any Actions-settings
> change.

To run the behavioural check against **latest** (not just the pinned bundle),
build a throwaway agent on latest before driving UAT:
`switchroom apply --build-local` with the base image built
`--build-arg CLAUDE_CODE_VERSION=<latest>`, restart `test-harness`, then run the
UAT scenarios.

## Hindsight recreate note (manual `docker run`, NOT compose)

Hindsight is a standalone `docker run` (managed by `src/setup/hindsight.ts`),
not part of the switchroom compose project. To pick up a new image it must be
stop+rm+run with the COMPLETE flag set, or it crash-loops / loses the shm fix:

- `--shm-size=2g` — the durable Postgres fix (the 2026-06-06 outage); **not**
  in setup.ts, must be added manually or PG writes die.
- `--tmpfs /run/claude-creds:rw,mode=0700,uid=11000,gid=11000` — **mandatory**;
  the image runs `USER hindsight` (UID 11000) and the entrypoint mkdirs
  `/run/claude-creds`. Without the uid-owned tmpfs → `Permission denied` →
  restart loop.
- `--memory=4g --memory-reservation=2g --pids-limit=1000`, the two volumes
  (`switchroom-hindsight-data:/home/hindsight/.pg0` — Postgres data, persists
  across recreate — and `auth-broker-hindsight-sock:/run/switchroom/auth-broker`),
  ports `127.0.0.1:18888:8888` + `127.0.0.1:19999:9999`, and the captured env.

`docker inspect` field-picking misses `Tmpfs` + `User` — use
`src/setup/hindsight.ts` (`runHindsight`) as the source of truth for the run
command, then add `--shm-size=2g`. Verify after:
`curl 127.0.0.1:18888/health` → `{"status":"healthy","database":"connected"}`.
