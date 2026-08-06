import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock execFileSync so `docker run` never actually fires. We capture
// the args to assert on the command shape.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  startHindsight,
  stopHindsight,
  ensureHindsightConsumer,
  buildLiteLlmAwareHealthCmd,
  listHindsightDataVolumeMounts,
  HINDSIGHT_CONSUMER_NAME,
  HINDSIGHT_DEFAULT_UID,
  HINDSIGHT_DEFAULT_WORKER_ID,
  HINDSIGHT_DATA_VOLUME,
  HINDSIGHT_BROKER_SOCK_VOLUME,
  HINDSIGHT_IMAGE,
  HINDSIGHT_DEFAULT_SHM_SIZE,
  HINDSIGHT_DEFAULT_MODEL,
  HINDSIGHT_DEFAULT_LITELLM_MODEL,
  getRunningHindsightPorts,
  HINDSIGHT_DEFAULT_API_PORT,
  HINDSIGHT_DEFAULT_UI_PORT,
} from "../../src/setup/hindsight.js";
import { SWITCHROOM_DEFAULT_MAIN_MODEL } from "../../src/agents/scaffold.js";

const mockedExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

function findRunArgs(): string[] {
  const runCall = mockedExec.mock.calls.find(
    (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "run",
  );
  expect(runCall).toBeDefined();
  return runCall![1] as string[];
}

/** Every `-e KEY=VALUE` payload from a captured `docker run` argv. */
function runEnvPairs(args: string[]): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-e") pairs.push(args[i + 1] as string);
  }
  return pairs;
}

