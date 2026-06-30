/**
 * gpu-detect: install-time GPU detection + the local-vs-cloud voice-engine
 * verdict (voice PR-B1). These pin all three verdict branches via the
 * injectable probes — NO real `nvidia-smi` / `docker` shellout.
 */
import { describe, it, expect, vi } from "vitest";
import {
  detectGpuCapabilities,
  NVIDIA_TOOLKIT_INSTALL_HINT,
  type GpuDetectDeps,
} from "./gpu-detect.js";

function deps(gpu: boolean, toolkit: boolean): GpuDetectDeps {
  return {
    probeGpu: () => gpu,
    probeContainerToolkit: () => toolkit,
  };
}

describe("detectGpuCapabilities", () => {
  it("GPU + toolkit present → engine local", () => {
    const caps = detectGpuCapabilities(deps(true, true));
    expect(caps.gpuPresent).toBe(true);
    expect(caps.containerToolkit).toBe(true);
    expect(caps.engine).toBe("local");
    expect(caps.reason).toMatch(/run locally/i);
    expect(caps.reason).toMatch(/free, private, on-device/i);
  });

  it("GPU present, toolkit missing → engine cloud with install hint in reason", () => {
    const caps = detectGpuCapabilities(deps(true, false));
    expect(caps.gpuPresent).toBe(true);
    expect(caps.containerToolkit).toBe(false);
    expect(caps.engine).toBe("cloud");
    expect(caps.reason).toMatch(/nvidia-container-toolkit/i);
    expect(caps.reason).toContain(NVIDIA_TOOLKIT_INSTALL_HINT);
  });

  it("no GPU → engine cloud, no install hint, toolkit probe NOT run", () => {
    const toolkitProbe = vi.fn(() => true);
    const caps = detectGpuCapabilities({
      probeGpu: () => false,
      probeContainerToolkit: toolkitProbe,
    });
    expect(caps.gpuPresent).toBe(false);
    expect(caps.containerToolkit).toBe(false);
    expect(caps.engine).toBe("cloud");
    expect(caps.reason).toMatch(/no gpu detected/i);
    // No point interrogating docker on a GPU-less host.
    expect(toolkitProbe).not.toHaveBeenCalled();
  });

  it("local verdict requires BOTH probes true (gpu-only is not enough)", () => {
    expect(detectGpuCapabilities(deps(true, false)).engine).toBe("cloud");
    expect(detectGpuCapabilities(deps(false, false)).engine).toBe("cloud");
    expect(detectGpuCapabilities(deps(true, true)).engine).toBe("local");
  });
});
