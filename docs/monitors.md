# Host monitors

Three small host tools watch the agents from outside their containers:

| Tool | Watches | Default action |
| --- | --- | --- |
| `scripts/switchroom-ownership-audit.py` | owner and permissions of each agent's directories | report |
| `scripts/switchroom-memory-alert.py` | sustained host memory pressure, container task limits | report |
| `scripts/switchroom-storage-monitor.py` | disk use per agent and of the filesystems under them | report |

All three are **off by default** and **report-only**. Nothing in the image or
the starter overlay runs them: you install them on the Docker host, copy the
example config, set `"enabled": true` for the ones you want, and enable a timer
or a cron line. None of them restarts, kills, deletes or reconfigures anything.
The ownership audit has one opt-in repair command, described below, that only
touches paths an audit report lists.

They need only the host's `python3` (3.11 or newer, standard library). They
read agent volumes owned by the container user, so they usually run as root.

**Status:** proven by unit tests on synthetic directories
(`tests/test_ops_kit_monitors.py`). Not yet run on a real fleet host.

## Config

One JSON file for all three, for example `/etc/switchroom/monitors.json`.
Start from [`examples/overlay-repo/ops-kit/monitors.json`](../examples/overlay-repo/ops-kit/monitors.json),
which ships with every monitor disabled and paths for the starter overlay's
named volumes.

```json
{
  "agents": {
    "ops": {"roots": {"state": "/var/lib/docker/volumes/my-fleet_ops-state/_data",
                      "workspace": "/var/lib/docker/volumes/my-fleet_ops-workspace/_data"}}
  },
  "alert": {"sink": "stdout"},
  "ownership": {"enabled": false},
  "memory": {"enabled": false},
  "storage": {"enabled": false}
}
```

`agents` lists each agent and its directories on the host. A label (`state`,
`workspace`) is just a name; each path must be absolute. Each monitor reads its
own section, and a disabled monitor exits `3` without doing anything, so a
timer enabled before the config is ready is visible rather than silent.

## Where alerts go

`alert.sink` is `stdout` (the default) or `webhook`. There is no built-in chat
service and no chat ID anywhere in the code.

- **stdout**: one line per alert, prefixed with the tool name. The systemd
  journal or cron mail picks it up; point `OnFailure=` or your log shipper at it.
- **webhook**: one JSON POST per alert to the URL in the environment variable
  named by `alert.url_env` (default `SWITCHROOM_ALERT_WEBHOOK_URL`). The URL
  never sits in the config, a report or a log line, because incoming-webhook
  URLs are credentials. It must be `https://` unless `"allow_http": true`.
  Redirects are not followed. The body is
  `{"text": "...", "source": "switchroom-memory-alert", "kind": "memory", "host": "..."}`;
  most incoming webhooks read `text`. For anything else, run a small relay.

`--sink stdout` on the command line overrides the config, which is handy for a
first manual run.

## Ownership audit

Agents in the Fleet image run as one container user, UID/GID `1000` by
default. A file left by a root shell, a host-side tool or a restore with the
wrong owner can stop an agent writing its own state, and a private file that
other users can read is a leak.

```bash
sudo python3 -I /opt/switchroom/scripts/switchroom-ownership-audit.py audit \
  --config /etc/switchroom/monitors.json \
  --report /var/lib/switchroom-monitors/ownership/latest.json
```

`audit` walks every root of every agent (or `--agent NAME`), never follows a
symlink and never crosses into another filesystem. It lists:

- **owner**: any path whose owner is not `ownership.uid:ownership.gid`
  (symlinks are checked as links);
- **mode**: any file in `ownership.private_files` (paths relative to a root,
  default `.env` and `auth.json`) that group or other users can read.

It changes nothing. It prints a short JSON summary, writes the full report
(`0600`) to `--report`, sends one alert when it finds anything, and exits `1`
on findings, `0` when clean. A root that is missing or only partly readable
makes the result `incomplete` (exit `1`), never `clean`.

### Repair (opt-in)

```bash
# Dry run: lists what it would change, changes nothing.
sudo python3 -I /opt/switchroom/scripts/switchroom-ownership-audit.py repair \
  --config /etc/switchroom/monitors.json \
  --report /var/lib/switchroom-monitors/ownership/latest.json

# Apply.
sudo python3 -I /opt/switchroom/scripts/switchroom-ownership-audit.py repair \
  --config /etc/switchroom/monitors.json \
  --report /var/lib/switchroom-monitors/ownership/latest.json --apply
```

Repair acts only on the paths that report enumerates. For each one it:

1. requires the agent and root to still be in the config, with the same
   UID/GID, and the path to be a plain relative path inside that root;
2. reaches it one directory at a time without following any symlink;
3. checks it is still the same inode, unchanged since the audit (device,
   inode and change time); anything else is skipped as "replaced";
4. changes the owner without following a symlink (`lchown`), or, for a
   private file, removes group and other permission bits from that regular file.

