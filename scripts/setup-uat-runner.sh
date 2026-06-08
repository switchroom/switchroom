#!/usr/bin/env bash
# Build + register the SANDBOXED GitHub Actions runner that runs switchroom's
# behavioural UAT (label: uat-host) — a real inbound→reply round-trip on each
# claude CLI bump (and other UAT-relevant changes).
#
# Isolation by construction (the whole point — switchroom is a PUBLIC repo, so a
# runner must not be a foothold next to the vault/fleet):
#   - non-root user, no-new-privileges, mem/pids capped
#   - NO docker socket, NO host bind-mounts
#   - bridge network = egress only (reaches Telegram + GitHub; cannot touch the
#     host's 127.0.0.1 fleet/vault services)
#   - the host-mutating jtbd-restart UAT scenarios self-skip (no sudo) — only the
#     network-only fuzz / inbound-no-drop round-trips run here.
#
# Pair this with (one-time, in the repo's GitHub settings):
#   - Actions → fork-PR approval = "all external contributors" (so a fork PR
#     can't run on the runner without an explicit approve). This script sets it.
#   - repo variable UAT_GATE_ENABLED=true + the 4 TELEGRAM_* secrets (this
#     script pushes them from ./.env if present).
#
# Requires: docker, gh (authenticated with admin on the repo), and a repo-root
# .env carrying TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_TEST_BOT_USERNAME
# / TELEGRAM_UAT_DRIVER_SESSION (from `bun run uat:login`).
set -euo pipefail

REPO="${SWITCHROOM_REPO:-switchroom/switchroom}"
IMAGE="switchroom-uat-runner:local"
CONTAINER="switchroom-uat-runner"
VOLUME="uat-runner-data"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> build sandboxed runner image"
docker build -t "$IMAGE" -f "$HERE/docker/Dockerfile.uat-runner" "$HERE/docker"

echo "==> push UAT secrets + gate var from .env (if present)"
if [ -f "$HERE/.env" ]; then
  for k in TELEGRAM_API_ID TELEGRAM_API_HASH TELEGRAM_TEST_BOT_USERNAME TELEGRAM_UAT_DRIVER_SESSION; do
    v="$(grep -E "^${k}=" "$HERE/.env" | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//')"
    [ -n "$v" ] && printf '%s' "$v" | gh secret set "$k" --repo "$REPO" && echo "   set $k"
  done
  gh variable set UAT_GATE_ENABLED --repo "$REPO" --body "true"
fi

echo "==> harden: require approval for outside-collaborator fork PRs"
gh api -X PUT "repos/${REPO}/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=all_external_contributors >/dev/null

echo "==> register + run the runner (config persists in the $VOLUME volume)"
REG_TOKEN="$(gh api -X POST "repos/${REPO}/actions/runners/registration-token" --jq .token)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --security-opt no-new-privileges \
  --memory=3g --pids-limit=2000 \
  -v "${VOLUME}:/actions-runner" \
  -e RUNNER_TOKEN="$REG_TOKEN" \
  "$IMAGE"

echo "==> done. Verify: gh api repos/${REPO}/actions/runners --jq '.runners[].status'"
echo "    Then run the gate: gh workflow run ci-uat.yml --repo ${REPO}"
