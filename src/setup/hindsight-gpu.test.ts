/**
 * GPU passthrough for the hindsight recall reranker.
 *
 * The reranker is sentence-transformers + PyTorch (provider `local` →
 * LocalSTCrossEncoder), and upstream's `cross_encoder.py` already picks `cuda`
 * when `torch.cuda.is_available()`. Two things have to hold for that to fire:
 *
 *   1. the image ships a CUDA-flavoured torch — pinned in
 *      tests/docker/dockerfile-hindsight-bakes.test.ts; and
 *   2. the container can SEE the device — `--gpus all` on the docker-run path,
 *      `deploy.resources.reservations.devices` on the compose path.
 *
 * (2) is what this file pins, including the property that MATTERS most: the
 * two launch paths are driven by ONE gate, so a host that gets GPU from
 * `switchroom memory setup` also gets it from the emitted compose file, and a
 * host without the nvidia-container-toolkit gets it from NEITHER (docker
 * refuses `--gpus` outright there — "could not select device driver").
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

import {
  startHindsight,
  generateHindsightComposeSnippet,
  hindsightGpuEnabled,
} from "./hindsight.js";

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue(Buffer.from(""));
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

/**
 * The `docker run` argv that launches the hindsight container itself.
 *
 * Selected by `--name switchroom-hindsight`, NOT by "first run call": mirror
 * mode (#2578) issues a throwaway `docker run --rm` chown helper first, and
 * matching that one would silently test the wrong argv.
 */
function runArgs(): string[] {
  const call = execFileSyncMock.mock.calls.find(
    (c) =>
      c[0] === "docker" &&
      Array.isArray(c[1]) &&
      (c[1] as string[])[0] === "run" &&
      (c[1] as string[]).includes("switchroom-hindsight"),
  );
  expect(call, "startHindsight must have issued a `docker run` for switchroom-hindsight").toBeDefined();
  return call![1] as string[];
}

/** True iff argv carries the `--gpus all` pair (flag AND value, adjacent). */
function hasGpusAll(args: string[]): boolean {
  const i = args.indexOf("--gpus");
  return i >= 0 && args[i + 1] === "all";
}

/** The compose GPU reservation stanza, exactly as the voice sidecar emits it. */
const COMPOSE_GPU_STANZA = [
  "    deploy:",
  "      resources:",
  "        reservations:",
  "          devices:",
  "            - driver: nvidia",
  "              count: 1",
  '              capabilities: ["gpu"]',
].join("\n");

// ── the gate itself ───────────────────────────────────────────────────────
describe("hindsightGpuEnabled — fail-safe host-capabilities gate", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "switchroom-hs-gpu-"));
    // resolveStatePath() reads HOME. Point it at a tmpdir so the suite never
    // reads (or depends on) the real ~/.switchroom/host-capabilities.json.
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeCaps(gpuPresent: boolean, containerToolkit: boolean): void {
    mkdirSync(join(home, ".switchroom"), { recursive: true });
    writeFileSync(
      join(home, ".switchroom", "host-capabilities.json"),
      JSON.stringify({
        version: 1,
        voice: {
          gpuPresent,
          containerToolkit,
          engine: gpuPresent && containerToolkit ? "local" : "cloud",
          detectedAt: "2026-07-26T00:00:00.000Z",
        },
      }) + "\n",
    );
  }

  it("is FALSE with no persisted verdict (fresh install ⇒ today's CPU behaviour)", () => {
    // The load-bearing default. `docker run --gpus all` HARD-FAILS on a host
    // without the nvidia-container-toolkit, so an unknown host must never get
    // the flag — that would turn `switchroom memory setup` into an error.
    expect(hindsightGpuEnabled()).toBe(false);
  });

  it("is FALSE when a GPU exists but Docker cannot reach it (no toolkit)", () => {
    writeCaps(true, false);
    expect(hindsightGpuEnabled()).toBe(false);
  });

  it("is FALSE when the toolkit is present but there is no GPU", () => {
    writeCaps(false, true);
    expect(hindsightGpuEnabled()).toBe(false);
  });

  it("is TRUE only when a GPU is present AND the container toolkit is wired", () => {
    writeCaps(true, true);
    expect(hindsightGpuEnabled()).toBe(true);
  });

  it("honours an explicit override without touching the persisted verdict", () => {
    writeCaps(true, true);
    expect(hindsightGpuEnabled(false)).toBe(false);
    writeCaps(false, false);
    expect(hindsightGpuEnabled(true)).toBe(true);
  });
});

