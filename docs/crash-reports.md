# Crash reports

When the watchdog (`bin/bridge-watchdog.sh`) decides to kill an agent
because it looks wedged — bridge stale, turn-active marker stuck,
journal silent past the hard threshold — it first snapshots the
agent's tmux pane scrollback to a crash-report file. RCA tooling can
then see what was on screen at the moment of the kill, which is
usually the single most useful artefact for diagnosing why the agent
hung.

## Where they land

```
~/.switchroom/agents/<agent>/crash-reports/<ISO8601>-<reason>.txt
```

- `ISO8601` is UTC, with colons replaced by dashes for filesystem
  safety. Example: `2026-05-06T01-59-37Z`.
- `<reason>` is a short slug describing the watchdog trigger:
  `bridge-disconnect`, `turn-hang`, `journal-silence`.

The file starts with a small header:

```
# agent: klanker
# reason: turn-hang
# captured-at: 2026-05-06T01-59-37Z
# tmux-socket: switchroom-klanker

<raw pane bytes follow>
```

## Retention & size

- 20 most recent `.txt` files are kept per agent; older files are
  pruned on every capture.
- Each file is capped at 10 MB. tmux's `history-limit` is 100k lines
  per `writeAgentTmuxConf`; ANSI-heavy panes can spike beyond that,
  so the cap is enforced at write time. The newest bytes (tail of
  the scrollback) are preserved if truncation occurs.

## Viewing one

```bash
ls -1t ~/.switchroom/agents/klanker/crash-reports/ | head
less ~/.switchroom/agents/klanker/crash-reports/2026-05-06T01-59-37Z-turn-hang.txt
```

`less -R` if you want ANSI colour codes interpreted.

## What's NOT captured

- Operator-initiated restarts (`switchroom agent restart <agent>`)
  do not produce crash reports — those aren't crashes, just a clean
  stop. Capturing them would just litter the directory.
- Service-inactive heals (the watchdog `systemctl start` path for
  cleanly-exited units) skip capture; by the time the heal fires the
  tmux session has usually already gone away with the unit.
- Agents running with `experimental.legacy_pty: true` (no tmux) —
  the capture is a no-op `error` since there's no tmux socket. The
  watchdog logs the error to its journal trail but proceeds with the
  restart.

## Two implementations, one stream

Both `bin/bridge-watchdog.sh` (bash, hot path) and
`src/agents/tmux.ts` (TypeScript, used by lifecycle/crash-detection
code paths) write to the same directory using the same naming
scheme and header format. RCA tooling reads from one stream
regardless of which path produced the file. If you change one
implementation, change the other.

## Disabling

There's no env knob today. To disable, comment out the
`capture_pane_before_restart` calls in `bridge-watchdog.sh` — the
function itself is best-effort and never blocks the restart, so
leaving it on costs nothing for healthy agents (the file write only
fires on actual restart events, which are rare on a healthy host).
