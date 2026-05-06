#!/usr/bin/env bash
# Watchdog: restarts switchroom agent services whose Telegram bridge has
# disconnected from the gateway, OR whose journal output has been silent
# for too long (indicating an internally-frozen agent that systemd still
# reports as "active (running)"). Designed to run on a systemd timer.
#
# For each agent, checks whether the gateway is up and has an active bridge.
# If the gateway is healthy but the bridge is disconnected (or never connected),
# restarts the agent service so Claude Code gets a fresh MCP server.
#
# Journal-silence check (2026-04-26, issue #116): Three klanker hangs in
# 10 hours exposed a class of failure where the agent process is
# "active (running)" to systemd but internally frozen — no journal output
# for many minutes, manual restart the only recovery. Two hangs were on the
# Stop-hook ladder ("running stop hooks 0/N"); one was mid-task at 1.0 GB
# RSS. The watchdog now also checks journal-output freshness per-agent and
# restarts via `switchroom agent restart <agent>` when an agent has been
# silent for JOURNAL_SILENCE_SECS (default 600s) and has cleared the uptime
# grace. Sustained suspicion via a state file under
# /run/user/<uid>/switchroom-watchdog/ prevents transient quiet from
# triggering.
#
# Agent discovery: enumerates ALL active switchroom-*-gateway.service units
# and derives the agent name + gateway-log path from each. This replaces the
# previous hardcoded (agent, log) list which rotted any time an agent was
# renamed or added — e.g. on 2026-04-21 the old list still held "assistant"
# (since renamed to "clerk") and silently skipped the new "lawgpt" agent
# entirely, leaving both in a stale-bridge state for hours while klanker
# (still on the list) kept getting healed.
#
# False-restart fix (2026-04-22): the bridge IPC flaps `registered ↔
# disconnected` rapidly across Claude Code turn boundaries. The old
# `tail -1` heuristic caught transient disconnect states and restarted
# otherwise-healthy agents. On 2026-04-21 20:12–20:26 AEST this produced
# 3 spurious restarts of klanker mid-CPU-heavy-work. The watchdog now
# requires SUSTAINED disconnection (>= DISCONNECT_GRACE_SECS across
# consecutive ticks) and an uptime grace (>= UPTIME_GRACE_SECS since
# the agent service started) before acting.

set -euo pipefail

# Tunables. Expressed as env-overridable so the test harness can drive
# edge cases without mutating the script.
: "${UPTIME_GRACE_SECS:=90}"              # skip checks for this long after agent (re)start
: "${DISCONNECT_GRACE_SECS:=600}"         # require disconnection to persist this long before restarting
: "${LIVENESS_GRACE_SECS:=30}"            # liveness file mtime must be recent before we treat bridge as dead
# Journal-silence thresholds. Defaults raised from 600s to 4000s on
# 2026-04-30 (issue #405). The previous 600s default opened a trap zone
# where any agent whose latest journal entry sat between
# JOURNAL_SILENCE_SECS (600s) and RECENT_ACTIVITY_WINDOW_SECS (3600s)
# was eligible for restart. Normal chat-cadence agents (10–60 min between
# user messages) land in that zone every cycle, producing ~208 false
# restarts/24h on a typical host. With both defaults at 4000s (> the
# 3600s recent-activity window), the trap zone closes: by the time
# silence reaches 4000s, the latest entry is already past the
# recent-activity gate and gets treated as idle. The hang detector is
# effectively inert under defaults — operators who want it active must
# opt in by lowering these values via env, and `Restart=on-failure` in
# the unit file still catches actual crashes. See issue #405 for the
# worked example showing the 21.5-min restart cadence the trap zone
# produced.
: "${JOURNAL_SILENCE_SECS:=4000}"          # seconds of journal silence before suspecting a hang
: "${JOURNAL_SILENCE_HARD_SECS:=4000}"     # seconds the silence_since marker must predate before restarting
# Recent-activity gate: only treat journal-silence as suspect-hang when the
# agent had ANY log activity within this window. Distinguishes "hung mid-task"
# (last log moments ago, then silence) from "genuinely idle" (no logs in
# hours/days — agent waiting for the next user message). Default 1h: long
# enough to span a normal session but short enough that a long overnight idle
# doesn't get falsely flagged.
: "${RECENT_ACTIVITY_WINDOW_SECS:=3600}"
# Turn-active marker check (issue #412): the gateway writes a per-agent
# `turn-active.json` at turn-start, touches its mtime on every tool_use,
# and removes it on turn_complete. If the file exists AND its mtime
# hasn't advanced in TURN_HANG_SECS, the agent is wedged mid-turn —
# distinguishable from "legitimately idle" because legitimate idle
# leaves no marker file at all. Default 5 min: bigger than the slowest
# legitimate single-tool turn (a long Bash compile maybe) but tight
# enough to catch Stop-hook deadlocks before the user notices.
: "${TURN_HANG_SECS:=300}"
# Forward-progress liveness window. The gateway only bumps
# `turn-active.json` mtime on PARENT-stream tool_use events; when the
# parent dispatches a Task() to a sub-agent, the marker goes stale
# even while real work is happening. The bridge can also flap
# (transient socket close, MCP plugin restart) while a sub-agent
# keeps working. Before any restart path acts, probe the agent's
# `.claude/projects/**/*.jsonl` AND `.claude/tasks/**/*.json` files:
# if EITHER was modified within JSONL_LIVENESS_SECS, the agent is
# making forward progress and the restart is a false positive.
#
# Two independent fingerprints means a wedged agent has to be silent
# on BOTH to be killed — much stronger evidence than a single signal.
# 60s matches the in-flight detector's "recent" semantics in
# src/agents/in-flight.ts (30s window + 60s tick spread).
#
# (Name kept as JSONL_LIVENESS_SECS for back-compat with operators
# who already set it via env; the value gates both fingerprints.)
: "${JSONL_LIVENESS_SECS:=60}"

# Per-agent watchdog state lives under /run/user/$UID/switchroom-watchdog/
# (tmpfs, cleared on logout — correct: we don't want stale silence markers
# surviving restarts). mkdir -p is idempotent.
# WATCHDOG_STATE_DIR is env-overridable for the test harness.
UID_VAL="${UID:-$(id -u)}"
: "${WATCHDOG_STATE_DIR:=/run/user/${UID_VAL}/switchroom-watchdog}"
mkdir -p "$WATCHDOG_STATE_DIR" 2>/dev/null || true

