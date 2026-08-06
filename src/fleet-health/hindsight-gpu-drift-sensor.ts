/**
 * Fleet Health — hindsight GPU drift sensor.
 *
 * The nightly, no-one-looking counterpart to the `switchroom doctor` check
 * (`src/cli/doctor-hindsight-gpu.ts`). Both route through the ONE assessment in
 * `src/setup/hindsight-gpu-drift.ts`, so their verdicts cannot diverge.
 *
 * It emits a `Finding` (→ priority ledger → GitHub issue) ONLY for the FAIL
 * case: a PROVABLY usable GPU (nvidia-smi + the nvidia container runtime) paired
 * with a live container that requests no devices. That is the 2026-07-28
 * incident (#4459) — CPU-only recalls on an idle GPU, missed by a green doctor.
 *
 * The WARN case (the persisted verdict records a GPU but the live probe cannot
 * confirm it) is deliberately NOT escalated into the ledger: it is an
 * unconfirmable conflict — a false-negative probe from a non-login `$PATH`, or a
 * genuinely-absent GPU — and opening a severity-3 GitHub issue on it would cry
 * wolf. Doctor still surfaces it interactively; only the provable degradation
 * opens an issue. A "could not tell" about the container (no container / docker
 * down) never produces a finding either.
 *
 * STRICTLY MODEL-FREE: a host probe, a caps-file read, one `docker inspect`.
 * No LLM, no network.
 */

import type { Finding } from "./detect.js";
import {
  runHindsightGpuDriftAssessment,
  type HindsightGpuDriftDeps,
} from "../setup/hindsight-gpu-drift.js";

/** The pseudo-agent the GPU-drift finding is attributed to. It names the shared
 *  hindsight container, not a real switchroom agent, so the ledger's `reach`
 *  and occurrence pointers read sensibly. `isTestAgent` never matches it, and
 *  `runScan` injects it directly (not via the per-agent artifact loop), so it
 *  never collides with an agent directory. */
export const HINDSIGHT_PSEUDO_AGENT = "switchroom-hindsight";

export interface HindsightGpuSensorOptions {
  /** `hindsight.gpu` pin from switchroom.yaml, if set — shapes the fix text. */
  gpuPinned?: boolean;
  /** I/O seams (host probe / caps read / docker inspect). Injected by tests so
   *  the suite never depends on a real GPU, container, or filesystem. */
  deps?: HindsightGpuDriftDeps;
  log?: (msg: string) => void;
  /** Timestamp for the finding (ISO). Defaults to now. */
  nowIso?: string;
}

export interface HindsightGpuSensorResult {
  status: "ok" | "warn" | "violation";
  findings: Finding[];
}

/**
 * Run the hindsight GPU drift sensor. A provable CPU-on-GPU-host drift → one
 * `Finding` attributed to the hindsight pseudo-agent, escalating into the
 * ledger. Everything else (agreement, unconfirmable conflict, could-not-tell)
 * → no finding, with a visible log line.
 */
export function scanHindsightGpuDrift(
  opts: HindsightGpuSensorOptions = {},
): HindsightGpuSensorResult {
  const log = opts.log ?? (() => {});
  const nowIso = opts.nowIso ?? new Date().toISOString();

  const assessment = runHindsightGpuDriftAssessment({
    gpuPinned: opts.gpuPinned,
    deps: opts.deps,
  });

  if (assessment.status === "fail") {
    log(`fleet-health: hindsight-gpu sensor VIOLATION — ${assessment.detail}`);
    const finding: Finding = {
      signal: "hindsight-gpu-cpu-on-gpu-host",
      agent: HINDSIGHT_PSEUDO_AGENT,
      turn_id: "hindsight-gpu:cpu-only-on-gpu-host",
      log_pointer: `docker inspect ${HINDSIGHT_PSEUDO_AGENT} HostConfig.DeviceRequests — ${assessment.detail}`,
      ts: nowIso,
    };
    return { status: "violation", findings: [finding] };
  }

  if (assessment.status === "warn") {
    // Surfaced by doctor; NOT escalated into the nightly ledger (unconfirmable).
    log(`fleet-health: hindsight-gpu sensor WARN (not ledgered) — ${assessment.detail}`);
    return { status: "warn", findings: [] };
  }

  log(`fleet-health: hindsight-gpu sensor OK — ${assessment.detail}`);
  return { status: "ok", findings: [] };
}
