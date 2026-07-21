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

const SRC_DIR = join(fileURLToPath(import.meta.url), "..", "..", "src");
const CLI_DIR = join(SRC_DIR, "cli");

/** True for a line citing the bare nonexistent verb `switchroom reconcile`
 *  (i.e. NOT the real `switchroom agent reconcile`). */
function citesBareReconcileVerb(line: string): boolean {
  return /switchroom reconcile\b/.test(line) && !/switchroom agent reconcile\b/.test(line);
}

/** Matches a `fix:` string literal that cites the bare nonexistent verb. */
function badFixLines(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => /\bfix:/.test(line) && citesBareReconcileVerb(line))
    .map((line) => line.trim());
}

/** Any OPERATOR-VISIBLE occurrence of the bare nonexistent verb: a string
 *  literal `push`ed into generated output, or a comment. Excludes the ONE
 *  legitimate pattern — text that documents the verb does NOT exist ("no
 *  ... switchroom reconcile CLI verb"), which is accurate (protocol.ts:24). */
function badVerbLines(source: string): string[] {
  const bad: string[] = [];
  for (const line of source.split("\n")) {
    if (!citesBareReconcileVerb(line)) continue;
    if (/no\b.*switchroom reconcile|switchroom reconcile.*(does ?n.?t|never) exist/i.test(line)) {
      continue; // accurate absence documentation
    }
    bad.push(line.trim());
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

describe("footgun F — generated output / comments cite only real CLI verbs", () => {
  // The files PR6 also fixed beyond doctor `fix:` strings: compose.ts emits the
  // bad verb into the generated docker-compose.yml header (operator-VISIBLE),
  // and scaffold.ts had comments citing it. Guard those too so a regression
  // there is caught, not just the doctor strings.
  const files = [
    join(SRC_DIR, "agents", "compose.ts"),
    join(SRC_DIR, "agents", "scaffold.ts"),
  ];

  for (const path of files) {
    it(`no operator-visible line in ${path.split("/").slice(-2).join("/")} cites the nonexistent \`switchroom reconcile\` verb`, () => {
      const source = readFileSync(path, "utf8");
      expect(badVerbLines(source)).toEqual([]);
    });
  }
});