now_epoch() { date +%s; }

# Unified logging — every decision goes to journalctl with the
# `switchroom-watchdog` tag AND to the unit's own stdout (which is
# also captured by journal via StandardOutput=journal). Use level tags
# (`detect`, `restart`, `skip`, `error`) so `journalctl -t
# switchroom-watchdog | grep '\[restart\]'` is a clean audit trail of
# every action this watchdog took.
wd_log() {
  local level="$1"
  shift
  local msg="$*"
  logger -t switchroom-watchdog "[$level] $msg" 2>/dev/null || true
  # Stdout (not stderr) matches the prior `echo` lines so existing
  # systemd journal capture (StandardOutput=journal) and the test
  # harness that reads stdout from execFileSync both see the line.
  echo "$(date -Iseconds) watchdog [$level] $msg"
}

# Returns 0 (true) iff the agent shows ANY of two independent
# forward-progress fingerprints within the last `$2` seconds:
#
#   1. `.claude/projects/**/*.jsonl` — Claude Code appends to these
#      transcripts on every event (model output, tool_use, sub-agent
#      activity). Fresh mtime ⇒ the model or a sub-agent is alive.
#   2. `.claude/tasks/<session>/*.json` — TodoWrite / Task-tool state
#      files. Updated independently of the transcript stream when the
#      agent is iterating on a task list. Catches the case where the
#      transcript momentarily quiets (large model thinking pause)
#      while the agent is still progressing through todos.
#
# OR semantics: a wedged agent has to be silent on BOTH to be
# declared dead. Two uncorrelated fingerprints make false positives
# (kill while still working) much rarer than a single signal.
#
# `find -mmin` minimum granularity is minutes; round up to be
# conservative (better to defer a restart by an extra minute than to
# kill a live sub-agent). Both probes are bounded — quit on first
# match — so this stays O(1)-ish even on busy projects.
agent_has_recent_progress() {
  local agent_name="$1"
  local within_secs="$2"
  local agent_root="${HOME}/.switchroom/agents/${agent_name}/.claude"
  [[ -d "$agent_root" ]] || return 1
  local mmin=$(( (within_secs + 59) / 60 ))
  [[ "$mmin" -lt 1 ]] && mmin=1

  # Signal 1: transcript JSONL writes (parent or sub-agent).
  local hit
  hit=$(find "${agent_root}/projects" -name '*.jsonl' -mmin "-${mmin}" -print -quit 2>/dev/null)
  [[ -n "$hit" ]] && return 0

  # Signal 2: TodoWrite/Task state JSON updates.
  hit=$(find "${agent_root}/tasks" -name '*.json' -mmin "-${mmin}" -print -quit 2>/dev/null)
  [[ -n "$hit" ]] && return 0

  return 1
}

# ─── Forensic observation helpers ──────────────────────────────────────
# Composed at every restart/detect/skip log line so `journalctl -t
# switchroom-watchdog` carries enough context to reconstruct WHY any
# action was taken without re-deriving from kernel/process state
# after the fact (which is impossible — the process is gone after a
# restart). Each helper is best-effort, returns a compact key=value
# fragment, and never fails the script.

# Resolve the most-interesting PID in the agent's systemd cgroup —
# i.e., the actual `claude` process, not the start.sh / `script -qfc`
# PTY wrappers that systemd reports as MainPID. Strategy:
#
#   1. Look up the unit's cgroup path via systemctl.
#   2. Read `/sys/fs/cgroup/<cgroup>/cgroup.procs` for the full list.
#   3. Pick the PID with the largest RSS — claude is reliably the
#      memory-heaviest member of the cgroup (start.sh: ~2MB, script:
#      ~1MB, claude: hundreds of MB to multiple GB).
#
# Falls back to MainPID if the cgroup walk fails (rare — only when
# cgroup v2 isn't mounted at /sys/fs/cgroup or systemd reports an
# unusual unit layout). Returns 0 when nothing resolvable.
agent_main_pid() {
  local name="$1"
  local unit="switchroom-${name}.service"
  local cgroup
  cgroup=$(systemctl --user show "$unit" -p ControlGroup --value 2>/dev/null)
  if [[ -n "$cgroup" && -r "/sys/fs/cgroup${cgroup}/cgroup.procs" ]]; then
    # Pick the PID whose RSS (in KB) is largest. ps -o rss= prints
    # just the rss column; pair with -p PID-list to score them.
    local pids
    pids=$(tr '\n' ' ' < "/sys/fs/cgroup${cgroup}/cgroup.procs" 2>/dev/null)
    if [[ -n "$pids" ]]; then
      local heaviest
      heaviest=$(ps -o pid=,rss= -p $pids 2>/dev/null \
        | awk 'BEGIN{best_pid=0; best_rss=0} {if ($2+0 > best_rss) {best_rss=$2+0; best_pid=$1+0}} END{print best_pid}')
      if [[ "${heaviest:-0}" -gt 0 ]]; then
        echo "$heaviest"
        return 0
      fi
    fi
  fi
  systemctl --user show "$unit" -p MainPID --value 2>/dev/null || echo 0
}

# Process-state snapshot: state letter (R running, S sleeping, D
# uninterruptible sleep — usually I/O wait or kernel stuck, Z zombie,
# T stopped), CPU%, RSS in MB. State `D` for >30s is the smoking-gun
# signature of a genuinely wedged process (the original #116 hangs).
# Reads /proc/<pid>/stat for the state letter (field 3) and uses
# `ps -o` for CPU/RSS — both cheap and free of GNU/BSD portability
# pitfalls on Linux.
agent_proc_snapshot() {
  local pid="$1"
  if [[ -z "$pid" || "$pid" == "0" ]]; then
    echo "pid=0 state=missing"
    return 0
  fi
  if [[ ! -r "/proc/${pid}/stat" ]]; then
    echo "pid=${pid} state=gone"
    return 0
  fi
  # /proc/<pid>/stat field 3 is the state letter. The comm field
  # (field 2) is parenthesized and may contain spaces — strip it
  # before splitting so awk indexing is reliable.
  local stat_state
  stat_state=$(awk '{
    line=$0;
    sub(/.*\) /, "", line);
    split(line, a, " ");
    print a[1];
  }' "/proc/${pid}/stat" 2>/dev/null || echo "?")
  local cpu rss
  read -r cpu rss < <(ps -o pcpu=,rss= -p "$pid" 2>/dev/null | awk '{print $1, $2}')
  cpu="${cpu:-?}"
  rss="${rss:-0}"
  local rss_mb=$(( rss / 1024 ))
  echo "pid=${pid} state=${stat_state} cpu=${cpu}% rss_mb=${rss_mb}"
}