describe("hindsight broker-fed mode (#1245)", () => {
  beforeEach(() => {
    mockedExec.mockReset();
    mockedExec.mockReturnValue("");
  });

  it("does NOT pass any LLM API key via -e or --env-file", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    expect(args).not.toContain("--env-file");

    // No -e value should look like an API-key var.
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") {
        const val = args[i + 1] as string;
        expect(val).not.toMatch(/^HINDSIGHT_API_LLM_API_KEY=/);
        expect(val).not.toMatch(/^OPENAI_API_KEY=/);
        expect(val).not.toMatch(/^ANTHROPIC_API_KEY=/);
      }
    }
  });

  it("does NOT pass an entrypoint shim (broker-fed mode uses the image's ENTRYPOINT)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    expect(args).not.toContain("--entrypoint");
  });

  it("adds a container healthcheck that marks a wedged API unhealthy (visibility, not auto-restart)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    expect(args).toContain("--health-cmd");
    const cmd = args[args.indexOf("--health-cmd") + 1] as string;
    // Hits /health via python3 (always in the image; curl/wget are not).
    expect(cmd).toContain("python3");
    expect(cmd).toContain("/health");
    expect(args).toContain("--health-interval");
  });

  it("mounts a SEPARATE backups volume so a data-volume loss is recoverable", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    let found = false;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-v" && args[i + 1] === "switchroom-hindsight-backups:/backups") {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
    // Must NOT co-locate backups on the data volume (defeats the point).
    expect(args).not.toContain("switchroom-hindsight-data:/backups");
  });

  it("bind-mounts the auth-broker consumer socket volume", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    // Look for `-v auth-broker-hindsight-sock:/run/switchroom/auth-broker`.
    let found = false;
    for (let i = 0; i < args.length - 1; i++) {
      if (
        args[i] === "-v" &&
        args[i + 1] === `${HINDSIGHT_BROKER_SOCK_VOLUME}:/run/switchroom/auth-broker`
      ) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("sets up a tmpfs at /run/claude-creds for the credential dotfile", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    let found = false;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--tmpfs" && (args[i + 1] as string).startsWith("/run/claude-creds")) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("passes --shm-size so PostgreSQL doesn't fail on Docker's 64MB default shm (2026-06-06 outage)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    // Single-token form: `--shm-size=2g`.
    expect(args).toContain(`--shm-size=${HINDSIGHT_DEFAULT_SHM_SIZE}`);
    // And the default must be larger than Docker's 64MB so the bug can't
    // silently regress to the broken default.
    const m = /^(\d+)g$/.exec(HINDSIGHT_DEFAULT_SHM_SIZE);
    expect(m, "HINDSIGHT_DEFAULT_SHM_SIZE should be N gigabytes").not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1);
  });

  it("emits the reranker oversubscription fix in the docker run argv (2026-08-06)", () => {
    // Outcome at the REAL launch surface: assert the `-e KEY=VALUE` payloads
    // the container is actually started with, not just the constants. Recall
    // latency on a GPU-less box is CPU cross-encoder reranker time — a live
    // pgvector HNSW EXPLAIN ANALYZE of the recall runs in 5ms, so the DB and
    // index are not the cost. The fix pins each op's native thread pool so
    // 4 concurrent rerankers x 4 threads ~= 16 cores (was: OMP unset => each
    // grabbed all 16, oversubscribing the box while it sat ~85% idle) and
    // trims the candidate budget 150 -> 100.
    // Explicit empty processEnv seam so a stray OMP_NUM_THREADS in the runner's
    // own environment can't be picked up as an "operator override" and skew the
    // asserted default.
    startHindsight(
      { apiPort: 8888, uiPort: 9999 },
      undefined, // litellm
      undefined, // imageTag
      undefined, // llm
      undefined, // mirrorDir
      undefined, // gpu
      { processEnv: {} }, // perf
    );
    const env = runEnvPairs(findRunArgs());
    for (const v of [
      "OMP_NUM_THREADS",
      "OPENBLAS_NUM_THREADS",
      "MKL_NUM_THREADS",
      "NUMEXPR_NUM_THREADS",
    ]) {
      expect(env, `${v} must reach the container pinned to 4`).toContain(`${v}=4`);
    }
    expect(env).toContain("HINDSIGHT_API_RERANKER_MAX_CANDIDATES=100");
    // Paired knob unchanged from its source default of 4 (concurrency x threads
    // stays within the core budget).
    expect(env).toContain("HINDSIGHT_API_RERANKER_LOCAL_MAX_CONCURRENT=4");
  });

  it("lets a hindsight.env override retune the native thread caps", () => {
    // The caps are managed keys, so an operator on a differently-sized box
    // retunes them declaratively and the value reaches the container — the
    // silent-drop defect this module exists to prevent.
    startHindsight(
      { apiPort: 8888, uiPort: 9999 },
      undefined, // litellm
      undefined, // imageTag
      undefined, // llm
      undefined, // mirrorDir
      undefined, // gpu
      { env: { OMP_NUM_THREADS: "8" } }, // perf
    );
    const env = runEnvPairs(findRunArgs());
    expect(env).toContain("OMP_NUM_THREADS=8");
    // Exactly once — the override replaces the default rather than appending.
    expect(env.filter((p) => p.startsWith("OMP_NUM_THREADS=")).length).toBe(1);
  });

  it("sets HINDSIGHT_API_LLM_PROVIDER=claude-code (subscription-honest path)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    const envPairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") envPairs.push(args[i + 1] as string);
    }
    expect(envPairs).toContain("HINDSIGHT_API_LLM_PROVIDER=claude-code");
  });

  it("pins HINDSIGHT_API_LLM_MODEL to the switchroom default sonnet", () => {
    // Without this override the upstream hindsight image silently picks
    // its own default (an older date-pinned sonnet from
    // PROVIDER_DEFAULT_MODELS in /app/api/hindsight_api/config.py) and
    // drifts behind the rest of the fleet on every upstream pull.
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    const envPairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") envPairs.push(args[i + 1] as string);
    }
    expect(envPairs).toContain("HINDSIGHT_API_LLM_MODEL=claude-sonnet-5");
    // For the claude-code provider the embedded `claude` CLI reads
    // ANTHROPIC_MODEL, not HINDSIGHT_API_LLM_MODEL — without it the CLI
    // falls back to its own default (opus) and silently burns quota.
    expect(envPairs).toContain("ANTHROPIC_MODEL=claude-sonnet-5");
  });

  const envPairsFromArgs = (args: string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") out.push(args[i + 1] as string);
    }
    return out;
  };

  it("honors the hindsight.llm override (provider + model) from switchroom.yaml", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, undefined, {
      provider: "claude-code",
      model: "openrouter/z-ai/glm-5.2",
    });
    const env = envPairsFromArgs(findRunArgs());
    expect(env).toContain("HINDSIGHT_API_LLM_PROVIDER=claude-code");
    expect(env).toContain("HINDSIGHT_API_LLM_MODEL=openrouter/z-ai/glm-5.2");
    // claude-code provider ALSO pins ANTHROPIC_MODEL for the subprocess.
    expect(env).toContain("ANTHROPIC_MODEL=openrouter/z-ai/glm-5.2");
  });

  it("falls back to the hard-coded defaults when hindsight.llm is absent (no ANTHROPIC_MODEL drift)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const env = envPairsFromArgs(findRunArgs());
    expect(env).toContain("HINDSIGHT_API_LLM_PROVIDER=claude-code");
    expect(env).toContain("HINDSIGHT_API_LLM_MODEL=claude-sonnet-5");
    // Default is still claude-code, so ANTHROPIC_MODEL tracks the default model.
    expect(env).toContain("ANTHROPIC_MODEL=claude-sonnet-5");
  });

  it("does NOT set ANTHROPIC_MODEL for a non-claude-code provider", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, undefined, {
      provider: "openai",
      model: "gpt-4o",
    });
    const env = envPairsFromArgs(findRunArgs());
    expect(env).toContain("HINDSIGHT_API_LLM_PROVIDER=openai");
    expect(env).toContain("HINDSIGHT_API_LLM_MODEL=gpt-4o");
    expect(env.some((e) => e.startsWith("ANTHROPIC_MODEL="))).toBe(false);
  });

  it("compose snippet reflects the hindsight.llm override", async () => {
    const { generateHindsightComposeSnippet } = await import("../../src/setup/hindsight.js");
    const snippet = generateHindsightComposeSnippet({
      provider: "claude-code",
      model: "openrouter/z-ai/glm-5.2",
    });
    expect(snippet).toContain("HINDSIGHT_API_LLM_PROVIDER=claude-code");
    expect(snippet).toContain("HINDSIGHT_API_LLM_MODEL=openrouter/z-ai/glm-5.2");
    expect(snippet).toContain("ANTHROPIC_MODEL=openrouter/z-ai/glm-5.2");
  });

  it("emits per-op LLM env vars (retain / reflect) alongside the global (#2925 follow-up)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, undefined, {
      provider: "claude-code",
      model: "openrouter/z-ai/glm-5.2",
      retain: { model: "gpt-oss-20b" },
      reflect: { model: "gpt-oss-120b", provider: "openrouter" },
    });
    const env = envPairsFromArgs(findRunArgs());
    // Global still present (backward-compat) …
    expect(env).toContain("HINDSIGHT_API_LLM_MODEL=openrouter/z-ai/glm-5.2");
    // … and the per-op overrides ride on top.
    expect(env).toContain("HINDSIGHT_API_RETAIN_LLM_MODEL=gpt-oss-20b");
    expect(env).toContain("HINDSIGHT_API_REFLECT_LLM_MODEL=gpt-oss-120b");
    expect(env).toContain("HINDSIGHT_API_REFLECT_LLM_PROVIDER=openrouter");
  });

  it("emits per-op provider/base_url/api_key passthrough only for the fields set", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, undefined, {
      model: "glm-5.2",
      consolidation: {
        model: "gpt-oss-120b",
        provider: "openrouter",
        base_url: "http://127.0.0.1:4010",
        api_key: "sk-consol",
      },
    });
    const env = envPairsFromArgs(findRunArgs());
    expect(env).toContain("HINDSIGHT_API_CONSOLIDATION_LLM_MODEL=gpt-oss-120b");
    expect(env).toContain("HINDSIGHT_API_CONSOLIDATION_LLM_PROVIDER=openrouter");
    expect(env).toContain("HINDSIGHT_API_CONSOLIDATION_LLM_BASE_URL=http://127.0.0.1:4010");
    expect(env).toContain("HINDSIGHT_API_CONSOLIDATION_LLM_API_KEY=sk-consol");
  });

  it("emits GLOBAL base_url / api_key passthrough only for the fields set (#3687)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, undefined, {
      provider: "litellm",
      model: "openrouter/z-ai/glm-5.2",
      base_url: "http://127.0.0.1:4010",
      api_key: "sk-global",
    });
    const env = envPairsFromArgs(findRunArgs());
    expect(env).toContain("HINDSIGHT_API_LLM_BASE_URL=http://127.0.0.1:4010");
    expect(env).toContain("HINDSIGHT_API_LLM_API_KEY=sk-global");
  });

  it("emits NO global base_url / api_key when unset (default broker-fed mode) (#3687)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, undefined, {
      provider: "claude-code",
      model: "openrouter/z-ai/glm-5.2",
    });
    const env = envPairsFromArgs(findRunArgs());
    expect(env.some((e) => e.startsWith("HINDSIGHT_API_LLM_BASE_URL="))).toBe(false);
    expect(env.some((e) => e.startsWith("HINDSIGHT_API_LLM_API_KEY="))).toBe(false);
  });

  it("compose snippet emits the GLOBAL base_url / api_key passthrough too (#3687)", async () => {
    const { generateHindsightComposeSnippet } = await import("../../src/setup/hindsight.js");
    const snippet = generateHindsightComposeSnippet({
      provider: "litellm",
      model: "glm-5.2",
      base_url: "http://127.0.0.1:4010",
      api_key: "sk-global",
    });
    expect(snippet).toContain("HINDSIGHT_API_LLM_BASE_URL=http://127.0.0.1:4010");
    expect(snippet).toContain("HINDSIGHT_API_LLM_API_KEY=sk-global");
  });

  it("a loopback GLOBAL base_url forces host networking (#3687, no silent bridge outage)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, undefined, {
      provider: "litellm",
      model: "glm-5.2",
      base_url: "http://127.0.0.1:4010",
    });
    const args = findRunArgs();
    expect(args).toContain("--network");
    expect(args).toContain("host");
  });

  it("does NOT emit a per-op var for an op with no override (engine falls back to global)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, undefined, {
      model: "glm-5.2",
      retain: { model: "gpt-oss-20b" },
      // reflect + consolidation absent → no per-op vars for them.
    });
    const env = envPairsFromArgs(findRunArgs());
    expect(env).toContain("HINDSIGHT_API_RETAIN_LLM_MODEL=gpt-oss-20b");
    expect(env.some((e) => e.startsWith("HINDSIGHT_API_REFLECT_LLM_MODEL="))).toBe(false);
    expect(env.some((e) => e.startsWith("HINDSIGHT_API_CONSOLIDATION_LLM_MODEL="))).toBe(false);
    // An empty per-op block emits nothing either.
    expect(env.some((e) => e.startsWith("HINDSIGHT_API_RETAIN_LLM_PROVIDER="))).toBe(false);
  });

  it("flat single-model form emits NO per-op vars (backward compat)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, undefined, {
      provider: "claude-code",
      model: "openrouter/z-ai/glm-5.2",
    });
    const env = envPairsFromArgs(findRunArgs());
    expect(env).toContain("HINDSIGHT_API_LLM_MODEL=openrouter/z-ai/glm-5.2");
    expect(env.some((e) => /^HINDSIGHT_API_(RETAIN|REFLECT|CONSOLIDATION)_LLM_MODEL=/.test(e))).toBe(false);
  });

  it("compose snippet emits per-op LLM env vars too", async () => {
    const { generateHindsightComposeSnippet } = await import("../../src/setup/hindsight.js");
    const snippet = generateHindsightComposeSnippet({
      model: "glm-5.2",
      retain: { model: "gpt-oss-20b" },
      reflect: { model: "gpt-oss-120b" },
    });
    expect(snippet).toContain("HINDSIGHT_API_RETAIN_LLM_MODEL=gpt-oss-20b");
    expect(snippet).toContain("HINDSIGHT_API_REFLECT_LLM_MODEL=gpt-oss-120b");
  });

  it("pins HINDSIGHT_CP_DATAPLANE_API_URL at the API port in host-network (litellm) mode, not squatted 8888", () => {
    startHindsight({ apiPort: 18888, uiPort: 19999 }, {
      baseUrl: "http://127.0.0.1:4010",
      apiKey: "sk-test",
    });
    const args = findRunArgs();
    // Host-network mode should be in effect.
    expect(args).toContain("--network");
    const env = envPairsFromArgs(args);
    // The API binds 18888; the CP dataplane URL MUST track it (not the
    // image-default localhost:8888, which is squatted on the host → 502).
    expect(env).toContain("HINDSIGHT_API_PORT=18888");
    expect(env).toContain("HINDSIGHT_CP_DATAPLANE_API_URL=http://localhost:18888");
    expect(env).not.toContain("HINDSIGHT_CP_DATAPLANE_API_URL=http://localhost:8888");
  });

  it("tracks an auto-bumped API port in the CP dataplane URL (not hardcoded 18888)", () => {
    startHindsight({ apiPort: 18890, uiPort: 19999 }, {
      baseUrl: "http://127.0.0.1:4010",
      apiKey: "sk-test",
    });
    const env = envPairsFromArgs(findRunArgs());
    expect(env).toContain("HINDSIGHT_CP_DATAPLANE_API_URL=http://localhost:18890");
  });

  it("compose snippet sets HINDSIGHT_CP_DATAPLANE_API_URL for the CP dashboard", async () => {
    const { generateHindsightComposeSnippet } = await import("../../src/setup/hindsight.js");
    // Bridge-networked compose: the API binds container-internal 8888.
    expect(generateHindsightComposeSnippet()).toContain(
      "HINDSIGHT_CP_DATAPLANE_API_URL=http://localhost:8888",
    );
  });

  it("raises the reflect wall timeout (vendor 300s times out large-bank mental-model refresh)", async () => {
    const { HINDSIGHT_DEFAULT_REFLECT_WALL_TIMEOUT_S: t } = await import("../../src/setup/hindsight.js");
    expect(t).toBeGreaterThan(300);
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    const envPairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") envPairs.push(args[i + 1] as string);
    }
    expect(envPairs).toContain(`HINDSIGHT_API_REFLECT_WALL_TIMEOUT=${t}`);
    // Parity in the compose path.
    const { generateHindsightComposeSnippet } = await import("../../src/setup/hindsight.js");
    expect(generateHindsightComposeSnippet()).toContain(`HINDSIGHT_API_REFLECT_WALL_TIMEOUT=${t}`);
  });

  it("caps retain output tokens well below the vendor 64000 runaway default", async () => {
    const h = await import("../../src/setup/hindsight.js");
    // 64000 tokens at the measured 80.6 tok/s is a ~13 minute call; one such
    // request was observed running 767.6s on 2026-07-25.
    expect(h.HINDSIGHT_DEFAULT_RETAIN_MAX_COMPLETION_TOKENS).toBe(16384);
    expect(h.HINDSIGHT_DEFAULT_RETAIN_MAX_COMPLETION_TOKENS).toBeLessThan(64000);

    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const envPairs = envPairsFromArgs(findRunArgs());
    expect(envPairs).toContain(
      `HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS=${h.HINDSIGHT_DEFAULT_RETAIN_MAX_COMPLETION_TOKENS}`,
    );
    expect(h.generateHindsightComposeSnippet()).toContain(
      `HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS=${h.HINDSIGHT_DEFAULT_RETAIN_MAX_COMPLETION_TOKENS}`,
    );
  });

  it("keeps #3611's token-derived value as a FLOOR on the retain deadline", async () => {
    const h = await import("../../src/setup/hindsight.js");
    // ceil(16384 / 80.6) = 204. Unchanged, and still derived from the cap:
    // double the cap and the floor follows.
    expect(h.hindsightRetainLlmTimeoutSeconds()).toBe(204);
    expect(h.hindsightRetainLlmTimeoutSeconds(32768)).toBe(407);
    expect(h.hindsightRetainLlmTimeoutSeconds(16384, 40)).toBe(410);
    // …but it is a floor, not the answer: the litellm retain chain
    // (200 + 90 + 10 margin) is larger, so the emitted deadline is that.
    expect(h.hindsightRetainClientTimeoutSeconds()).toBe(300);
    expect(h.hindsightRetainClientTimeoutSeconds()).toBeGreaterThanOrEqual(
      h.hindsightRetainLlmTimeoutSeconds(),
    );
  });

  it("emits a retain deadline that COVERS the litellm fallback hop (the #3611 gap)", async () => {
    const h = await import("../../src/setup/hindsight.js");
    const tb = await import("../../src/litellm/timeout-budget.js");
    // The bug: #3611 shipped HINDSIGHT_API_RETAIN_LLM_TIMEOUT=204 (confirmed
    // live on switchroom-hindsight 2026-07-26) while the litellm retain chain
    // under it was 200 + 90 = 290. The fallback hop had 4s of headroom and
    // could never complete. This asserts the emitted value covers the chain.
    const emitted = h.hindsightRetainClientTimeoutSeconds();
    expect(emitted).toBeGreaterThanOrEqual(
      tb.minimumClientBudgetSeconds(tb.LITELLM_TIMEOUT_TIERS.retain),
    );
    expect(emitted).toBe(300);
    expect(emitted).not.toBe(204); // the shipped bug

    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const envPairs = envPairsFromArgs(findRunArgs());
    expect(envPairs).toContain(`HINDSIGHT_API_RETAIN_LLM_TIMEOUT=${emitted}`);
    expect(h.generateHindsightComposeSnippet()).toContain(
      `HINDSIGHT_API_RETAIN_LLM_TIMEOUT=${emitted}`,
    );
  });

  it("emits the INTERACTIVE budget (160s) rather than leaving the 120s vendor default", async () => {
    const h = await import("../../src/setup/hindsight.js");
    // Neither HINDSIGHT_API_LLM_TIMEOUT nor HINDSIGHT_API_REFLECT_LLM_TIMEOUT
    // was emitted at all before this, so both silently took
    // hindsight_api/config.py DEFAULT_LLM_TIMEOUT = 120.0 while the litellm
    // interactive chain became 90 + 60 = 150. An unset knob is still half of a
    // pair. 90 + 60 + 10 = 160 — the value Ken set for this lane, derived.
    expect(h.hindsightInteractiveLlmTimeoutSeconds()).toBe(160);

    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const envPairs = envPairsFromArgs(findRunArgs());
    const snippet = h.generateHindsightComposeSnippet();
    for (const key of ["HINDSIGHT_API_LLM_TIMEOUT", "HINDSIGHT_API_REFLECT_LLM_TIMEOUT"]) {
      expect(envPairs).toContain(`${key}=160`);
      expect(snippet).toContain(`${key}=160`);
    }
  });

  it("emits the CONSOLIDATION budget (300s) rather than leaving the 120s vendor default", async () => {
    const h = await import("../../src/setup/hindsight.js");
    // Same defect, third lane: 173 `exceeded timeout=120.0s` errors observed
    // against a 200 + 90 = 290s chain.
    expect(h.hindsightConsolidationLlmTimeoutSeconds()).toBe(300);

    startHindsight({ apiPort: 8888, uiPort: 9999 });
    expect(envPairsFromArgs(findRunArgs())).toContain(
      "HINDSIGHT_API_CONSOLIDATION_LLM_TIMEOUT=300",
    );
    expect(h.generateHindsightComposeSnippet()).toContain(
      "HINDSIGHT_API_CONSOLIDATION_LLM_TIMEOUT=300",
    );
  });

  it("holds the shipped budget end to end: chain <= per-call timeout < client deadline", async () => {
    const h = await import("../../src/setup/hindsight.js");
    const tb = await import("../../src/litellm/timeout-budget.js");
    // The whole three-deadline stack, asserted as one chain:
    //   litellm 200+90 (+10 margin) = 300 <= 300 < 310
    expect(tb.minimumClientBudgetSeconds(tb.LITELLM_TIMEOUT_TIERS.retain)).toBeLessThanOrEqual(
      h.hindsightRetainClientTimeoutSeconds(),
    );
    expect(h.hindsightRetainClientTimeoutSeconds()).toBeLessThan(
      h.HINDSIGHT_RETAIN_CLIENT_DEADLINE_S,
    );
    expect(h.HINDSIGHT_RETAIN_CLIENT_DEADLINE_S).toBe(310);
    expect(() => h.hindsightLlmBudgetEnv()).not.toThrow();
  });

  it("turns ON the per-bank metrics label that upstream defaults off", async () => {
    // Structural fix #7. Upstream disables `bank_id` on the
    // `hindsight_operation_*` families to bound cardinality for a multi-tenant
    // SaaS. This fleet is single-tenant by invariant, so the label's
    // cardinality is the agent roster, and WITHOUT it no per-bank SLO is
    // expressible from /metrics at all: through the 2026-07 regression the
    // aggregate histogram looked mediocre while two banks sat at ~97% own-bank
    // timeout and another at 0%.
    const h = await import("../../src/setup/hindsight.js");
    expect(new Map(h.hindsightLlmBudgetEnv()).get("HINDSIGHT_API_METRICS_INCLUDE_BANK_ID")).toBe(
      "true",
    );
  });

  it("keeps the reflect WALL timeout above the reflect per-call timeout", async () => {
    // Third deadline on the same lane: HINDSIGHT_API_REFLECT_WALL_TIMEOUT
    // bounds the whole agentic reflect loop, which makes SEVERAL per-call LLM
    // requests. If the per-call budget ever grew past the wall budget, reflect
    // would be killed by its own wall clock before a single call could use its
    // full deadline — the same paired-drift class, one level up.
    const h = await import("../../src/setup/hindsight.js");
    const perCall = Number(new Map(h.hindsightLlmBudgetEnv()).get("HINDSIGHT_API_REFLECT_LLM_TIMEOUT"));
    expect(perCall).toBeGreaterThan(0);
    expect(h.HINDSIGHT_DEFAULT_REFLECT_WALL_TIMEOUT_S).toBeGreaterThan(perCall);
  });

  it("every emitted LLM timeout covers its own litellm routing chain", async () => {
    // The general form of the bug, asserted over whatever is emitted rather
    // than over specific numbers: if any lane's budget ever drops below its
    // chain again, this fails regardless of which lane or which half moved.
    const h = await import("../../src/setup/hindsight.js");
    const tb = await import("../../src/litellm/timeout-budget.js");
    const env = new Map(h.hindsightLlmBudgetEnv());
    const lanes: Array<[string, tb.LitellmTimeoutTier]> = [
      ["HINDSIGHT_API_LLM_TIMEOUT", tb.LITELLM_TIMEOUT_TIERS.interactive],
      ["HINDSIGHT_API_REFLECT_LLM_TIMEOUT", tb.LITELLM_TIMEOUT_TIERS.interactive],
      ["HINDSIGHT_API_RETAIN_LLM_TIMEOUT", tb.LITELLM_TIMEOUT_TIERS.retain],
      ["HINDSIGHT_API_CONSOLIDATION_LLM_TIMEOUT", tb.LITELLM_TIMEOUT_TIERS.consolidation],
    ];
    for (const [key, tier] of lanes) {
      const raw = env.get(key);
      expect(raw, `${key} must be emitted, not left to the vendor default`).toBeDefined();
      expect(() =>
        tb.assertClientBudget({ role: key, tier, clientBudgetS: Number(raw) }),
      ).not.toThrow();
    }
  });

  it("keeps HINDSIGHT_RETAIN_CLIENT_DEADLINE_S equal to the plugin's own constant", async () => {
    // #3611 declares this constant "mirrors DEFAULT_RETAIN_CLIENT_DEADLINE_S
    // in vendor/hindsight-memory/scripts/lib/retain_split.py", and its budget
    // assertion is only meaningful if that is TRUE. Two literals in two
    // languages with a doc comment between them is not a mirror, it is a
    // promise; this is the check that makes it one. The python side derives
    // BOTH its content bound and the backlog drain's per-entry deadline from
    // its copy (#3610), so a silent drift here reintroduces the re-post loop
    // #3599 fixed, one size class up.
    const h = await import("../../src/setup/hindsight.js");
    const src = readFileSync(
      join(process.cwd(), "vendor/hindsight-memory/scripts/lib/retain_split.py"),
      "utf8",
    );
    const m = src.match(/^DEFAULT_RETAIN_CLIENT_DEADLINE_S\s*=\s*([0-9.]+)\s*$/m);
    expect(m, "retain_split.py must define DEFAULT_RETAIN_CLIENT_DEADLINE_S").not.toBeNull();
    expect(Number(m![1])).toBe(h.HINDSIGHT_RETAIN_CLIENT_DEADLINE_S);
  });

  it("keeps the backlog drain's per-entry deadline above the retain routing chain", async () => {
    // The OUTERMOST member of the paired-budget family, and the one that
    // produced the unexplained ~280.1s per-entry give-up in the 2026-07-26
    // backlog-recovery logs. It is not a third hand-set number: the drainer's
    // `_backlog_timeout()` defaults to `int(retain_client_deadline())`
    // (vendor/hindsight-memory/scripts/drain_pending.py:220), which reads
    // DEFAULT_RETAIN_CLIENT_DEADLINE_S — 280.0 at the time. 280 < 300, so
    // every drained entry that fell through to the OpenRouter fallback was
    // abandoned client-side while the server was still inside a legitimate
    // budget, and the entry stayed queued to burn another attempt.
    //
    // This asserts the OUTCOME (the outer deadline covers the whole chain),
    // not the number, so it fails on the 280 shape and on any future edit
    // that lowers either side independently.
    const h = await import("../../src/setup/hindsight.js");
    const tb = await import("../../src/litellm/timeout-budget.js");

    const drainSrc = readFileSync(
      join(process.cwd(), "vendor/hindsight-memory/scripts/drain_pending.py"),
      "utf8",
    );
    expect(
      drainSrc,
      "the drain deadline must stay DERIVED from retain_client_deadline(), not a literal",
    ).toContain("int(retain_client_deadline())");

    const chain = tb.minimumClientBudgetSeconds(tb.LITELLM_TIMEOUT_TIERS.retain);
    expect(chain).toBe(300);
    expect(h.HINDSIGHT_RETAIN_CLIENT_DEADLINE_S).toBeGreaterThan(chain);
    // The exact regression: the shipped 280 must not satisfy this.
    expect(280).toBeLessThan(chain);
  });

  it("refuses to emit a budget where the server outlives the client deadline", async () => {
    const h = await import("../../src/setup/hindsight.js");
    // The 2026-07-25 shape: a ~190s job under a 90s deadline.
    expect(() =>
      h.assertHindsightRetainBudget({
        maxCompletionTokens: 16384,
        chunkSize: 3000,
        serverTimeoutS: 190,
        clientDeadlineS: 90,
      }),
    ).toThrow(/strictly less than the retain client deadline/);
    // Equality is a violation too — it must be strictly less.
    expect(() =>
      h.assertHindsightRetainBudget({
        maxCompletionTokens: 16384,
        chunkSize: 3000,
        serverTimeoutS: 280,
        clientDeadlineS: 280,
      }),
    ).toThrow(/strictly less than the retain client deadline/);
  });

  it("refuses to emit a token cap the hindsight container would refuse to boot on", async () => {
    const h = await import("../../src/setup/hindsight.js");
    // config.py validate_retain_*: max_completion_tokens must exceed chunk_size.
    expect(() =>
      h.assertHindsightRetainBudget({
        maxCompletionTokens: 3000,
        chunkSize: 3000,
        serverTimeoutS: 40,
        clientDeadlineS: 280,
      }),
    ).toThrow(/must exceed retain_chunk_size/);
    expect(h.HINDSIGHT_DEFAULT_RETAIN_MAX_COMPLETION_TOKENS).toBeGreaterThan(
      h.HINDSIGHT_RETAIN_CHUNK_SIZE,
    );
  });

  it("emits every consolidation scheduling var on BOTH emit paths, with the same value", async () => {
    const h = await import("../../src/setup/hindsight.js");
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const envPairs = runEnvPairs(findRunArgs());
    const snippet = h.generateHindsightComposeSnippet();

    // LITERAL values, not `=${constant}`. An assertion written against the
    // constant it is checking passes no matter what the constant becomes, so
    // it cannot catch a silent value regression — which is precisely the class
    // of drift this file exists to prevent.
    const expected: Array<[string, string]> = [
      ["HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS", "1"],
      ["HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT", "6"],
      ["HINDSIGHT_API_CONSOLIDATION_LLM_PARALLELISM", "2"],
      ["HINDSIGHT_API_CONSOLIDATION_MAX_MEMORIES_PER_ROUND", "250"],
    ];
    for (const [key, value] of expected) {
      // docker-run path
      expect(envPairs, `${key} missing/wrong on the docker-run path`).toContain(
        `${key}=${value}`,
      );
      // compose path — the twin that a `switchroom apply` actually renders.
      // A var present on only one path is dropped the moment the other path
      // recreates the container.
      expect(snippet, `${key} missing/wrong in the compose snippet`).toContain(
        `      - ${key}=${value}`,
      );
    }
    // …and the constants really are what the literals above claim, so the
    // exported API and the emitted env can't disagree.
    expect(h.HINDSIGHT_DEFAULT_CONSOLIDATION_RESERVED_SLOTS).toBe(1);
    expect(h.HINDSIGHT_DEFAULT_CONSOLIDATION_SLOT_LIMIT).toBe(6);
    expect(h.HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_PARALLELISM).toBe(2);
    expect(h.HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_MEMORIES_PER_ROUND).toBe(250);

    expect(envPairs).toContain(
      `HINDSIGHT_API_CONSOLIDATION_LLM_BATCH_SIZE=${h.HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_BATCH_SIZE}`,
    );

    // Subscription-path ceiling: concurrent model calls = reserved slots ×
    // parallelism. #2894 throttled this to 1 × 2 = 2 after an 18-way fan-out
    // exhausted the shared failover quota (2026-07-06 token-burn). switchroom
    // still ships `claude-code` as the default provider, so an operator who has
    // NOT moved consolidation onto local inference must keep that ceiling —
    // this pins it at ≤2 so a regression that re-raises slots/parallelism trips.
    expect(
      h.HINDSIGHT_DEFAULT_CONSOLIDATION_RESERVED_SLOTS *
        h.HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_PARALLELISM,
    ).toBeLessThanOrEqual(2);
  });

  it("keeps the consolidation slot CEILING above the reserved FLOOR and inside the worker pool", async () => {
    const h = await import("../../src/setup/hindsight.js");
    // Two knobs, confusingly similar upstream names (config.py warns about it):
    // MAX_SLOTS is the reserved floor, SLOT_LIMIT the per-type ceiling.
    const UPSTREAM_WORKER_MAX_SLOTS = 10;

    // (a) BOOT correctness. HindsightConfig.validate() REJECTS an explicit
    //     ceiling below the type's own reservation ("the floor is
    //     unsatisfiable") or above worker_max_slots — both make the container
    //     refuse to start. Asserted against the same rules pinned in
    //     tests/docker/hindsight-recall-isolation-patches.test.ts.
    expect(h.HINDSIGHT_DEFAULT_CONSOLIDATION_SLOT_LIMIT).toBeGreaterThanOrEqual(
      h.HINDSIGHT_DEFAULT_CONSOLIDATION_RESERVED_SLOTS,
    );
    expect(h.HINDSIGHT_DEFAULT_CONSOLIDATION_SLOT_LIMIT).toBeLessThanOrEqual(
      UPSTREAM_WORKER_MAX_SLOTS,
    );
    expect(h.HINDSIGHT_DEFAULT_CONSOLIDATION_SLOT_LIMIT).toBeGreaterThan(0);

    // (b) DESIGN intent, stricter than (a): consolidation must not be able to
    //     take the whole worker. Every other op type (retain,
    //     refresh_mental_model, graph_maintenance, import_documents) is
    //     uncapped upstream, so slots left over are the only thing keeping them
    //     schedulable while consolidation is saturated.
    expect(h.HINDSIGHT_DEFAULT_CONSOLIDATION_SLOT_LIMIT).toBeLessThan(
      UPSTREAM_WORKER_MAX_SLOTS,
    );
  });

  it("bounds consolidation per-round scope so a huge bank still re-queues", async () => {
    const h = await import("../../src/setup/hindsight.js");
    // The round limit is what forces a re-queue; it must stay a real bound.
    // It is ALSO a correctness knob: the engine sets
    // stats["mental_models_refreshed"] = 0 on any round that hits it
    // (consolidator.py), so a bank permanently above the limit never refreshes
    // its mental models. Upstream's own default is 1000 — stay at or under it.
    expect(h.HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_MEMORIES_PER_ROUND).toBeGreaterThan(100);
    expect(h.HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_MEMORIES_PER_ROUND).toBeLessThanOrEqual(1000);
  });

  it("raises the memory limit to give the throughput bump headroom (16g, was 8g)", async () => {
    const h = await import("../../src/setup/hindsight.js");
    // Baseline RSS ~3.4g; 4g was tight, and more in-flight consolidation
    // raises it. 8g then went to 16g when the live cgroup sat at 99.5% of the
    // ceiling re-reading ~24.5 GB/hour of evicted page cache. Both emit paths
    // must carry the bumped limit.
    const m = /^(\d+)g$/.exec(h.HINDSIGHT_DEFAULT_MEM_LIMIT);
    expect(m, "mem limit should be N gigabytes").not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(16);
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    expect(findRunArgs()).toContain(`--memory=${h.HINDSIGHT_DEFAULT_MEM_LIMIT}`);
    expect(h.generateHindsightComposeSnippet()).toMatch(
      new RegExp(`mem_limit:\\s*${h.HINDSIGHT_DEFAULT_MEM_LIMIT}\\b`),
    );
  });

  // ── the swap cushion ───────────────────────────────────────────────────
  //
  // Docker's rule: when `--memory-swap` is OMITTED it defaults to 2 × memory,
  // so the container gets a swap cushion the size of its RAM cap. Setting it
  // EQUAL to `--memory` means "no swap at all". Those two look like the same
  // kind of tidying edit and are opposites.
  //
  // On the live container that cushion is load-bearing, not theoretical:
  // Memory=8g / MemorySwap=16g with ~900 MiB actually resident in swap, and
  // 7,400+ reclaim events with ZERO OOM kills. Zeroing it in the same change
  // that pins ~1.5 GiB more unreclaimable shared memory turns a slow
  // degradation into a hard kill of the memory backend for the whole fleet.
  //
  // So the invariant is: emit no swap flag at all (inherit 2x), or emit one
  // that is STRICTLY GREATER than the memory limit. Never equal, never less.
  // Asserted on BOTH launch paths, because compose is what actually creates
  // the container on a fleet host.
  it("never emits a memory-swap equal to (or below) the memory limit — the OOM cushion", async () => {
    const h = await import("../../src/setup/hindsight.js");

    /** Docker size string (`16g`, `512m`, `2G`, `1024`) → MiB. */
    const toMib = (size: string): number => {
      const m = /^(\d+(?:\.\d+)?)\s*([kmgKMG])?[bB]?$/.exec(size.trim());
      expect(m, `unparseable docker size: ${size}`).not.toBeNull();
      const n = Number(m![1]);
      switch ((m![2] ?? "m").toLowerCase()) {
        case "k":
          return n / 1024;
        case "g":
          return n * 1024;
        default:
          return n;
      }
    };

    /**
     * Pull `--memory` / `--memory-swap` out of a docker-run argv, accepting
     * both the single-token (`--memory=16g`) and split (`--memory 16g`) forms
     * so the assertion cannot be dodged by a formatting change.
     */
    const runFlag = (args: string[], flag: string): string | null => {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === flag) return (args[i + 1] as string) ?? null;
        if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
      }
      return null;
    };

    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();

    const runMemory = runFlag(args, "--memory");
    expect(runMemory, "docker run must cap memory").not.toBeNull();
    const runSwap = runFlag(args, "--memory-swap");
    if (runSwap !== null) {
      expect(
        toMib(runSwap),
        `--memory-swap=${runSwap} must be STRICTLY greater than --memory=${runMemory}; ` +
          "equal disables swap and removes the cushion that has kept this " +
          "container OOM-free through 7,400+ reclaim events",
      ).toBeGreaterThan(toMib(runMemory!));
    }

    // Compose twin. `memswap_limit` is compose's spelling of --memory-swap;
    // omitted, the daemon applies the same 2x default.
    const snippet = h.generateHindsightComposeSnippet();
    const memLine = /^\s*mem_limit:\s*(\S+)\s*$/m.exec(snippet);
    expect(memLine, "compose snippet must carry mem_limit").not.toBeNull();
    const swapLine = /^\s*memswap_limit:\s*(\S+)\s*$/m.exec(snippet);
    if (swapLine) {
      expect(
        toMib(swapLine[1]),
        `memswap_limit: ${swapLine[1]} must be STRICTLY greater than ` +
          `mem_limit: ${memLine![1]} — equal disables swap entirely`,
      ).toBeGreaterThan(toMib(memLine![1]));
    }

    // Guard the guard: if BOTH paths silently stopped emitting a memory cap,
    // every branch above would be vacuous. Pin that the caps are still there
    // and that the two paths agree, so this test can never pass by emitting
    // nothing at all.
    expect(runMemory).toBe(h.HINDSIGHT_DEFAULT_MEM_LIMIT);
    expect(memLine![1]).toBe(h.HINDSIGHT_DEFAULT_MEM_LIMIT);
  });

  it("enables stateless MCP (HINDSIGHT_API_MCP_STATELESS=true) so a hindsight bounce doesn't strand agent-side MCP sessions", () => {
    // Stateful MCP makes the server assign an Mcp-Session-Id on
    // initialize that the client must echo on every subsequent call.
    // When hindsight restarts, its in-memory session table is wiped
    // but every agent's claude MCP client keeps caching the now-stale
    // id — retain fails with "Session not found" until each agent is
    // also restarted. Stateless mode makes every request self-contained.
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    const envPairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") envPairs.push(args[i + 1] as string);
    }
    expect(envPairs).toContain("HINDSIGHT_API_MCP_STATELESS=true");
  });

  it("uses the switchroom-hindsight image, not upstream", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    expect(args).toContain(HINDSIGHT_IMAGE);
    // Upstream image MUST NOT be used — that one is missing
    // claude-agent-sdk + the claude CLI.
    expect(args).not.toContain("ghcr.io/vectorize-io/hindsight:latest");
  });

  // #2752 fix 1 — a version-pinned rollout threads its target through as
  // imageTag so the standalone recreate pulls + runs the SAME pinned image
  // (`:vX.Y.Z`) the rest of the fleet moved to, not floating `:latest`.
  it("runs the PINNED :vX.Y.Z image when an imageTag is provided", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, "v0.15.18");
    const args = findRunArgs();
    expect(args).toContain("ghcr.io/switchroom/switchroom-hindsight:v0.15.18");
    expect(args).not.toContain(HINDSIGHT_IMAGE); // NOT floating :latest
  });

  it("normalizes a bare (v-less) tag to the :vX.Y.Z form the workflow publishes", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, "0.15.18");
    const args = findRunArgs();
    expect(args).toContain("ghcr.io/switchroom/switchroom-hindsight:v0.15.18");
  });

  it("falls back to floating :latest when no imageTag is given (standalone memory setup)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    expect(args).toContain(HINDSIGHT_IMAGE);
  });

  // Regression — without uid/gid on the tmpfs, the mount lands root-owned
  // and the entrypoint shim's `chmod 0700 /run/claude-creds` (running as
  // the image's pinned USER hindsight, UID 11000) fails EACCES → boot
  // exits non-zero → docker `--restart unless-stopped` crash-loops.
  it("tmpfs at /run/claude-creds carries uid + gid matching HINDSIGHT_DEFAULT_UID", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    let tmpfsArg: string | undefined;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--tmpfs" && (args[i + 1] as string).startsWith("/run/claude-creds")) {
        tmpfsArg = args[i + 1] as string;
        break;
      }
    }
    expect(tmpfsArg).toBeDefined();
    expect(tmpfsArg).toMatch(/uid=11000\b/);
    expect(tmpfsArg).toMatch(/gid=11000\b/);
    // Sanity: the existing mode + rw flags survive the addition.
    expect(tmpfsArg).toMatch(/mode=0700\b/);
    expect(tmpfsArg).toMatch(/\brw\b/);
  });

  // Regression — the standalone `docker run` path mounts the broker
  // socket volume by name. The auth-broker compose declares the volume
  // with an explicit `name:` override (see compose-generator.test.ts
  // "auth-broker per-consumer volume naming"), so the actual docker
  // volume name has NO project prefix. setup.ts must reference that
  // unprefixed name; if it ever silently picks up the prefixed name, a
  // fresh empty volume gets created and the entrypoint times out on
  // the missing UDS.
  it("mounts the broker socket volume by the unprefixed canonical name", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    let volArg: string | undefined;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-v" && (args[i + 1] as string).includes("/run/switchroom/auth-broker")) {
        volArg = args[i + 1] as string;
        break;
      }
    }
    expect(volArg).toBe("auth-broker-hindsight-sock:/run/switchroom/auth-broker");
    // Must NOT have the docker-compose project prefix.
    expect(volArg).not.toMatch(/^switchroom_/);
  });
});

