/**
 * The live-state hindsight GPU drift assessment (issue #4459).
 *
 * The regression this guards: the `switchroom-hindsight` container ran CPU-only
 * (`HostConfig.DeviceRequests: null`) on a host with a working RTX 3070 +
 * nvidia-container-toolkit. Reranker + local embeddings fell to CPU, recalls
 * hit 5-9s and the deadline, and `switchroom doctor` stayed GREEN — because
 * nothing inspected the LIVE container's device state.
 *
 * Every cell of the decision table is pinned here, and each of the three
 * load-bearing outcomes would independently have caught the incident:
 *
 *   1. a PROVABLY usable GPU + a provably CPU-only container ⇒ FAIL (loud);
 *   2. a container we could NOT read (docker down / absent) ⇒ never alarms;
 *   3. a caps verdict that says GPU but a probe that can't confirm ⇒ WARN,
 *      not a false FAIL.
 */

import { describe, expect, it } from "vitest";

import type { GpuCapabilities } from "./gpu-detect.js";
import type {
  HostCapabilitiesRead,
  HostCapabilities,
} from "./host-capabilities.js";
import type { HindsightDeviceRequest } from "./hindsight.js";
import {
  assessHindsightGpuDrift,
  runHindsightGpuDriftAssessment,
} from "./hindsight-gpu-drift.js";

/** `--gpus all`, exactly as docker materialises it in HostConfig.DeviceRequests. */
const GPUS_ALL: HindsightDeviceRequest[] = [
  { Driver: "", Count: -1, DeviceIDs: null, Capabilities: [["gpu"]] },
];

/** A GPU probe result. Defaults to a fully usable GPU host. */
function probe(over: Partial<GpuCapabilities> = {}): GpuCapabilities {
  return {
    gpuPresent: true,
    containerToolkit: true,
    engine: "local",
    reason: "GPU detected — voice will run locally (free, private, on-device).",
    ...over,
  };
}

/** A host-capabilities read. Defaults to an `ok` verdict proving a usable GPU. */
function capsRead(over: Partial<HostCapabilitiesRead> = {}): HostCapabilitiesRead {
  const caps: HostCapabilities = {
    version: 1,
    voice: {
      gpuPresent: true,
      containerToolkit: true,
      engine: "local",
      detectedAt: "2026-06-30T00:00:00.000Z",
    },
  };
  return {
    status: "ok",
    path: "/home/x/.switchroom/host-capabilities.json",
    caps,
    detail: "",
    ...over,
  };
}

/** A verdict `ok`-read but recording a specific pair of probe booleans. */
function capsVerdict(gpuPresent: boolean, containerToolkit: boolean): HostCapabilitiesRead {
  return capsRead({
    caps: {
      version: 1,
      voice: {
        gpuPresent,
        containerToolkit,
        engine: gpuPresent && containerToolkit ? "local" : "cloud",
        detectedAt: "2026-06-30T00:00:00.000Z",
      },
    },
  });
}

