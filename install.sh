#!/usr/bin/env bash
# Switchroom installer.
#
# Bootstraps a fresh Ubuntu box to run switchroom agents:
# apt deps, bun, node 22 via nvm, claude CLI, switchroom-ai.
# Does NOT configure anything — run `switchroom setup` after.
#
# Usage:
#   curl -fsSL https://get.switchroom.ai | bash
#   curl -fsSL https://raw.githubusercontent.com/switchroom/switchroom/main/install.sh | bash
#
# Idempotent. Safe to re-run.

set -euo pipefail

BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m'); BLUE=$(printf '\033[34m')
RESET=$(printf '\033[0m')

log()   { printf '%s▸%s %s\n' "$BLUE" "$RESET" "$1"; }
ok()    { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn()  { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()   { printf '%s✗%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

# ---- preflight ----

[ "$(uname -s)" = "Linux" ] || die "Linux only. Systemd is core to the design; macOS and Windows aren't supported."

have() { command -v "$1" >/dev/null 2>&1; }

need_sudo() {
  if ! have sudo; then
    die "sudo not found. Install sudo or run as root."
  fi
}

printf '%s\n' "$BOLD"
cat <<'BANNER'
  Switchroom installer
  Bootstraps bun, node, claude CLI, and switchroom-ai.
BANNER
printf '%s\n' "$RESET"

# ---- apt deps ----

log "Checking apt dependencies (tmux, expect, sqlite3, curl, git)"
need_apt=()
for pkg in tmux expect sqlite3 curl git; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    need_apt+=("$pkg")
  fi
done

if [ ${#need_apt[@]} -gt 0 ]; then
  warn "Installing: ${need_apt[*]} (requires sudo)"
  need_sudo
  sudo apt-get update -qq
  sudo apt-get install -y -qq "${need_apt[@]}"
  ok "apt packages installed"
else
  ok "apt packages already present"
fi

# ---- bun ----

if have bun; then
  ok "bun already installed ($(bun --version))"
else
  log "Installing bun"
  curl -fsSL https://bun.sh/install | bash
  # bun installs to ~/.bun/bin — surface it for this shell
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  have bun || die "bun install completed but 'bun' not on PATH. Re-source your shell and re-run."
  ok "bun installed ($(bun --version))"
fi

# ---- node via nvm ----

NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
need_node_install=0

if have node; then
  node_major=$(node -v | sed 's/v//' | cut -d. -f1)
  node_minor=$(node -v | sed 's/v//' | cut -d. -f2)
  if [ "$node_major" -ge 21 ] || { [ "$node_major" -eq 20 ] && [ "$node_minor" -ge 11 ]; }; then
    ok "node already installed ($(node -v))"
  else
    warn "node $(node -v) is below required 20.11, installing 22 via nvm"
    need_node_install=1
  fi
else
  log "Installing node 22 via nvm"
  need_node_install=1
fi

if [ "$need_node_install" = "1" ]; then
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm use 22
  ok "node installed ($(node -v))"
fi

# ---- claude CLI + switchroom-ai ----

log "Installing @anthropic-ai/claude-code and switchroom-ai globally via npm"
npm install -g --silent @anthropic-ai/claude-code switchroom-ai
ok "CLIs installed"

have claude     || warn "claude not on PATH — open a new shell or run: export PATH=\"$(npm prefix -g)/bin:\$PATH\""
have switchroom || warn "switchroom not on PATH — open a new shell or run: export PATH=\"$(npm prefix -g)/bin:\$PATH\""

# ---- done ----

printf '\n%s%sDone.%s\n\n' "$BOLD" "$GREEN" "$RESET"
cat <<'NEXT'
  Next:
    switchroom setup            # interactive config + Telegram wiring
    switchroom doctor           # sanity check the environment

  Docs: https://switchroom.ai · https://github.com/switchroom/switchroom
NEXT