// (Removed: a regression test for the legacy host-side volume probe in
// `checkHindsightConsumer`. PR #1313 replaced that approach with a
// container-side `docker exec` probe that doesn't construct paths at
// all — the bug class this test covered is structurally impossible
// in the new shape. Coverage for the canonical-volume-name shape is
// preserved in compose-generator.test.ts and the broker-mount tests.)

// Regression — the compose snippet (used by operators who run hindsight
// in its OWN compose project rather than via `docker run`) had the same
// tmpfs ownership bug. Pin the tmpfs flag shape here so the two
// codepaths can't drift.
describe("getRunningHindsightPorts — host-network env fallback (#2903 fix 5.2)", () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it("reads HINDSIGHT_API_PORT from `docker inspect` env when `docker port` is empty (--network host)", () => {
    // A `--network host` container publishes no port mappings, so
    // `docker port` returns "" — the code must then recover the real host
    // port from the container's environment.
    mockedExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "port") return ""; // host-network: no mappings
      if (args[0] === "inspect") {
        // `{{.Config.Env}}` renders as a bracketed, space-separated Go list.
        return "[PATH=/usr/bin HINDSIGHT_API_PORT=28888 ANTHROPIC_BASE_URL=http://127.0.0.1:4010/anthropic]\n";
      }
      return "";
    });
    const ports = getRunningHindsightPorts();
    expect(ports).toEqual({ apiPort: 28888, uiPort: 19999 });
  });

  it("still prefers `docker port` output when the container publishes mappings", () => {
    mockedExec.mockImplementation((_cmd: string, args: string[]) => {
      // args = ["port", "switchroom-hindsight", "<containerPort>/tcp"]
      if (args[0] === "port" && args[2] === "8888/tcp") return "127.0.0.1:18888\n";
      if (args[0] === "port" && args[2] === "9999/tcp") return "127.0.0.1:9999\n";
      return "";
    });
    const ports = getRunningHindsightPorts();
    expect(ports).toEqual({ apiPort: HINDSIGHT_DEFAULT_API_PORT, uiPort: HINDSIGHT_DEFAULT_UI_PORT });
  });

  it("returns null when neither `docker port` nor inspect env yield an API port", () => {
    mockedExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "port") return "";
      if (args[0] === "inspect") return "[PATH=/usr/bin FOO=bar]\n";
      return "";
    });
    expect(getRunningHindsightPorts()).toBeNull();
  });
});

