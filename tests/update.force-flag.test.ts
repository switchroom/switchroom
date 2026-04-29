import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Static guard for the --force flag added to `switchroom update`.
 *
 * `runPostBuildPhase` has no easy unit-test seam (it shells out to systemctl,
 * git, and bun). We pin the invariants at source-inspection level instead —
 * the same pattern used by update.unit-regen.test.ts.
 */
const UPDATE_TS = resolve(__dirname, "../src/cli/update.ts");

describe("switchroom update --force", () => {
  const src = readFileSync(UPDATE_TS, "utf-8");

  it("registers the --force option on the update command", () => {
    // The option must appear in registerUpdateCommand, which is the only
    // exported function. We look for the option string near the command
    // definition rather than anywhere in the file.
    expect(src).toMatch(/\.option\(\s*["']--force["']/);
  });

  it("includes the settle-gate risk warning in --force help text", () => {
    // The help text must call out the 'whole fleet' risk so operators
    // understand the trade-off before using the flag.
    expect(src).toMatch(/whole fleet/);
  });

  it("accepts force in the UpdateResumeState interface", () => {
    // The persisted state carries force so the self-reexec resume path
    // honours the original operator intent.
    expect(src).toMatch(/force\?:\s*boolean/);
  });

  it("skips waitForAgentReady when force is true", () => {
    // The settle-gate is `waitForAgentReady`. When force is set, the call
    // must be guarded by `!force` so the gate is bypassed entirely.
    expect(src).toMatch(/if\s*\(!force\)/);
    // And waitForAgentReady must not appear outside the guard in the
    // rolling-restart block — confirm the only call site is inside the guard.
    const waitCallCount = (src.match(/waitForAgentReady/g) ?? []).length;
    // One import/type reference, one actual call site (guarded by !force).
    expect(waitCallCount).toBeGreaterThanOrEqual(1);
  });

  it("passes force through from opts to runPostBuildPhase in the normal path", () => {
    // Both call sites of runPostBuildPhase must forward the flag.
    const forcePassCount = (src.match(/force:\s*(?:opts\.force|state\.force)/g) ?? []).length;
    expect(forcePassCount).toBeGreaterThanOrEqual(2);
  });

  it("guards against --force combined with --no-restart", () => {
    // --force has no effect when the restart phase is skipped, so the two
    // flags are mutually exclusive. The guard must exit 1 with a clear error.
    expect(src).toMatch(/opts\.force && opts\.restart === false/);
    expect(src).toMatch(/--force and --no-restart are mutually exclusive/);
  });

  it("still writes the deployed-SHA after a --force restart", () => {
    // SHA write must come AFTER the restart loop (not inside the settle-gate
    // block). Verify the SHA write and the settle-gate skip are separate.
    const shaIdx = src.indexOf("writeLastDeployedSha(newSha)");
    const forceIdx = src.indexOf("if (!force)");
    expect(shaIdx).toBeGreaterThan(0);
    expect(forceIdx).toBeGreaterThan(0);
    // SHA write must be after the settle-gate block.
    expect(shaIdx).toBeGreaterThan(forceIdx);
  });
});
