/**
 * Live-state GPU drift assessment for the hindsight container.
 *
 * The gap this closes (issue #4459, incident 2026-07-28..08-06): the
 * `switchroom-hindsight` container ran CPU-only (`HostConfig.DeviceRequests:
 * null`) on a host with a working RTX 3070 + nvidia-container-toolkit. The
 * reranker and the local embedding model fell to CPU on the interactive recall
 * path — recalls climbed to 5-9s and hit the deadline — and NOTHING detected
 * it. `switchroom doctor` was green throughout, because its only GPU-related
 * check (`checkHostCapabilitiesReadable`) inspects the caps FILE — what a
 * FUTURE recreate would decide — and never the LIVE container's actual device
 * state. Its "GPU not proven" branch returns `ok`, not a warning.
 *
 * The building blocks already existed but were only wired into the
 * recreate-time drop guard (`hindsight-gpu-guard.ts`), never into a standing
 * health check:
 *   - {@link getHindsightDeviceRequests} / {@link deviceRequestsHaveGpu} read
 *     and interpret the live container's `HostConfig.DeviceRequests`;
 *   - {@link detectGpuCapabilities} probes the host (nvidia-smi + the nvidia
 *     container runtime);
 *   - {@link readHostCapabilities} corroborates with the persisted verdict,
 *     keeping the "no GPU" vs "could not tell" distinction it was built for.
 *
 * This module is the cause-AGNOSTIC alarm: it compares what the host can
 * actually do against what the running container actually has, and reports
 * loudly when a usable GPU sits idle while hindsight serves CPU-only recalls —
 * regardless of HOW the container ended up CPU-only (a stale hand `docker run`,
 * an on-disk recreate script that dropped `--gpus all`, a slipped `--no-gpu`).
 * It is consumed by both `switchroom doctor` (`doctor-hindsight-gpu.ts`) and
 * the nightly fleet-health scan (`fleet-health/hindsight-gpu-drift-sensor.ts`).
 */

import { detectGpuCapabilities, type GpuCapabilities } from "./gpu-detect.js";
import {
  readHostCapabilities,
  type HostCapabilitiesRead,
} from "./host-capabilities.js";
import {
  deviceRequestsHaveGpu,
  getHindsightDeviceRequests,
  type HindsightDeviceRequest,
} from "./hindsight.js";

/** The default container name the drift check inspects. */
export const HINDSIGHT_CONTAINER = "switchroom-hindsight";

/** Severity of the drift verdict. Mirrors the doctor `CheckStatus` subset this
 *  check can emit (it never `skip`s — a "could not tell" is a benign `ok`). */
export type HindsightGpuDriftStatus = "ok" | "warn" | "fail";

/**
 * How confidently the host is known to offer USABLE GPU passthrough.
 *
 *   - `proven`    — the live probe confirmed BOTH an NVIDIA GPU (`nvidia-smi`)
 *                   AND the nvidia container runtime (Docker can pass it in).
 *                   This is the strong signal: a CPU-only container here is a
 *                   provable degradation → FAIL.
 *   - `suspected` — the live probe could NOT confirm usability this run, but
 *                   the persisted capabilities verdict records a usable GPU
 *                   (`gpuPresent && containerToolkit`). Either the GPU is
 *                   genuinely unavailable now, or the probe cannot see it from
 *                   this process (e.g. `nvidia-smi` off a non-login `$PATH`).
 *                   A CPU-only container here is worth surfacing → WARN.
 *   - `unproven`  — no positive evidence of a usable GPU from either source: a
 *                   genuine no-GPU host, or one we simply cannot tell about. A
 *                   CPU-only container here is expected → no alarm.
 */
export type HostGpuUsability = "proven" | "suspected" | "unproven";

/**
 * The live container's device state.
 *
 *   - `gpu`     — `HostConfig.DeviceRequests` carries an NVIDIA GPU.
 *   - `cpu`     — the container exists and requests no devices (`[]`).
 *   - `unknown` — could not tell: no container, docker unavailable, or an
 *                 unparseable inspect ({@link getHindsightDeviceRequests}
 *                 returned `null`). NEVER produces an alarm — a false positive
 *                 here would cry wolf every time the container is down.
 */
export type LiveContainerGpu = "gpu" | "cpu" | "unknown";

export interface HindsightGpuDriftAssessment {
  status: HindsightGpuDriftStatus;
  hostGpu: HostGpuUsability;
  container: LiveContainerGpu;
  /** One-line human explanation, operator-facing. */
  detail: string;
  /** How to fix it — present only for `warn`/`fail`. */
  fix?: string;
}

/**
 * The pure decision. All I/O (the host probe, the caps read, the docker
 * inspect) is done by the caller and passed in, so this is fully hermetic and
 * every cell of the decision table is unit-testable without a real GPU, a real
 * container, or a real filesystem.
 *
 * Decision table (rows = host GPU usability, cols = live container state):
 *
 *   host \ container | gpu        | cpu            | unknown
 *   -----------------+------------+----------------+-------------
 *   proven           | ok (agree) | FAIL           | ok (degrade)
 *   suspected        | ok (agree) | WARN           | ok (degrade)
 *   unproven         | ok         | ok (expected)  | ok (degrade)
 *
 * The `unknown` column is always `ok`: a "could not tell" about the container
 * must not manufacture a false alarm. The `gpu` column is always `ok`: the
 * container has what the host can give. Only a provably/suspectedly usable GPU
 * paired with a provably CPU-only container is loud.
 */
