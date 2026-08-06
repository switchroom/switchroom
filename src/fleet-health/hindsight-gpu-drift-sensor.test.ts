/**
 * Fleet Health — the hindsight GPU drift sensor (#4459).
 *
 * The core decision table lives in `src/setup/hindsight-gpu-drift.test.ts`.
 * This file pins the SENSOR contract: a PROVABLE CPU-on-GPU-host drift emits
 * exactly one ledger-bound `Finding`; the unconfirmable WARN case and the
 * agreement/could-not-tell cases emit NONE (they must not open a nightly
 * GitHub issue).
 */

import { describe, it, expect } from "vitest";

import { scanHindsightGpuDrift, HINDSIGHT_PSEUDO_AGENT } from "./hindsight-gpu-drift-sensor.js";
import { SIGNAL_MAP } from "./mapping.js";
import type { GpuCapabilities } from "../setup/gpu-detect.js";
import type { HostCapabilitiesRead } from "../setup/host-capabilities.js";
import type { HindsightDeviceRequest } from "../setup/hindsight.js";

const usableProbe: GpuCapabilities = {
  gpuPresent: true,
  containerToolkit: true,
  engine: "local",
  reason: "GPU detected — voice will run locally (free, private, on-device).",
};
const noGpuProbe: GpuCapabilities = {
  gpuPresent: false,
  containerToolkit: false,
  engine: "cloud",
  reason: "No GPU detected — voice will use cloud providers if you enable it.",
};

function verdict(gpuPresent: boolean, containerToolkit: boolean): HostCapabilitiesRead {
  return {
    status: "ok",
    path: "/home/x/.switchroom/host-capabilities.json",
    caps: {
      version: 1,
      voice: { gpuPresent, containerToolkit, engine: gpuPresent && containerToolkit ? "local" : "cloud", detectedAt: "2026-06-30T00:00:00.000Z" },
    },
    detail: "",
  };
}

const GPUS_ALL: HindsightDeviceRequest[] = [
  { Driver: "", Count: -1, DeviceIDs: null, Capabilities: [["gpu"]] },
];

describe("scanHindsightGpuDrift", () => {
  it("emits ONE ledger finding on a provable CPU-on-GPU-host drift", () => {
    const r = scanHindsightGpuDrift({
      deps: { probe: () => usableProbe, capsRead: () => verdict(true, true), deviceRequests: () => [] },
      nowIso: "2026-08-06T00:00:00.000Z",
    });
    expect(r.status).toBe("violation");
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.signal).toBe("hindsight-gpu-cpu-on-gpu-host");
    expect(f.agent).toBe(HINDSIGHT_PSEUDO_AGENT);
    expect(f.ts).toBe("2026-08-06T00:00:00.000Z");
    expect(f.log_pointer).toContain("DeviceRequests");
    // The signal must be mapped, or the ledger writer would throw on it.
    expect(SIGNAL_MAP["hindsight-gpu-cpu-on-gpu-host"]).toBeDefined();
    expect(SIGNAL_MAP["hindsight-gpu-cpu-on-gpu-host"].severity).toBe(3);
  });

  it("emits NO finding for the unconfirmable WARN case (verdict claims GPU, probe can't confirm)", () => {
    const r = scanHindsightGpuDrift({
      deps: { probe: () => noGpuProbe, capsRead: () => verdict(true, true), deviceRequests: () => [] },
    });
    expect(r.status).toBe("warn");
    expect(r.findings).toHaveLength(0);
  });

  it("emits NO finding when host + container agree (GPU host, GPU container)", () => {
    const r = scanHindsightGpuDrift({
      deps: { probe: () => usableProbe, capsRead: () => verdict(true, true), deviceRequests: () => GPUS_ALL },
    });
    expect(r.status).toBe("ok");
    expect(r.findings).toHaveLength(0);
  });

  it("emits NO finding when the container cannot be read (docker down / absent)", () => {
    const r = scanHindsightGpuDrift({
      deps: { probe: () => usableProbe, capsRead: () => verdict(true, true), deviceRequests: () => null },
    });
    expect(r.status).toBe("ok");
    expect(r.findings).toHaveLength(0);
  });

  it("emits NO finding on a genuine no-GPU host running CPU-only", () => {
    const r = scanHindsightGpuDrift({
      deps: { probe: () => noGpuProbe, capsRead: () => verdict(false, false), deviceRequests: () => [] },
    });
    expect(r.status).toBe("ok");
    expect(r.findings).toHaveLength(0);
  });
});
