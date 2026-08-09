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

/**
 * The default seams for the host-shell case: the process running the check IS
 * the host CLI (so `cliVersion` drives the `cli (host)` row), and no install
 * stamp exists. Both are pinned EXPLICITLY rather than left to production
 * detection, which reads `/.dockerenv` and the real switchroom home — a test
 * that inherited those would pass or fail depending on where it ran.
 */
const HOST_SHELL = { hostCli: { inContainer: false }, hostCliStamp: null } as const;

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
      ...HOST_SHELL,
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
      ...HOST_SHELL,
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
      ...HOST_SHELL,
    });
    expect(rows.some((r) => r.status === "fail")).toBe(false);
    // The lagging containers are still surfaced, as warnings.
    expect(rows.some((r) => r.status === "warn")).toBe(true);
  });

  it("reports a single ok row on a converged host", () => {
    const rows = runComponentVersionChecks(config("v0.19.28"), {
      exec: ps(REFERENCE_HOST.map((l) => l.replace("v0.19.26", "v0.19.28"))),
      cliVersion: "0.19.28",
      ...HOST_SHELL,
    });
    expect(rows.filter((r) => r.status === "warn")).toEqual([]);
    expect(rows[0].status).toBe("ok");
  });

  it("skips cleanly when docker is unreachable and no pin is set", () => {
    const rows = runComponentVersionChecks(config(), {
      exec: () => ({ status: 1, stdout: "" }),
      cliVersion: "not-a-version",
      ...HOST_SHELL,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("skip");
  });

  it("flags an AHEAD component (mid-roll / stale pin) without failing", () => {
    const rows = runComponentVersionChecks(config("v0.19.26"), {
      exec: ps(REFERENCE_HOST),
      cliVersion: "0.19.26",
      ...HOST_SHELL,
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
      ...HOST_SHELL,
    });
    const hostCli = rows.find((r) => r.name.includes("cli (host)"));
    expect(hostCli?.status).not.toBe("fail");
    expect(rows.some((r) => r.status === "fail")).toBe(false);
  });
});

/**
 * #4571 — the reason the silent drift survived five releases. From inside a
 * container the running CLI is the CONTAINER's CLI, but the inventory reported
 * it under the `cli (host)` label, so the one enumerative check that should
 * have caught a stale host binary was measuring the wrong binary and always
 * agreed with the target.
 */
describe("doctor: the host CLI row must never report the CONTAINER's version", () => {
  it("uses the STAMPED host version, not the container's, when a stamp exists", () => {
    const rows = runComponentVersionChecks(config("v0.19.28"), {
      exec: ps(REFERENCE_HOST),
      // The container CLI is on target — the pre-fix code reported this and
      // called the host converged.
      cliVersion: "0.19.28",
      hostCli: { inContainer: true, observedVersion: "0.19.23" },
      hostCliStamp: {
        version: "0.19.23",
        installKind: "npm-global",
        path: "/home/op/.nvm/versions/node/v22/lib/node_modules/switchroom/dist/cli/switchroom.js",
        npmPrefix: "/home/op/.nvm/versions/node/v22",
        ownerUid: 1000,
        ownerUser: "op",
      },
    });
    const hostCli = rows.find((r) => r.name === "component behind: cli (host)");
    expect(hostCli?.status).toBe("fail");
    expect(hostCli?.detail).toContain("0.19.23");
    // …and the remediation is derived from how the host is ACTUALLY installed:
    // a user-owned npm prefix, so neither `switchroom update` (a no-op on an
    // npm install) nor `sudo npm i -g` (wrong tree) is correct.
    expect(hostCli?.fix).toContain("npm i -g switchroom@0.19.28");
    expect(hostCli?.fix).toContain("run as op");
    expect(hostCli?.fix).not.toMatch(/(^|[;&|]\s*)sudo\s/);
  });

  it("reports the host CLI as UNKNOWN in a container with no stamp, never as converged", () => {
    const rows = runComponentVersionChecks(config("v0.19.28"), {
      exec: ps(REFERENCE_HOST),
      cliVersion: "0.19.28",
      hostCli: { inContainer: true },
      hostCliStamp: null,
    });
    // Not a behind row, not an ok row silently claiming the host is on target:
    // an explicit "not observable from here".
    expect(rows.some((r) => r.name.includes("cli (host)") && r.status !== "skip")).toBe(
      false,
    );
    const unknown = rows.find((r) => r.name === "component version unknown: cli (host)");
    expect(unknown?.status).toBe("skip");
  });
});