describe("assessHindsightGpuDrift — the decision table", () => {
  it("FAILs when a provably usable GPU host runs a CPU-only container", () => {
    const a = assessHindsightGpuDrift({
      probe: probe(),
      capsRead: capsRead(),
      deviceRequests: [], // container exists, requests no devices
    });
    expect(a.status).toBe("fail");
    expect(a.hostGpu).toBe("proven");
    expect(a.container).toBe("cpu");
    // The message must name the fix.
    expect(a.fix).toBeDefined();
    expect(a.fix).toContain("--recreate");
    expect(a.fix).toContain("hindsight.gpu");
  });

  it("is OK when a GPU host runs a GPU container (agreement)", () => {
    const a = assessHindsightGpuDrift({
      probe: probe(),
      capsRead: capsRead(),
      deviceRequests: GPUS_ALL,
    });
    expect(a.status).toBe("ok");
    expect(a.container).toBe("gpu");
    expect(a.fix).toBeUndefined();
  });

  it("is OK (could-not-tell) when the container state is null — NO false alarm", () => {
    // This is the docker-down / no-container case. A usable GPU host with an
    // unreadable container MUST NOT fail — else doctor cries wolf every time the
    // container is stopped.
    const a = assessHindsightGpuDrift({
      probe: probe(),
      capsRead: capsRead(),
      deviceRequests: null,
    });
    expect(a.status).toBe("ok");
    expect(a.container).toBe("unknown");
    expect(a.fix).toBeUndefined();
  });

  it("WARNs (not FAILs) when the caps verdict claims a GPU the probe can't confirm", () => {
    // Live probe sees no usable GPU (e.g. nvidia-smi off a non-login $PATH),
    // but the persisted verdict records one. CPU-only container → surface it,
    // but do not open a provable-FAIL — the probe might be a false negative.
    const a = assessHindsightGpuDrift({
      probe: probe({ gpuPresent: false, containerToolkit: false, engine: "cloud", reason: "No GPU detected" }),
      capsRead: capsVerdict(true, true),
      deviceRequests: [],
    });
    expect(a.status).toBe("warn");
    expect(a.hostGpu).toBe("suspected");
    expect(a.fix).toBeDefined();
  });

  it("is OK when neither the probe nor the verdict proves a usable GPU (genuine no-GPU host)", () => {
    const a = assessHindsightGpuDrift({
      probe: probe({ gpuPresent: false, containerToolkit: false, engine: "cloud", reason: "No GPU detected" }),
      capsRead: capsVerdict(false, false),
      deviceRequests: [],
    });
    expect(a.status).toBe("ok");
    expect(a.hostGpu).toBe("unproven");
    expect(a.fix).toBeUndefined();
  });

  it("does NOT alarm on a GPU-present-but-no-toolkit host (passthrough impossible)", () => {
    // A GPU with no container runtime cannot be passed in, so a CPU container is
    // correct. Probe reports not-usable; the verdict also records toolkit=false.
    const a = assessHindsightGpuDrift({
      probe: probe({ containerToolkit: false, engine: "cloud", reason: "GPU detected but nvidia-container-toolkit isn't installed" }),
      capsRead: capsVerdict(true, false),
      deviceRequests: [],
    });
    expect(a.status).toBe("ok");
    expect(a.hostGpu).toBe("unproven");
  });

  it("does NOT alarm when the caps read is DEGRADED (unreadable) and the probe can't prove GPU", () => {
    // A degraded verdict is "could not tell", not "usable GPU". With no positive
    // probe either, a CPU container must stay quiet — the degraded read has its
    // own loud doctor row (`checkHostCapabilitiesReadable`).
    const a = assessHindsightGpuDrift({
      probe: probe({ gpuPresent: false, containerToolkit: false, engine: "cloud", reason: "No GPU detected" }),
      capsRead: capsRead({ status: "unreadable", caps: null, code: "EACCES", detail: "EACCES: permission denied" }),
      deviceRequests: [],
    });
    expect(a.status).toBe("ok");
    expect(a.hostGpu).toBe("unproven");
  });

  it("still FAILs on a proven-usable probe even when the caps read is degraded", () => {
    // The live probe is the strong signal; a degraded verdict does not soften a
    // proven GPU + CPU container into a mere warning.
    const a = assessHindsightGpuDrift({
      probe: probe(),
      capsRead: capsRead({ status: "unreadable", caps: null, code: "EACCES", detail: "EACCES: permission denied" }),
      deviceRequests: [],
    });
    expect(a.status).toBe("fail");
    expect(a.hostGpu).toBe("proven");
  });

  it("recognises `--gpus device=0` shape as a GPU container", () => {
    const a = assessHindsightGpuDrift({
      probe: probe(),
      capsRead: capsRead(),
      deviceRequests: [{ Driver: "nvidia", Count: 0, DeviceIDs: ["0"], Capabilities: null }],
    });
    expect(a.status).toBe("ok");
    expect(a.container).toBe("gpu");
  });

  it("adapts the fix text when hindsight.gpu is already pinned true", () => {
    const a = assessHindsightGpuDrift({
      probe: probe(),
      capsRead: capsRead(),
      deviceRequests: [],
      gpuPinned: true,
    });
    expect(a.status).toBe("fail");
    // A pinned-true host that is still CPU-only needs a recreate, and the text
    // should say the pin is already set.
    expect(a.fix).toContain("already set");
    expect(a.fix).toContain("--recreate");
  });
});

describe("runHindsightGpuDriftAssessment — wires the injected probes", () => {
  it("routes injected deps through the pure assessment (proven GPU + CPU container ⇒ FAIL)", () => {
    const a = runHindsightGpuDriftAssessment({
      deps: {
        probe: () => probe(),
        capsRead: () => capsRead(),
        deviceRequests: () => [],
      },
    });
    expect(a.status).toBe("fail");
  });

  it("degrades to OK when the container probe returns null (docker unavailable)", () => {
    const a = runHindsightGpuDriftAssessment({
      deps: {
        probe: () => probe(),
        capsRead: () => capsRead(),
        deviceRequests: () => null,
      },
    });
    expect(a.status).toBe("ok");
    expect(a.container).toBe("unknown");
  });
});
