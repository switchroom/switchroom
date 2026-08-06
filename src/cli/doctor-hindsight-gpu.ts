/**
 * `switchroom doctor` — the live-state hindsight GPU drift check.
 *
 * `checkHostCapabilitiesReadable` (in `doctor.ts`) inspects the caps FILE:
 * what a future recreate would DECIDE. This check inspects the LIVE
 * `switchroom-hindsight` container's actual device state and compares it
 * against what the host can actually do. It is the standing counterpart to the
 * recreate-time drop guard (`hindsight-gpu-guard.ts`) — the incident that
 * motivated it (issue #4459) had a green doctor while hindsight served CPU-only
 * recalls on a GPU host, precisely because nothing looked at the running
 * container.
 *
 * The decision logic lives in `src/setup/hindsight-gpu-drift.ts` so the nightly
 * fleet-health sensor and this check share one assessment and cannot drift.
 */

import type { SwitchroomConfig } from "../config/schema.js";
import type { CheckStatus } from "./doctor-status.js";
import {
  runHindsightGpuDriftAssessment,
  type HindsightGpuDriftDeps,
} from "../setup/hindsight-gpu-drift.js";

/** Structurally identical to `doctor.ts`'s `CheckResult` (each doctor module
 *  declares its own to avoid a circular import back into `doctor.ts`). */
export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/**
 * Assess whether the live hindsight container is running CPU-only on a
 * GPU-capable host.
 *
 * - **fail** — the host has a PROVABLY usable GPU (nvidia-smi + the nvidia
 *   container runtime) but the running container requests no devices.
 * - **warn** — the persisted verdict records a usable GPU but the live probe
 *   could not confirm it, and the container is CPU-only.
 * - **ok** — they agree (GPU host + GPU container, or a genuine no-GPU host +
 *   CPU container), OR the container state could not be read (no container /
 *   docker down) — a "could not tell" never false-alarms.
 *
 * @internal exported for testing
 */
export function checkHindsightGpuLiveState(
  config: SwitchroomConfig,
  deps?: HindsightGpuDriftDeps,
): CheckResult {
  const gpuPinned =
    typeof config.hindsight?.gpu === "boolean" ? config.hindsight.gpu : undefined;

  const assessment = runHindsightGpuDriftAssessment({ gpuPinned, deps });

  return {
    name: "hindsight GPU (live container)",
    status: assessment.status,
    detail: assessment.detail,
    ...(assessment.fix ? { fix: assessment.fix } : {}),
  };
}
