#!/usr/bin/env bash
# Publish dynamic shields.io-compatible badge JSON to a GitHub Gist.
# Called at the end of the eval-summary step with the current build's
# trigger + quality eval result JSONs already downloaded to evals/results/.
#
# Required env:
#   GITHUB_GIST_TOKEN — PAT with `gist` scope (fetched from cluster secret
#                       in the eval-summary step).
#
# Best-effort: any failure is logged and swallowed — bad badge updates
# should never fail the build.

set -uo pipefail

GIST_ID="${CLERK_BADGE_GIST_ID:-002f3482b19111d35e57c1903b3733e2}"

if [[ -z "${GITHUB_GIST_TOKEN:-}" ]]; then
  echo "publish-badges: GITHUB_GIST_TOKEN not set — skipping"
  exit 0
fi

shopt -s nullglob
results_dir="evals/results"

latest_of() {
  local files=( "$results_dir"/$1 )
  if [[ ${#files[@]} -eq 0 ]]; then return 1; fi
  ls -t "${files[@]}" | head -1
}

# Compute badge JSON from an eval-result file.
#   $1 = file, $2 = label
badge_from() {
  local file="$1" label="$2"
  python3 - "$file" "$label" <<'PY'
import json, sys
path, label = sys.argv[1], sys.argv[2]
data = json.load(open(path))
results = data.get("results", data) if isinstance(data, dict) else data
total = len(results)
passed = sum(1 for r in results if r.get("passed") or r.get("status") == "pass")
pct = (100 * passed / total) if total else 0
if pct >= 95: color = "brightgreen"
elif pct >= 85: color = "green"
elif pct >= 70: color = "yellow"
elif pct >= 50: color = "orange"
else: color = "red"
print(json.dumps({
    "schemaVersion": 1,
    "label": label,
    "message": f"{passed}/{total} ({pct:.0f}%)",
    "color": color,
}))
PY
}

build_tests_badge() {
  # We only reach this script if eval-summary ran, which implies the test
  # stages passed (hard dependency via `wait` barrier).
  cat <<'EOF'
{"schemaVersion":1,"label":"tests","message":"passing","color":"brightgreen"}
EOF
}

build_build_badge() {
  cat <<'EOF'
{"schemaVersion":1,"label":"build","message":"passing","color":"brightgreen"}
EOF
}

# Build the JSON patch body for the gist API:
#   PATCH /gists/{id}  { "files": { "file.json": { "content": "..." } } }
build_patch_body() {
  python3 <<PY
import json, os, sys
files = {}
for name in ["clerk-build.json","clerk-tests.json","clerk-trigger-evals.json","clerk-quality-evals.json"]:
    path = "/tmp/badges-out/" + name
    if os.path.exists(path):
        files[name] = {"content": open(path).read()}
print(json.dumps({"files": files}))
PY
}

mkdir -p /tmp/badges-out

build_build_badge > /tmp/badges-out/clerk-build.json
build_tests_badge > /tmp/badges-out/clerk-tests.json

trigger_file="$(latest_of 'trigger_*.json' || true)"
quality_file="$(latest_of 'quality_*.json' || true)"

if [[ -n "${trigger_file:-}" ]]; then
  badge_from "$trigger_file" "trigger evals" > /tmp/badges-out/clerk-trigger-evals.json
  echo "publish-badges: trigger = $(cat /tmp/badges-out/clerk-trigger-evals.json)"
fi

if [[ -n "${quality_file:-}" ]]; then
  badge_from "$quality_file" "quality evals" > /tmp/badges-out/clerk-quality-evals.json
  echo "publish-badges: quality = $(cat /tmp/badges-out/clerk-quality-evals.json)"
fi

BODY="$(build_patch_body)"

HTTP=$(curl -sS -o /tmp/badges-resp.json -w "%{http_code}" \
  -X PATCH \
  -H "Authorization: Bearer ${GITHUB_GIST_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/gists/${GIST_ID}" \
  -d "${BODY}" || echo "curl-failed")

if [[ "$HTTP" == "200" ]]; then
  echo "publish-badges: gist updated (gist ${GIST_ID})"
else
  echo "publish-badges: gist PATCH got HTTP ${HTTP}"
  head -c 500 /tmp/badges-resp.json
fi

exit 0
