#!/bin/sh
# Switchroom static-binary installer.
#
# POSIX sh, deliberately. The documented invocation below pipes this file to
# `sh`, and on Debian/Ubuntu `/bin/sh` is dash — where the old
# `#!/usr/bin/env bash` + `set -euo pipefail` header aborted on line 1 with
# "Illegal option -o pipefail" before a single byte was installed. The shebang
# does not save it either: a piped script has no shebang. Keep this file free
# of bashisms (#4163).
#
# Detects platform/arch, fetches the matching pre-built `switchroom`
# binary from the latest GitHub release, verifies its SHA256 checksum,
# and installs it to /usr/local/bin (falls back to ~/.local/bin if
# /usr/local/bin is not writable).
#
# It ALSO fetches the shipped-asset payload (#4163). `bun build --compile`
# embeds the JS bundle and nothing else, so `profiles/`, `skills/`,
# `vendor/hindsight-memory/` and the dashboard UI have no on-disk home in a
# binary-only install — and without them `switchroom apply` cannot scaffold a
# single agent ("Profile not found: default"). The payload is verified against
# the same checksums file as the binary and extracted to
# <prefix>/share/switchroom, which is exactly where the CLI probes.
#
# Usage:
#   curl -fsSL https://github.com/switchroom/switchroom/raw/main/install.sh | sh
#
# Environment overrides:
#   SWITCHROOM_INSTALL_DIR   target dir (default: /usr/local/bin or ~/.local/bin)
#   SWITCHROOM_VERSION       pin a specific tag (default: latest release)
#   SWITCHROOM_SHARE_DIR     asset payload dir (default: <prefix>/share/switchroom)
#   SWITCHROOM_BASE_URL      override the release download base (offline / testing)
#
# The binary is self-contained (bun runtime is bundled). You'll still
# need the `claude` CLI installed separately to run agents — see
# https://github.com/switchroom/switchroom for the full setup guide.

# `-o pipefail` is not POSIX (see the header). Nothing here depends on it:
# every pipeline whose failure matters is checked for an empty result.
set -eu

REPO="switchroom/switchroom"

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

# ---- platform / arch detection ----

uname_s=$(uname -s)
case "$uname_s" in
  Linux)   platform=linux ;;
  Darwin)  platform=macos ;;
  *)       die "Unsupported OS: $uname_s. Switchroom static binaries ship for Linux and macOS only." ;;
esac

uname_m=$(uname -m)
case "$uname_m" in
  x86_64|amd64)   arch=amd64 ;;
  aarch64|arm64)  arch=arm64 ;;
  *)              die "Unsupported architecture: $uname_m. Switchroom static binaries ship for amd64 and arm64 only." ;;
esac

asset="switchroom-${platform}-${arch}"

# The shipped-asset payload (#4163). Deliberately NOT versioned in the
# filename: release assets are already namespaced by the tag in their download
# URL, exactly like the four binaries and the checksums file, and a
# `${version}` here would be a second thing for the installer and
# `switchroom update` to derive independently and get wrong.
# scripts/release-assets.mjs parses this literal out of this file and fails
# `npm run lint` if the workflow stops producing it.
assets_payload="switchroom-assets.tar.gz"

log "Detected ${BOLD}${platform}/${arch}${RESET}, will fetch ${BOLD}${asset}${RESET}"

# ---- prerequisites ----

have curl || die "curl is required."
have tar  || die "tar is required (the shipped-asset payload is a .tar.gz)."

# Either sha256sum (linux) or shasum (macos) works for verification.
if have sha256sum; then
  sha_cmd="sha256sum"
elif have shasum; then
  sha_cmd="shasum -a 256"
else
  die "sha256sum or shasum is required for checksum verification."
fi

# ---- resolve version ----

