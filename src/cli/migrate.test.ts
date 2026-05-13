/**
 * Tests for `switchroom migrate cron-unit-names` planner.
 *
 * The CLI action handler shells through to commander + getConfig and is
 * harder to exercise directly; the meat lives in `planCronUnitRenames`,
 * which is a pure function over (agentsDir, agents map). We pin:
 *
 *   - legacy filenames get planned for rename to the canonical hash form;
 *   - already-canonical filenames produce zero plans (idempotent);
 *   - legacy files whose index has no matching schedule entry are skipped.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCronUnitRenames } from "./migrate.js";
import { cronScriptFilename } from "../agents/cron-unit-name.js";

describe("planCronUnitRenames", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "switchroom-migrate-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeLegacy(agent: string, idx: number): void {
    const tg = join(dir, agent, "telegram");
    mkdirSync(tg, { recursive: true });
    writeFileSync(join(tg, `cron-${idx}.sh`), "#!/bin/bash\n");
  }

  it("plans rename of legacy file to canonical hash", () => {
    writeLegacy("alpha", 0);
    const plans = planCronUnitRenames(dir, {
      alpha: { schedule: [{ cron: "0 8 * * *", prompt: "morning" }] },
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.agent).toBe("alpha");
    expect(plans[0]!.to.endsWith(cronScriptFilename("0 8 * * *", "morning"))).toBe(true);
  });

  it("is idempotent: canonical-only directory produces zero plans", () => {
    const fname = cronScriptFilename("0 8 * * *", "morning");
    const tg = join(dir, "alpha", "telegram");
    mkdirSync(tg, { recursive: true });
    writeFileSync(join(tg, fname), "#!/bin/bash\n");
    const plans = planCronUnitRenames(dir, {
      alpha: { schedule: [{ cron: "0 8 * * *", prompt: "morning" }] },
    });
    expect(plans).toHaveLength(0);
  });

  it("skips legacy files with no matching schedule entry", () => {
    writeLegacy("alpha", 5); // index out of range
    const plans = planCronUnitRenames(dir, {
      alpha: { schedule: [{ cron: "0 8 * * *", prompt: "morning" }] },
    });
    expect(plans).toHaveLength(0);
  });

  it("handles agents with no schedule gracefully", () => {
    writeLegacy("alpha", 0);
    const plans = planCronUnitRenames(dir, { alpha: {} });
    expect(plans).toHaveLength(0);
  });
});
