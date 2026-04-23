import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Static guard for PR #44 review blocker 2: `switchroom update` used to
 * call only reconcileAgent + restartAgent, which never rewrites the
 * systemd unit files. Installs upgrading past the timezone-awareness PR
 * were inheriting stale units without `Environment=SWITCHROOM_TIMEZONE=`,
 * so the hook fell back to UTC forever.
 *
 * The fix is a call to `installAllUnits(config)` between the dep-install
 * step and the reconcile/restart loop. A heavyweight integration test for
 * update.ts would need to fake git, bun, and systemctl, so we instead
 * lock the invariant at source-inspection level: the import is present,
 * and there is a call site that feeds `config` into installAllUnits
 * before the reconcile loop begins.
 */
const UPDATE_TS = resolve(__dirname, "../src/cli/update.ts");

describe("switchroom update — systemd unit regeneration", () => {
  const src = readFileSync(UPDATE_TS, "utf-8");

  it("imports installAllUnits from the systemd module", () => {
    expect(src).toMatch(
      /import\s*\{\s*installAllUnits\s*\}\s*from\s*"\.\.\/agents\/systemd\.js"/,
    );
  });

  it("calls installAllUnits(config) inside the update action", () => {
    expect(src).toMatch(/installAllUnits\(config\)/);
  });

  it("regenerates units before the reconcile loop", () => {
    // "Regenerating systemd units" log lives above "Reconciling" log —
    // this pins the ordering so a future refactor can't accidentally move
    // the call below reconcile (which would run restart before the new
    // unit files are on disk, defeating the whole point).
    const regenIdx = src.indexOf("Regenerating systemd units");
    const reconcileIdx = src.indexOf("Reconciling ");
    expect(regenIdx).toBeGreaterThan(0);
    expect(reconcileIdx).toBeGreaterThan(0);
    expect(regenIdx).toBeLessThan(reconcileIdx);
  });
});
