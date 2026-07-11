/**
 * Guard the fleet-wide webkite render config against the #3030 regression:
 * webkite 0.4.0's `RouteConfig` requires a SINGULAR string
 * `provider = "<name>"`. The config previously shipped an ARRAY field
 * `providers = ["cloakbrowser", "cloudflare"]` inside a `[[render.routes]]`
 * block. That invalid field aborts parsing of the ENTIRE config file (not
 * just the route), so no renderer loads at all and all JS rendering is
 * silently disabled fleet-wide (`has_renderers: false`,
 * `decision: no_renderer`).
 *
 * No TOML parser is a repo dependency, so this is a structural check over
 * the shipped file: every `[[render.routes]]` entry must use the singular
 * `provider` key and no route may carry the plural `providers` array. The
 * test FAILS on the pre-fix file (which had `providers = [...]` on line ~75).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const config = readFileSync(resolve(root, "docker/webkite/config.toml"), "utf8");

// Strip comments (leading-whitespace `#` lines and inline `# ...` tails) so
// the check only sees ACTIVE, parser-visible TOML — commented example shapes
// must not trip or satisfy it.
function activeLines(toml: string): string[] {
  return toml
    .split("\n")
    .map((line) => {
      const hash = line.indexOf("#");
      return hash === -1 ? line : line.slice(0, hash);
    })
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

describe("docker/webkite/config.toml — webkite 0.4.0 render.routes schema (#3030)", () => {
  it("has no active plural `providers =` field anywhere (0.4.0 uses singular `provider`)", () => {
    const offenders = activeLines(config).filter((line) =>
      /^\s*providers\s*=/.test(line),
    );
    expect(
      offenders,
      "webkite 0.4.0 render.routes requires singular `provider = \"<name>\"`; a plural " +
        "`providers = [...]` array aborts parsing of the WHOLE config and disables all " +
        "JS rendering fleet-wide (#3030)",
    ).toEqual([]);
  });

  it("every active [[render.routes]] block uses a singular `provider` string", () => {
    const lines = activeLines(config);
    let inRoute = false;
    const routeStarts: number[] = [];
    const providerNamed: boolean[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\[\[render\.routes\]\]$/.test(trimmed)) {
        inRoute = true;
        routeStarts.push(1);
        providerNamed.push(false);
        continue;
      }
      // Any other top-level table header ends the current route block.
      if (/^\[/.test(trimmed)) {
        inRoute = false;
        continue;
      }
      if (inRoute && /^provider\s*=\s*"[^"]+"/.test(trimmed)) {
        providerNamed[providerNamed.length - 1] = true;
      }
      if (inRoute && /^providers\s*=/.test(trimmed)) {
        // plural form — invalid; leave providerNamed false so the assert trips
        providerNamed[providerNamed.length - 1] = false;
      }
    }

    // Every declared route (if any) must name exactly one provider via the
    // singular key. Zero routes is also valid — auto-escalation covers thin
    // SPAs — so this only asserts on routes that DO exist.
    for (let i = 0; i < routeStarts.length; i++) {
      expect(
        providerNamed[i],
        `[[render.routes]] block #${i + 1} must declare a singular \`provider = "<name>"\` ` +
          "field (webkite 0.4.0 schema; #3030)",
      ).toBe(true);
    }
  });
});
