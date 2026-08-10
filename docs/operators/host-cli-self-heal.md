# Host CLI self-heal (systemd timer)

`switchroom update` updates the fleet **and** the host operator binary
(`self-update-cli`, #3919). But nothing *re-runs* it on a schedule, so if the
host binary is left behind after a roll it stays behind until a human runs
`switchroom update` again. That is exactly what happened once: after **v0.19.38**
rolled to every container, `/usr/local/bin/switchroom` stayed on **v0.19.33** and
the `hindsight-watch` cron ran retired code for **12 hours**.

Two standing checks already make that drift *loud* — `switchroom doctor` now
FAILs on a behind host CLI, and the `hindsight-watch` cron is reconciled on
every update — but "loud" still needs a human to look. This timer makes the host
binary **self-heal** without one: it re-runs `switchroom update --skip-images` on
a cadence, so a behind host CLI is corrected within one interval.

> **Installed automatically.** As of the change that shipped this doc's timer,
> `switchroom update` **installs and enables this timer for you** whenever it
> runs on a **systemd-booted host with root privilege and a resolvable non-root
> operator user** (the `install-self-heal-timer` step). So one host-context
> `switchroom update` is enough to arm perpetual self-heal — you do not need to
> run the manual steps below. They are kept as the **fallback** for a host
> *without* systemd, without root, or where no operator user resolves: on such a
> host the step writes nothing, never fails the update, and prints these exact
> unit files plus the two `systemctl` commands so you can install it by hand.
> Re-running `switchroom update` once the timer exists is a byte-identical no-op.

## What the tick does (and does not do)

`ExecStart` runs `switchroom update --skip-images`:

- **Does** run `self-update-cli` — the checksum-verified, atomic host-binary
  swap (this flag does **not** skip self-update; only `--skip-self-update`
  does). This is the self-heal.
- **Does** reconcile the `hindsight-watch` cron and regenerate the per-agent
  scaffolds/compose (`apply-config`) — both idempotent.
- **Does NOT** pull GHCR images or refresh hostd/web on every tick
  (`--skip-images`), so each run is cheap and offline-safe apart from the
  GitHub release check the self-update performs.
- The final `docker compose up -d` is a **no-op when nothing changed** — it does
  not restart the fleet on a healthy tick.

Deliberate container rolls stay the operator's explicit, un-skipped
`switchroom update`. This unit's only job is keeping the **host binary** current.

## This timer does NOT heal an `npm i -g` install (#4571)

`self-update-cli` classifies the running CLI first and **returns early for
anything that is not a `static-binary`** (`src/cli/update.ts`, the
`detection.kind !== "static-binary"` branch). An `npm i -g switchroom` install —
including the common nvm-prefix one — is therefore *never* swapped by this
timer, no matter how often it ticks. It prints `host CLI not self-updated: …`
and moves on.

That is precisely how the reference host ended up on **0.20.16 while the fleet
ran 0.20.21**: the host CLI lived in the operator's nvm tree, self-heal skipped
it every tick, and the only other signal was a trailing rollout warning that
scrolled past.

Two mechanisms close it, and neither depends on anyone remembering to look:

1. **The host CLI stamps itself.** Every host-context CLI invocation refreshes
   `~/.switchroom/host-cli.json` with its version, install kind, npm prefix and
   the uid/user owning the install tree (idempotent — an unchanged stamp is not
   rewritten). That is the only path by which a container can observe the *host*
   binary, because hostd mounts `~/.switchroom` and nothing else.
2. **`switchroom rollout` refuses to roll past a stale host CLI.** The gate
   reads the stamp before any agent restarts and stops with the exact install
   command *derived from the stamp* — never a hardcoded `sudo npm i -g`, which
   is wrong on a user-owned prefix. `--allow-stale-host-cli` overrides it and
   says so loudly in the roll's warnings.

An npm-installed host CLI is upgraded with `npm i -g switchroom@<version>` **as
the user who owns the npm prefix**. Running that under `sudo` on a user-owned
nvm tree either installs into root's prefix (so the operator's `switchroom`
never moves) or leaves root-owned files in the operator's tree. `switchroom
doctor`'s `cli (host)` row prints the correct command for the install it
actually observed.

## The roll heals a static-binary host CLI itself (#4585)

The gate above is right to stop, but on the **agent path** it used to stop at a
dead end: `mcp__hostd__rollout(pin=…)` refused with `failedStep:
preflight-host-cli-stale` and named `switchroom update --pin vX.Y.Z` — a command
only a human at a host terminal could run. The roll could not be finished from
chat.

For a **`static-binary`** host CLI that remedy is entirely mechanical, so the
roll now performs it before refusing:

1. It reads the stamp, sees the host binary is behind, and spawns a **short-lived
   helper container** from the *running hostd image* (so a fork or GHCR mirror
   keeps working, and no multi-hundred-MB pull happens).
2. The helper is given **one bind mount — the host CLI's install prefix, rw —
   and nothing else**: no docker socket, no `~/.switchroom`, no config. It runs
   `switchroom host-cli-upgrade`, which is the same checksum-verified,
   prove-then-swap sequence `switchroom update` runs, pointed at the bind-mounted
   binary instead of its own. The outgoing binary is kept for rollback under
   `<bindir>/.switchroom-versions/`, and the whole tree it touched — the binary,
   the rollback store, `<prefix>/share` and every file in the extracted asset
   payload, however deeply nested — is chowned back to whoever owned the binary
   before the swap, so the non-root timer above keeps working on the next tick.
   That handoff runs on **every** exit path, including a failed download or a
   checksum mismatch: the helper is root, and a root-owned directory left inside
   an operator-owned bindir would `EACCES` the operator's own `switchroom update`
   from then on.
3. The roll then **re-probes the swapped binary** and only continues if it
   reports the target. It rewrites `~/.switchroom/host-cli.json` with the
   **proven** version — not the pin it asked for — because nothing has run that
   binary in host context, so no other code path would refresh the stamp. If that
   file cannot be written, the roll still continues on the proven version and
   says so; the next roll will simply re-observe the old record and heal again.

If any of that fails, the roll falls back to exactly the pre-existing refusal
with the helper's own diagnostic appended, having changed nothing else. The
prefix bind is refused outright for a path that is not a plain absolute
`…/<dir>/switchroom` (no traversal, and never the host root).

**Ordering:** the heal runs *after* every request-validation bail — the downgrade
guard, an unknown `--agents` name, an empty agent list — and before the first
fleet mutation. A roll that is going to exit 2 on a typo does not swap your host
binary on the way out.

**Scope:** `static-binary` only. An `npm i -g` install still refuses — replacing
one file is not the whole update for it — and the refusal now says plainly that
**an operator must run this on the host**, rather than addressing the caller as
though it could.

## Requirements

- **systemd** on the host.
- The service runs as the **operator** user whose `~/.switchroom` holds the
  fleet config — *not* root. `switchroom update` reads `$HOME/.switchroom` and
  the operator's compose; running it as root would read root's empty home.
- `self-update-cli` replaces the binary **in place** with an atomic
  `rename(2)` in the binary's own directory, so **that directory must be
  writable by the service user**. Two easy ways:
  - Install to a user-writable dir (`SWITCHROOM_INSTALL_DIR=$HOME/.local/bin`,
    the installer's fallback) and point `ExecStart` at it, **or**
  - keep it in `/usr/local/bin` and `sudo chown <operator> /usr/local/bin/switchroom`
    plus make the dir writable, **or** drop the binary in a dedicated
    operator-owned dir on `PATH`.

## The unit files

Replace `OPERATOR` with the operator username (e.g. the output of `id -un`) and
adjust the `switchroom` path if you did not install to `/usr/local/bin`.

### `/etc/systemd/system/switchroom-self-heal.service`

```ini
[Unit]
Description=Switchroom host CLI self-heal (re-run `switchroom update` so the host binary can't silently trail the fleet)
Documentation=https://github.com/switchroom/switchroom/blob/main/docs/operators/host-cli-self-heal.md
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
# Run as the operator whose ~/.switchroom holds the fleet config — NOT root.
User=OPERATOR
Environment=HOME=/home/OPERATOR
# --skip-images keeps each tick cheap: it still runs self-update-cli (the host
# binary swap) and reconciles the hindsight-watch cron, but does not pull GHCR
# images or touch running containers on a healthy tick.
ExecStart=/usr/local/bin/switchroom update --skip-images
# Self-heal must never wedge the host: bound the run, run at low priority, and
# do not retry-storm — the next tick will pick it up.
TimeoutStartSec=600
Nice=10
```

### `/etc/systemd/system/switchroom-self-heal.timer`

```ini
[Unit]
Description=Run the Switchroom host CLI self-heal every 30 minutes
Documentation=https://github.com/switchroom/switchroom/blob/main/docs/operators/host-cli-self-heal.md

[Timer]
# First run shortly after boot, then every 30 minutes. A behind host binary is
# corrected within one interval (the 12h drift incident could not recur).
OnBootSec=5min
OnUnitActiveSec=30min
# Jitter so a fleet of hosts does not hit the GitHub release API in lockstep.
RandomizedDelaySec=2min
# Fire a missed run (host was off) on next boot rather than waiting a full
# interval.
Persistent=true

[Install]
WantedBy=timers.target
```

> **Cadence.** 30 minutes bounds worst-case host-binary drift to one interval
> while keeping the GitHub release round-trip infrequent. Hourly (`OnUnitActiveSec=1h`)
> is a fine, lighter alternative; anything much longer re-opens the multi-hour
> drift window this unit exists to close.

## Install and enable (manual fallback)

> You only need this on a host where `switchroom update` **could not** install
> the timer itself (no systemd, no root, or no resolvable operator user). On a
> normal systemd host the `install-self-heal-timer` step already did all of this.

```bash
# 1. Drop the two unit files in place (edit OPERATOR / the binary path first).
sudo install -m 0644 switchroom-self-heal.service /etc/systemd/system/
sudo install -m 0644 switchroom-self-heal.timer   /etc/systemd/system/

# 2. Reload systemd and enable the timer (starts it now + on every boot).
sudo systemctl daemon-reload
sudo systemctl enable --now switchroom-self-heal.timer

# 3. Verify it is scheduled and that a manual run is clean.
systemctl list-timers switchroom-self-heal.timer
sudo systemctl start switchroom-self-heal.service   # run once, now
journalctl -u switchroom-self-heal.service -n 50 --no-pager
```

## Verify it is working

- `systemctl list-timers switchroom-self-heal.timer` shows a `NEXT` fire time.
- After a tick, `switchroom doctor` shows the `component versions` section
  **green** for `cli (host)` (it FAILs while the host binary is behind).
- `journalctl -u switchroom-self-heal.service` shows either
  `host CLI already on vX.Y.Z` (healthy no-op) or the self-update swap message.

## Disable

```bash
sudo systemctl disable --now switchroom-self-heal.timer
sudo rm /etc/systemd/system/switchroom-self-heal.{service,timer}
sudo systemctl daemon-reload
```

## Where the auto-install lives (and why not `install.sh`)

The auto-install is a step in **`switchroom update`** (`install-self-heal-timer`,
right after the `hindsight-watch` cron reconcile), **not** in `install.sh`.

`install.sh` is a `curl | sh` one-shot that must work on hosts **without**
systemd or root (it falls back to `~/.local/bin`), and it cannot know the
operator username — so arming a system-wide timer from it would fail or surprise
those hosts. `switchroom update` is the right seam: it already self-elevates,
already resolves the operator, and is the host-context path that converges the
rest of the host. The step is guarded (systemd-booted **and** root **and** a
non-root operator user) and degrades to the manual fallback above on any host
that fails a guard, so it is safe to run unconditionally. It is deferred in
hostd-context because `/etc/systemd/system` lives on the host, not inside the
hostd container.
