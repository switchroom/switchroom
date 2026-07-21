/**
 * Footgun F — doctor must never tell operators to run a nonexistent verb.
 *
 * The doctor `fix:` strings used to say "Re-run `switchroom reconcile`" — but
 * there is NO `switchroom reconcile` top-level CLI verb (the real verbs are
 * `switchroom apply` for a fleet converge / compose regen, and
 * `switchroom agent reconcile <name>` for one agent). An operator who copied
 * the fix string got "unknown command". This is a deterministic source guard:
 * no doctor `fix:` string may reference the bare nonexistent verb.
 *
 * Scanning the source (not a runtime snapshot) is deliberate — it catches a
 * bad fix string at the point it is written, in every doctor module at once,
 * without having to construct a failing config for each check.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = join(fileURLToPath(import.meta.url), "..", "..", "src", "cli");

/** Matches a `fix:` string literal that contains the bare nonexistent verb
 *  `switchroom reconcile` (i.e. NOT the real `switchroom agent reconcile`). */
function badFixLines(source: string): string[] {
  const bad: string[] = [];
  for (const line of source.split("\n")) {
    if (!/\bfix:/.test(line)) continue;
    // `switchroom reconcile` that is NOT `switchroom agent reconcile`.
    if (/switchroom reconcile\b/.test(line) && !/switchroom agent reconcile\b/.test(line)) {
      bad.push(line.trim());
    }
  }
  return bad;
}

describe("footgun F — doctor fix strings cite only real CLI verbs", () => {
  const doctorFiles = readdirSync(CLI_DIR).filter(
    (f) => f.startsWith("doctor") && f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );

  it("scans at least the core doctor modules (guard is not vacuous)", () => {
    expect(doctorFiles).toContain("doctor-docker.ts");
    expect(doctorFiles.length).toBeGreaterThan(3);
  });

  for (const file of doctorFiles) {
    it(`no fix: string in ${file} references the nonexistent \`switchroom reconcile\` verb`, () => {
      const source = readFileSync(join(CLI_DIR, file), "utf8");
      expect(badFixLines(source)).toEqual([]);
    });
  }
});
