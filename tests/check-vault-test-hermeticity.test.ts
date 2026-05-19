/**
 * Tests for the broker-test hermeticity lint gate (#1561, the regression-
 * proof half of the 2026-05-20 incident fix).
 *
 * Two layers covered:
 *   1. `checkFile` — pure decision over a single test file's source text.
 *      Pinned via in-memory fixtures for the bad pattern, the fixed
 *      pattern, the irrelevant pattern, and the opt-out marker.
 *   2. `checkRepo` — runs across the LIVE `src/vault/` tree and asserts
 *      it is currently clean. If a future PR (re-)introduces a
 *      hermeticity regression in a vault test, this fires immediately.
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs without a .d.ts. The exports are well-typed
// by usage; the runtime contract is { ok: boolean, file, matched? } /
// { ok, failures, scanned }. Keeping the lint script as a plain .mjs
// (rather than .ts) matches the other check-*.mjs scripts in this dir
// so the npm-run-lint chain can invoke it directly via `node`.
import { checkFile, checkRepo } from "../scripts/check-vault-test-hermeticity.mjs";

describe("check-vault-test-hermeticity / checkFile (pure)", () => {
  it("flags a test that calls os.homedir() with NO process.env.HOME override", () => {
    const source = `
      import { describe, it } from "vitest";
      import * as os from "node:os";
      import * as path from "node:path";

      describe("oops", () => {
        it("writes to real home", () => {
          const p = path.join(os.homedir(), ".switchroom", "agents", "foo");
          // ...
        });
      });
    `;
    const v = checkFile("/repo/src/vault/example.test.ts", source);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.matched).toMatch(/os\.homedir/);
    }
  });

  it("accepts the same test once `process.env.HOME = tmpDir` is added", () => {
    const source = `
      import { describe, it, beforeEach } from "vitest";
      import * as os from "node:os";
      import * as fs from "node:fs";
      import * as path from "node:path";

      let tmpDir: string;
      let prevHome: string | undefined;
      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-"));
        prevHome = process.env.HOME;
        process.env.HOME = tmpDir; // hermetic
      });

      it("writes only to tmpdir-home", () => {
        const p = path.join(os.homedir(), ".switchroom", "agents", "foo");
        // ...
      });
    `;
    const v = checkFile("/repo/src/vault/example.test.ts", source);
    expect(v.ok).toBe(true);
  });

  it("ignores tests with NO home-resolution at all (already hermetic via tmpdir paths)", () => {
    const source = `
      import { describe, it, beforeEach } from "vitest";
      import * as fs from "node:fs";
      import * as os from "node:os";
      import * as path from "node:path";

      beforeEach(() => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "x-"));
        // never calls os.homedir() or references ~/.switchroom
      });
    `;
    const v = checkFile("/repo/src/vault/clean.test.ts", source);
    expect(v.ok).toBe(true);
  });

  it("flags a literal '~/.switchroom' string even without os.homedir()", () => {
    const source = `
      import { describe, it } from "vitest";
      describe("oops", () => {
        it("uses tilde-prefix literal", () => {
          const p = "~/.switchroom/vault.enc";
        });
      });
    `;
    const v = checkFile("/repo/src/vault/literal.test.ts", source);
    expect(v.ok).toBe(false);
  });

  it("respects the explicit per-file opt-out marker (intentional real-home tests)", () => {
    const source = `
      // SWITCHROOM_HERMETICITY_LINT: allow-real-home — this is the
      // dedicated regression test for the broker's own real-home
      // guard; it MUST exercise the production resolution path.
      import * as os from "node:os";
      const p = os.homedir() + "/.switchroom/...";
    `;
    const v = checkFile("/repo/src/vault/intentional.test.ts", source);
    expect(v.ok).toBe(true);
  });

  it("treats setEnv(\"HOME\", …) as an equivalent override (helper pattern)", () => {
    const source = `
      import * as os from "node:os";
      setEnv("HOME", tmpDir);
      const p = os.homedir() + "/.switchroom/...";
    `;
    const v = checkFile("/repo/src/vault/helper-override.test.ts", source);
    expect(v.ok).toBe(true);
  });
});

describe("check-vault-test-hermeticity / checkRepo (live tree)", () => {
  it("the current repo is clean — no vault test resolves real home without override", () => {
    // From this test file's location: <repo>/tests/check-vault-test-hermeticity.test.ts.
    // CWD when vitest runs is the repo root, so we use that.
    const result = checkRepo(process.cwd());
    if (!result.ok) {
      // Print the precise offending files so a future regressor sees
      // exactly what to fix.
      const lines = result.failures
        .map((f: { file: string; matched: string }) => `  ${f.file}  (matched ${JSON.stringify(f.matched)})`)
        .join("\n");
      throw new Error(
        `check-vault-test-hermeticity: ${result.failures.length} live offender(s):\n${lines}\n\n` +
        `Fix: add \`process.env.HOME = tmpDir;\` in the test's beforeEach (BEFORE broker.start()).`,
      );
    }
    expect(result.scanned).toBeGreaterThan(0); // smoke: it actually walked files
  });
});
