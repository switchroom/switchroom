/**
 * The GPU passthrough decision + the recreate drop guard.
 *
 * Regression under test (2026-07-28, production): `switchroom memory setup
 * --recreate` relaunched the hindsight container WITHOUT `--gpus all` on a
 * host that has a GPU, because the persisted verdict file was `root:root 0600`
 * under a uid-1000 home. `loadHostCapabilities()` swallowed the EACCES,
 * `hindsightGpuEnabled()` read the resulting `null` as "no GPU", and the local
 * embedding model plus the cross-encoder reranker moved to CPU on the
 * interactive recall path. The GPU-gated perf defaults
 * (`HINDSIGHT_API_RERANKER_LOCAL_FP16`, `..._BATCH_SIZE`) went with them.
 * Nothing printed. It was found by hand-diffing a `docker inspect` snapshot.
 *
 * Three properties are pinned here, and each one alone would have caught it:
 *
 *   1. an unreadable verdict yields a `degraded` decision, not a quiet false;
 *   2. an explicit operator answer beats autodetect in BOTH directions, so the
 *      verdict file is never the only lever;
 *   3. a recreate that would take GPU away from the running container is
 *      REFUSED unless the operator said so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

import {
  deviceRequestsHaveGpu,
  getHindsightDeviceRequests,
  hindsightGpuDecision,
  hindsightGpuEnabled,
  resolveHindsightGpuOverride,
  startHindsight,
  type HindsightDeviceRequest,
} from "./hindsight.js";
import { assessHindsightGpuDrop } from "./hindsight-gpu-guard.js";
import { resetHostCapabilitiesWarnings } from "./host-capabilities.js";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "switchroom-gpuguard-"));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  resetHostCapabilitiesWarnings();
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue(Buffer.from(""));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** Write a verdict file with the two probe booleans. */
function writeVerdict(gpuPresent: boolean, containerToolkit: boolean): void {
  mkdirSync(join(home, ".switchroom"), { recursive: true });
  writeFileSync(
    join(home, ".switchroom", "host-capabilities.json"),
    JSON.stringify({
      version: 1,
      voice: {
        gpuPresent,
        containerToolkit,
        engine: gpuPresent && containerToolkit ? "local" : "cloud",
        detectedAt: "2026-07-26T00:00:00.000Z",
      },
    }) + "\n",
  );
}

/**
 * Make the verdict file present-but-unreadable in a way that holds for a root
 * test runner too (root ignores mode bits, so `chmod 000` would be a no-op in
 * some CI images and this suite would pass without testing anything).
 */
function makeVerdictUnreadable(): void {
  mkdirSync(join(home, ".switchroom", "host-capabilities.json"), { recursive: true });
}

/** `--gpus all`, exactly as docker materialises it in HostConfig.DeviceRequests. */
const GPUS_ALL: HindsightDeviceRequest[] = [
  { Driver: "", Count: -1, DeviceIDs: null, Capabilities: [["gpu"]] },
];

describe("hindsightGpuDecision — a blind false is not a negative one", () => {
  it("is enabled + not degraded when the verdict proves GPU and toolkit", () => {
    writeVerdict(true, true);
    const d = hindsightGpuDecision();
    expect(d.enabled).toBe(true);
    expect(d.source).toBe("autodetect");
    expect(d.degraded).toBe(false);
  });

  it("is a NON-degraded false when the verdict genuinely says no GPU", () => {
    writeVerdict(false, false);
    const d = hindsightGpuDecision();
    expect(d.enabled).toBe(false);
    expect(d.degraded).toBe(false);
    expect(d.reason).toContain("does not prove GPU passthrough");
  });

  it("is a DEGRADED false when the verdict exists but cannot be read", () => {
    makeVerdictUnreadable();
    const d = hindsightGpuDecision();
    // Still false — emitting `--gpus all` blind would hard-fail container
    // create on a toolkit-less host. But now it is a false that SAYS SO.
    expect(d.enabled).toBe(false);
    expect(d.degraded).toBe(true);
    expect(d.capabilities.status).toBe("unreadable");
    expect(d.reason).toContain("unreadable");
    expect(d.reason).toContain(join(home, ".switchroom", "host-capabilities.json"));
  });

  it("is a DEGRADED false when the verdict is corrupt", () => {
    mkdirSync(join(home, ".switchroom"), { recursive: true });
    writeFileSync(join(home, ".switchroom", "host-capabilities.json"), "{ truncated");
    const d = hindsightGpuDecision();
    expect(d.enabled).toBe(false);
    expect(d.degraded).toBe(true);
    expect(d.capabilities.status).toBe("malformed");
  });

  it("is a NON-degraded false when no verdict was ever written", () => {
    const d = hindsightGpuDecision();
    expect(d.enabled).toBe(false);
    expect(d.degraded).toBe(false);
    expect(d.reason).toContain("host never probed");
  });
});

