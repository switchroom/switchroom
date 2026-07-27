/**
 * The recreate-time GPU drop guard.
 *
 * `switchroom memory setup --recreate` tears the hindsight container down and
 * rebuilds its argv from scratch. The `--gpus all` pair on that argv is gated
 * on `hindsightGpuDecision()`, and on 2026-07-28 that gate evaluated false on a
 * host that genuinely had a GPU — the persisted verdict file was
 * `root:root 0600` under a uid-1000 home, so the read EACCES'd and was
 * swallowed. The recreate succeeded, the container came back on `runc` with
 * `HostConfig.DeviceRequests: null`, and the local embedding model plus the
 * cross-encoder reranker moved to CPU on the interactive recall path. Nothing
 * printed. Nothing failed. It was found by hand-diffing a `docker inspect`
 * snapshot taken minutes earlier.
 *
 * The read is now loud (`readHostCapabilities`) and the answer is now
 * overridable (`hindsight.gpu` / `--gpu` / `--no-gpu`), but neither of those is
 * a backstop: both require the operator to already be looking. This module is
 * the backstop. It compares what the RUNNING container has against what the
 * NEXT launch plans to have, and refuses the recreate when GPU would be lost
 * without anyone having asked for that.
 *
 * Deliberate asymmetry — an explicit `--no-gpu` / `hindsight.gpu: false` is NOT
 * refused. That IS the opt-out: the operator stated the intent in the same
 * breath as the recreate. `--allow-gpu-drop` exists for the remaining case, an
 * autodetected drop the operator has looked at and accepted, so that accepting
 * it never requires editing switchroom.yaml mid-incident.
 */

import type { HindsightDeviceRequest, HindsightGpuDecision } from "./hindsight.js";
import { deviceRequestsHaveGpu } from "./hindsight.js";

/** Verdict of {@link assessHindsightGpuDrop}. */
export interface HindsightGpuDropAssessment {
  /** True iff the running container has GPU and the next launch would not. */
  drops: boolean;
  /**
   * True iff the drop must block the recreate. False for a drop the operator
   * explicitly asked for (`--no-gpu` / `hindsight.gpu: false`) or explicitly
   * accepted (`--allow-gpu-drop`) — those are reported, not refused.
   */
  blocks: boolean;
  /** Operator-facing report. Empty string when `drops` is false. */
  message: string;
}

/**
 * Compare the live container's device requests against the planned GPU answer.
 *
 * @param existing Live `HostConfig.DeviceRequests`, or `null` for "could not
 *   tell" (no container / docker unavailable). A `null` never blocks — the
 *   guard refuses only on positive evidence that GPU is being taken away.
 */
export function assessHindsightGpuDrop(args: {
  existing: HindsightDeviceRequest[] | null;
  decision: HindsightGpuDecision;
  /** `--allow-gpu-drop`: proceed past an autodetected drop. */
  allowDrop?: boolean;
}): HindsightGpuDropAssessment {
  const { existing, decision, allowDrop = false } = args;

  const hadGpu = deviceRequestsHaveGpu(existing);
  if (!hadGpu || decision.enabled) {
    return { drops: false, blocks: false, message: "" };
  }

  // An explicit operator answer is consent. Report it; do not refuse it.
  const explicit = decision.source !== "autodetect";
  const blocks = !explicit && !allowDrop;

  return { drops: true, blocks, message: buildMessage(decision, blocks, explicit) };
}

function buildMessage(
  decision: HindsightGpuDecision,
  blocks: boolean,
  explicit: boolean,
): string {
  const head = blocks
    ? "Refusing to recreate switchroom-hindsight: it is running WITH GPU passthrough and this recreate would drop it."
    : "switchroom-hindsight is running WITH GPU passthrough and this recreate drops it.";

  const lines = [head, `  Reason: ${decision.reason}`];

  if (decision.degraded) {
    lines.push(
      "  This is a BLIND false, not a negative one — switchroom could not read the",
      "  host-capabilities verdict, so it cannot tell whether this host has a GPU.",
      `  Fix the file: sudo chown $(id -u):$(id -g) ${decision.capabilities.path} && chmod 600 ${decision.capabilities.path}`,
    );
  }

  lines.push(
    "  Dropping GPU moves the local embedding model and the cross-encoder reranker",
    "  to CPU on the interactive recall path, and also withholds the GPU-gated perf",
    "  defaults (HINDSIGHT_API_RERANKER_LOCAL_FP16, ..._BATCH_SIZE).",
  );

  if (blocks) {
    lines.push(
      "  Choose one:",
      "    --gpu                        keep GPU passthrough on this recreate",
      "    hindsight.gpu: true          keep it on every recreate (switchroom.yaml)",
      "    --allow-gpu-drop             proceed to CPU anyway, this once",
      "    --no-gpu                     proceed to CPU and mean it",
    );
  } else if (explicit) {
    lines.push("  Proceeding: the drop was requested explicitly.");
  } else {
    lines.push("  Proceeding: --allow-gpu-drop was passed.");
  }

  return lines.join("\n");
}