version="${SWITCHROOM_VERSION:-}"
if [ -z "$version" ]; then
  log "Resolving latest release tag from github.com/${REPO}"
  api_url="https://api.github.com/repos/${REPO}/releases/latest"
  # Grep tag_name out of the JSON without needing jq.
  version=$(curl -fsSL "$api_url" | grep '"tag_name"' | head -n 1 | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
  [ -n "$version" ] || die "Could not determine latest release tag from $api_url."
fi

ok "Version: $version"

# GHCR auth: anonymous `docker pull` against ghcr.io returns 401 even for
# public images (the registry always wants a bearer token), so probing
# from the installer was always going to flap or false-positive. We just
# tell the user what to do if `docker compose pull` later fails — see the
# "Next" block at the end of this script.

# ---- download binary + checksums ----

base_url="${SWITCHROOM_BASE_URL:-https://github.com/${REPO}/releases/download/${version}}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

log "Downloading $asset"
curl -fsSL --retry 3 -o "$tmp/$asset" "$base_url/$asset" \
  || die "Failed to download $base_url/$asset (does this release ship static binaries? need v-tag with the release workflow active)."

log "Downloading checksums"
curl -fsSL --retry 3 -o "$tmp/switchroom-checksums.txt" "$base_url/switchroom-checksums.txt" \
  || die "Failed to download $base_url/switchroom-checksums.txt."

# ---- verify checksums ----

# The checksums file uses the `sha256sum`-canonical "<hash>  <file>"
# two-space format. Older revisions of this script grep'd with a
# pattern that only tolerated a single trailing space and was anchored
# at end-of-line, which mis-fired on some platforms (BSD grep regex
# alternation, CRLF line endings) and silently missed valid entries.
# Use a fixed-string match against the exact two-space-prefixed asset
# name to find the line.
checksum_for() {
  # `|| true`: under `set -e` a grep that matches nothing would otherwise take
  # the whole command substitution's exit status non-zero at the call site,
  # aborting the install with no message instead of reaching the
  # "No checksum entry" die below. Callers test for an EMPTY result.
  { grep -F "  ${1}" "$tmp/switchroom-checksums.txt" || true; } | awk '{print $1}' | head -n 1
}

verify_sha() {
  # $1 = asset name. Dies on mismatch; never installs an unverified file.
  _expected=$(checksum_for "$1")
  [ -n "$_expected" ] || die "No checksum entry for $1 in switchroom-checksums.txt."
  _actual=$($sha_cmd "$tmp/$1" | awk '{print $1}')
  if [ "$_expected" != "$_actual" ]; then
    die "Checksum mismatch for $1. Expected $_expected, got $_actual."
  fi
  ok "Checksum verified for $1 ($_expected)"
}

log "Verifying SHA256"
verify_sha "$asset"
chmod +x "$tmp/$asset"

# ---- download + verify the shipped-asset payload (#4163) ----
#
# A binary with no payload installs fine and then fails at the first useful
# thing you ask it to do. Distinguish the two reasons it can be absent:
#
#   - no checksum entry  -> this release predates the payload. Warn loudly and
#     continue; the operator asked for an old version and gets the old (broken
#     for scaffolding) behaviour, stated plainly rather than discovered later.
#   - entry present, download or verification fails -> this release is
#     incomplete or the artifact is corrupt. Die. Installing half of a release
#     is how #4163 happened in the first place.
payload_available=""
if [ -n "$(checksum_for "$assets_payload")" ]; then
  payload_available=1
  log "Downloading $assets_payload"
  curl -fsSL --retry 3 -o "$tmp/$assets_payload" "$base_url/$assets_payload" \
    || die "Failed to download $base_url/$assets_payload. The checksums file lists it, so this release is incomplete — not installing a CLI that cannot scaffold."
  verify_sha "$assets_payload"
else
  warn "Release $version ships no $assets_payload. Agent scaffolding (\`switchroom apply\`) needs profiles/, skills/ and vendor/ on disk and WILL fail on this version — upgrade to a release that ships the asset payload."
fi

# ---- choose install dir ----

install_dir="${SWITCHROOM_INSTALL_DIR:-}"
if [ -z "$install_dir" ]; then
  if [ -w /usr/local/bin ] || ([ -d /usr/local/bin ] && [ "$(id -u)" -eq 0 ]); then
    install_dir="/usr/local/bin"
  else
    install_dir="$HOME/.local/bin"
    mkdir -p "$install_dir"
    case ":$PATH:" in
      *":$install_dir:"*) ;;
      *) warn "$install_dir is not on your PATH. Add it to your shell profile to run 'switchroom'." ;;
    esac
  fi
fi

target="$install_dir/switchroom"

# ---- install the asset payload FIRST (#4163) ----
#
# Two artifacts, one release, and no syscall that swaps both at once. So:
# the payload lands before the binary, each by an atomic rename. If this
# script is killed between them the host has NEW templates + OLD (or no)
# binary — the recoverable direction — and never a new CLI rendering agent
# scaffolds from stale templates, which is the failure mode #4163 names as
# worse than shipping nothing.
#
# The layout matches what `switchroom update`'s self-update writes and what
# src/util/shipped-assets.ts probes:
#
#   <prefix>/share/switchroom-<version>/     extracted payload
#   <prefix>/share/switchroom -> switchroom-<version>
#
# The extract-then-publish split means a failed download or a corrupt archive
# never touches the live payload. The final `ln -s` is NOT atomic here (there
# is no portable atomic symlink swap in POSIX sh — `mv -T` is GNU-only), so
# there is a sub-millisecond window on an UPGRADE install where <share_dir>
# does not exist. That is deliberate and bounded: a torn payload has no
# manifest, `switchroom doctor` reports it and `switchroom update` reinstalls
# it. `switchroom update`'s own self-update path, which runs far more often,
# does do the atomic rename(2) swap (src/cli/self-update.ts).