A file that appeared after the audit is never touched: run the audit again.
The example timer and cron entries only ever run `audit`.

## Memory pressure alert

Run `check` every minute. It samples `/proc/meminfo` and memory pressure
(PSI) and alerts once the host has been under real pressure for
`sustain_seconds` (default 5 minutes):

| Setting | Default | Meaning |
| --- | --- | --- |
| `low_available_bytes` | 4 GiB | `MemAvailable` below this is pressure |
| `psi_full_avg60` | 5.0 | PSI `full avg60` at or above this is pressure |
| `psi_some_avg60` | 20.0 | PSI `some avg60` at or above this is pressure |
| `sustain_seconds` | 300 | how long pressure must last before an alert |
| `repeat_seconds` | 21600 | at most one repeat alert per this period |
| `pids_warn_ratio` | 0.8 | alert when a container passes this share of `pids.max` |
| `top_users` | 5 | how many top memory users the alert names |
| `state_dir` | `/var/lib/switchroom-monitors/memory` | small state files (`0600`) |

Swap use alone never alerts. One good sample resets the clock, so short spikes
stay silent. After an alert it sends one "recovered" note when pressure clears.
The alert names the biggest Docker containers and login sessions by memory
from the cgroup tree.

The same run compares each container's `pids.current` with `pids.max` and
alerts once per episode when it passes `pids_warn_ratio`, and whenever the
kernel refuses a new task (`pids.events` `max` grows). A failed delivery is
retried on the next run and exits `1`.

`status` prints the current sample and reasons without alerting or writing
state.

## Storage monitor

Run `check` daily. For each agent it counts its roots, each file once even
when hard-linked, never following a symlink or crossing a mount, and splits
out `cache_paths` (paths relative to a root label, for example
`{"state": [".cache", "home/.cache"]}`) so rebuildable caches do not hide real
growth.

| Setting | Default | Warns when |
| --- | --- | --- |
| `filesystem_warn_used_percent` | 85 | a filesystem under an agent root is this full |
| `filesystem_warn_available_bytes` | 20 GiB | it has less than this free |
| `agent_warn_bytes` | 10 GiB | an agent's persistent data (not caches) reaches this |
| `agent_warn_overrides` | `{}` | per-agent `agent_warn_bytes` |
| `cache_warn_bytes` | 2 GiB | an agent's caches reach this |
| `scan_timeout_seconds` | 600 | the whole scan stops (and reports `timeout`) after this |
| `dormant_agents` | `[]` | agents that are stopped on purpose; not scanned |

All warnings go out as one message. The full JSON report goes to stdout and to
`--report`. Exit `0` means the scan completed, with or without warnings; `1`
means a root was missing, unreadable or timed out, or delivery failed.

## Install (host, root)

```bash
sudo install -d -m 0755 /opt/switchroom/scripts
sudo install -m 0644 scripts/switchroom_alerts.py /opt/switchroom/scripts/
sudo install -m 0755 scripts/switchroom-ownership-audit.py scripts/switchroom-memory-alert.py \
  scripts/switchroom-storage-monitor.py /opt/switchroom/scripts/
sudo install -d -m 0700 /etc/switchroom /var/lib/switchroom-monitors
sudo install -m 0600 examples/overlay-repo/ops-kit/monitors.json /etc/switchroom/monitors.json
# Edit agents and paths, choose the sink, then set "enabled": true per monitor.
sudo python3 -I /opt/switchroom/scripts/switchroom-memory-alert.py status --config /etc/switchroom/monitors.json
sudo python3 -I /opt/switchroom/scripts/switchroom-storage-monitor.py check --config /etc/switchroom/monitors.json --sink stdout
```

`switchroom_alerts.py` must sit next to the three scripts; they load it from
their own directory, which works with `python3 -I`.

Example units are in [`examples/overlay-repo/ops-kit/systemd/`](../examples/overlay-repo/ops-kit/systemd/):

```bash
sudo install -m 0644 examples/overlay-repo/ops-kit/systemd/switchroom-*.service \
  examples/overlay-repo/ops-kit/systemd/switchroom-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now switchroom-memory-alert.timer       # every minute
sudo systemctl enable --now switchroom-ownership-audit.timer    # daily, audit only
sudo systemctl enable --now switchroom-storage-monitor.timer    # daily
```

For a webhook sink, put `SWITCHROOM_ALERT_WEBHOOK_URL=...` in a root-only
`/etc/switchroom/monitors.env` and uncomment `EnvironmentFile=` in the units.
Without systemd, use [`examples/overlay-repo/ops-kit/crontab.example`](../examples/overlay-repo/ops-kit/crontab.example).

## What they do not do

- They do not fix anything, except ownership repair when you run it with `--apply`.
- They do not judge whether an agent works; that is the gateway's health check.
- They do not watch other hosts, or the agents' own view from inside the container.
- The memory alert does not account for cgroup v1 hosts beyond `MemAvailable` and PSI.
