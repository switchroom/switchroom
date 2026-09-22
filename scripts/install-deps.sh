#!/usr/bin/env bash
# Switchroom dependency installer for fresh Linux hosts.
#
# Installs: docker (with compose v2), node (≥20.11), npm, bun, and the
# `claude` and `switchroom` CLIs. Idempotent — safe to re-run.
#
# Tested on: Ubuntu 24.04 LTS, Ubuntu 26.04 LTS.
# Other Debian-derivatives (Pop!_OS, Linux Mint) should work; non-apt
# distros will need to install docker + node manually first.
#
# Usage:
#   curl -fsSL https://github.com/switchroom/switchroom/raw/main/scripts/install-deps.sh | sudo bash
#   # or
#   git clone … && cd switchroom && sudo ./scripts/install-deps.sh
#
# Why sudo: apt + npm-global both need root. The script un-roots itself
# for the bun install and adds the invoking user to the `docker` group.

set -euo pipefail

BOLD=$(printf '\033[1m')
RED=$(printf '\033[31m')
GREEN=$(printf '\033[32m')
YELLOW=$(printf '\033[33m')
BLUE=$(printf '\033[34m')
RESET=$(printf '\033[0m')

log()  { printf '%s>%s %s\n' "$BLUE" "$RESET" "$1"; }
ok()   { printf '%s+%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '%sx%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# Wrap the body in a main() function so a partial curl-to-bash download
# can't execute a half-script. Bash only starts running once the entire
# function body parses successfully.

main() {

# macOS has no getent and no apt. Fail here, before either command, so the
# error is the missing Linux installer rather than "getent: command not found".
if [ "$(uname -s)" = "Darwin" ]; then
  die "install-deps.sh uses apt and only runs on Linux. On macOS use ./install.sh for the CLI, and install Docker Desktop plus Node.js 20.11+ yourself (nodejs.org or a user prefix; Homebrew is optional)."
fi

# Resolve the invoking user even when called via `sudo`. The bun install
# writes to ~/.bun, which must end up in the operator's home, not /root.
target_user="${SUDO_USER:-$(id -un)}"
target_home=$(getent passwd "$target_user" | cut -d: -f6)
[ -n "$target_home" ] || die "Could not resolve home dir for $target_user"

# ---- preflight: must be root for apt + npm -g ----

if [ "$(id -u)" -ne 0 ]; then
  die "This script needs root for apt + npm -g. Re-run with: sudo $0"
fi

# ---- preflight: are we on apt? ----

if ! have apt-get; then
  die "This script assumes apt (Debian/Ubuntu). For other distros, install docker, node 20.11+, bun, and the npm package 'switchroom' manually."
fi

# ---- preflight: memory check ----

mem_gb=$(awk '/MemTotal/ {printf "%.1f", $2/1048576}' /proc/meminfo)
mem_int=$(awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo)
log "Detected ${BOLD}${mem_gb} GiB${RESET} RAM"
if [ "$mem_int" -lt 4 ]; then
  warn "Less than 4 GiB RAM. Switchroom's canonical target is 4 GiB minimum."
  warn "Agent containers + Claude Code + Docker daemon will likely OOM."
  warn "Recommend bumping the VM/host to ≥4 GiB before proceeding."
fi

# ---- preflight: disable unattended-upgrades during install ----
#
# Concurrent apt operations during heavy installs (especially nodejs's
# 25+ MB of archives) have OOM-killed VMs in install-validation runs.
# We stop the daemon for the duration and restart it on exit.

UU_PAUSED=0
if systemctl is-enabled unattended-upgrades 2>/dev/null | grep -q enabled; then
  log "Pausing unattended-upgrades for the duration of this install"
  systemctl stop unattended-upgrades 2>/dev/null || true
  UU_PAUSED=1
  # Restart on any exit path, success or failure.
  trap '[ "$UU_PAUSED" = 1 ] && systemctl start unattended-upgrades 2>/dev/null || true' EXIT
fi

# ---- apt update + base tools ----

log "Refreshing apt"
apt-get update -qq

log "Installing base tools (curl, ca-certificates, gnupg, tmux)"
apt-get install -y --no-install-recommends \
  curl ca-certificates gnupg tmux >/dev/null

# ---- node (≥ 20.11) ----

if have node; then
  node_v=$(node --version | tr -d 'v' | cut -d. -f1)
  if [ "$node_v" -ge 20 ]; then
    ok "node $(node --version) already installed"
  else
    # `apt-get install` against an already-installed package is a no-op —
    # it won't upgrade you across major versions. Bail with explicit
    # guidance rather than silently leaving the user on a broken setup.
    die "node $(node --version) is too old (need 20.11+) and apt won't upgrade it in-place.
   Remove it first (sudo apt-get purge nodejs npm) and re-run this script,
   or install Node 20+ from NodeSource (https://github.com/nodesource/distributions)."
  fi
else
  log "Installing node + npm from distro repo"
  # Ubuntu 24.04 LTS / 26.04 ship node 22 in main; older distros need
  # NodeSource — `die`d on above if the user has stale node already.
  apt-get install -y --no-install-recommends nodejs npm >/dev/null
  ok "node $(node --version) installed"
fi

# ---- docker (engine + compose v2) ----

if have docker && docker compose version >/dev/null 2>&1; then
  ok "docker $(docker --version | awk '{print $3}' | tr -d ',') + compose v2 already installed"
else
  log "Installing docker engine + compose v2 via get.docker.com"
  # Docker's official convenience script doesn't publish a separate
  # checksum file, so this is a trust-on-fetch download. The script
  # itself is fetched over HTTPS from docker.com and is widely audited;
  # operators with stricter requirements should follow the per-distro
  # install guide at docs.docker.com instead.
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh >/dev/null
  rm -f /tmp/get-docker.sh
  ok "docker installed"
fi

# Add invoking user to docker group so they don't need sudo
if ! groups "$target_user" | tr ' ' '\n' | grep -qx docker; then
  log "Adding $target_user to the docker group"
  usermod -aG docker "$target_user"
  warn "$target_user must log out + back in (or run 'newgrp docker') for the group change to take effect."
fi

# ---- bun ----
#
# bun is a hard runtime dep of the npm-installed `switchroom` shim
# (#!/usr/bin/env bun). We install via npm-global so it lands in
# /usr/local/bin and is discoverable by the shebang without any
# PATH gymnastics.

if have bun; then
  ok "bun $(bun --version) already installed"
else
  log "Installing bun (required by switchroom CLI shebang)"
  npm install -g --silent bun >/dev/null
  ok "bun $(bun --version) installed"
fi

# ---- claude + switchroom ----

log "Installing @anthropic-ai/claude-code + switchroom (npm global)"
npm install -g --silent @anthropic-ai/claude-code switchroom >/dev/null
ok "claude $(claude --version 2>/dev/null | head -1)"
ok "switchroom $(switchroom --version 2>/dev/null || echo 'installed')"

# ---- final guidance ----

cat <<NEXT

${GREEN}${BOLD}Dependencies installed.${RESET}

Next steps:
  1. ${BOLD}Log out and back in${RESET} (or run 'newgrp docker') so the
     'docker' group membership takes effect for $target_user.
  2. Run the setup wizard:
       ${BOLD}switchroom setup${RESET}
  3. See ${BOLD}docs/install.md${RESET} for the full new-user walkthrough
     including BotFather setup.

Versions:
  docker:     $(docker --version | awk '{print $3}' | tr -d ',')
  compose:    $(docker compose version --short 2>/dev/null || echo '?')
  node:       $(node --version)
  bun:        $(bun --version 2>/dev/null || echo '?')
  claude:     $(claude --version 2>/dev/null | head -1 | awk '{print $1}')
  switchroom: $(switchroom --version 2>/dev/null || echo '?')

NEXT

} # end main

main "$@"