describe("hindsight/scaffold model pin (#2903 fix 5.4)", () => {
  it("HINDSIGHT_DEFAULT_MODEL stays in lockstep with SWITCHROOM_DEFAULT_MAIN_MODEL", () => {
    // A fleet model bump must move memory ops too; if these drift, hindsight's
    // retain/reflect/consolidation silently run on a stale model.
    expect(HINDSIGHT_DEFAULT_MODEL).toBe(SWITCHROOM_DEFAULT_MAIN_MODEL);
  });
});

describe("hindsight LiteLLM model routing (2026-07-07)", () => {
  beforeEach(() => {
    mockedExec.mockReset();
    mockedExec.mockReturnValue("");
  });

  function envVal(args: string[], key: string): string | undefined {
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e" && (args[i + 1] as string).startsWith(`${key}=`)) {
        return (args[i + 1] as string).slice(key.length + 1);
      }
    }
    return undefined;
  }

  it("without litellm, stays on HINDSIGHT_DEFAULT_MODEL and sets no ANTHROPIC_BASE_URL", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    expect(envVal(args, "ANTHROPIC_MODEL")).toBe(HINDSIGHT_DEFAULT_MODEL);
    expect(envVal(args, "HINDSIGHT_API_LLM_MODEL")).toBe(HINDSIGHT_DEFAULT_MODEL);
    expect(envVal(args, "ANTHROPIC_BASE_URL")).toBeUndefined();
  });

  it("with litellm and no model override, defaults to HINDSIGHT_DEFAULT_LITELLM_MODEL routed via the model-mapped root (no /anthropic suffix)", () => {
    startHindsight(
      { apiPort: 8888, uiPort: 9999 },
      { baseUrl: "http://127.0.0.1:4010", apiKey: "sk-test" },
    );
    const args = findRunArgs();
    expect(envVal(args, "ANTHROPIC_MODEL")).toBe(HINDSIGHT_DEFAULT_LITELLM_MODEL);
    expect(envVal(args, "HINDSIGHT_API_LLM_MODEL")).toBe(HINDSIGHT_DEFAULT_LITELLM_MODEL);
    expect(envVal(args, "ANTHROPIC_BASE_URL")).toBe("http://127.0.0.1:4010");
  });

  it("with litellm and an explicit claude-* model override, rides the Anthropic pass-through (/anthropic suffix)", () => {
    startHindsight(
      { apiPort: 8888, uiPort: 9999 },
      { baseUrl: "http://127.0.0.1:4010", apiKey: "sk-test", model: "claude-sonnet-5" },
    );
    const args = findRunArgs();
    expect(envVal(args, "ANTHROPIC_MODEL")).toBe("claude-sonnet-5");
    expect(envVal(args, "ANTHROPIC_BASE_URL")).toBe("http://127.0.0.1:4010/anthropic");
  });

  it("with litellm and an explicit non-Claude model override, rides the model-mapped root", () => {
    startHindsight(
      { apiPort: 8888, uiPort: 9999 },
      { baseUrl: "http://127.0.0.1:4010/", apiKey: "sk-test", model: "openrouter/minimax/minimax-m3" },
    );
    const args = findRunArgs();
    expect(envVal(args, "ANTHROPIC_MODEL")).toBe("openrouter/minimax/minimax-m3");
    // Trailing slash on baseUrl must not survive into the resolved URL.
    expect(envVal(args, "ANTHROPIC_BASE_URL")).toBe("http://127.0.0.1:4010");
  });

  // Regression: the routing split must use the same Claude-alias set as the
  // rest of the product (telegram-plugin/gateway/model-command.ts's
  // isClaudeModel/MODEL_ALIASES), not a narrower hand-rolled list. A bare
  // "opus"/"haiku"/"default" override is a legitimate thing an operator would
  // type (it's what /model accepts everywhere else) — misrouting it to the
  // model-mapped root would 404 against real Anthropic-shaped names.
  it.each(["opus", "haiku", "default", "OPUS"])(
    "treats the Claude alias %s as pass-through-eligible (case-insensitive)",
    (alias) => {
      startHindsight(
        { apiPort: 8888, uiPort: 9999 },
        { baseUrl: "http://127.0.0.1:4010", apiKey: "sk-test", model: alias },
      );
      const args = findRunArgs();
      expect(envVal(args, "ANTHROPIC_MODEL")).toBe(alias);
      expect(envVal(args, "ANTHROPIC_BASE_URL")).toBe("http://127.0.0.1:4010/anthropic");
    },
  );
});

