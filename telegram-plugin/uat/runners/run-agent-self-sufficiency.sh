#!/usr/bin/env bash
# Run the agent-self-sufficiency UAT against the live fleet on this host.
#
# Why a wrapper script: the UAT runner needs three secrets out of the
# vault (TELEGRAM_API_ID / API_HASH / DRIVER_SESSION) plus the per-agent
# bot usernames. Pulling them inline here so an operator can run the
# whole suite with a single command:
#
#   ./telegram-plugin/uat/runners/run-agent-self-sufficiency.sh
#
# The vault prompts for its passphrase interactively (once); the script
# then exports the three secrets only into the bun subprocess, never to
# the surrounding shell.
#
# Override fleet selection with UAT_FLEET / UAT_ADMIN_AGENTS (see the
# runner's --help for the format).

set -euo pipefail

cd "$(dirname "$0")/../../.."  # → repo root

# ── 1. Pull the three UAT secrets from vault ────────────────────────────
# `switchroom vault get` prompts for the passphrase on first call and
# caches the unlocked broker for the session — subsequent gets are
# silent. We avoid passing tokens via argv so they don't show up in
# `ps`. Failed lookups fail loud.
echo "[uat] unlocking vault to read UAT secrets..."
TELEGRAM_API_ID="$(switchroom vault get telegram-uat-api-id)"
TELEGRAM_API_HASH="$(switchroom vault get telegram-uat-api-hash)"
TELEGRAM_UAT_DRIVER_SESSION="$(switchroom vault get telegram-uat-driver-session)"
export TELEGRAM_API_ID TELEGRAM_API_HASH TELEGRAM_UAT_DRIVER_SESSION

# ── 2. Discover the fleet from switchroom.yaml ──────────────────────────
# Operator may override by exporting UAT_FLEET / UAT_ADMIN_AGENTS
# explicitly. Otherwise we extract each agent's bot username from its
# token via getMe. This requires the operator to have read access to
# the per-agent .env files — if not, point UAT_FLEET at the right
# usernames manually.
if [[ -z "${UAT_FLEET:-}" ]]; then
  echo "[uat] UAT_FLEET not set — set it explicitly to:"
  echo "    UAT_FLEET=\"agent1:@bot1,agent2:@bot2,agent3:@bot3\""
  echo "    UAT_ADMIN_AGENTS=\"agent1,agent2\"   # optional"
  echo ""
  echo "    Bot usernames live in BotFather or can be read from each"
  echo "    agent's vault entry. Set them and re-run."
  exit 64
fi

# ── 3. Run ──────────────────────────────────────────────────────────────
exec bun telegram-plugin/uat/runners/agent-self-sufficiency.ts "$@"
