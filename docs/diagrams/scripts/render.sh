#!/usr/bin/env bash
# render.sh — HTML diagram → 2x PNG (headless chromium)
#
# Usage:
#   docs/diagrams/scripts/render.sh <path/to/diagram.html> [WxH]
#
# Renders the HTML at a 2x device scale into <name>.png next to the source.
# The HTML is the source of truth; the PNG is a build artifact — re-render,
# never hand-edit the PNG. A 2x screenshot of a ~1200-wide canvas produces a
# ~2400px-wide PNG. Default canvas is 1200x760; pass WxH to override to match
# the diagram's .stage dimensions.
set -euo pipefail

html="${1:-}"
size="${2:-1200x760}"
if [[ -z "$html" || ! -f "$html" ]]; then
  echo "usage: render.sh <diagram.html> [WxH]  (e.g. 1200x760)" >&2
  exit 2
fi

w="${size%x*}"
h="${size#*x}"

# Auto-discover a headless-capable chromium. The playwright build on the
# fleet is known-good; fall back to system chrome/chromium names.
chrome=""
for c in "${CHROME:-}" \
         "$(find /opt/playwright -path '*chromium*/chrome' -type f 2>/dev/null | head -1)" \
         "$(command -v chromium 2>/dev/null || true)" \
         "$(command -v chromium-browser 2>/dev/null || true)" \
         "$(command -v google-chrome 2>/dev/null || true)"; do
  if [[ -n "$c" && -x "$c" ]]; then chrome="$c"; break; fi
done
if [[ -z "$chrome" ]]; then
  echo "render.sh: no chromium found. Set CHROME=/abs/path/to/chrome" >&2
  echo "  hint: find / -path '*chromium*/chrome' -type f 2>/dev/null | head -1" >&2
  exit 3
fi

abs_html="$(cd "$(dirname "$html")" && pwd)/$(basename "$html")"
out="${abs_html%.html}.png"

"$chrome" --headless --no-sandbox --disable-gpu \
  --force-device-scale-factor=2 \
  --hide-scrollbars \
  --window-size="${w},${h}" \
  --screenshot="$out" \
  "file://${abs_html}" >/dev/null 2>&1

echo "rendered: $out (${w}x${h} @2x)"
