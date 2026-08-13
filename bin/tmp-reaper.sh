#!/usr/bin/env bash
# switchroom-tmp-reaper — bounded janitor for the agent container's /tmp tmpfs.
#
# WHY THIS EXISTS
# ---------------
# An agent container mounts /tmp as a RAM-backed tmpfs, sized by
# `resources.tmp_size` (src/agents/compose.ts, DEFAULT_TMP_SIZE = 2g), with
# Docker's default tmpfs flags — `rw,nosuid,nodev,noexec`. Two consequences:
#
#   1. It is a hard ceiling. Nothing ages out of a tmpfs; a long-running
#      container accumulates every scratch dir any tool ever forgot to
#      remove until writes start failing ENOSPC. Observed on a live agent:
#      4,462 top-level entries, 490 MiB used, of which 204 MiB was two
#      orphaned `bun build --compile` artifacts from a single test run
#      (fixed at source in tests/install/static-binary.test.ts, but that
#      only fixes the leak we already found).
#   2. The failure is NOT localised. Once /tmp is full, everything that
#      stages through it fails — `npm ci`, git, the claude CLI's own
#      scratch — with errors that name the victim, never the cause.
#
# The size is deliberately NOT the lever. Raising the tmpfs converts a fast,
# loud failure into a slow leak that eats host RAM instead. This reaper
# bounds the accumulation itself.
#
# SAFETY CONTRACT (each clause is pinned by tests/tmp-reaper.test.ts)
# -------------------------------------------------------------------
#   * Scope. Only direct children of the root are considered, the root
#     itself is never removed, and every traversal is `-xdev` with no
#     symlink dereference — so a symlink under /tmp pointing at, say,
#     /state/agent can have the LINK reaped but never its target.
#   * Age. An entry is a candidate only when NOTHING anywhere in its
#     subtree has been modified or accessed within the age threshold
#     (default 24h). A directory's own mtime does not change when a
#     grandchild is written, so checking the entry alone would reap a
#     live tree — the whole subtree is checked.
#   * Open files. An entry is skipped when it, or anything beneath it, is
#     open by any process in the container: /proc/*/fd, /proc/*/cwd,
#     /proc/*/exe and mmapped regions from /proc/*/maps are all consulted.
#   * Logging. Every reaped entry is logged with its size and age, and every
#     pass emits a one-line summary — including passes that reap nothing.
#
# TUNING (all validated; garbage falls back to the default)
#   SWITCHROOM_TMP_REAPER=0                     disable entirely
#   SWITCHROOM_TMP_REAPER_MIN_AGE_SEC=86400     age threshold (min 3600)
#   SWITCHROOM_TMP_REAPER_INTERVAL_SEC=3600     seconds between passes
#   SWITCHROOM_TMP_REAPER_ROOT=/tmp             root (test harness only)
#
# Run standalone for a one-shot pass:  tmp-reaper.sh --once
set -uo pipefail

REAPER_NAME="switchroom-tmp-reaper"

TMP_REAPER_ROOT="${SWITCHROOM_TMP_REAPER_ROOT:-/tmp}"

# Age below which an entry is NEVER touched. One hour is the hard floor even
# if an operator sets something smaller: this reaper cannot distinguish "a
# build wrote this five minutes ago and will read it back in ten" from
# garbage, and the age bound is the only thing standing between it and a
# live workload.
MIN_AGE_SEC="${SWITCHROOM_TMP_REAPER_MIN_AGE_SEC:-86400}"
case "$MIN_AGE_SEC" in ''|*[!0-9]*) MIN_AGE_SEC=86400;; esac
[ "$MIN_AGE_SEC" -lt 3600 ] && MIN_AGE_SEC=3600

INTERVAL_SEC="${SWITCHROOM_TMP_REAPER_INTERVAL_SEC:-3600}"
case "$INTERVAL_SEC" in ''|0|*[!0-9]*) INTERVAL_SEC=3600;; esac
[ "$INTERVAL_SEC" -lt 60 ] && INTERVAL_SEC=60

