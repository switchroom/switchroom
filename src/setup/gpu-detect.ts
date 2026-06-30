/**
 * Install-time GPU capability detection + the local-vs-cloud voice-engine
 * verdict (voice feature PR-B1).
 *
 * Switchroom runs voice (STT/TTS) on LOCAL GPU models by default WHEN a GPU
 * is usable from a container, and falls back to cloud providers otherwise.
 * This module is the single source of that decision: it probes the host for
 * (a) an NVIDIA GPU and (b) the nvidia-container-toolkit (so Docker can
 * actually pass the GPU INTO a sidecar container), then derives an `engine`
 * verdict.
 *
 * BOTH must be present for a `local` verdict — a GPU the container runtime
 * can't reach is useless to the voice sidecar (which lands in PR-B2).
 *
 * The probes are INJECTABLE (`GpuDetectDeps`) so tests never shell out to a
 * real `nvidia-smi` / `docker`. The default implementations mirror the
 * shell-out style + 8s timeout used by `doctor-docker.ts`'s
 * `defaultListContainers`.
 *
 * This PR establishes detection + verdict + persistence + setup messaging
 * only. It deliberately does NOT emit a compose sidecar or touch the
 * gateway — that's PR-B2, which re-reads the persisted verdict.
 */

import { spawnSync } from "node:child_process";

/** The voice engine the host will use, derived from capability probes. */
export type VoiceEngine = "local" | "cloud";

/** Structured detection result — persisted (sans `reason` derivation) + surfaced at setup. */
export interface GpuCapabilities {
  /** An NVIDIA GPU is present (nvidia-smi exited 0). */
  gpuPresent: boolean;
  /** The nvidia-container-toolkit is wired so Docker can pass the GPU into a container. */
  containerToolkit: boolean;
  /** `local` only when BOTH gpuPresent AND containerToolkit; else `cloud`. */
  engine: VoiceEngine;
  /** Human-readable one-liner explaining the verdict (for setup output / doctor). */
  reason: string;
}

/**
 * Injectable probes. Each returns a plain boolean; the default
 * implementations shell out, but tests pass stubs so the suite never
 * depends on the host having (or lacking) a GPU.
 */
export interface GpuDetectDeps {
  /** True if an NVIDIA GPU is present — default probes `nvidia-smi` (exit 0). */
  probeGpu: () => boolean;
  /**
   * True if Docker can pass a GPU into a container — default checks for the
   * `nvidia` runtime in `docker info`. Only meaningful when a GPU is present.
   */
  probeContainerToolkit: () => boolean;
}

/** Default (real) GPU probe — `nvidia-smi` exiting 0 means a usable driver+GPU. */
function defaultProbeGpu(): boolean {
  const r = spawnSync("nvidia-smi", ["-L"], { stdio: "pipe", timeout: 8000 });
  // r.error → binary absent (ENOENT); non-zero status → driver/GPU problem.
  return !r.error && r.status === 0;
}

/**
 * Default (real) container-toolkit probe.
 *
 * The load-bearing question is "can Docker pass the GPU into a container",
 * not merely "is some toolkit package installed". The most reliable
 * cheap signal is whether the Docker daemon advertises the `nvidia`
 * runtime, which the nvidia-container-toolkit registers. We read
 * `docker info` and look for it. A GPU with the driver but no toolkit
 * registration will NOT show the runtime — exactly the case we must
 * route to cloud.
 */
function defaultProbeContainerToolkit(): boolean {
  const r = spawnSync(
    "docker",
    ["info", "--format", "{{json .Runtimes}}"],
    { stdio: "pipe", timeout: 8000 },
  );
  if (r.error || r.status !== 0) return false;
  const out = r.stdout.toString().toLowerCase();
  // {{json .Runtimes}} → an object keyed by runtime name; `nvidia` present
  // means the toolkit registered it with the daemon.
  return out.includes("nvidia");
}

const DEFAULT_DEPS: GpuDetectDeps = {
  probeGpu: defaultProbeGpu,
  probeContainerToolkit: defaultProbeContainerToolkit,
};

/**
 * Detect GPU capabilities and derive the voice-engine verdict.
 *
 * Verdict table:
 *   - GPU + toolkit  → engine: "local"  (free, private, on-device)
 *   - GPU, no toolkit → engine: "cloud" (toolkit missing — installable)
 *   - no GPU          → engine: "cloud" (no local option)
 *
 * The container-toolkit probe is only run when a GPU is present — there's
 * no reason to interrogate Docker's runtimes on a host that can't run
 * local models at all, and skipping it keeps a GPU-less host from a
 * needless `docker info` shell-out.
 */
export function detectGpuCapabilities(
  deps: GpuDetectDeps = DEFAULT_DEPS,
): GpuCapabilities {
  const gpuPresent = deps.probeGpu();

  if (!gpuPresent) {
    return {
      gpuPresent: false,
      containerToolkit: false,
      engine: "cloud",
      reason:
        "No GPU detected — voice will use cloud providers if you enable it.",
    };
  }

  const containerToolkit = deps.probeContainerToolkit();

  if (!containerToolkit) {
    return {
      gpuPresent: true,
      containerToolkit: false,
      engine: "cloud",
      reason:
        "GPU detected but nvidia-container-toolkit isn't installed — install it to run voice " +
        "locally, or voice will use cloud providers. See: " +
        NVIDIA_TOOLKIT_INSTALL_HINT,
    };
  }

  return {
    gpuPresent: true,
    containerToolkit: true,
    engine: "local",
    reason: "GPU detected — voice will run locally (free, private, on-device).",
  };
}

/** One-line install pointer surfaced when a GPU is present but the toolkit isn't. */
export const NVIDIA_TOOLKIT_INSTALL_HINT =
  "https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html";