export function assessHindsightGpuDrift(args: {
  probe: GpuCapabilities;
  capsRead: HostCapabilitiesRead;
  deviceRequests: HindsightDeviceRequest[] | null;
  /** `hindsight.gpu` pin from switchroom.yaml, if the operator set one. Shapes
   *  the fix text: a pinned-true host that is still CPU-only needs a recreate,
   *  not a config edit. */
  gpuPinned?: boolean;
}): HindsightGpuDriftAssessment {
  const { probe, capsRead, deviceRequests, gpuPinned } = args;

  const probeUsable = probe.gpuPresent === true && probe.containerToolkit === true;
  const voice = capsRead.status === "ok" ? capsRead.caps?.voice : undefined;
  const capsUsable = voice?.gpuPresent === true && voice?.containerToolkit === true;

  const hostGpu: HostGpuUsability = probeUsable
    ? "proven"
    : capsUsable
      ? "suspected"
      : "unproven";

  const container: LiveContainerGpu =
    deviceRequests === null
      ? "unknown"
      : deviceRequestsHaveGpu(deviceRequests)
        ? "gpu"
        : "cpu";

  const probeNote = `host probe: ${probe.reason}`;
  const capsNote =
    capsRead.status === "ok"
      ? `verdict: gpuPresent=${JSON.stringify(voice?.gpuPresent)}, ` +
        `containerToolkit=${JSON.stringify(voice?.containerToolkit)}`
      : `verdict: ${capsRead.status} (${capsRead.path})`;

  // --- The `unknown` container column: could not tell. Never alarm. ---
  if (container === "unknown") {
    return {
      status: "ok",
      hostGpu,
      container,
      detail:
        `could not read the live ${HINDSIGHT_CONTAINER} device state ` +
        "(container absent, or docker unavailable) — GPU/CPU drift not evaluated. " +
        probeNote,
    };
  }

  // --- The `gpu` container column: the container has GPU. Agreement. ---
  if (container === "gpu") {
    return {
      status: "ok",
      hostGpu,
      container,
      detail:
        `${HINDSIGHT_CONTAINER} is running WITH GPU passthrough ` +
        "(HostConfig.DeviceRequests carries an NVIDIA GPU). " +
        probeNote,
    };
  }

  // --- The `cpu` container column: the container requests no devices. ---
  if (hostGpu === "proven") {
    return {
      status: "fail",
      hostGpu,
      container,
      detail:
        `this host has a USABLE GPU (${probe.reason}) but ${HINDSIGHT_CONTAINER} ` +
        "is running CPU-only (HostConfig.DeviceRequests is empty). The reranker and " +
        "the local embedding model are on CPU on the interactive recall path — the " +
        "exact degradation from the 2026-07-28 incident (recalls 5-9s, deadline hits).",
      fix: driftFix(gpuPinned),
    };
  }

  if (hostGpu === "suspected") {
    return {
      status: "warn",
      hostGpu,
      container,
      detail:
        `${HINDSIGHT_CONTAINER} is running CPU-only (HostConfig.DeviceRequests is ` +
        "empty) and the persisted capabilities verdict records a usable GPU, but the " +
        `live probe could not confirm it this run (${probe.reason}). Either the GPU is ` +
        "genuinely unavailable now, or the probe cannot see it — confirm so recalls " +
        `aren't silently on CPU. ${capsNote}.`,
      fix: driftFix(gpuPinned),
    };
  }

  // hostGpu === "unproven": no usable GPU proven anywhere. CPU is expected.
  return {
    status: "ok",
    hostGpu,
    container,
    detail:
      `${HINDSIGHT_CONTAINER} is CPU-only and no usable GPU is proven on this host ` +
      `(${probe.reason}; ${capsNote}) — a CPU-only container is expected here.`,
  };
}

/** The remediation line, shared by the WARN and FAIL cases. */
function driftFix(gpuPinned?: boolean): string {
  if (gpuPinned) {
    return (
      "`hindsight.gpu: true` is already set, so recreate the container to apply it: " +
      "`switchroom memory setup --recreate` (the recreate emits `--gpus all`). If it " +
      "keeps coming back CPU-only, a stale hand `docker run` or an on-disk recreate " +
      "script is bypassing the GPU gate."
    );
  }
  return (
    "Recreate the container on GPU: set `hindsight.gpu: true` in switchroom.yaml, then " +
    "`switchroom memory setup --recreate` (the recreate emits `--gpus all`)."
  );
}

/** I/O seams for {@link runHindsightGpuDriftAssessment}. Each defaults to the
 *  real probe; tests inject stubs so the suite never depends on a real GPU,
 *  container, or capabilities file. */
export interface HindsightGpuDriftDeps {
  probe?: () => GpuCapabilities;
  capsRead?: () => HostCapabilitiesRead;
  deviceRequests?: () => HindsightDeviceRequest[] | null;
}

/**
 * Wire the real probes and run {@link assessHindsightGpuDrift}. This is the
 * single entry point both consumers (doctor + fleet-health) call, so the live
 * behaviour cannot drift between them.
 */
export function runHindsightGpuDriftAssessment(
  opts: { gpuPinned?: boolean; deps?: HindsightGpuDriftDeps } = {},
): HindsightGpuDriftAssessment {
  const deps = opts.deps ?? {};
  const probe = (deps.probe ?? (() => detectGpuCapabilities()))();
  const capsRead = (deps.capsRead ?? readHostCapabilities)();
  const deviceRequests = (
    deps.deviceRequests ?? (() => getHindsightDeviceRequests(HINDSIGHT_CONTAINER))
  )();
  return assessHindsightGpuDrift({
    probe,
    capsRead,
    deviceRequests,
    gpuPinned: opts.gpuPinned,
  });
}
