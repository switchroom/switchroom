# Rollback to legacy PTY supervisor (#725 PR-1)

As of #725 PR-1, the tmux supervisor is the default for all agents.
This doc is the operational runbook for the rare case where you need
to roll an individual agent back to the historical `script -qfc`
PTY-wrapped supervisor — typically because:

- The host doesn't have `tmux` installed or cannot run it.
- A regression on the tmux path breaks a specific agent and you need a
  same-day workaround while the fix lands.
- You're A/B-comparing supervisor behaviour during stabilisation.

## How to opt out

Add a single per-agent flag to `switchroom.yaml`:

```yaml
agents:
  myagent:
    profile: default
    experimental:
      legacy_pty: true   # opt OUT of the tmux supervisor (default false)
```

Then reconcile + restart that one agent:

```bash
switchroom systemd reconcile myagent
switchroom agent restart myagent
```

The unit re-renders with the legacy `ExecStart=/usr/bin/script -qfc …`
shape and `Type=simple`, and the gateway unit drops
`Environment=SWITCHROOM_TMUX_SUPERVISOR=1`. Boot cards / probes /
inject all degrade gracefully (inject is refused with a clear error
pointing at the flag).

## Behaviour differences under `legacy_pty: true`

- `switchroom agent attach` runs `tail -f service.log` instead of
  `tmux attach` — read-only log view, no live REPL.
- `switchroom agent send` and the `/inject` Telegram command refuse
  with a hint to remove the flag.
- The unit's `KillMode=control-group` still cleans up correctly; the
  cgroup-kill fix from #361 is independent of supervisor choice.
- `service.log` contains the raw `script -qfc` output (bytes-on-the-
  wire same as pre-#725).

## Migrating from the deprecated `tmux_supervisor` key

If you have legacy configs with `experimental.tmux_supervisor: true`
or `experimental.tmux_supervisor: false`, the schema shim normalises
them at parse time and emits a one-time stderr warning:

| Old (`tmux_supervisor`) | New (`legacy_pty`) |
|-------------------------|--------------------|
| `true`                  | omit (default) or `false` |
| `false`                 | `true`             |
| (unset)                 | (unset, default)   |

The compatibility shim will be removed in the next minor release —
update configs at your convenience but don't leave it forever.

## How to verify which supervisor an agent is on

```bash
systemctl --user cat switchroom-<name>.service | grep ^ExecStart=
# default:  ExecStart=/usr/bin/tmux -L switchroom-<name> ...
# legacy:   ExecStart=/usr/bin/script -qfc ...
```

Or check the unit type:

```bash
systemctl --user show switchroom-<name>.service -p Type
# default:  Type=forking
# legacy:   Type=simple
```