describe("generateHindsightComposeSnippet — tmpfs ownership", () => {
  it("emits uid + gid on the /run/claude-creds tmpfs entry", async () => {
    const { generateHindsightComposeSnippet } = await import("../../src/setup/hindsight.js");
    const snippet = generateHindsightComposeSnippet();
    // Find the tmpfs block — it's a `- /run/claude-creds:rw,...` line.
    const tmpfsLine = snippet
      .split("\n")
      .find((l) => l.includes("/run/claude-creds:rw"));
    expect(tmpfsLine).toBeDefined();
    expect(tmpfsLine).toMatch(/uid=11000\b/);
    expect(tmpfsLine).toMatch(/gid=11000\b/);
    expect(tmpfsLine).toMatch(/mode=0700\b/);
  });

  it("publishes both ports on 127.0.0.1 only — the tokenless API must never bind 0.0.0.0 (Fix 1.1)", async () => {
    const { generateHindsightComposeSnippet, HINDSIGHT_DEFAULT_API_PORT } =
      await import("../../src/setup/hindsight.js");
    const snippet = generateHindsightComposeSnippet();
    const portLines = snippet
      .split("\n")
      .filter((l) => /^\s+-\s+"[\d.:]+:\d+"\s*$/.test(l));
    // Both the API and UI published ports must be present and loopback-bound.
    expect(portLines.length).toBeGreaterThanOrEqual(2);
    for (const line of portLines) {
      expect(line, `port binding must be loopback-only: ${line}`).toMatch(
        /"127\.0\.0\.1:/,
      );
    }
    expect(snippet).toContain(`"127.0.0.1:${HINDSIGHT_DEFAULT_API_PORT}:8888"`);
    expect(snippet).toContain('"127.0.0.1:19999:9999"');
    // Guard against a regression that drops the host-IP prefix entirely.
    expect(snippet).not.toMatch(/-\s+"\d+:8888"/);
    expect(snippet).not.toMatch(/-\s+"\d+:9999"/);
  });

  it("emits shm_size so the compose path matches the docker-run shm fix (2026-06-06 outage)", async () => {
    const { generateHindsightComposeSnippet, HINDSIGHT_DEFAULT_SHM_SIZE: shm } =
      await import("../../src/setup/hindsight.js");
    const snippet = generateHindsightComposeSnippet();
    expect(snippet).toMatch(new RegExp(`shm_size:\\s*${shm}\\b`));
  });

  it("emits a healthcheck + separate backups volume (parity with the docker-run path)", async () => {
    const { generateHindsightComposeSnippet } = await import("../../src/setup/hindsight.js");
    const snippet = generateHindsightComposeSnippet();
    expect(snippet).toMatch(/healthcheck:/);
    expect(snippet).toContain("/health");
    expect(snippet).toContain("- switchroom-hindsight-backups:/backups");
    // The backups volume must be declared under top-level `volumes:`.
    expect(snippet).toMatch(/^ {2}switchroom-hindsight-backups:/m);
    // Backups must not share the data volume mount.
    expect(snippet).not.toContain("switchroom-hindsight-data:/backups");
  });
});