describe("explicit operator override beats autodetect — in both directions", () => {
  it("forces GPU ON over a verdict that says no GPU", () => {
    writeVerdict(false, false);
    expect(hindsightGpuDecision({ value: true, source: "config" }).enabled).toBe(true);
    expect(hindsightGpuDecision({ value: true, source: "flag" }).enabled).toBe(true);
  });

  it("forces GPU ON over an UNREADABLE verdict — the production recovery path", () => {
    makeVerdictUnreadable();
    const d = hindsightGpuDecision({ value: true, source: "config" });
    expect(d.enabled).toBe(true);
    expect(d.source).toBe("config");
    // The override is a real answer, so the decision is no longer "blind".
    expect(d.degraded).toBe(false);
    expect(d.reason).toContain("hindsight.gpu: true");
  });

  it("forces GPU OFF over a verdict that proves GPU", () => {
    writeVerdict(true, true);
    const d = hindsightGpuDecision({ value: false, source: "flag" });
    expect(d.enabled).toBe(false);
    expect(d.reason).toContain("--no-gpu");
  });

  it("resolves the flag ahead of the yaml key, and yaml ahead of nothing", () => {
    expect(resolveHindsightGpuOverride({ flag: false, config: true })).toEqual({
      value: false,
      source: "flag",
    });
    expect(resolveHindsightGpuOverride({ config: true })).toEqual({
      value: true,
      source: "config",
    });
    // `false` is an answer, not an absence.
    expect(resolveHindsightGpuOverride({ config: false })).toEqual({
      value: false,
      source: "config",
    });
    expect(resolveHindsightGpuOverride({})).toBeNull();
  });

  it("reaches the launched argv: a forced-on override emits `--gpus all` on a no-GPU verdict", () => {
    writeVerdict(false, false);
    startHindsight({ apiPort: 18888, uiPort: 19999 }, undefined, undefined, undefined, undefined, true);
    const call = execFileSyncMock.mock.calls.find(
      (c) =>
        c[0] === "docker" &&
        Array.isArray(c[1]) &&
        (c[1] as string[])[0] === "run" &&
        (c[1] as string[]).includes("switchroom-hindsight"),
    );
    const argv = call![1] as string[];
    expect(argv[argv.indexOf("--gpus") + 1]).toBe("all");
  });

  it("hindsightGpuEnabled still answers the plain boolean for existing call sites", () => {
    writeVerdict(true, true);
    expect(hindsightGpuEnabled()).toBe(true);
    writeVerdict(false, true);
    expect(hindsightGpuEnabled()).toBe(false);
    // explicit seam unchanged
    expect(hindsightGpuEnabled(true)).toBe(true);
    expect(hindsightGpuEnabled(false)).toBe(false);
  });
});

describe("deviceRequestsHaveGpu / getHindsightDeviceRequests", () => {
  it("recognises `--gpus all` and `--gpus device=0`", () => {
    expect(deviceRequestsHaveGpu(GPUS_ALL)).toBe(true);
    expect(
      deviceRequestsHaveGpu([{ Driver: "nvidia", Count: 0, DeviceIDs: ["0"], Capabilities: null }]),
    ).toBe(true);
  });

  it("is false for a CPU container and for `could not tell`", () => {
    expect(deviceRequestsHaveGpu([])).toBe(false);
    expect(deviceRequestsHaveGpu(null)).toBe(false);
  });

  it("parses docker's JSON DeviceRequests, and maps the `null` literal to []", () => {
    execFileSyncMock.mockReturnValue(JSON.stringify(GPUS_ALL));
    expect(deviceRequestsHaveGpu(getHindsightDeviceRequests())).toBe(true);

    execFileSyncMock.mockReturnValue("null\n");
    expect(getHindsightDeviceRequests()).toEqual([]);
  });

  it("returns null (not []) when docker inspect fails, so the guard cannot misfire", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("No such object: switchroom-hindsight");
    });
    expect(getHindsightDeviceRequests()).toBeNull();
  });
});