# Per-fingerprint freshness summary. Reports the age (in seconds) of
# the newest JSONL transcript and tasks-state file under the agent's
# `.claude/` tree. A wedged process shows both ages climbing past the
# threshold; a working sub-agent shows at least one stays small.
agent_progress_snapshot() {
  local name="$1"
  local agent_root="${HOME}/.switchroom/agents/${name}/.claude"
  if [[ ! -d "$agent_root" ]]; then
    echo "jsonl_age=- tasks_age=-"
    return 0
  fi
  local now
  now=$(now_epoch)
  # Newest JSONL mtime (may be empty if no project history yet).
  local newest_jsonl_mtime
  newest_jsonl_mtime=$(find "${agent_root}/projects" -name '*.jsonl' \
    -printf '%T@\n' 2>/dev/null | awk 'BEGIN{m=0} {if ($1+0 > m) m=$1+0} END{print int(m)}')
  local newest_tasks_mtime
  newest_tasks_mtime=$(find "${agent_root}/tasks" -name '*.json' \
    -printf '%T@\n' 2>/dev/null | awk 'BEGIN{m=0} {if ($1+0 > m) m=$1+0} END{print int(m)}')
  local jsonl_age="-"
  local tasks_age="-"
  if [[ "${newest_jsonl_mtime:-0}" -gt 0 ]]; then
    jsonl_age=$(( now - newest_jsonl_mtime ))s
  fi
  if [[ "${newest_tasks_mtime:-0}" -gt 0 ]]; then
    tasks_age=$(( now - newest_tasks_mtime ))s
  fi
  echo "jsonl_age=${jsonl_age} tasks_age=${tasks_age}"
}

# Compose the full forensic observation line: process state + the
# two progress fingerprints. Embedded in every action log message so
# the journal entry is self-contained — operators don't need to
# re-run probes after the fact (which would be useless if the
# process has been restarted in the meantime).
agent_observation() {
  local name="$1"
  local pid
  pid=$(agent_main_pid "$name")
  local proc progress
  proc=$(agent_proc_snapshot "$pid")
  progress=$(agent_progress_snapshot "$name")
  echo "${proc} ${progress}"
}

# Stamp a clean-shutdown.json marker into the agent's telegram state
# dir BEFORE issuing a restart, so the next greeting card can render
# "Restarted  <reason>". Mirrors the inline jq/printf logic that lived
# in the bridge-disconnect path; pulled into a function so every
# restart path stamps consistently. Best-effort: never fails.
stamp_restart_reason() {
  local marker="$1"
  local reason="$2"
  local ts_ms
  ts_ms=$(( $(date +%s) * 1000 ))
  local tmp="${marker}.tmp-$$"
  if command -v jq >/dev/null 2>&1; then
    jq -n --argjson ts "$ts_ms" --arg reason "$reason" \
      '{ts: $ts, signal: "SIGTERM", reason: $reason}' > "$tmp" 2>/dev/null \
      && mv -f "$tmp" "$marker" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  else
    local esc_reason
    esc_reason=$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '{"ts":%s,"signal":"SIGTERM","reason":"%s"}' "$ts_ms" "$esc_reason" > "$tmp" 2>/dev/null \
      && mv -f "$tmp" "$marker" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  fi
}

