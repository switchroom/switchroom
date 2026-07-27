#!/usr/bin/env bash
#
# Warm the BuildKit builder image into the runner's LOCAL image store
# before `docker/setup-buildx-action` boots a builder.
#
# Why this exists (issue #3815):
#
#   `docker/setup-buildx-action`'s default `docker-container` driver boots
#   BuildKit by pulling `moby/buildkit:buildx-stable-1` from DOCKER HUB.
#   That pull is unauthenticated, un-retried, and happens before any
#   `docker/login-action` step. When docker.io is slow the job dies with
#
#     #1 [internal] booting buildkit
#     #1 ERROR: Error response from daemon:
#        Get "https://registry-1.docker.io/v2/": ... Client.Timeout exceeded
#
#   before it has built anything. It killed 19 of the 21 failed image jobs
#   between 2026-07-16 and 2026-07-27 and ejected four PRs from the merge
#   queue.
#
# Two layers of protection, both load-bearing:
#
#   1. This script retries the pull with bounded exponential backoff and
#      jitter, so a transient docker.io blip usually just costs a few
#      seconds. Jitter matters: a `docker-images` run fans out to ~13
#      buildx-booting jobs that all start within seconds of each other.
#
#   2. Even if every attempt here fails, buildx's own boot-time pull now
#      has somewhere to fall back to ONLY if we succeeded — see
#      buildx v0.35.0 `driver/docker-container/driver.go:108-116`:
#
#          // image pulling failed, check if it exists in local image store.
#          // if not, return pulling error. otherwise log it.
#          _, errInspect := d.DockerAPI.ImageInspect(ctx, imageName)
#          found := errInspect == nil
#          if !found { return err }
#          l.Wrap("pulling failed, using local image "+imageName, ...)
#
#      The fallback has always existed; nothing ever populated the local
#      store, so `ImageInspect` missed and the pull error was fatal. That
#      is why "warm the store" — not "retry the boot" — is the fix.
#
# HARD RULES:
#
#   * This script NEVER fails the job. It is an optimisation in front of
#     `docker/setup-buildx-action`, which remains the authority on whether
#     a builder could be created. Exiting non-zero here would turn a
#     recoverable warm-pull miss into a NEW failure mode. It always
#     `exit 0`; every give-up path is annotated so it is visible in the
#     run summary.
#
#   * It retries ONLY on recognised transient network/registry errors.
#     A non-transient error (bad pin, auth, dead daemon) breaks out on the
#     first attempt. This is what stops the retry from becoming a blanket
#     "run it again until it works" — and note that the only thing being
#     retried is a pull of the BUILDER image, which happens before any
#     Dockerfile is read, so it cannot mask a genuine build failure.
#
# Environment:
#   BUILDKIT_IMAGE             required — image ref to warm
#   BUILDKIT_WARM_ATTEMPTS     max pull attempts       (default 4)
#   BUILDKIT_WARM_BASE_DELAY   backoff base in seconds (default 5; 0 disables sleep)
#   DOCKER_BIN                 docker command          (default "docker")

set -uo pipefail

IMAGE="${BUILDKIT_IMAGE:-}"
ATTEMPTS="${BUILDKIT_WARM_ATTEMPTS:-4}"
BASE_DELAY="${BUILDKIT_WARM_BASE_DELAY:-5}"
DOCKER_BIN="${DOCKER_BIN:-docker}"

if [ -z "$IMAGE" ]; then
  echo "::warning title=BuildKit warm-pull skipped::BUILDKIT_IMAGE is empty"
  exit 0
fi

# Recognised transient failures — retry these.
TRANSIENT='Client\.Timeout|context deadline exceeded|request canceled|i/o timeout|TLS handshake timeout|connection reset by peer|connection refused|no such host|network is unreachable|dial tcp|temporary failure|unexpected EOF|toomanyrequests|Too Many Requests|received unexpected HTTP status: 5|50[0234] '

# Recognised permanent failures — never retry these. A bad pin or a dead
# daemon will not fix itself, and retrying only delays the real error that
# setup-buildx-action is about to report.
#
# Deliberately NARROW. Bare `denied` / `unauthorized` / `not found` would
# swallow Docker Hub's rate-limit and 404-from-a-flaky-CDN responses, which
# ARE worth retrying — this list is checked first, so an over-broad entry
# here silently disables the retry for the case it exists to handle.
FATAL='manifest unknown|manifest for .* not found|repository does not exist|pull access denied|unauthorized:|denied:|invalid reference format|Cannot connect to the Docker daemon'

if "$DOCKER_BIN" image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "warm-buildkit-image: $IMAGE already in the local image store — nothing to do."
  exit 0
fi

out=""
attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  echo "warm-buildkit-image: $DOCKER_BIN pull $IMAGE (attempt ${attempt}/${ATTEMPTS})"

  if out=$("$DOCKER_BIN" pull "$IMAGE" 2>&1); then
    printf '%s\n' "$out"
    if [ "$attempt" -gt 1 ]; then
      echo "::notice title=BuildKit warm-pull recovered::${IMAGE} pulled on attempt ${attempt}/${ATTEMPTS} after transient registry errors (issue #3815)"
    fi
    exit 0
  fi

  printf '%s\n' "$out"

  if printf '%s' "$out" | grep -Eqi -- "$FATAL"; then
    echo "::warning title=BuildKit warm-pull failed (not transient)::${IMAGE} — not retrying; letting docker/setup-buildx-action report the real error"
    exit 0
  fi

  if ! printf '%s' "$out" | grep -Eqi -- "$TRANSIENT"; then
    echo "::warning title=BuildKit warm-pull failed (unrecognised error)::${IMAGE} — not retrying; letting docker/setup-buildx-action report the real error"
    exit 0
  fi

  if [ "$attempt" -eq "$ATTEMPTS" ]; then
    break
  fi

  delay=$(( BASE_DELAY * (1 << (attempt - 1)) ))
  if [ "$delay" -gt 0 ]; then
    delay=$(( delay + RANDOM % 5 ))
  fi
  echo "::notice title=BuildKit warm-pull retry::transient registry error pulling ${IMAGE}; retrying in ${delay}s (attempt ${attempt}/${ATTEMPTS}, issue #3815)"
  [ "$delay" -gt 0 ] && sleep "$delay"
  attempt=$(( attempt + 1 ))
done

echo "::warning title=BuildKit warm-pull exhausted::${IMAGE} could not be pulled in ${ATTEMPTS} attempts (transient registry errors). docker/setup-buildx-action will try once more and fail loudly if Docker Hub is still unreachable. See issue #3815."
exit 0
