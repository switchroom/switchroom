#!/usr/bin/env bash
# ci-infra-watchdog classifier — extracted from
# .github/workflows/ci-infra-watchdog.yml so it can be tested with a
# stubbed `gh` on PATH (the yaml-embedded version had no test at all).
#
# Contract (all inputs via env):
#   GH_TOKEN, REPO, RUN_ID, WF_NAME, HEAD_SHA, RUN_URL, RUN_CONCLUSION
#
# Outcomes:
#   - >=1 job with conclusion "failure"  -> genuine red, no alert, exit 0.
#   - 0 failing jobs                     -> infra force-fail signature,
#                                           open/de-dupe an issue, exit 0.
#   - classification read unavailable    -> ::warning + exit 0 (see below).
#
# Why the classification read retries, and why exhausting the retries is
# a warning rather than a failure:
#
# The read is a single idempotent GET. On 2026-07-20 the GitHub REST API
# brownouted and returned `HTTP 503 No server is currently available to
# service your request` to this step in three consecutive watchdog runs
# — 29709703593 (00:35Z), 29710301287 (01:01Z), 29710576955 (01:12Z).
# With `set -euo pipefail` and no retry, each 503 killed the step and
# painted `main` red. In all three the underlying workflow was a GENUINE
# red (the `scaffold.persona` byte-ceiling regression), so the correct
# outcome was the silent `exit 0` path — the watchdog reported a failure
# it was explicitly built NOT to report.
#
# Retrying the GET recovers the common single-blip case. Exhausting the
# retries means GitHub's own API is unavailable, which is precisely the
# gap this workflow's header already documents as accepted ("this is a
# backstop, not a guarantee"). Turning a GitHub outage into a red main
# is a false signal about the commit, so we degrade to a loud
# `::warning` annotation (visible on the run) and exit 0. We never
# *guess* a classification: no read, no alert.
set -euo pipefail

: "${REPO:?REPO required}"
: "${RUN_ID:?RUN_ID required}"
: "${WF_NAME:?WF_NAME required}"
: "${HEAD_SHA:?HEAD_SHA required}"
: "${RUN_URL:?RUN_URL required}"
: "${RUN_CONCLUSION:?RUN_CONCLUSION required}"

# Bounded retry knobs (overridable so the tests don't sleep for a minute).
WATCHDOG_MAX_ATTEMPTS="${WATCHDOG_MAX_ATTEMPTS:-5}"
WATCHDOG_BASE_DELAY="${WATCHDOG_BASE_DELAY:-2}"

# --paginate --slurp walks every page and wraps them as
# [{page1},{page2},...]; flatten .[].jobs[] so a run with >100 jobs whose
# failures land on page 2+ is still counted. Without this a large matrix
# could undercount failures to 0 and mis-classify a genuine red as an
# infra force-fail — the exact false-positive that defeats this watchdog.
jobs_json=""
attempt=1
delay="$WATCHDOG_BASE_DELAY"
while :; do
  if jobs_json="$(gh api "repos/$REPO/actions/runs/$RUN_ID/jobs?per_page=100" --paginate --slurp 2>&1)"; then
    break
  fi
  if [ "$attempt" -ge "$WATCHDOG_MAX_ATTEMPTS" ]; then
    echo "::warning title=ci-infra-watchdog could not classify::Reading jobs for run $RUN_ID failed $WATCHDOG_MAX_ATTEMPTS times (GitHub REST API unavailable). Skipping classification for $WF_NAME @ $HEAD_SHA — no alert raised, and no red reported for a GitHub-side outage. Last error: ${jobs_json}"
    exit 0
  fi
  echo "gh api attempt ${attempt}/${WATCHDOG_MAX_ATTEMPTS} failed; retrying in ${delay}s. Error: ${jobs_json}"
  sleep "$delay"
  attempt=$((attempt + 1))
  delay=$((delay * 2))
done

failed_jobs="$(echo "$jobs_json" | jq '[.[].jobs[] | select(.conclusion=="failure")] | length')"

if [ "${failed_jobs:-0}" -ne 0 ]; then
  echo "Run $RUN_ID ($WF_NAME): $failed_jobs job(s) reported failure — genuine red, not an infra force-fail. No alert."
  exit 0
fi

echo "Infra signature: $WF_NAME @ $HEAD_SHA concluded '$RUN_CONCLUSION' with 0 failing jobs (jobs skipped/queued/never-scheduled)."

# Idempotent label.
gh label create ci-infra-failure \
  --repo "$REPO" \
  --color B60205 \
  --description "Main CI red from infra/queue force-fail, not a code regression" \
  2>/dev/null || true

existing="$(gh issue list --repo "$REPO" --state open --label ci-infra-failure \
  --json number,title \
  --jq "[.[] | select(.title | contains(\"$HEAD_SHA\"))][0].number // empty")"

if [ -n "$existing" ]; then
  gh issue comment "$existing" --repo "$REPO" \
    --body "Another infra/queue force-fail on the same commit: **$WF_NAME** — run: $RUN_URL"
  echo "Commented on existing issue #$existing"
  exit 0
fi

body_file="$(mktemp)"
{
  printf '%s\n' "Automated infra alert — this is NOT a code or test regression."
  printf '%s\n' ""
  printf '%s\n' "Workflow \"$WF_NAME\" failed on main @ $HEAD_SHA, but no job reported"
  printf '%s\n' "a failure — every job was skipped, cancelled, or never scheduled."
  printf '%s\n' "That is the GitHub hosted-runner queue force-fail signature (jobs"
  printf '%s\n' "sit queued past the scheduling window and GHA fails the run before"
  printf '%s\n' "tests execute), or a workflow startup error. Either way, the test"
  printf '%s\n' "code never ran, so main is red on infra, not on the commit."
  printf '%s\n' ""
  printf '%s\n' "Failed run: $RUN_URL"
  printf '%s\n' ""
  printf '%s\n' "Recovery (workflow_dispatch was wired in #1340):"
  printf '%s\n' "    gh workflow run <workflow-file>.yml --ref main"
  printf '%s\n' "Re-dispatch the affected workflow(s), confirm green, then close"
  printf '%s\n' "this issue. If it recurs immediately, suspect a real GHA outage"
  printf '%s\n' "(check https://www.githubstatus.com) rather than re-dispatching"
  printf '%s\n' "in a loop."
  printf '%s\n' ""
  printf '%s\n' "cc @mekenthompson"
} > "$body_file"

gh issue create --repo "$REPO" \
  --title "CI infra: main red without job execution @ $HEAD_SHA" \
  --label ci-infra-failure \
  --body-file "$body_file"
echo "Opened new infra-alert issue."
