#!/bin/sh
#
# switchroom-cli-wrapper.sh — run the switchroom CLI via bun, not node.
#
# Context: the packaged `switchroom` binary installed by `bun install -g
# switchroom-ai` has `#!/usr/bin/env node` as its shebang. On hosts that
# run bun but not node (which is switchroom's documented runtime), every
# invocation of the binary ENOENTs silently.
#
# The gateway in `telegram-plugin/gateway/gateway.ts` shells out via
# `execFileSync(SWITCHROOM_CLI_PATH, [...])` for slash-command actions.
# When that path points at the node-shebang binary on a node-less host
# every gateway command (/restart, /auth reauth, /reconcile, etc.) fails
# silently with nothing surfaced to Telegram — the exact "silent respawn"
# / "ready message hides broken state" anti-pattern called out in the
# restart-and-know-what-im-running JTBD.
#
# This wrapper avoids the node dependency by invoking the TypeScript
# entry point in the repo via bun directly. Point `SWITCHROOM_CLI_PATH`
# in the gateway unit at this file and the exact same argv is handled
# by the exact same CLI module, just with the right runtime.
#
# Resolution of the repo root:
#   SWITCHROOM_REPO — explicit override, wins if set
#   otherwise      — resolves two levels up from this script
#                    (scripts/switchroom-cli-wrapper.sh → repo root)
#
# Keep this as POSIX sh so it runs on minimal hosts without bash.

set -eu

if [ -n "${SWITCHROOM_REPO:-}" ]; then
  repo="$SWITCHROOM_REPO"
else
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  repo="$(cd "$script_dir/.." && pwd)"
fi

entry="$repo/bin/switchroom.ts"

if [ ! -f "$entry" ]; then
  echo "switchroom-cli-wrapper: entry not found at $entry" >&2
  echo "switchroom-cli-wrapper: set SWITCHROOM_REPO to the switchroom checkout root, or re-run reconcile from a host with the repo in place" >&2
  exit 127
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "switchroom-cli-wrapper: bun not found on PATH" >&2
  exit 127
fi

exec bun "$entry" "$@"
