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
  it("WARNs once per stale component and names a remediation for each", () => {
    const rows = runComponentVersionChecks(config("v0.19.28"), {
      exec: ps(REFERENCE_HOST),
      cliVersion: "0.19.23",
    });
    const warns = rows.filter((r) => r.status === "warn");
    expect(warns.map((r) => r.name).sort()).toEqual([
      "component behind: cli (host)",
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
    expect(warns.find((r) => r.name.endsWith("cli (host)"))?.fix).toContain(
      "switchroom update",
    );
  });

  it("never FAILs — version skew must not change doctor's exit code", () => {
    const rows = runComponentVersionChecks(config("v0.19.28"), {
      exec: ps(REFERENCE_HOST),
      cliVersion: "0.19.23",
    });
    expect(rows.some((r) => r.status === "fail")).toBe(false);
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
});