# ─── Crash-time tmux pane capture (#725 PR-2) ──────────────────────────
#
# Snapshot the agent's tmux pane scrollback to
# `<agentDir>/crash-reports/<ISO8601>-<reason>.txt` immediately
# before a watchdog-triggered restart. Gives RCA tooling the live
# screen state at the moment of the kill.
#
# Mirror of `src/agents/tmux.ts#captureAgentPane`. Same socket
# convention (`switchroom-<agent>`), same target session
# (`<agent>`), same output dir, same header. Keep the two paths in
# sync — RCA tooling reads from one stream regardless of which
# crash path produced the file.
#
# Best-effort: every step is `|| true`-ish so a missing socket /
# tmux / write failure NEVER blocks the restart. Operator-initiated
# restarts (`switchroom agent restart <agent>`) do NOT call this —
# only watchdog-triggered restart paths do, since clean restarts
# aren't crashes.
#
# Retention: 20 newest .txt files; size cap: 10MB per file
# (post-header bytes; tmux history-limit is 100k lines so worst-case
# ANSI-heavy panes can spike beyond that).
capture_pane_before_restart() {
  local agent="$1"
  local reason="$2"
  local agent_dir="${HOME}/.switchroom/agents/${agent}"
  local socket="switchroom-${agent}"
  local out_dir="${agent_dir}/crash-reports"
  local ts
  ts="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  local out="${out_dir}/${ts}-${reason}.txt"
  mkdir -p "$out_dir" 2>/dev/null || true
  {
    printf '# agent: %s\n# reason: %s\n# captured-at: %s\n# tmux-socket: %s\n\n' \
      "$agent" "$reason" "$ts" "$socket"
    timeout 5 tmux -L "$socket" capture-pane -p -S - -t "$agent" 2>&1 \
      | head -c 10485760 \
      || echo "[capture-pane failed: $?]"
  } > "$out" 2>/dev/null || true
  # Retention: keep newest 20 .txt files in the dir.
  ls -1t "$out_dir"/*.txt 2>/dev/null | tail -n +21 | xargs -r rm -f 2>/dev/null || true
}

# ─── Restart rate cap ──────────────────────────────────────────────────
#
# Belt-and-suspenders for runaway restart loops (#550 follow-up). Even
# with the in-flight detector + progress-fingerprint defences above,
# there are pathological combinations (e.g. a stuck marker file the
# sweep can't clear, a bridge that ESTAB-flaps once a minute) where
# the watchdog could chew through Claude quota by restarting the same
# agent N times an hour — every restart loads model context fresh.
#
# Rule: a single agent cannot be restarted by THIS watchdog more than
# `MAX_RESTARTS_PER_WINDOW` times within `RESTART_RATE_WINDOW_SECS`.
# When the cap trips, the restart is logged-and-skipped with a clear
# `restart-rate-capped` reason so an operator can see the throttle
# fired in `journalctl -t switchroom-watchdog | grep rate-capped`.
#
# The cap covers ALL three restart paths (bridge-disconnect, turn-hang,
# journal-silence) plus the service-inactive heal — anything that
# would cost a fresh `claude` startup. systemd's own
# StartLimitBurst/IntervalSec is not enough on its own because each
# `switchroom agent restart` resets that counter.
#
# State file: `${WATCHDOG_STATE_DIR}/${agent}.restarts` — newline-
# separated epoch timestamps, trimmed to the window on every check.
# tmpfs → cleared on logout, which is what we want (don't carry a
# stale 30-min window across a reboot).
: "${MAX_RESTARTS_PER_WINDOW:=5}"
: "${RESTART_RATE_WINDOW_SECS:=1800}"

# Returns 0 (allow) when the agent is under the cap. Returns 1 (block)
# and emits a `[skip]` log line when the cap would be exceeded. Pure
# read — does NOT record the restart; call restart_rate_record on the
# allowed path.
restart_rate_check() {
  local agent="$1"
  local reason_tag="$2"
  local rate_file="${WATCHDOG_STATE_DIR}/${agent}.restarts"
  [[ -f "$rate_file" ]] || return 0
  local now cutoff count=0
  now=$(now_epoch)
  cutoff=$(( now - RESTART_RATE_WINDOW_SECS ))
  while IFS= read -r ts; do
    [[ "$ts" =~ ^[0-9]+$ ]] || continue
    (( ts >= cutoff )) && count=$(( count + 1 ))
  done < "$rate_file"
  if (( count >= MAX_RESTARTS_PER_WINDOW )); then
    wd_log skip "agent=${agent} reason=${reason_tag} decision=restart-rate-capped recent=${count} max=${MAX_RESTARTS_PER_WINDOW} window=${RESTART_RATE_WINDOW_SECS}s (operator intervention required — investigate before clearing ${rate_file})"
    return 1
  fi
  return 0
}

# Append a restart timestamp and trim to the window. Best-effort I/O.
restart_rate_record() {
  local agent="$1"
  local rate_file="${WATCHDOG_STATE_DIR}/${agent}.restarts"
  local now cutoff
  now=$(now_epoch)
  cutoff=$(( now - RESTART_RATE_WINDOW_SECS ))
  local tmp="${rate_file}.tmp-$$"
  {
    if [[ -f "$rate_file" ]]; then
      while IFS= read -r ts; do
        [[ "$ts" =~ ^[0-9]+$ ]] || continue
        (( ts >= cutoff )) && echo "$ts"
      done < "$rate_file"
    fi
    echo "$now"
  } > "$tmp" 2>/dev/null && mv -f "$tmp" "$rate_file" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
}

# Discover active gateway units. systemd's list-units output includes only
# currently-loaded units; we filter to the switchroom-*-gateway.service
# pattern and strip the prefix/suffix to get the agent name.
mapfile -t gateway_services < <(
  systemctl --user list-units --type=service --state=active --no-legend --plain 2>/dev/null \
    | awk '{print $1}' \
    | grep -E '^switchroom-.+-gateway\.service$' || true
)

if [[ ${#gateway_services[@]} -eq 0 ]]; then
  # No active gateways — nothing to watch. Exit cleanly so the timer
  # keeps firing; transient absences (deploy windows) shouldn't error.
  exit 0
fi

for gateway_svc in "${gateway_services[@]}"; do
  # Extract agent name: switchroom-<agent>-gateway.service → <agent>
  agent="${gateway_svc#switchroom-}"
  agent="${agent%-gateway.service}"
  agent_svc="switchroom-${agent}.service"

  # Resolve the gateway's WorkingDirectory to locate its telegram state
  # dir. The gateway's gateway.log lives under WorkingDirectory/gateway.log
  # (the unit generator in src/agents/systemd.ts sets WorkingDirectory to
  # the agent's telegram/ subdir; see generateGatewayUnit).
  gateway_state_dir="$(
    systemctl --user show "$gateway_svc" -p WorkingDirectory --value 2>/dev/null
  )"
  if [[ -z "$gateway_state_dir" ]]; then
    wd_log error "agent=${agent} gateway has no WorkingDirectory; skipping"
    continue
  fi
  gateway_log="${gateway_state_dir}/gateway.log"
  # Sidecar file where we remember when the disconnected state started,
  # so we can detect SUSTAINED disconnection across ticks. Lives in the
  # same per-agent state dir so it's self-cleaning when an agent is
  # removed.
  disconnect_marker="${gateway_state_dir}/.watchdog-disconnect-since"

  if [[ ! -f "$gateway_log" ]]; then
    # Log file missing — gateway probably hasn't written a full turn yet.
    # Skip this tick; we'll try again in 60s.
    continue
  fi

  # If the agent service itself is inactive but the gateway is up,
  # treat that as a stale-bridge scenario too and restart it.
  #
  # Why: the agent service has `Restart=on-failure` in its unit (not
  # `Restart=always`) so a clean 0-exit of start.sh leaves it inactive.
  # That happens when Claude Code exits normally mid-session for any
  # reason (including external kill that start.sh handles gracefully).
  # Without this heal path the watchdog's earlier skip-if-inactive
  # guard left agents dead indefinitely.
  #
  # Production incident: 2026-04-22 ~03:44 AEST clerk's start.sh
  # exited with status=0/SUCCESS and the service went inactive. The
  # gateway stayed up; bridge was disconnected; systemd did nothing.
  if ! systemctl --user is-active --quiet "$agent_svc" 2>/dev/null; then
    # Also skip if the service is marked failed (start-limit-hit etc.)
    # — that needs operator intervention, not a restart loop.
    state="$(systemctl --user show "$agent_svc" -p ActiveState --value 2>/dev/null)"
    if [[ "$state" == "failed" ]]; then
      wd_log skip "agent=${agent} reason=service-failed decision=needs-operator-reset state=${state} $(agent_progress_snapshot "$agent") (unit in failed state; needs operator reset-failed)"
      continue
    fi
    if ! restart_rate_check "$agent" "service-inactive"; then
      continue
    fi
    wd_log restart "agent=${agent} reason=service-inactive state=${state} action=start $(agent_progress_snapshot "$agent") (agent service is inactive)"
    restart_rate_record "$agent"
    systemctl --user start "$agent_svc" || {
      wd_log error "agent=${agent} systemctl start failed"
    }
    continue
  fi

  # Uptime grace: freshly-started agents haven't had time to register
  # their bridge yet. systemctl emits ActiveEnterTimestamp in a format
  # like "Tue 2026-04-21 20:23:38 AEST"; ActiveEnterTimestampMonotonic
  # is easier to parse (microseconds since boot) but comparing to
  # wall-clock uptime is cross-platform-icky. We use the wall-clock
  # field and parse it with `date -d`, which systemd's format supports.
  active_enter_ts="$(
    systemctl --user show "$agent_svc" -p ActiveEnterTimestamp --value 2>/dev/null
  )"
  if [[ -n "$active_enter_ts" ]]; then
    # `date -d ""` fails; guard the empty case.
    active_enter_epoch="$(date -d "$active_enter_ts" +%s 2>/dev/null || echo 0)"
    if [[ "$active_enter_epoch" -gt 0 ]]; then
      uptime_secs=$(( $(now_epoch) - active_enter_epoch ))
      if [[ "$uptime_secs" -lt "$UPTIME_GRACE_SECS" ]]; then
        # Agent just started — give it time to come up. Clear any
        # stale disconnect marker from a previous cycle too, so the
        # grace window really is a clean slate.
        rm -f "$disconnect_marker" 2>/dev/null || true
        continue
      fi
    fi
  fi

  # Check the IPC socket for an actual ESTAB connection from the
  # agent's bridge. This is authoritative — if there's a live unix
  # socket, the bridge is connected right now. If not, it isn't.
  #
  # Why not just grep the gateway log: log grep used to be the check,
  # but it had a subtle bug. After a gateway restart, the log persists
  # across the restart (the gateway's `tee $LOG_PATH` appends). The
  # last "bridge registered" event might be from BEFORE the restart,
  # so `tail -1` reports it as healthy even though the agent hasn't
  # reconnected yet. Production incident 2026-04-22 ~07:20: clerk was
  # stuck with 0 IPC connections but watchdog said healthy because
  # the pre-restart "bridge registered" was the latest in the log.
  #
  # ss -x reads kernel-level socket state so it's immune to log
  # staleness. Unix sockets are visible without sudo for the owner.
  gateway_sock="${gateway_state_dir}/gateway.sock"
  if [[ ! -S "$gateway_sock" ]]; then
    # Socket file doesn't exist — gateway hasn't fully started or is
    # shutting down. Skip this tick; try again in 60s.
    continue
  fi

  ipc_estab_count=$(
    ss -x 2>/dev/null \
      | awk -v sock="$gateway_sock" '$1 == "u_str" && $2 == "ESTAB" && index($0, sock) { n++ } END { print n+0 }'
  )

  if (( ipc_estab_count > 0 )); then
    bridge_healthy=true
  else
    # ESTAB == 0: socket is disconnected. Before declaring the bridge dead,
    # check the liveness file the bridge writes on every heartbeat tick (~5s).
    # A recent mtime means the bridge process is alive but temporarily
    # reconnecting (e.g. after a gateway restart) — restarting the agent
    # here would be wasteful and would kill any in-flight Claude turn.
    liveness_file="${gateway_state_dir}/.bridge-alive"
    bridge_healthy=false
    if [[ -f "$liveness_file" ]]; then
      liveness_mtime=$(stat -c %Y "$liveness_file" 2>/dev/null || echo 0)
      liveness_age=$(( $(now_epoch) - liveness_mtime ))
      if (( liveness_age < LIVENESS_GRACE_SECS )); then
        bridge_healthy=true
        wd_log skip "agent=${agent} reason=bridge-socket-flap decision=liveness-file-fresh liveness_age=${liveness_age}s threshold=${LIVENESS_GRACE_SECS}s $(agent_observation "$agent") (liveness file is fresh)"
      fi
    fi
  fi

  if [[ "$bridge_healthy" == true ]]; then
    # Healthy — wipe the disconnect marker so the next disconnect
    # starts a fresh grace window.
    rm -f "$disconnect_marker" 2>/dev/null || true
    continue
  fi

  # Disconnected. Has it been sustained long enough to act?
  now="$(now_epoch)"
  if [[ -f "$disconnect_marker" ]]; then
    disc_since="$(cat "$disconnect_marker" 2>/dev/null || echo "$now")"
    # Paranoia: if the file got corrupted (non-numeric), treat as now.
    if ! [[ "$disc_since" =~ ^[0-9]+$ ]]; then
      disc_since="$now"
      echo "$now" > "$disconnect_marker"
    fi
  else
    # First observation of disconnect on this tick. Record it and wait.
    echo "$now" > "$disconnect_marker"
    disc_since="$now"
  fi

  disc_duration=$(( now - disc_since ))
  if [[ "$disc_duration" -lt "$DISCONNECT_GRACE_SECS" ]]; then
    # Transient flap — the bridge IPC disconnects across Claude Code
    # turn boundaries. Don't restart yet; give it another tick or two.
    continue
  fi

  # Progress gate — same defence as turn-hang/journal-silence. A
  # bridge can flap (MCP plugin crash, transient socket close)
  # while a sub-agent is still doing real work. Without this gate
  # the bridge-disconnect path would kill any in-flight sub-agent
  # whenever the bridge had a bad minute. Skip the restart if any
  # forward-progress fingerprint is fresh and just keep the
  # disconnect marker around — next tick will re-evaluate.
  observation=$(agent_observation "$agent")
  if agent_has_recent_progress "$agent" "$JSONL_LIVENESS_SECS"; then
    wd_log skip "agent=${agent} reason=bridge-disconnect disc_duration=${disc_duration}s threshold=${DISCONNECT_GRACE_SECS}s decision=defer-progress-fresh ${observation}"
    continue
  fi

  wd_log detect "agent=${agent} reason=bridge-disconnect disc_duration=${disc_duration}s threshold=${DISCONNECT_GRACE_SECS}s ${observation}"
  if ! restart_rate_check "$agent" "bridge-disconnect"; then
    continue
  fi
  wd_log restart "agent=${agent} reason=bridge-disconnect disc_duration=${disc_duration}s threshold=${DISCONNECT_GRACE_SECS}s ${observation}"
  capture_pane_before_restart "$agent" "bridge-disconnect"
  restart_rate_record "$agent"
  # Clear the marker so post-restart we don't immediately re-trip on
  # the still-old tail. The uptime grace will cover the startup window
  # anyway, but removing the marker keeps state clean.
  rm -f "$disconnect_marker" 2>/dev/null || true
  # Stamp WHY before killing so the next agent greeting card can show
  # "Restarted  watchdog: bridge disconnected for ${disc_duration}s".
  # The gateway's own SIGTERM handler writes `clean-shutdown.json` on
  # shutdown too — but its marker carries no `reason`, so the greeting
  # omits the row.
  stamp_restart_reason \
    "${gateway_state_dir}/clean-shutdown.json" \
    "watchdog: bridge disconnected for ${disc_duration}s"
  # Route through `switchroom agent restart` (not raw systemctl) for
  # parity with the turn-hang and journal-silence paths: the CLI's
  # in-flight guard is one more belt-and-suspenders check, and config
  # reconciliation runs on every lifecycle transition per the project
  # contract. Falls back to systemctl if the CLI isn't on PATH.
  switchroom_cli=""
  for candidate in "${HOME}/.bun/bin/switchroom" "${HOME}/.local/bin/switchroom"; do
    if [[ -x "$candidate" ]]; then
      switchroom_cli="$candidate"
      break
    fi
  done
  if [[ -z "$switchroom_cli" ]] && command -v switchroom >/dev/null 2>&1; then
    switchroom_cli="$(command -v switchroom)"
  fi
  if [[ -n "$switchroom_cli" ]]; then
    "$switchroom_cli" agent restart "$agent" || {
      wd_log error "agent=${agent} switchroom agent restart failed; falling back to systemctl --user restart"
      systemctl --user restart "$agent_svc" || true
    }
  else
    wd_log error "agent=${agent} switchroom CLI not on PATH; using systemctl restart fallback"
    systemctl --user restart "$agent_svc" || true
  fi
done

# ─── Auth refresh tick ───────────────────────────────────────────────────────
#
# Wire `switchroom auth refresh-tick` into every watchdog cycle (issue #429
# Phase 1). The command is idempotent and cheap when tokens are healthy, so
# it's safe to run once per watchdog tick (≈60s).
#
# Two independently-tunable knobs (both default to 600, but for different
# reasons — coincidence, not coupling):
#
#   AUTH_REFRESH_INTERVAL_SECS — how often the watchdog runs the CLI at all.
#     Gated by a state-file timestamp; the CLI is skipped entirely until this
#     many seconds have passed since the last run. Default 600s (10 min).
#
#   AUTH_REFRESH_THRESHOLD_MS — how close to expiry a token must be before
#     the CLI actually contacts the OAuth endpoint to refresh it. Passed as
#     --threshold-ms. Default 600000 ms (10 min). Operators who want earlier
#     proactive refreshes (e.g. 1800000 ms = 30 min) can raise this without
#     touching the run cadence, and vice-versa.
#
# Disabled by setting WATCHDOG_REFRESH_AUTH=0 (default on).
: "${WATCHDOG_REFRESH_AUTH:=1}"
: "${AUTH_REFRESH_INTERVAL_SECS:=600}"
: "${AUTH_REFRESH_THRESHOLD_MS:=600000}"

if [[ "${WATCHDOG_REFRESH_AUTH}" == "1" ]]; then
  auth_refresh_marker="${WATCHDOG_STATE_DIR}/.auth-refresh-last"
  last_refresh=0
  if [[ -f "$auth_refresh_marker" ]]; then
    last_refresh="$(cat "$auth_refresh_marker" 2>/dev/null || echo 0)"
    [[ "$last_refresh" =~ ^[0-9]+$ ]] || last_refresh=0
  fi
  now_for_auth="$(now_epoch)"
  auth_age=$(( now_for_auth - last_refresh ))
  if [[ "$auth_age" -ge "$AUTH_REFRESH_INTERVAL_SECS" ]]; then
    # Resolve the switchroom CLI (same pattern as restart paths above).
    switchroom_cli_auth=""
    for candidate in "${HOME}/.bun/bin/switchroom" "${HOME}/.local/bin/switchroom"; do
      if [[ -x "$candidate" ]]; then
        switchroom_cli_auth="$candidate"
        break
      fi
    done
    if [[ -z "$switchroom_cli_auth" ]] && command -v switchroom >/dev/null 2>&1; then
      switchroom_cli_auth="$(command -v switchroom)"
    fi
    if [[ -n "$switchroom_cli_auth" ]]; then
      wd_log detect "auth-refresh age=${auth_age}s threshold=${AUTH_REFRESH_INTERVAL_SECS}s decision=run-refresh-tick"
      if "$switchroom_cli_auth" auth refresh-tick --threshold-ms "${AUTH_REFRESH_THRESHOLD_MS}" >/dev/null 2>&1; then
        echo "$now_for_auth" > "$auth_refresh_marker"
        wd_log skip "auth-refresh decision=tick-complete threshold_ms=${AUTH_REFRESH_THRESHOLD_MS}"
      else
        wd_log error "auth-refresh switchroom auth refresh-tick exited non-zero (partial failures are logged by the CLI; state file not updated)"
      fi
    else
      wd_log error "auth-refresh switchroom CLI not on PATH; skipping refresh tick"
    fi
  fi
fi

# ─── Journal-silence check ───────────────────────────────────────────────────
#
# Independent of the bridge-disconnect check above. For each active
# switchroom-<agent>.service unit (NOT the gateway), verify that it has
# emitted at least one journal entry within JOURNAL_SILENCE_SECS. If an
# agent has been silent longer than that AND uptime has cleared
# UPTIME_GRACE_SECS, record a silence_since marker in the watchdog state
# dir. Once the marker is older than JOURNAL_SILENCE_HARD_SECS, restart
# via `switchroom agent restart <agent>` (the contracted reconcile+restart
# path; NOT raw systemctl restart, which would bypass switchroom's
# config reconciliation).
#
# Why `switchroom agent restart` rather than `systemctl --user restart`:
# the project contract is that all lifecycle transitions go through the
# switchroom CLI so that config reconciliation always runs. Raw systemctl
# calls skip that step and can leave units with stale unit files.

mapfile -t agent_services < <(
  systemctl --user list-units --type=service --state=active --no-legend --plain 2>/dev/null \
    | awk '{print $1}' \
    | grep -E '^switchroom-.+\.service$' \
    | grep -v -E '^switchroom-(gateway|vault-broker|foreman)\.service$' \
    | grep -v -E '^switchroom-.+-gateway\.service$' \
    | grep -v -E '^switchroom-.+-cron-[0-9]+\.service$' || true
)

for agent_svc in "${agent_services[@]}"; do
  # Extract agent name: switchroom-<agent>.service → <agent>
  agent="${agent_svc#switchroom-}"
  agent="${agent%.service}"

  silence_marker="${WATCHDOG_STATE_DIR}/${agent}.silence_since"

  # Uptime grace: same logic as the bridge check. Fresh agents haven't
  # had time to settle into a normal logging cadence.
  active_enter_ts="$(
    systemctl --user show "$agent_svc" -p ActiveEnterTimestamp --value 2>/dev/null
  )"
  if [[ -n "$active_enter_ts" ]]; then
    active_enter_epoch="$(date -d "$active_enter_ts" +%s 2>/dev/null || echo 0)"
    if [[ "$active_enter_epoch" -gt 0 ]]; then
      uptime_secs=$(( $(now_epoch) - active_enter_epoch ))
      if [[ "$uptime_secs" -lt "$UPTIME_GRACE_SECS" ]]; then
        # Clear stale silence marker on fresh start so the grace window
        # is a clean slate.
        rm -f "$silence_marker" 2>/dev/null || true
        continue
      fi
    fi
  fi

  # Issue #412: turn-active marker hang detector. The gateway writes
  # `<agentDir>/telegram/turn-active.json` at turn-start, bumps its
  # mtime on every tool_use, and removes it on turn_complete. If the
  # file is older than TURN_HANG_SECS, the agent is wedged mid-turn —
  # distinguishable from healthy idle because healthy idle leaves no
  # marker file at all. This closes the gap left when JOURNAL_SILENCE_SECS
  # was raised to 4000s (PR #410) to kill chat-cadence false positives.
  agent_state_dir="${HOME}/.switchroom/agents/${agent}/telegram"
  turn_active_file="${agent_state_dir}/turn-active.json"
  if [[ -f "$turn_active_file" ]]; then
    turn_mtime=$(stat -c %Y "$turn_active_file" 2>/dev/null || echo 0)
    if [[ "$turn_mtime" -gt 0 ]]; then
      turn_age=$(( $(now_epoch) - turn_mtime ))
      if [[ "$turn_age" -ge "$TURN_HANG_SECS" ]]; then
        # Progress gate — sub-agent activity does NOT bump the
        # parent's turn-active marker, so a stale marker plus fresh
        # JSONL writes means a sub-agent (or the main turn) is doing
        # real work and a restart would kill it mid-flight. This was
        # the dominant false-positive path observed in the journal
        # 2026-05-02 (finn/klanker restarted while sub-agents had
        # `last activity: 0s ago` per the in-flight detector).
        observation=$(agent_observation "$agent")
        if agent_has_recent_progress "$agent" "$JSONL_LIVENESS_SECS"; then
          wd_log skip "agent=${agent} reason=turn-hang turn_age=${turn_age}s threshold=${TURN_HANG_SECS}s decision=defer-progress-fresh ${observation}"
          continue
        fi
        wd_log detect "agent=${agent} reason=turn-hang turn_age=${turn_age}s threshold=${TURN_HANG_SECS}s ${observation} (no progress fingerprints within ${JSONL_LIVENESS_SECS}s — wedged mid-turn)"
        if ! restart_rate_check "$agent" "turn-hang"; then
          continue
        fi
        # Stamp the reason BEFORE the restart so the next greeting
        # card renders "Restarted  watchdog: …".
        stamp_restart_reason \
          "${agent_state_dir}/clean-shutdown.json" \
          "watchdog: turn-active marker stale ${turn_age}s with no JSONL activity"
        wd_log restart "agent=${agent} reason=turn-hang turn_age=${turn_age}s threshold=${TURN_HANG_SECS}s ${observation}"
        capture_pane_before_restart "$agent" "turn-hang"
        restart_rate_record "$agent"
        # Resolve the switchroom CLI (same belt-and-suspenders as below)
        switchroom_cli=""
        for candidate in "${HOME}/.bun/bin/switchroom" "${HOME}/.local/bin/switchroom"; do
          if [[ -x "$candidate" ]]; then
            switchroom_cli="$candidate"
            break
          fi
        done
        if [[ -z "$switchroom_cli" ]] && command -v switchroom >/dev/null 2>&1; then
          switchroom_cli="$(command -v switchroom)"
        fi
        if [[ -n "$switchroom_cli" ]]; then
          "$switchroom_cli" agent restart "$agent" || {
            wd_log error "agent=${agent} switchroom agent restart failed; falling back to systemctl --user restart"
            systemctl --user restart "$agent_svc" || true
          }
        else
          wd_log error "agent=${agent} switchroom CLI not on PATH; using systemctl restart fallback"
          systemctl --user restart "$agent_svc" || true
        fi
        # Restarted — skip remaining checks for this agent this tick.
        continue
      fi
    fi
  fi

  # Read the timestamp of the most recent journal entry from this unit.
  # --output=short-unix gives "EPOCH.USEC MESSAGE" format; we grab the
  # leading integer epoch seconds.
  latest_journal_line="$(
    journalctl --user -u "$agent_svc" -n 1 --output=short-unix --no-pager 2>/dev/null || true
  )"
  latest_journal_epoch=0
  if [[ -n "$latest_journal_line" ]]; then
    # short-unix format: "1745632800.123456 hostname unit[pid]: message"
    # Extract the leading epoch (integer part before the dot or space).
    candidate="$(echo "$latest_journal_line" | awk '{print $1}' | cut -d. -f1)"
    if [[ "$candidate" =~ ^[0-9]+$ ]]; then
      latest_journal_epoch="$candidate"
    fi
  fi

  now="$(now_epoch)"
  if [[ "$latest_journal_epoch" -eq 0 ]]; then
    # No journal entries at all — possibly a very new unit that hasn't
    # logged yet. Treat conservatively: skip this tick (uptime grace
    # should have caught a genuine fresh start above, so this branch
    # mostly hits units that truly haven't logged due to a bug — still
    # give them one tick of benefit of the doubt).
    continue
  fi

  journal_age=$(( now - latest_journal_epoch ))

  if [[ "$journal_age" -lt "$JOURNAL_SILENCE_SECS" ]]; then
    # Journal is fresh — clear any stale silence marker and move on.
    rm -f "$silence_marker" 2>/dev/null || true
    continue
  fi

  # Recent-activity gate: only suspect a hang if the agent had log activity
  # within RECENT_ACTIVITY_WINDOW_SECS. A genuinely idle agent (e.g. a
  # personal agent that hasn't received a message in hours/days) has its
  # latest journal entry far in the past — restarting it would just churn
  # state for no reason. A hung agent, by contrast, was active before
  # freezing, so its most recent entry is recent (within the window).
  #
  # Implementation: if `journal_age >= RECENT_ACTIVITY_WINDOW_SECS`, the
  # latest entry is older than the window, so by definition there's no
  # activity inside it. Treat as idle — clear any stale marker and skip.
  if [[ "$journal_age" -ge "$RECENT_ACTIVITY_WINDOW_SECS" ]]; then
    rm -f "$silence_marker" 2>/dev/null || true
    continue
  fi

  # Journal has been silent for >= JOURNAL_SILENCE_SECS but the agent had
  # activity within RECENT_ACTIVITY_WINDOW_SECS. Record the first
  # observation so we can require sustained silence.
  if [[ -f "$silence_marker" ]]; then
    silence_since="$(cat "$silence_marker" 2>/dev/null || echo "$now")"
    if ! [[ "$silence_since" =~ ^[0-9]+$ ]]; then
      silence_since="$now"
      echo "$now" > "$silence_marker"
    fi
  else
    echo "$now" > "$silence_marker"
    silence_since="$now"
    wd_log detect "agent=${agent} reason=journal-silence journal_age=${journal_age}s threshold=${JOURNAL_SILENCE_SECS}s decision=record-silence-marker $(agent_observation "$agent") (will restart after ${JOURNAL_SILENCE_HARD_SECS}s of sustained silence)"
    continue
  fi

  silence_duration=$(( now - silence_since ))
  if [[ "$silence_duration" -lt "$JOURNAL_SILENCE_HARD_SECS" ]]; then
    # Silence not yet sustained long enough to act.
    continue
  fi

  # Progress gate — same defence as the turn-hang path. A silent
  # agent journal can co-exist with a busy sub-agent (the parent's
  # stdout goes quiet while the sub-agent runs). If JSONL or tasks
  # writes are happening, real work is in progress; don't restart.
  observation=$(agent_observation "$agent")
  if agent_has_recent_progress "$agent" "$JSONL_LIVENESS_SECS"; then
    wd_log skip "agent=${agent} reason=journal-silence journal_age=${journal_age}s silence_duration=${silence_duration}s threshold=${JOURNAL_SILENCE_HARD_SECS}s decision=defer-progress-fresh ${observation}"
    rm -f "$silence_marker" 2>/dev/null || true
    continue
  fi

  # The agent has been journal-silent for >= JOURNAL_SILENCE_HARD_SECS
  # AND has cleared the uptime grace AND has no progress fingerprints.
  # This matches the production hang pattern (issue #116). Restart
  # via the switchroom CLI.
  wd_log detect "agent=${agent} reason=journal-silence journal_age=${journal_age}s silence_duration=${silence_duration}s threshold=${JOURNAL_SILENCE_HARD_SECS}s ${observation} (no progress fingerprints — wedged)"
  if ! restart_rate_check "$agent" "journal-silence"; then
    continue
  fi
  agent_state_dir="${HOME}/.switchroom/agents/${agent}/telegram"
  stamp_restart_reason \
    "${agent_state_dir}/clean-shutdown.json" \
    "watchdog: journal silent for ${journal_age}s with no progress activity"
  wd_log restart "agent=${agent} reason=journal-silence journal_age=${journal_age}s silence_duration=${silence_duration}s threshold=${JOURNAL_SILENCE_HARD_SECS}s ${observation}"
  capture_pane_before_restart "$agent" "journal-silence"
  restart_rate_record "$agent"
  rm -f "$silence_marker" 2>/dev/null || true

  # Use `switchroom agent restart` (not raw systemctl) — the project
  # contract is that all agent lifecycle transitions go through the CLI
  # so config reconciliation always runs.
  #
  # Belt-and-suspenders CLI resolution (issue #406): the systemd .service
  # unit pins Environment=PATH=~/.bun/bin:..., but if a hand-installed
  # legacy unit is still on disk the PATH may be empty. Probe the two
  # known install locations directly before falling back to PATH lookup,
  # so a silent PATH gap can't silently downgrade us to the systemctl
  # fallback (which bypasses reconcile).
  switchroom_cli=""
  for candidate in "${HOME}/.bun/bin/switchroom" "${HOME}/.local/bin/switchroom"; do
    if [[ -x "$candidate" ]]; then
      switchroom_cli="$candidate"
      break
    fi
  done
  if [[ -z "$switchroom_cli" ]] && command -v switchroom >/dev/null 2>&1; then
    switchroom_cli="$(command -v switchroom)"
  fi

  if [[ -n "$switchroom_cli" ]]; then
    "$switchroom_cli" agent restart "$agent" || {
      wd_log error "agent=${agent} switchroom agent restart failed; falling back to systemctl --user restart"
      systemctl --user restart "$agent_svc" || true
    }
  else
    # Fallback: if the switchroom CLI isn't on PATH (unusual), use systemctl
    # directly and log the degraded path.
    wd_log error "agent=${agent} switchroom CLI not on PATH; using systemctl restart fallback"
    systemctl --user restart "$agent_svc" || true
  fi
done
