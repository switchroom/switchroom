#!/bin/sh
# git-agent-attribution-hook.sh — deterministic `Switchroom-Agent:` /
# `Switchroom-Model:` commit trailers for work done inside a switchroom
# agent container.
#
# WHY THIS IS A HOOK AND NOT A RULE IN CLAUDE.md
# ----------------------------------------------
# Every PR and commit in the fleet's repos is authored by the operator's
# GitHub account, because agents commit with the operator's git identity.
# That is deliberate and stays. The cost is that `git log` cannot answer
# "which agent, on which model, produced this" — the only machine marker
# is the generic `Co-authored-by: Claude ...` trailer, which names no
# agent.
#
# A prompt rule ("always add these trailers") is model-dependent: it is
# forgotten under compaction, dropped by a sub-agent that never read the
# rule, and silently absent forever after. This hook makes the trailers a
# property of the ENVIRONMENT instead: any `git commit` run inside an
# agent container gets them, from `$SWITCHROOM_AGENT_NAME` and the live
# session model, with no model cooperation at all.
#
# WHY `prepare-commit-msg` AND NOT `commit-msg`
# ---------------------------------------------
# `git commit --no-verify` bypasses `pre-commit` and `commit-msg`. It does
# NOT bypass `prepare-commit-msg` (verified against git 2.47). Agents reach
# for `--no-verify` routinely to get past a slow or broken repo hook, so a
# `commit-msg` implementation would be one habitual flag away from silent
# non-attribution. `prepare-commit-msg` also runs for `git merge` and
# `git commit --amend`, and it puts the trailers in the message BEFORE the
# editor, so they are visible rather than injected behind the author's back.
#
# ACTIVATION
# ----------
# `docker/Dockerfile.agent` installs this file (read-only, in the image, at
# a path no agent can rewrite) as
# `/opt/switchroom/git-hooks/prepare-commit-msg`, and the scaffolded
# `start.sh` sets `git config --global core.hooksPath
# /opt/switchroom/git-hooks` on every boot. Global config means it applies
# to EVERY repo the agent clones, including worktrees, without per-repo
# setup — which is the point: a new clone must not be able to start out
# un-attributed.
#
# REPO-LOCAL HOOK CHAINING
# ------------------------
# `core.hooksPath` REPLACES `.git/hooks` wholesale, so a repo that installs
# its own `prepare-commit-msg` into `.git/hooks` (the `pre-commit`
# framework does exactly this) would silently stop running it. We therefore
# delegate to `$GIT_DIR/hooks/prepare-commit-msg` FIRST, propagate a
# non-zero exit from it, and only then append our trailers — so our
# trailers are the last word and cannot be clobbered by the repo hook
# rewriting the message. (husky and friends set `core.hooksPath` LOCALLY,
# and local config beats global, so those repos never reach this file.)
#
# NOT ADDED HERE: `Co-authored-by:`
# ---------------------------------
# Deliberate. `Co-authored-by: Claude ...` is the independent "a model
# wrote this" marker that `scripts/check-agent-attribution-trailers.mjs`
# keys off to decide whether the Switchroom-* trailers are REQUIRED. If
# this hook emitted it too, then disabling the hook would remove the
# marker and the evidence of its own absence in the same stroke, and CI
# could never go red. Keeping the two producers separate (model writes
# Co-authored-by, environment writes Switchroom-*) is what gives the CI
# check teeth.
#
# Exit code: always 0 unless a chained repo hook failed. Attribution must
# never be the reason a commit cannot be made.

set -u

MSG_FILE="${1-}"
COMMIT_SOURCE="${2-}"

[ -n "$MSG_FILE" ] || exit 0
[ -f "$MSG_FILE" ] || exit 0

# --- 1. Chain to the repo-local hook this one displaced -------------------
_git_dir="$(git rev-parse --git-dir 2>/dev/null || true)"
if [ -n "$_git_dir" ] && [ -x "$_git_dir/hooks/prepare-commit-msg" ]; then
  "$_git_dir/hooks/prepare-commit-msg" "$@" || exit $?
fi

# --- 2. Are we in an agent container? -------------------------------------
# `$SWITCHROOM_AGENT_NAME` is set by compose for every agent container and
# by nothing else. Absent ⇒ a human at a laptop, or a stray copy of this
# script: do nothing at all. A human commit must never be stamped with an
# agent name it did not come from.
AGENT="${SWITCHROOM_AGENT_NAME:-}"
[ -n "$AGENT" ] || exit 0

# `SWITCHROOM_ATTRIBUTION_DISABLE=1` is the documented, greppable escape
# hatch for the rare case where a trailer genuinely must not be written
# (e.g. replaying an upstream patch verbatim). It is intentionally an env
# var and not a config knob, so its use is confined to one command.
[ "${SWITCHROOM_ATTRIBUTION_DISABLE:-0}" = "1" ] && exit 0

# --- 3. Resolve the model -------------------------------------------------
# Chain, most specific first:
#   1. SWITCHROOM_SESSION_MODEL — exported by start.sh immediately before
#      `exec claude`, from the SAME `$_EFFECTIVE_MODEL` the session is
#      actually launched on (so a `/model` override is reflected).
#   2. SWITCHROOM_AGENT_MODEL   — the configured default, written into the
#      container env by compose. Covers shells that did not inherit
#      start.sh's export (a bare `docker exec`).
#   3. "unknown" — never empty: a present-but-unknown trailer still proves
#      the hook ran, and an empty trailer value would read as a bug.
MODEL="${SWITCHROOM_SESSION_MODEL:-}"
[ -n "$MODEL" ] || MODEL="${SWITCHROOM_AGENT_MODEL:-}"
[ -n "$MODEL" ] || MODEL="unknown"

# --- 4. Sanitize ----------------------------------------------------------
# A git trailer value is single-line by definition. Both inputs are
# operator-controlled rather than attacker-controlled, but they land
# verbatim in an argv passed to `git interpret-trailers`, so clamp them to
# a conservative charset and length regardless: anything else is replaced,
# not silently dropped, so a malformed value is visible in the log rather
# than mistaken for a different agent.
_sanitize() {
  printf '%s' "$1" \
    | tr -d '\n\r' \
    | sed 's/[^A-Za-z0-9._@:+/-]/_/g' \
    | cut -c1-100
}
AGENT="$(_sanitize "$AGENT")"
MODEL="$(_sanitize "$MODEL")"
[ -n "$AGENT" ] || exit 0
[ -n "$MODEL" ] || MODEL="unknown"

# --- 5. Write the trailers ------------------------------------------------
# `--if-exists doNothing` makes this idempotent: `--amend`, a rebase that
# re-runs the hook, and a `-c` reuse all leave a single pair of trailers
# rather than stacking duplicates.
git interpret-trailers \
  --in-place \
  --if-exists doNothing \
  --trailer "Switchroom-Agent: $AGENT" \
  --trailer "Switchroom-Model: $MODEL" \
  "$MSG_FILE" 2>/dev/null || true

# COMMIT_SOURCE is unused today but is part of the hook contract; naming it
# keeps `set -u` honest and documents that we deliberately stamp every
# source (message, template, merge, squash, commit/amend).
: "${COMMIT_SOURCE}"

exit 0