describe("assessHindsightGpuDrop — the recreate cannot silently drop GPU", () => {
  const degraded = () => {
    makeVerdictUnreadable();
    return hindsightGpuDecision();
  };

  it("BLOCKS a GPU→CPU recreate caused by an unreadable verdict", () => {
    const a = assessHindsightGpuDrop({ existing: GPUS_ALL, decision: degraded() });
    expect(a.drops).toBe(true);
    expect(a.blocks).toBe(true);
    // The message has to be actionable, not just alarming.
    expect(a.message).toContain("Refusing to recreate");
    expect(a.message).toContain("unreadable");
    expect(a.message).toContain(join(home, ".switchroom", "host-capabilities.json"));
    expect(a.message).toContain("--gpu");
    expect(a.message).toContain("--allow-gpu-drop");
    expect(a.message).toContain("HINDSIGHT_API_RERANKER_LOCAL_FP16");
  });

  it("BLOCKS a GPU→CPU recreate caused by an honest no-GPU verdict too", () => {
    writeVerdict(false, false);
    const a = assessHindsightGpuDrop({ existing: GPUS_ALL, decision: hindsightGpuDecision() });
    expect(a.blocks).toBe(true);
    expect(a.message).toContain("does not prove GPU passthrough");
  });

  it("allows the recreate when the next launch keeps GPU", () => {
    writeVerdict(true, true);
    const a = assessHindsightGpuDrop({ existing: GPUS_ALL, decision: hindsightGpuDecision() });
    expect(a.drops).toBe(false);
    expect(a.blocks).toBe(false);
    expect(a.message).toBe("");
  });

  it("allows a CPU→CPU recreate (nothing is being lost)", () => {
    const a = assessHindsightGpuDrop({ existing: [], decision: degraded() });
    expect(a.drops).toBe(false);
    expect(a.blocks).toBe(false);
  });

  it("does not manufacture a refusal when the container cannot be inspected", () => {
    const a = assessHindsightGpuDrop({ existing: null, decision: degraded() });
    expect(a.drops).toBe(false);
    expect(a.blocks).toBe(false);
  });

  it("reports but does NOT block a drop the operator asked for (--no-gpu)", () => {
    writeVerdict(true, true);
    const a = assessHindsightGpuDrop({
      existing: GPUS_ALL,
      decision: hindsightGpuDecision({ value: false, source: "flag" }),
    });
    expect(a.drops).toBe(true);
    expect(a.blocks).toBe(false);
    expect(a.message).toContain("requested explicitly");
  });

  it("reports but does NOT block a drop the operator asked for (hindsight.gpu: false)", () => {
    writeVerdict(true, true);
    const a = assessHindsightGpuDrop({
      existing: GPUS_ALL,
      decision: hindsightGpuDecision({ value: false, source: "config" }),
    });
    expect(a.drops).toBe(true);
    expect(a.blocks).toBe(false);
  });

  it("reports but does NOT block once --allow-gpu-drop is passed", () => {
    const a = assessHindsightGpuDrop({
      existing: GPUS_ALL,
      decision: degraded(),
      allowDrop: true,
    });
    expect(a.drops).toBe(true);
    expect(a.blocks).toBe(false);
    expect(a.message).toContain("--allow-gpu-drop was passed");
  });
});

describe("the drop guard is wired into the recreate path, and refuses early enough", () => {
  // Same rationale as the env-drift guard's ordering block (PR #3834): a guard
  // that only refuses AFTER `docker rm` has already run has not guarded
  // anything — the GPU-bearing container is gone by then and the operator is
  // left with a stopped stack plus an error. Driving this behaviourally would
  // mean recreating the production hindsight container against a live daemon,
  // so the assertions are structural on purpose.
  //
  // Anchors are call sites, not identifiers: `stopHindsight()` is also reached
  // via `--stop`, and the imports sit at the top of the file, so a bare
  // indexOf would compare the wrong occurrence and pass blind.
  const src = readFileSync(join(import.meta.dirname, "..", "cli", "memory.ts"), "utf-8");

  const at = (needle: string) => {
    const i = src.indexOf(needle);
    expect(i, `${needle} not found in src/cli/memory.ts`).toBeGreaterThan(-1);
    return i;
  };

  const INSPECTS = "existing: getHindsightDeviceRequests()";
  const ASSESSES = "assessHindsightGpuDrop({";
  const REPORTS = "gpuDrop.message";
  const REFUSES = "if (gpuDrop.blocks)";
  const PULLS = "pullHindsightImage(effectiveTag);";
  const REMOVES = "Removing existing switchroom-hindsight container";

  it("inspects the live container's device requests before removing it", () => {
    expect(at(INSPECTS)).toBeLessThan(at(REMOVES));
  });

  it("assesses the drop before the pull and before the removal", () => {
    // Before the pull too: a refusal should not have spent minutes pulling an
    // image it is about to decline to run.
    expect(at(ASSESSES)).toBeLessThan(at(PULLS));
    expect(at(ASSESSES)).toBeLessThan(at(REMOVES));
  });

  it("prints the reason before it refuses, and refuses before anything is touched", () => {
    expect(at(REPORTS)).toBeLessThan(at(REFUSES));
    expect(at(REFUSES)).toBeLessThan(at(PULLS));
    expect(at(REFUSES)).toBeLessThan(at(REMOVES));
  });

  it("threads the resolved GPU decision into the launch, not a hardcoded undefined", () => {
    // The bug's blast radius included the GPU-gated perf defaults, which are
    // selected from the same flag. If the drift report and the launcher
    // disagree about GPU, the report is lying about what is coming.
    expect(src).toContain("gpu: gpuDecision.enabled");
    expect(at("gpuDecision.enabled")).toBeLessThan(at(REMOVES));
  });
});