# One decision about privilege, used for both artifacts.
SUDO=""
if [ ! -w "$install_dir" ]; then
  if have sudo; then
    warn "$install_dir requires sudo"
    SUDO="sudo"
  else
    die "$install_dir is not writable and sudo not available. Set SWITCHROOM_INSTALL_DIR to a writable directory."
  fi
fi

if [ -n "$payload_available" ]; then
  share_dir="${SWITCHROOM_SHARE_DIR:-$(dirname "$install_dir")/share/switchroom}"
  share_parent=$(dirname "$share_dir")
  payload_version="${version#v}"
  version_dir="${share_dir}-${payload_version}"

  log "Installing shipped assets to $share_dir"
  $SUDO mkdir -p "$share_parent"
  $SUDO rm -rf "${version_dir}.incoming" "$version_dir"
  $SUDO mkdir -p "${version_dir}.incoming"
  $SUDO tar -xzf "$tmp/$assets_payload" -C "${version_dir}.incoming" \
    || die "Failed to unpack $assets_payload into ${version_dir}.incoming."

  # Prove the tarball really is this release's payload before publishing it:
  # these files become every agent's container entrypoint template.
  manifest="${version_dir}.incoming/switchroom-assets.json"
  [ -f "$manifest" ] \
    || die "$assets_payload contains no switchroom-assets.json — refusing to install an unidentifiable payload."
  manifest_version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' "$manifest" | head -n 1)
  if [ "$manifest_version" != "$payload_version" ]; then
    die "$assets_payload declares version '$manifest_version' but this is release $version — refusing to pair a CLI with someone else's templates."
  fi

  $SUDO mv "${version_dir}.incoming" "$version_dir"
  if [ -e "$share_dir" ] && [ ! -L "$share_dir" ]; then
    warn "$share_dir already exists as a real directory — moving it to ${share_dir}.replaced"
    $SUDO rm -rf "${share_dir}.replaced"
    $SUDO mv "$share_dir" "${share_dir}.replaced"
  fi
  $SUDO rm -f "$share_dir"
  $SUDO ln -s "$(basename "$version_dir")" "$share_dir"
  ok "Shipped assets installed ($share_dir -> $(basename "$version_dir"))"
fi

log "Installing to $target"
if [ -z "$SUDO" ]; then
  mv "$tmp/$asset" "$target"
else
  sudo mv "$tmp/$asset" "$target"
fi

# macOS Gatekeeper: unsigned binaries get the quarantine xattr from curl.
# Strip it so the user doesn't have to right-click > Open the first time.
if [ "$platform" = "macos" ] && have xattr; then
  xattr -d com.apple.quarantine "$target" 2>/dev/null || true
fi

# Sequoia (macOS 15+) adds a notarization re-check that survives the
# xattr strip — the OS still prompts on first run. Best-effort whitelist
# the binary with spctl so it's allowed without the dialog. Requires
# admin / sudo and is silently no-op'd if either is unavailable.
if [ "$platform" = "macos" ] && have spctl; then
  if [ -w "$(dirname "$target")" ]; then
    spctl --add "$target" 2>/dev/null || true
  elif have sudo; then
    sudo spctl --add "$target" 2>/dev/null || true
  fi
fi

ok "Installed switchroom to $target"

# ---- verify ----

if "$target" version >/dev/null 2>&1; then
  printf '\n%s%sDone.%s ' "$BOLD" "$GREEN" "$RESET"
  "$target" version
else
  warn "Installed but 'switchroom version' did not exit cleanly. Try running it manually."
fi

cat <<'NEXT'

Next:
  switchroom setup            # interactive config + Telegram wiring
  switchroom doctor           # sanity check the environment

Note: the static binary bundles its runtime, but you still need the
`claude` CLI installed (npm i -g @anthropic-ai/claude-code) to run agents.

If `docker compose pull` later fails with 401 from ghcr.io, log in once:
  gh auth login --hostname github.com --scopes read:packages
  gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin
See docs/operators/install.md#ghcr-auth for details.

Docs: https://switchroom.ai
NEXT