describe("ensureHindsightConsumer (#1245)", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "switchroom-setup-test-"));
    configPath = join(dir, "switchroom.yaml");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds an `auth.consumers[hindsight]` entry pinned to the active account", async () => {
    writeFileSync(
      configPath,
      [
        "telegram: {}",
        "agents: {}",
        "auth:",
        "  active: me@example.com",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = await ensureHindsightConsumer(configPath, "me@example.com");
    expect(result.added).toBe(true);
    const raw = readFileSync(configPath, "utf-8");
    expect(raw).toMatch(/consumers:/);
    expect(raw).toMatch(/name: hindsight/);
    expect(raw).toMatch(/account: me@example\.com/);
    expect(raw).toMatch(new RegExp(`uid: ${HINDSIGHT_DEFAULT_UID}`));
    expect(result.reason).toBe("added");
  });

  it("is idempotent when an entry named `hindsight` already exists", async () => {
    writeFileSync(
      configPath,
      [
        "auth:",
        "  active: me@example.com",
        "  consumers:",
        "    - name: hindsight",
        "      account: prior@example.com",
        "      uid: 12345",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = await ensureHindsightConsumer(configPath, "me@example.com");
    expect(result.added).toBe(false);
    const raw = readFileSync(configPath, "utf-8");
    // Prior entry untouched (account stays at prior@, uid stays at 12345).
    expect(raw).toMatch(/account: prior@example\.com/);
    expect(raw).toMatch(/uid: 12345/);
    expect(raw).not.toMatch(/account: me@example\.com/);
  });

  it("creates the `auth.consumers` array when missing", async () => {
    writeFileSync(
      configPath,
      [
        "auth:",
        "  active: me@example.com",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = await ensureHindsightConsumer(configPath, "me@example.com");
    expect(result.added).toBe(true);
    const raw = readFileSync(configPath, "utf-8");
    expect(raw).toMatch(/consumers:\s*\n\s+- name: hindsight/);
  });

  it("creates the entire `auth:` block when missing", async () => {
    writeFileSync(configPath, "telegram: {}\nagents: {}\n", "utf-8");
    const result = await ensureHindsightConsumer(configPath, "me@example.com");
    expect(result.added).toBe(true);
    const raw = readFileSync(configPath, "utf-8");
    expect(raw).toMatch(/auth:/);
    expect(raw).toMatch(/name: hindsight/);
  });

  it("does NOT write any OpenAI key or HINDSIGHT_API_LLM_API_KEY to the yaml", async () => {
    writeFileSync(configPath, "auth:\n  active: me@example.com\n", "utf-8");
    await ensureHindsightConsumer(configPath, "me@example.com");
    const raw = readFileSync(configPath, "utf-8");
    expect(raw).not.toMatch(/openai/i);
    expect(raw).not.toMatch(/api_key/i);
    expect(raw).not.toMatch(/HINDSIGHT_API_LLM_API_KEY/);
  });

  it("uses the canonical consumer slug", () => {
    expect(HINDSIGHT_CONSUMER_NAME).toBe("hindsight");
  });
});

describe("hindsight recovery footguns (2026-07-19 dual-writer + silent LLM)", () => {
  beforeEach(() => {
    mockedExec.mockReset();
    mockedExec.mockReturnValue("");
  });

  it("pins HINDSIGHT_API_WORKER_ID on both docker-run and compose emit paths", async () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const env: string[] = [];
    const args = findRunArgs();
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") env.push(args[i + 1] as string);
    }
    expect(env).toContain(`HINDSIGHT_API_WORKER_ID=${HINDSIGHT_DEFAULT_WORKER_ID}`);
    const { generateHindsightComposeSnippet } = await import("../../src/setup/hindsight.js");
    expect(generateHindsightComposeSnippet()).toContain(
      `HINDSIGHT_API_WORKER_ID=${HINDSIGHT_DEFAULT_WORKER_ID}`,
    );
  });

  it("pairs /health with LiteLLM TCP in litellm-mode health-cmd", () => {
    startHindsight(
      { apiPort: 18888, uiPort: 19999 },
      { baseUrl: "http://127.0.0.1:4010", apiKey: "sk-test" },
    );
    const args = findRunArgs();
    const i = args.indexOf("--health-cmd");
    expect(i).toBeGreaterThan(-1);
    const cmd = args[i + 1] as string;
    expect(cmd).toContain("localhost:18888/health");
    expect(cmd).toContain("create_connection(('127.0.0.1',4010)");
    const built = buildLiteLlmAwareHealthCmd(18888, "http://10.0.0.5:9/v1");
    expect(built).toContain("10.0.0.5");
    expect(built).toContain(",9)");
  });

  it("compose with loopback per-op LiteLLM base uses host network + LiteLLM-aware healthcheck", async () => {
    const {
      generateHindsightComposeSnippet,
      HINDSIGHT_DEFAULT_API_PORT,
      HINDSIGHT_HEALTHCHECK_PY,
    } = await import("../../src/setup/hindsight.js");
    const snippet = generateHindsightComposeSnippet({
      retain: {
        provider: "litellm",
        model: "openai/gpt-oss-20b",
        base_url: "http://127.0.0.1:4010/v1",
      },
      reflect: {
        provider: "litellm",
        model: "openai/gpt-oss-20b",
        base_url: "http://127.0.0.1:4010/v1",
      },
    });
    // Match live fleet deploy + startHindsight: host net for loopback LiteLLM.
    expect(snippet).toContain("network_mode: host");
    expect(snippet).not.toMatch(/^\s+ports:/m);
    expect(snippet).toContain(`HINDSIGHT_API_PORT=${HINDSIGHT_DEFAULT_API_PORT}`);
    expect(snippet).toContain(
      `HINDSIGHT_CP_DATAPLANE_API_URL=http://localhost:${HINDSIGHT_DEFAULT_API_PORT}`,
    );
    // Health pairs /health with TCP to LiteLLM — not the bare DB-only probe.
    expect(snippet).toContain("create_connection(('127.0.0.1',4010)");
    expect(snippet).toContain(`localhost:${HINDSIGHT_DEFAULT_API_PORT}/health`);
    expect(snippet).not.toContain(HINDSIGHT_HEALTHCHECK_PY);
  });

  it("compose with explicit litellm config uses host network + LiteLLM-aware healthcheck", async () => {
    const { generateHindsightComposeSnippet } = await import("../../src/setup/hindsight.js");
    const snippet = generateHindsightComposeSnippet(
      undefined,
      undefined,
      { baseUrl: "http://127.0.0.1:4010", apiKey: "sk-test" },
    );
    expect(snippet).toContain("network_mode: host");
    expect(snippet).toContain("create_connection(('127.0.0.1',4010)");
    expect(snippet).toContain("ANTHROPIC_BASE_URL=");
  });

  it("compose without LiteLLM stays bridge + plain /health probe", async () => {
    const {
      generateHindsightComposeSnippet,
      HINDSIGHT_HEALTHCHECK_PY,
      HINDSIGHT_DEFAULT_API_PORT,
    } = await import("../../src/setup/hindsight.js");
    const snippet = generateHindsightComposeSnippet();
    expect(snippet).not.toContain("network_mode: host");
    expect(snippet).toContain(`"127.0.0.1:${HINDSIGHT_DEFAULT_API_PORT}:8888"`);
    // JSON.stringify escapes embedded quotes in the CMD python body, so the
    // raw HINDSIGHT_HEALTHCHECK_PY string is not a literal substring.
    expect(snippet).toMatch(/healthcheck:[\s\S]*localhost:8888\/health/);
    expect(snippet).not.toContain("create_connection");
  });

  it("stopHindsight disables restart and removes every data-volume twin, not just the live name", () => {
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      stopHindsight(exec, () => [
        HINDSIGHT_DEFAULT_WORKER_ID,
        "switchroom-hindsight-old-v01833",
      ]);
      const twin = "switchroom-hindsight-old-v01833";
      const lines = calls.map((c) => c.join(" "));
      expect(lines).toContain(`docker update --restart=no ${twin}`);
      expect(lines).toContain(`docker stop ${twin}`);
      expect(lines).toContain(`docker rm -f ${twin}`);
      expect(lines).toContain(`docker update --restart=no ${HINDSIGHT_DEFAULT_WORKER_ID}`);
      expect(lines).toContain(`docker rm -f ${HINDSIGHT_DEFAULT_WORKER_ID}`);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("switchroom-hindsight-old-v01833"),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("listHindsightDataVolumeMounts uses docker ps filter on the data volume", () => {
    const exec = vi.fn((..._args: unknown[]) =>
      ["switchroom-hindsight", "switchroom-hindsight-old-v01833"].join("\n") + "\n",
    );
    const names = listHindsightDataVolumeMounts(
      exec as unknown as (cmd: string, args: string[]) => string,
    );
    expect(exec).toHaveBeenCalledWith("docker", [
      "ps", "-a",
      "--filter", `volume=${HINDSIGHT_DATA_VOLUME}`,
      "--format", "{{.Names}}",
    ]);
    expect(names).toEqual([
      "switchroom-hindsight",
      "switchroom-hindsight-old-v01833",
    ]);
  });
});