# Never-reap names. These are conventional tmpfs fixtures whose mtime can sit
# still for weeks while they are very much in use, and whose removal breaks
# things in ways that are hard to trace back here.
TMP_REAPER_KEEP_DEFAULT=".X11-unix .ICE-unix .font-unix .Test-unix .XIM-unix"
TMP_REAPER_KEEP="${SWITCHROOM_TMP_REAPER_KEEP:-$TMP_REAPER_KEEP_DEFAULT}"

_log() { printf '[%s] %s %s\n' "$REAPER_NAME" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

# Refuse to operate on a root that is not a plain, existing directory, or that
# is the filesystem root. The default is /tmp and the override exists for the
# test harness; this guard is what keeps a mis-set override from being
# catastrophic rather than merely wrong.
_root_ok() {
  local r="$1"
  [ -n "$r" ] || { _log "refusing: empty root"; return 1; }
  [ "$r" != "/" ] || { _log "refusing: root is /"; return 1; }
  case "$r" in
    /*) ;;
    *) _log "refusing: root '$r' is not absolute"; return 1;;
  esac
  case "$r" in
    *..*) _log "refusing: root '$r' contains '..'"; return 1;;
  esac
  [ -d "$r" ] || { _log "refusing: root '$r' is not a directory"; return 1; }
  [ ! -L "$r" ] || { _log "refusing: root '$r' is a symlink"; return 1; }
  return 0
}

# Emit every path under $1 that some process in this container currently has
# open — as an fd, as its cwd, as its executable, or as an mmapped region.
# Unreadable /proc entries (a process owned by another uid, or one that exited
# mid-scan) are skipped: they can only cause us to reap LESS, never more.
#
# Cost matters here: a busy container has hundreds of processes and thousands
# of fds, so this uses ONE `find` (with -printf '%l' to read the link targets
# in-process) and ONE `grep`+`awk` pipeline over the maps files, rather than a
# readlink fork per fd. A per-fd fork loop measured multiple seconds per pass.
#
# CRITICAL: neither traversal may ABORT on an unreadable input. `find` reports
# a vanished/denied start point and keeps going, which is what we need. `awk`
# does NOT: the image ships mawk 1.3.4, which stops at the FIRST file it cannot
# open and never reads the rest of its argument list. Handing mawk the raw
# /proc/[0-9]*/maps glob therefore meant that one PID exiting between bash's
# glob expansion and mawk's serial open (ESRCH), or one EPERM, silently
# discarded every LATER process's mappings — a fail-OPEN in a safety guard,
# after which the reaper would delete a tree a live process still had mapped.
# So `grep` (GNU grep continues past unreadable files, exit 2) does the
# multi-file read and `awk` only ever sees a single stdin stream.
#
# `awk substr` rather than `grep -o`: a maps line is
# "addr perms offset dev inode <pathname>", so the path runs to end-of-line and
# MAY CONTAIN SPACES. `grep -oE "$root/[^ ]*"` would truncate
# "/tmp/my dir/lib.so" to "/tmp/my", which no longer prefix-matches the entry
# in the caller below — fail-open again, for any /tmp entry with a space.
_open_paths() {
  local root="$1"
  find /proc/[0-9]*/fd /proc/[0-9]*/cwd /proc/[0-9]*/exe \
       -maxdepth 1 -type l -printf '%l\n' 2>/dev/null \
    | grep -F -- "$root/" 2>/dev/null
  # mmapped files (a running binary, a memory-mapped DB) do not appear as an
  # fd once mapped and the fd is closed, but are absolutely still in use.
  grep -haF -- "$root/" /proc/[0-9]*/maps 2>/dev/null \
    | awk -v r="$root/" '{ p=index($0, r); if (p) print substr($0, p) }'
}

_human() {
  local b="${1:-0}"
  if   [ "$b" -ge 1073741824 ] 2>/dev/null; then echo "$((b / 1073741824))G"
  elif [ "$b" -ge 1048576 ]    2>/dev/null; then echo "$((b / 1048576))M"
  elif [ "$b" -ge 1024 ]       2>/dev/null; then echo "$((b / 1024))K"
  else echo "${b}B"; fi
}

# One pass. Returns 0 always; a failure to remove one entry must not abort
# the pass (the next entry may be the one actually holding the space).
tmp_reaper_pass() {
  local root="$TMP_REAPER_ROOT"
  _root_ok "$root" || return 1
  # Canonicalise. /proc/*/fd link targets are already fully resolved, so an
  # un-canonicalised root with a symlinked ancestor would never prefix-match
  # them and the open-file check would silently pass everything through —
  # the guard would look present and do nothing.
  root=$(readlink -f -- "$root" 2>/dev/null) || root="$TMP_REAPER_ROOT"
  [ -n "$root" ] || root="$TMP_REAPER_ROOT"
  _root_ok "$root" || return 1

  local now cutoff
  now=$(date +%s)
  cutoff=$((now - MIN_AGE_SEC))

  local open_list
  open_list=$(_open_paths "$root")

  local reaped=0 freed=0 kept_open=0 kept_young=0 kept_pinned=0 failed=0
  local entry base

  while IFS= read -r -d '' entry; do
    base="${entry##*/}"

    # 1. Never-reap list.
    local pinned=0 k
    for k in $TMP_REAPER_KEEP; do
      [ "$base" = "$k" ] && { pinned=1; break; }
    done
    if [ "$pinned" -eq 1 ]; then kept_pinned=$((kept_pinned + 1)); continue; fi

    # 2. Age — nothing ANYWHERE in the subtree may be newer than the cutoff,
    #    by mtime or atime. `-print -quit` stops at the first offender.
    local young
    young=$(find "$entry" -xdev \( -newermt "@$cutoff" -o -newerat "@$cutoff" \) \
              -print -quit 2>/dev/null)
    if [ -n "$young" ]; then kept_young=$((kept_young + 1)); continue; fi

    # 3. Open by a live process (the entry itself, or anything under it).
    local is_open=0 p
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      if [ "$p" = "$entry" ] || [ "${p#"$entry"/}" != "$p" ]; then
        is_open=1; break
      fi
    done <<< "$open_list"
    if [ "$is_open" -eq 1 ]; then kept_open=$((kept_open + 1)); continue; fi

    # Size and age for the log line, computed BEFORE removal.
    local bytes mtime age_h
    bytes=$(du -sxb -- "$entry" 2>/dev/null | cut -f1)
    case "$bytes" in ''|*[!0-9]*) bytes=0;; esac
    mtime=$(stat -c %Y -- "$entry" 2>/dev/null || echo "$now")
    age_h=$(( (now - mtime) / 3600 ))

    if rm -rf --one-file-system --preserve-root -- "$entry" 2>/dev/null; then
      reaped=$((reaped + 1))
      freed=$((freed + bytes))
      _log "reaped $entry ($(_human "$bytes"), idle ${age_h}h)"
    else
      failed=$((failed + 1))
      _log "could NOT remove $entry ($(_human "$bytes"), idle ${age_h}h)"
    fi
  done < <(find "$root" -xdev -mindepth 1 -maxdepth 1 -print0 2>/dev/null)

  _log "pass complete on $root: reaped=$reaped freed=$(_human "$freed")" \
       "kept_young=$kept_young kept_open=$kept_open kept_pinned=$kept_pinned" \
       "failed=$failed min_age=${MIN_AGE_SEC}s"
  return 0
}

tmp_reaper_main() {
  if [ "${SWITCHROOM_TMP_REAPER:-1}" = "0" ]; then
    _log "disabled via SWITCHROOM_TMP_REAPER=0 — not starting"
    return 0
  fi
  if [ "${1:-}" = "--once" ]; then
    tmp_reaper_pass
    return $?
  fi
  _log "starting: root=$TMP_REAPER_ROOT min_age=${MIN_AGE_SEC}s interval=${INTERVAL_SEC}s"
  while true; do
    tmp_reaper_pass
    sleep "$INTERVAL_SEC"
  done
}

# Only auto-run when EXECUTED. Sourcing (the test harness, and any future
# caller that wants a single pass inline) gets the functions and nothing else.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  tmp_reaper_main "$@"
fi
