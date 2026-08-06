/**
 * `switchroom doctor` — the live-container hindsight GPU drift row (#4459).
 *
 * The decision table itself is exhaustively covered in
 * `src/setup/hindsight-gpu-drift.test.ts`. This file pins the doctor ADAPTER:
 * that the assessment's status/detail/fix become a well-formed `CheckResult`,
 * and that the `hindsight.gpu` pin is read off the config into the fix text.
 */

import { describe, it, expect } from "vitest";
import { checkHindsightGpuLiveState } from "./doctor-hindsight-gpu.js";
import type { SwitchroomConfig } from "../config/schema.js";
import type { GpuCapabilities } from "../setup/gpu-detect.js";
import type { HostCapabilitiesRead } from "../setup/host-capabilities.js";
import type { HindsightDeviceRequest } from "../setup/hindsight.js";

const CONFIG = { agents: {} } as unknown as SwitchroomConfig;
const CONFIG_GPU_PINNED = { agents: {}, hindsight: { gpu: true } } as unknown as SwitchroomConfig;

const usableProbe: GpuCapabilities = {
  gpuPresent: true,
  containerToolkit: true,
  engine: "local",
  reason: "GPU detected — voice will run locally (free, private, on-device).",
};

const okVerdict: HostCapabilitiesRead = {
  status: "ok",
  path: "/home/x/.switchroom/host-capabilities.json",
  caps: {
    version: 1,
    voice: { gpuPresent: true, containerToolkit: true, engine: "local", detectedAt: "2026-06-30T00:00:00.000Z" },
  },
  detail: "",
};

const GPUS_ALL: HindsightDeviceRequest[] = [
  { Driver: "", Count: -1, DeviceIDs: null, Capabilities: [["gpu"]] },
];

describe("checkHindsightGpuLiveState", () => {
  it("FAILs — a usable GPU host serving a CPU-only container", () => {
    const r = checkHindsightGpuLiveState(CONFIG, {
      probe: () => usableProbe,
      capsRead: () => okVerdict,
      deviceRequests: () => [],
    });
    expect(r.name).toBe("hindsight GPU (live container)");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("USABLE GPU");
    expect(r.fix).toContain("--recreate");
  });

  it("is OK when the container has GPU passthrough", () => {
    const r = checkHindsightGpuLiveState(CONFIG, {
      probe: () => usableProbe,
      capsRead: () => okVerdict,
      deviceRequests: () => GPUS_ALL,
    });
    expect(r.status).toBe("ok");
    expect(r.fix).toBeUndefined();
  });

  it("stays OK — never false-alarms — when the container cannot be read (docker down)", () => {
    const r = checkHindsightGpuLiveState(CONFIG, {
      probe: () => usableProbe,
      capsRead: () => okVerdict,
      deviceRequests: () => null,
    });
    expect(r.status).toBe("ok");
    expect(r.fix).toBeUndefined();
  });

  it("reads the hindsight.gpu pin into the fix wording", () => {
    const r = checkHindsightGpuLiveState(CONFIG_GPU_PINNED, {
      probe: () => usableProbe,
      capsRead: () => okVerdict,
      deviceRequests: () => [],
    });
    expect(r.status).toBe("fail");
    expect(r.fix).toContain("already set");
  });
});