// ── docker-run path ───────────────────────────────────────────────────────
describe("startHindsight — GPU passthrough", () => {
  it("passes `--gpus all` when the host can reach a GPU", () => {
    startHindsight(undefined, undefined, undefined, undefined, undefined, true);
    expect(hasGpusAll(runArgs())).toBe(true);
  });

  it("emits NO --gpus flag when the host cannot (docker would refuse to start)", () => {
    startHindsight(undefined, undefined, undefined, undefined, undefined, false);
    expect(runArgs()).not.toContain("--gpus");
  });

  it("keeps GPU orthogonal to the other run knobs (mirror mode still applies)", () => {
    // Guards against the flag being spliced in a branch that swallows the
    // creds-mirror mount — both must survive together.
    startHindsight(
      undefined,
      undefined,
      undefined,
      undefined,
      "/run/consumer-creds/hindsight",
      true,
    );
    const args = runArgs();
    expect(hasGpusAll(args)).toBe(true);
    expect(args.join(" ")).toContain("consumer-creds-hindsight");
  });
});

// ── compose path ──────────────────────────────────────────────────────────
describe("generateHindsightComposeSnippet — GPU passthrough", () => {
  it("emits the nvidia device reservation when the host can reach a GPU", () => {
    const snippet = generateHindsightComposeSnippet(
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(snippet).toContain(COMPOSE_GPU_STANZA);
  });

  it("emits NO deploy/devices stanza when the host cannot", () => {
    const snippet = generateHindsightComposeSnippet(
      undefined,
      undefined,
      undefined,
      false,
    );
    expect(snippet).not.toContain("driver: nvidia");
    expect(snippet).not.toContain("    deploy:");
  });

  it("nests the stanza under the hindsight service, not at the compose root", () => {
    // 4-space `deploy:` = a key of the single service in this snippet. A
    // top-level (2-space) `deploy:` would be silently ignored by compose.
    const snippet = generateHindsightComposeSnippet(
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(snippet).toMatch(/^ {4}deploy:$/m);
    expect(snippet).not.toMatch(/^ {0,2}deploy:$/m);
  });
});

// ── run ⇄ compose parity ──────────────────────────────────────────────────
describe("run ⇄ compose GPU parity", () => {
  // The two launch paths must never disagree: whichever one an operator uses,
  // the container either sees the GPU or it doesn't. Assert the OUTCOME of
  // both generators for the same gate value rather than just calling them.
  for (const gpu of [true, false]) {
    it(`agree for gpu=${gpu}`, () => {
      startHindsight(undefined, undefined, undefined, undefined, undefined, gpu);
      const runHasGpu = hasGpusAll(runArgs());
      const composeHasGpu = generateHindsightComposeSnippet(
        undefined,
        undefined,
        undefined,
        gpu,
      ).includes("driver: nvidia");

      expect(runHasGpu).toBe(gpu);
      expect(composeHasGpu).toBe(gpu);
      expect(runHasGpu).toBe(composeHasGpu);
    });
  }

  it("both paths default to the SAME persisted verdict when no override is passed", () => {
    // Not a tautology: this is what stops one path from being wired to
    // hindsightGpuEnabled() and the other to a hard-coded literal.
    const expected = hindsightGpuEnabled();
    startHindsight();
    expect(hasGpusAll(runArgs())).toBe(expected);
    expect(generateHindsightComposeSnippet().includes("driver: nvidia")).toBe(expected);
  });
});
