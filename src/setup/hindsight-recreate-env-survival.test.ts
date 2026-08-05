/**
 * End-to-end survival of the two reranker keys across a recreate, against the
 * REAL env derivation the launcher uses (`hindsightContainerEnvPairs`) rather
 * than a restatement of the constants.
 *
 * On 2026-07-28 a `switchroom memory setup --recreate` dropped
 * `HINDSIGHT_API_RERANKER_LOCAL_FP16=true` and
 * `HINDSIGHT_API_RERANKER_LOCAL_BATCH_SIZE=128` off the live container. Both
 * ARE managed defaults (HINDSIGHT_PERF_DEFAULTS_GPU) — they were withheld
 * because the host did not prove a usable GPU that run, which on the affected
 * host was itself an artefact: `~/.switchroom/host-capabilities.json` was
 * root:root 0600 inside a non-root home, so `loadHostCapabilities()` could not
 * read it and `hindsightGpuEnabled()` fell back to "not proven".
 *
 * So there are two outcomes worth pinning, and only pinning both is honest:
 *
 *   1. On a host that proves the GPU, an EMPTY `hindsight.env` still lands both
 *      keys on the container — no operator declaration required.
 *   2. On a host that does not, they are correctly withheld (upstream's CPU
 *      values), and the recreate SAYS SO instead of dropping them in silence.
 */

import { describe, expect, it } from "vitest";

import { hindsightContainerEnvPairs } from "./hindsight.js";
import { diffDroppedHindsightEnv } from "./hindsight-env-drift.js";
import {
  HINDSIGHT_DEFAULT_RERANKER_LOCAL_BATCH_SIZE,
  HINDSIGHT_DEFAULT_RERANKER_LOCAL_FP16,
} from "./hindsight-perf-defaults.js";

const FP16 = "HINDSIGHT_API_RERANKER_LOCAL_FP16";
const BATCH = "HINDSIGHT_API_RERANKER_LOCAL_BATCH_SIZE";

/** Empty `hindsight.env` AND an empty process env — nothing declared anywhere. */
const NOTHING_DECLARED = { env: {}, processEnv: {} as NodeJS.ProcessEnv };

const envMap = (gpu: boolean, env: Record<string, string | number | boolean> = {}) =>
  new Map(
    hindsightContainerEnvPairs({
      apiPort: 18888,
      gpu,
      perf: { ...NOTHING_DECLARED, env },
    }),
  );

describe("reranker defaults survive a recreate with an empty hindsight.env", () => {
  it("a GPU-proven host lands both keys with nothing declared", () => {
    const env = envMap(true);
    expect(env.get(FP16)).toBe(HINDSIGHT_DEFAULT_RERANKER_LOCAL_FP16);
    expect(env.get(BATCH)).toBe(String(HINDSIGHT_DEFAULT_RERANKER_LOCAL_BATCH_SIZE));
    // The values the live fleet runs, spelled out so a drive-by retune of the
    // constants has to come past this assertion.
    expect(env.get(FP16)).toBe("true");
    expect(env.get(BATCH)).toBe("128");
  });

  it("recreating a container that already has them drops NOTHING", () => {
    // The actual recreate shape: live container env vs the env the next launch
    // computes. This is the assertion that would have gone red on 2026-07-28.
    const next = [...envMap(true)] as Array<[string, string]>;
    const live = next.map(([k, v]) => `${k}=${v}`);
    expect(diffDroppedHindsightEnv(live, next, [])).toEqual([]);
  });

  it("an operator value still wins over the managed default", () => {
    const env = envMap(true, { [FP16]: "false", [BATCH]: 64 });
    expect(env.get(FP16)).toBe("false");
    expect(env.get(BATCH)).toBe("64");
  });

  it("an operator value reaches the container even where the GPU gate is OFF", () => {
    // The recovery path the warning tells operators to take has to actually
    // work on the host that triggered the warning.
    const env = envMap(false, { [FP16]: "true", [BATCH]: 128 });
    expect(env.get(FP16)).toBe("true");
    expect(env.get(BATCH)).toBe("128");
  });

  it("a host that cannot prove the GPU withholds them — and the recreate says so", () => {
    const env = envMap(false);
    expect(env.has(FP16)).toBe(false);
    expect(env.has(BATCH)).toBe(false);

    // …and that withholding is exactly the drop the guard must surface, with
    // the live values an operator can paste back.
    const live = [...envMap(true)].map(([k, v]) => `${k}=${v}`);
    const dropped = diffDroppedHindsightEnv(live, [...env] as Array<[string, string]>, []);
    expect(dropped).toEqual([
      { key: BATCH, value: "128", redacted: false },
      { key: FP16, value: "true", redacted: false },
    ]);
  });
});

/**
 * The dead-letter auto-requeue safety net (#3795 / #3797) is OFF in the
 * maintenance script's own defaults; it only runs on the fleet if the launcher
 * PINS it onto the container env. This is the guard that it does — against the
 * real derivation, on both GPU verdicts (it is unrelated to the GPU gate), with
 * an empty `hindsight.env`. It goes red the instant the two pins are removed.
 */
const REQUEUE_ON = "SWITCHROOM_HINDSIGHT_REQUEUE_DEAD_LETTERS";
const REQUEUE_MAX = "SWITCHROOM_HINDSIGHT_REQUEUE_MAX";

describe("dead-letter requeue safety net is enabled on the launched container", () => {
  it.each([true, false])(
    "pins REQUEUE_DEAD_LETTERS=1 and REQUEUE_MAX=25 with nothing declared (gpu=%s)",
    (gpu) => {
      const env = envMap(gpu);
      // ON, so the maintenance sidecar's Section-7 recovery sweep actually runs.
      expect(env.get(REQUEUE_ON)).toBe("1");
      // The exact bound the fleet runs — a drive-by retune has to come past this.
      expect(env.get(REQUEUE_MAX)).toBe("25");
    },
  );

  it("the pins survive a recreate — the next launch drops neither", () => {
    const next = [...envMap(true)] as Array<[string, string]>;
    const live = next.map(([k, v]) => `${k}=${v}`);
    const dropped = diffDroppedHindsightEnv(live, next, []);
    expect(dropped.some((d) => d.key === REQUEUE_ON || d.key === REQUEUE_MAX)).toBe(false);
  });
});
