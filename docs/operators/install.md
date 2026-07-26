# Operator install — Docker fleet from GHCR

Switchroom publishes its container images to GitHub Container Registry
(GHCR). The fleet pulls four runtime images —
`ghcr.io/switchroom/switchroom-{agent,broker,kernel,auth-broker}`
(`switchroom-base` is a build-stage parent, not pulled at runtime).
The supported install path on Linux pulls those images and brings the
fleet up via `docker compose`. No `docker build` on the operator's host.

## Prerequisites

- Linux (Ubuntu 24.04 LTS canonical; other distros work).
- Docker Engine 24+ with the compose v2 plugin (`docker compose ...`).
- The `claude` CLI on the host (`npm i -g @anthropic-ai/claude-code`,
  Node 20.11+) for OAuth. The agent runtime itself ships in
  containers — the host only needs `claude` for the
  `switchroom auth add --via-claude` flow.

## Install — one-liner (recommended)

```sh
curl -fsSL https://github.com/switchroom/switchroom/raw/main/install.sh | sh
```

This drops a self-contained `switchroom` binary in `/usr/local/bin`
(falls back to `~/.local/bin` if the former isn't writable). The
`switchroom` binary itself needs no `bun`, `node`, or source checkout;
the agent runtime is pulled from GHCR by Docker. Note: the OAuth step
below still requires the `claude` CLI on the host (Node 20.11+, per
Prerequisites) — that requirement is not optional even on the binary
install.

**On macOS, use this one-liner — do not download the binary from the
Releases page in a browser.** The published `switchroom-macos-*` binaries
are ad-hoc signed (which is what makes them runnable on Apple Silicon) but
**not Apple-notarized** — the repo has no Developer ID credentials, tracked
in #3634. `curl` does not set the `com.apple.quarantine` xattr, so the
one-liner is unaffected by Gatekeeper. A browser download *is* quarantined,
and macOS 15 (Sequoia) removed the right-click → Open bypass, so it will be
refused until you allow it under System Settings → Privacy & Security. macOS
remains a development target, not a release-validated one (see the README).

Then bring up your fleet:

```sh
# 1. Interactive first-time wiring (Telegram bot token, vault, first agent).
switchroom setup

# 2. Authenticate with your Claude subscription (one OAuth flow,
#    fleet-wide). The auth-broker becomes the sole writer of every
#    agent's credentials.
switchroom auth add me --via-claude
switchroom auth use me

# 3. Scaffold agents + write ~/.switchroom/compose/docker-compose.yml.
switchroom apply

# 4. Bring the fleet up.
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml pull
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
```

`switchroom apply` only scaffolds + writes the compose file — it does
not call `docker`. Operators control the bring-up so the CLI never has
to second-guess your docker setup, daemon socket, or rootless config.

## Install — from source (development)

If you're hacking on switchroom itself, install from a checkout instead:

```sh
git clone https://github.com/switchroom/switchroom.git ~/code/switchroom
cd ~/code/switchroom
bun install
bun run build
bun link               # adds the dev `switchroom` to PATH
switchroom setup
switchroom apply
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
```

## Image refs

The generated compose pins each service to a tagged GHCR ref:

```
ghcr.io/switchroom/switchroom-broker:latest
ghcr.io/switchroom/switchroom-kernel:latest
ghcr.io/switchroom/switchroom-auth-broker:latest
ghcr.io/switchroom/switchroom-agent:latest
```

(Four runtime images: `broker`, `kernel`, `auth-broker`, `agent`.
`base` is a build-stage parent, not pulled; `hindsight`/`hostd` run in
their own separate compose projects.)

`:latest` floats with the canonical repo's `main`. To pin to a specific
release tag, set `imageTag` directly when calling `generateCompose()`
programmatically (CLI-level `--image-tag` plumbing is a follow-up).

## Dev-time: building locally

When you're iterating on the Dockerfiles themselves (or on the source
that gets baked into the images via `npm run build`), you don't want
`docker compose up` to pull a stale GHCR image. Use `--build-local`:

```sh
cd ~/code/switchroom
switchroom apply --build-local        # context = cwd
# or
switchroom apply --build-local /alt/checkout/path

docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d --build
```

This emits `build:` blocks instead of `image:` refs in the generated
compose. Pass `--build` to `docker compose up` to actually rebuild. The
production path (no flag) is unaffected.

## Upgrading

For the static-binary install, re-run the installer to pick up a newer
release, then re-apply + pull + up:

```sh
curl -fsSL https://github.com/switchroom/switchroom/raw/main/install.sh | sh
switchroom apply
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml pull
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
```

For the source install:

```sh
cd ~/code/switchroom
git pull
bun install
bun run build
switchroom apply
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml pull
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
```

## Troubleshooting

- **First `docker compose up` is slow** — pulls 4 images
  (~1-2 GB total) on a fresh host. Subsequent `up` calls only pull
  changed layers.
- **`unauthorized` on pull** — the published images are public; if you
  see auth errors, you're either pointing at a private fork or your
  Docker daemon is configured with a stale GHCR credential. `docker
  logout ghcr.io` clears it.
- **`docker compose up` hangs** — usually compose waiting for a
  `depends_on` healthcheck. Inspect with `docker compose -p switchroom
  ps` in another terminal.

<a id="ghcr-auth"></a>
## GHCR auth

Switchroom's container images are intended to be public on
`ghcr.io/switchroom/...`. If you've forked the repo, or if the org's
package visibility is set to private, anonymous `docker pull` will
return `401 Unauthorized`. The fix is to authenticate Docker against
GHCR with a personal access token that has `read:packages` scope. The
easiest path uses the GitHub CLI:

```sh
# Mint a token with read:packages scope (interactive, one-time).
gh auth login --hostname github.com --scopes read:packages

# Hand the token to docker. -u must be your GitHub username.
gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin
```

Subsequent `docker compose pull` calls will reuse the credential cached
in `~/.docker/config.json`. To clear it: `docker logout ghcr.io`.

If you don't have `gh` available, mint a classic PAT via the GitHub
web UI (Settings → Developer settings → Personal access tokens →
`read:packages`) and pipe it into `docker login ghcr.io -u <user> --password-stdin` directly.

## Related

- `runtime-mode.md` — Docker is the only supported runtime in v0.7+.
- `.github/workflows/docker-images.yml` — the GHCR build/push workflow.
- `.github/workflows/release.yml` — builds the static `switchroom` binaries
  that `install.sh` downloads, and attaches them (plus
  `switchroom-checksums.txt`) to each `vX.Y.Z` GitHub Release.
