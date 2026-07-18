#!/usr/bin/env bash
# Reap stale wedged runner workdirs on the self-hosted uat-host runner (#3335).
#
# Self-hosted runners reuse a PERSISTENT `_work` tree across jobs (unlike the
# ephemeral hosted runners). On 2026-07-18 a canary UAT run wedged mid-checkout:
# `actions/checkout`'s `git clean -ffdx` went into uninterruptible D-state
# (disk-wait) on the slow `uat-runner-state` volume. Manual recovery renamed the
# wedged checkout aside to `switchroom.wedged-<date>` so a fresh clone could
# proceed — but those remnants then accumulate as dead weight on an already
# contended volume.
#
# This guard sweeps stale `switchroom.wedged-*` remnants BEFORE checkout so they
# don't pile up. It is deliberately conservative:
#   - Age-gated: only remnants older than REAP_RETAIN_DAYS (default 1 day) are
#     removed, so a FRESH wedge from the current incident stays inspectable for
#     forensics — the exact tension the source issue flags.
#   - Self-bounded: each `rm -rf` is wrapped in `timeout` so this guard can NEVER
#     itself wedge the runner on the same slow disk; a timed-out removal warns
#     and is left in place rather than hanging the job.
#   - Never fails the job: cleanup is best-effort defense-in-depth, not a gate.
#
# Env overrides (all optional):
#   REAP_ROOT         directory to scan (default: dirname of GITHUB_WORKSPACE —
#                     the runner's per-repo _work subdir holding the live
#                     checkout + any renamed-aside wedged remnants).
#   REAP_RETAIN_DAYS  keep wedged dirs modified within this many days (default 1).
#   REAP_RM_TIMEOUT   per-dir removal budget in seconds (default 120).
set -uo pipefail

reap_root="${REAP_ROOT:-}"
if [ -z "$reap_root" ]; then
  if [ -n "${GITHUB_WORKSPACE:-}" ]; then
    reap_root="$(dirname "$GITHUB_WORKSPACE")"
  else
    echo "reap-stale-workdirs: neither REAP_ROOT nor GITHUB_WORKSPACE set — nothing to do"
    exit 0
  fi
fi

retain_days="${REAP_RETAIN_DAYS:-1}"
rm_timeout="${REAP_RM_TIMEOUT:-120}"
retain_min=$(( retain_days * 1440 ))

if [ ! -d "$reap_root" ]; then
  echo "reap-stale-workdirs: reap root '$reap_root' absent — nothing to do"
  exit 0
fi

echo "reap-stale-workdirs: scanning '$reap_root' for switchroom.wedged-* older than ${retain_days}d"

found=0
reaped=0
while IFS= read -r -d '' d; do
  found=$(( found + 1 ))
  echo "reap-stale-workdirs: removing stale remnant '$d'"
  if timeout "$rm_timeout" rm -rf "$d"; then
    reaped=$(( reaped + 1 ))
  else
    echo "::warning::reap-stale-workdirs: rm of '$d' exceeded ${rm_timeout}s (disk may be wedged again) — leaving it and continuing"
  fi
done < <(find "$reap_root" -maxdepth 1 -type d -name 'switchroom.wedged-*' -mmin "+${retain_min}" -print0 2>/dev/null)

echo "reap-stale-workdirs: done — ${found} stale remnant(s) matched, ${reaped} removed"
exit 0
