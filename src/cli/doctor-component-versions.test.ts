import { describe, it, expect } from "vitest";

import { runComponentVersionChecks } from "./doctor-component-versions.js";
import type { SwitchroomConfig } from "../config/schema.js";
import type { ExecFn } from "./component-versions.js";

const config = (pin?: string) =>
  ({ agents: {}, ...(pin ? { release: { pin } } : {}) }) as unknown as SwitchroomConfig;

const ps = (lines: string[]): ExecFn => () => ({
  status: 0,
  stdout: lines.join("\n"),
});

const REFERENCE_HOST = [
  "switchroom-hostd\tghcr.io/switchroom/switchroom-hostd:v0.19.28",
  "switchroom-hindsight-autoheal\tghcr.io/switchroom/switchroom-hostd:v0.19.26",
  "switchroom-web\tghcr.io/switchroom/switchroom-web:v0.19.26",
  "switchroom-klanker\tghcr.io/switchroom/switchroom-agent:v0.19.28",
];

describe("doctor: component versions (#3919)", () => {
  it("WARNs once per stale CONTAINER and names a remediation for each", () => {
    const rows = runComponentVersionChecks(config("v0.19.28"), {
      exec: ps(REFERENCE_HOST),
      cliVersion: "0.19.23",
    });
    const warns = rows.filter((r) => r.status === "warn");
    // Containers that lag are warn-only (they can trail legitimately
    // mid-roll). The host CLI is NOT in this set — it is a fail, asserted
    // separately below.
    expect(warns.map((r) => r.name).sort()).toEqual([
      "component behind: switchroom-hindsight-autoheal",
      "component behind: switchroom-web",
    ]);
    expect(warns.every((r) => (r.fix ?? "").length > 0)).toBe(true);
    expect(
      warns.find((r) => r.name.endsWith("switchroom-web"))?.fix,
    ).toContain("webd install --tag v0.19.28");
    expect(
      warns.find((r) => r.name.endsWith("switchroom-hindsight-autoheal"))?.fix,
    ).toContain("hostd install --tag v0.19.28");
  });

  it("FAILs when the host CLI binary trails the target — the silent-drift bug", () => {
    // The regression: fleet on v0.19.28, host binary left on an older
    // release running a retired cron. This is the case that must turn
    // doctor RED (non-zero exit), not merely warn.
    const rows = runComponentVersionChecks(config("v0.19.28"), {
      exec: ps(REFERENCE_HOST),
      cliVersion: "0.19.23",
    });
    const hostCli = rows.find((r) => r.name === "component behind: cli (host)");
    expect(hostCli?.status).toBe("fail");
    expect(hostCli?.fix).toContain("switchroom update");
    expect(rows.some((r) => r.status === "fail")).toBe(true);
  });

  it("does NOT fail when the host CLI is on target even while CONTAINERS lag", () => {
    // A current host binary with containers mid-roll must stay green
    // (no fail): container skew alone never changes doctor's exit code.
    const rows = runComponentVersionChecks(config("v0.19.28"), {
      exec: ps(REFERENCE_HOST),
      cliVersion: "0.19.28",
    });
    expect(rows.some((r) => r.status === "fail")).toBe(false);
    // The lagging containers are still surfaced, as warnings.
    expect(rows.some((r) => r.status === "warn")).toBe(true);
  });

  it("reports a single ok row on a converged host", () => {
    const rows = runComponentVersionChecks(config("v0.19.28"), {
      exec: ps(REFERENCE_HOST.map((l) => l.replace("v0.19.26", "v0.19.28"))),
      cliVersion: "0.19.28",
    });
    expect(rows.filter((r) => r.status === "warn")).toEqual([]);
    expect(rows[0].status).toBe("ok");
  });

  it("skips cleanly when docker is unreachable and no pin is set", () => {
    const rows = runComponentVersionChecks(config(), {
      exec: () => ({ status: 1, stdout: "" }),
      cliVersion: "not-a-version",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("skip");
  });

  it("flags an AHEAD component (mid-roll / stale pin) without failing", () => {
    const rows = runComponentVersionChecks(config("v0.19.26"), {
      exec: ps(REFERENCE_HOST),
      cliVersion: "0.19.26",
    });
    const ahead = rows.filter((r) => r.name.startsWith("component ahead:"));
    expect(ahead.map((r) => r.name).sort()).toEqual([
      "component ahead: switchroom-hostd",
      "component ahead: switchroom-klanker",
    ]);
    expect(ahead.every((r) => r.status === "warn")).toBe(true);
  });

  it("does NOT fail when the host CLI is AHEAD of a stale pin", () => {
    // An ahead host binary (operator bumped ahead of release.pin, or the
    // pin is stale) is not the drift bug — only *behind* fails.
    const rows = runComponentVersionChecks(config("v0.19.26"), {
      exec: ps(REFERENCE_HOST.map((l) => l.replace(/v0\.19\.2[68]/g, "v0.19.26"))),
      cliVersion: "0.19.28",
    });
    const hostCli = rows.find((r) => r.name.includes("cli (host)"));
    expect(hostCli?.status).not.toBe("fail");
    expect(rows.some((r) => r.status === "fail")).toBe(false);
  });
});
