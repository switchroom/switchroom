#!/bin/sh
# Migration notice for the retired Switchroom installer.
#
# Older Switchroom docs told people to run:
#   curl -fsSL https://github.com/switchroom/switchroom/raw/main/scripts/install-deps.sh | sudo bash
# That installer belonged to the original Node/Bun Switchroom, which now lives
# in the archived repository switchroom/switchroom-classic. This repository is
# the Hermes-based Switchroom and ships as a container image, so there is no
# host dependency installer. This stub installs nothing and exits non-zero so
# an automated run cannot mistake it for a successful install.

printf '%s\n' \
  'Switchroom has moved to a new, Hermes-based design.' \
  '' \
  'This script used to install Docker, Node, Bun and the `switchroom` CLI for the' \
  'original Switchroom. That version is retired:' \
  '  - source (archived): https://github.com/switchroom/switchroom-classic' \
  '  - npm package: deprecated' \
  '' \
  'Nothing was installed.' \
  '' \
  'The new Switchroom runs as a container image and needs only Docker on the host.' \
  'Start here instead:' \
  '  https://github.com/switchroom/switchroom#quick-start' \
  '  https://switchroom.ai' >&2
exit 1
