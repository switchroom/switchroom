# tmux supervisor fanout runbook (#725)

This is the operational playbook for flipping
`experimental.tmux_supervisor: true` on a single agent at a time. It
captures everything you need to know to canary the flag safely,
including a known cosmetic gotcha that has already been patched but is
worth understanding when reading older boot cards.

## What the flag does

Without the flag (legacy default), the agent's systemd unit launches:

```
ExecStart=/usr/bin/script -qfc "/bin/bash -l <agentDir>/start.sh" service.log
```

`script -qfc` allocates a PTY so `expect`-based autoaccept can drive
the prompt, and pipes everything to `service.log`. It works, but the
PTY layer detaches claude from the unit cgroup and `tmux send-keys`
cannot reach the live REPL — so injecting Claude Code slash commands
from outside the agent (`/cost`, `/status`, etc.) is impossible.

With the flag, the unit becomes:

```
[Service]
Type=forking
Delegate=yes
ExecStart=/usr/bin/tmux -L switchroom-<name> -f <agentDir>/tmux.conf \
          new-session -A -d -s <name> -x 400 -y 50 \
          'bash -l <agentDir>/start.sh'
ExecStartPost=/usr/bin/tmux -L switchroom-<name> pipe-pane -o -t <name> \
              'cat >> service.log'
ExecStop=-/usr/bin/tmux -L switchroom-<name> kill-session -t <name>
```

Claude now runs inside a per-agent tmux session on a per-agent socket
(`switchroom-<name>`). `pipe-pane` mirrors the pane to `service.log`
so existing log consumers (pty-tail, journald followers) keep working.
External slash-command injection works via `tmux send-keys`.

## Per-agent ordering (recommended canary plan)

Stage one agent per day. Confirm the previous flip is healthy before
moving on. **Klanker last** — that's the agent the operator may be
actively talking to and you don't want a flip-day surprise mid-thread.

Recommended order (gymbro is already on it):

1. clerk
2. finn
3. lawgpt
4. ziggy
5. carrie
6. reggie
7. klanker

## Flip procedure for a single agent

```bash
# 1. Edit switchroom.yaml — add the flag under the agent's entry:
#    agents:
#      <name>:
#        experimental:
#          tmux_supervisor: true

# 2. Re-render the systemd unit + tmux.conf
switchroom systemd install

# 3. IMPORTANT — restart immediately after install. Between `install`
#    and `restart` the unit on disk doesn't match the running process;
#    leaving the gap open invites a config-mismatch incident.
systemctl --user restart switchroom-<name>.service
```

The agent unit is now the tmux ExecStart; the gateway unit picks up
`Environment=SWITCHROOM_TMUX_SUPERVISOR=1` so its boot card shows the
real claude PID instead of the tmux server PID (cosmetic note below).

## Sanity checks after flip

```bash
# Unit cgroup contains tmux + claude (and bash/expect wrappers)
systemd-cgls --user-unit switchroom-<name>.service

# tmux session is live on the per-agent socket
tmux -L switchroom-<name> ls
# expect: <name>: 1 windows (created ...) [400x50]

# Boot card PID — should be a hundreds-of-MB claude pid, NOT the
# tmux server (~2MB). If it shows as ~2MB, see "MainPID gotcha" below.
systemctl --user show switchroom-<name>.service \
  -p MainPID,MemoryCurrent,ControlGroup
```

You can also drop into the live REPL to confirm:

```bash
switchroom agent attach <name>      # uses tmux attach when flag is on
# Detach with C-b d (the default tmux prefix) — do NOT C-c.
```

## Rollback

If anything looks wrong, flip the flag back:

```bash
# 1. Edit switchroom.yaml — remove (or set false) experimental.tmux_supervisor
# 2. Re-render and restart in one go:
switchroom systemd install
systemctl --user restart switchroom-<name>.service
```

The legacy `script -qfc` ExecStart is restored; existing log/tail
consumers continue to work because pipe-pane was writing to the same
`service.log` path.

## Migration interregnum — the dash on ExecStop

The first restart that flips an agent from legacy → tmux runs
`ExecStop` against the OLD unit which has no tmux socket. Without the
leading `-` on `ExecStop=-/usr/bin/tmux ... kill-session`, that
non-zero exit would mark the unit as `failed` and trigger
`Restart=on-failure` chaos. The dash silences that one-shot transition;
in steady state `kill-session` against a real session succeeds and the
dash is a no-op.

Implication: do NOT remove the dash on ExecStop in any future template
edit. The systemd-restart test suite asserts the dash is present
(`tests/systemd-restart.test.ts`).

## MainPID gotcha (patched, but historical)

Under `Type=forking`, systemd records `MainPID` as the leader of the
forked process group — which is the tmux server (~2MB RSS), not
claude (hundreds of MB). Surfaces that displayed `MainPID` directly
showed the tmux PID with a misleading 2MB memory line.

Fixed in this same PR: `getAgentStatus` and the gateway boot card
probes (`probeAgentProcess`, `watchAgentProcess`) walk the unit's
cgroup and pick the heaviest-RSS claude/node process when the flag is
on. The cgroup walk mirrors `agent_main_pid()` in
`bin/bridge-watchdog.sh:187-208`.

If you see a boot card with a tiny memory number on a tmux-supervised
agent, that's the un-patched display path and worth filing — every
known surface should now resolve correctly.

## Known-good signs

- `systemd-cgls` shows tmux + bash + claude under the unit cgroup
- `tmux -L switchroom-<name> ls` returns the session within ~2s of restart
- Boot card shows `PID <claude-pid> · up <duration> · <hundreds-of-MB>`
- `switchroom agent attach <name>` drops into the live REPL
- `switchroom agent inject <name> /cost` reaches Claude Code (Phase 2)

## Linked

- Epic #725 — tmux supervisor
- #728 — argv-ordering bug for `tmux send-keys` (caught after #727 merged)
- This doc lives at `docs/tmux-supervisor-fanout.md`; the epic README
  / CHANGELOG entry should link here.
