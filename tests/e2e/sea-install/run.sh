#!/bin/sh
# Reproduce the #4163 acceptance criterion end to end:
#
#   "A host that has only ever run `curl -fsSL … | sh` can run
#    `switchroom apply --non-interactive` and scaffold every agent, with no
#    SWITCHROOM_*_ROOT env override and no hand-staged directories."
#
# Builds the real release artifacts (static binary + asset payload + checksums),
# serves them over local HTTP inside a fresh Debian container, runs the REAL
# install.sh against them, and then applies. Not wired into CI — it needs a
# docker daemon and a bun toolchain — but it is the only check that exercises
# installer + payload + resolver + scaffold together.
#
# Usage:  sh tests/e2e/sea-install/run.sh
set -eu

repo=$(cd "$(dirname "$0")/../../.." && pwd)
work=${SR_E2E_WORK:-/var/tmp/sr-e2e}
version=v$(node -e "process.stdout.write(require('$repo/package.json').version)")

mkdir -p "$work/dist"
( cd "$repo" \
  && npm run build:cli \
  && node scripts/build-asset-payload.mjs --version "$version" --out switchroom-assets.tar.gz )
cp "$repo/switchroom-linux-amd64" "$repo/switchroom-assets.tar.gz" "$work/dist/"
( cd "$work/dist" \
  && sha256sum switchroom-linux-amd64 switchroom-assets.tar.gz > switchroom-checksums.txt )

docker build -q -t sr-e2e:latest -f "$(dirname "$0")/Dockerfile" "$(dirname "$0")"
docker run --rm \
  --label switchroom.test=e2e-4163 \
  -e SR_VERSION="$version" \
  -v "$work/dist:/artifacts:ro" \
  -v "$repo:/repo:ro" \
  sr-e2e:latest sh /repo/tests/e2e/sea-install/acceptance.sh
