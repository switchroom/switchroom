/**
 * The boot-time config-path-provenance warning is load-bearing and silent
 * when missing.
 *
 * `configPathProvenanceWarning()` is a pure function returning a string or
 * null, and every one of its branches is unit-tested in
 * `config-propose-edit.test.ts`. What those tests cannot reach is that
 * `main.ts` actually CALLS it and puts the line on stderr: a behavioural test
 * would have to construct the daemon the way `main.ts` does, which is the very
 * thing at issue. Delete the call and nothing fails — the fleet just loses its
 * only advance notice that hostd would write a `switchroom.yaml` it would not
 * itself read back, and the condition first surfaces as an
 * `E_CONFIG_PATH_MISMATCH` at the worst possible moment: mid-apply, on a change
 * the operator has already approved.
 *
 * So this is a static callsite assertion — same shape as
 * `hostd-fleet-components-callsite.test.ts` — pinning the one wiring that
 * exists to the one place it belongs.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mainSrc = readFileSync(
  join(repoRoot, "src", "host-control", "main.ts"),
  "utf8",
);

describe("hostd asserts config-path provenance at its composition root", () => {
  it("main.ts imports the boot assertion from server.ts", () => {
    expect(mainSrc).toMatch(
      /import\s*\{[^}]*\bconfigPathProvenanceWarning\b[^}]*\}\s*from\s*"\.\/server\.js"/,
    );
  });

  it("main.ts CALLS it during boot", () => {
    // A call expression, not a mention: the doc comment above the callsite
    // names the function too, and a comment is not a wiring.
    expect(mainSrc).toMatch(/\bconfigPathProvenanceWarning\s*\(\s*\)/);
  });

  it("main.ts writes the warning to stderr rather than swallowing it", () => {
    // The warning is worth nothing if it is computed and dropped. Bounded
    // window so an unrelated later `process.stderr.write` cannot satisfy this.
    expect(mainSrc).toMatch(
      /configPathProvenanceWarning\s*\(\s*\)[\s\S]{0,400}?process\.stderr\.write\(/,
    );
  });
});
