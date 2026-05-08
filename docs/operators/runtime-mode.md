# Runtime mode — Docker vs systemd

Switchroom can run its agent fleet in one of two runtimes:

- **Docker** — each agent runs in its own container, brought up by a
  generated `docker-compose.yml`. This is the default on Linux as of
  Phase 3b-3.
- **systemd** (legacy) — each agent runs as a `switchroom-<name>` user
  unit on the host. This is what every Switchroom install used before
  Phase 3b and remains supported.

The active runtime is recorded in `~/.switchroom/runtime-mode`, which
contains a single line: `docker` or `host`.

## How `switchroom up` chooses

`switchroom up` looks at four inputs and picks one of the two
runtimes:

| Platform | Marker        | Systemd installed? | Flag        | Runtime | Marker after |
| -------- | ------------- | ------------------ | ----------- | ------- | ------------ |
| Linux    | _absent_      | no                 | _none_      | docker  | `docker`     |
| Linux    | _absent_      | yes                | _none_      | host*   | _unchanged_  |
| Linux    | _absent_      | any                | `--legacy`  | host    | `host`       |
| Linux    | `docker`      | any                | _ignored_   | docker  | _unchanged_  |
| Linux    | `host`        | any                | _ignored_   | host    | _unchanged_  |
| non-Linux| any           | any                | any         | host    | _unchanged_  |

*The "Linux + systemd installed + no flag" row also prints a one-time
advisory:

```
You're on the legacy systemd runtime.
Run `switchroom migrate to-docker` to move to the Docker runtime,
or `switchroom up --legacy` to silence this notice.
```

The advisory keeps firing on every `up` until the operator either
migrates or explicitly opts in with `--legacy` (which writes
`runtime-mode = host` and silences future advisories).

## Choosing a runtime

Pick **Docker** if:

- You're on a fresh Linux host and don't have a strong reason
  otherwise.
- You want hard-isolated agents — each in its own container with its
  own UID, no shared sockets across agents.
- You want easier upgrades (`docker compose pull && switchroom up`
  vs systemd unit reconciliation).

Pick **systemd** if:

- You're already running on systemd and not ready to migrate.
- You're on a host without Docker and don't want to install it.
- Your environment forbids container runtimes (compliance,
  policy).

## Migrating between runtimes

Use `switchroom migrate to-docker` (Phase 3b-2) to move from systemd to
Docker. It runs preflight checks, generates compose, brings the docker
fleet up, stops + disables the systemd units, and writes
`runtime-mode = docker`. On any failure it rolls back automatically and
leaves you on the original runtime.

`switchroom migrate to-host` reverses the above.

## The `--legacy` opt-out

`switchroom up --legacy` forces the systemd path even on a fresh Linux
host where Docker would otherwise be the default. Use it when:

- You're scripting an install on a host where Docker isn't available.
- You see the legacy advisory but explicitly want to keep using
  systemd for the foreseeable future — `--legacy` writes the marker so
  the advisory stops firing.

`--legacy` is Linux-only (other platforms always use the systemd path
today; macOS Docker support is Phase 3d).

## Doctor: runtime-coexistence check

`switchroom doctor` includes a `runtime coexistence` check (Phase
3b-3) that warns when the marker says one runtime but the host still
has the other one's state in place — e.g. `runtime-mode = docker` but
`switchroom-*` systemd units are still enabled.

This is **a warning, not a failure**. Coexistence is legitimate during
a migration window — operators bring the new runtime up before tearing
the old one down. If the warning persists after migration:

- **`runtime-mode = docker` + systemd units enabled** → run
  `systemctl --user disable --now 'switchroom-*'` to clear the
  legacy state. (Or re-run `switchroom migrate to-docker` so the
  finalize step takes care of it.)
- **marker absent + systemd units enabled** → run
  `switchroom up --legacy` to pin the marker and silence the
  ambiguity, or run `switchroom migrate to-docker` to flip.

## Supervision

The Docker runtime is supervised by the **fleet watchdog** — a small
host-side process that subscribes to `docker events` and restarts
fleet containers (`agent`, `broker`, `kernel`, `scheduler`) that exit
unexpectedly. It complements `restart: unless-stopped` by adding rate
limiting, escalation after repeated failures, and a pause sentinel
that lets `switchroom migrate` safely stop containers without the
watchdog fighting the migration.

### Starting the watchdog

The watchdog ships as a user systemd unit installed alongside the
Docker runtime:

```
systemctl --user enable --now switchroom-watchdog.service
```

Verify it's running:

```
systemctl --user status switchroom-watchdog.service
```

### Logs

The watchdog tags every audit event with a stable journald identifier
so you can grep its history without trawling all of systemd:

```
# All watchdog audit events, last hour
journalctl --user -t switchroom-watchdog --since "1 hour ago"

# Per-role tags for the supervised containers themselves
journalctl --user -t switchroom-agent-<name>
journalctl --user -t switchroom-broker
journalctl --user -t switchroom-kernel
journalctl --user -t switchroom-scheduler
```

### Audit events

| Event                      | Meaning                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `restart-attempt`          | Watchdog observed a `die` event for a fleet container and is calling `docker start <name>`.          |
| `restart-skipped-paused`   | A restart was due but the pause sentinel is present (a migration is in progress) — no action taken.  |
| `restart-skipped-escalated`| The container has already exceeded the restart budget within the rolling window. See escalation.    |
| `escalated`                | Container hit `maxRestarts` within `windowMs` — watchdog gives up and stops attempting restarts.     |
| `health-fail`              | Periodic health-poll observed an unhealthy container; counts toward the restart budget.              |
| `pause`                    | Pause sentinel appeared (`~/.switchroom/watchdog.paused`). All restart actions suppressed.           |
| `resume`                   | Pause sentinel was removed. Normal restart behaviour resumes.                                        |
| `watchdog-start`           | Process booted; subscribed to `docker events`.                                                       |
| `watchdog-stop`            | Process is shutting down (SIGTERM / disable).                                                        |

### How `switchroom migrate` interacts with the watchdog

`switchroom migrate to-docker` and `to-host` both bracket their
docker-touching steps with `watchdog-pause` and `watchdog-resume`:

1. **Pause** is the first executor step. It writes
   `~/.switchroom/watchdog.paused` with `paused-by=migrate`. From this
   moment any `docker stop` or `docker compose down` performed by the
   migration will NOT trigger a restart attempt — the watchdog sees
   the sentinel and emits `restart-skipped-paused` instead.
2. **The migration runs** — systemd stop/disable, compose
   generate/up (or compose-down + systemd start on the reverse leg),
   marker write.
3. **Resume** is the last executor step. The sentinel file is removed
   and the watchdog returns to normal supervision.

If the migration fails midway, the executor's rollback path also
removes the sentinel — you should never end up with a stuck pause.
If you suspect you have (e.g. crash during migrate), check:

```
ls -la ~/.switchroom/watchdog.paused
```

If the file is older than your most recent `switchroom migrate`
invocation, it's safe to delete:

```
rm ~/.switchroom/watchdog.paused
```

The watchdog re-checks the sentinel on every action, so deletion
takes effect immediately — no restart needed.

### Disabling supervision

If you want to operate the Docker runtime without the watchdog
(e.g. you're running an external supervisor):

```
systemctl --user disable --now switchroom-watchdog.service
```

The fleet containers will still restart on their own (`restart:
unless-stopped`), but you lose rate-limited escalation, health-poll,
and the `migrate` pause integration.
