/**
 * Capability-gated Hindsight performance defaults.
 *
 * What these tests protect, in order of how badly a regression would hurt:
 *
 *   1. **Fail-safe gating.** A knob whose benefit needs hardware is emitted
 *      ONLY when the host proves it has that hardware. FP16 reranking on a
 *      CPU without native FP16 support is upstream's own stated reason for
 *      defaulting it off; throttling a cloud LLM endpoint to 4 concurrent
 *      requests is a throughput regression for nothing.
 *   2. **Operator override wins.** A value in `hindsight.env` (or exported in
 *      switchroom's environment) must reach the container — including when
 *      the gating capability is ABSENT, otherwise "override" quietly means
 *      "override, unless you have the wrong hardware".
 *   3. **Run ⇄ compose parity.** Two launch paths, one resolver. The
 *      assertions compare the OUTCOME of both generators for the same inputs,
 *      not that both happened to call a shared function.
 *   4. **Derivation coherence.** The per-source candidate cap exists to stop
 *      ONE source filling the reranker budget without stopping ALL FOUR from
 *      filling it. Both halves are asserted against the real reranker
 *      constant, so raising the budget can't silently invert the property.
 */

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

import {
  HINDSIGHT_DEFAULT_LINK_EXPANSION_PER_ENTITY_LIMIT,
  HINDSIGHT_DEFAULT_LINK_EXPANSION_TIMEOUT_S,
  HINDSIGHT_DEFAULT_RECALL_MAX_CANDIDATES_PER_SOURCE,
  HINDSIGHT_DEFAULT_RECENCY_DECAY_FUNCTION,
  HINDSIGHT_DEFAULT_RECENCY_DECAY_HALFLIFE_DAYS,
  HINDSIGHT_DEFAULT_RETAIN_LLM_MAX_CONCURRENT,
  HINDSIGHT_PERF_DEFAULTS_GPU,
  HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
  HINDSIGHT_PERF_DEFAULTS_UNGATED,
  HINDSIGHT_PERF_ENV_KEYS,
  HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS,
  HINDSIGHT_WORKER_RESERVED_SLOT_ALIASES,
  HINDSIGHT_WORKER_SLOT_TYPES,
  HINDSIGHT_RECALL_SOURCE_COUNT,
  HINDSIGHT_RERANKER_MAX_CANDIDATES_FOR_DERIVATION,
  hindsightPerfEnv,
  resolveHindsightPerfOverrides,
} from "./hindsight-perf-defaults.js";
import {
  HINDSIGHT_DEFAULT_RERANKER_MAX_CANDIDATES,
  generateHindsightComposeSnippet,
  hindsightLocalLlmEnabled,
  hindsightNeedsHostNetwork,
  hindsightPerfEnvPairs,
  isLoopbackHttpUrl,
  isSelfHostedHttpUrl,
  startHindsight,
} from "./hindsight.js";

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue(Buffer.from(""));
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

/** The `docker run` argv for the hindsight container itself (not the chown helper). */
function runArgs(): string[] {
  const call = execFileSyncMock.mock.calls.find(
    (c) =>
      c[0] === "docker" &&
      Array.isArray(c[1]) &&
      (c[1] as string[])[0] === "run" &&
      (c[1] as string[]).includes("switchroom-hindsight"),
  );
  expect(call, "startHindsight must have issued a `docker run`").toBeDefined();
  return call![1] as string[];
}

/** `KEY=VALUE` pairs following a `-e` flag in a docker-run argv. */
function runEnv(args: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "-e") continue;
    const eq = args[i + 1].indexOf("=");
    if (eq < 0) continue;
    const key = args[i + 1].slice(0, eq);
    const value = args[i + 1].slice(eq + 1);
    out.set(key, [...(out.get(key) ?? []), value]);
  }
  return out;
}

/** `      - KEY=VALUE` environment lines from a compose snippet. */
function composeEnv(snippet: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of snippet.split("\n")) {
    const m = line.match(/^ {6}- ([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    out.set(m[1], [...(out.get(m[1]) ?? []), m[2]]);
  }
  return out;
}

/** A LiteLLM config pointed at host loopback — this fleet's real shape. */
const LOOPBACK_LITELLM = { baseUrl: "http://127.0.0.1:4010", apiKey: "sk-" + "test" };
/** A hosted LiteLLM endpoint — the "not self-hosted" control. */
const CLOUD_LITELLM = { baseUrl: "https://litellm.example.com", apiKey: "sk-" + "test" };

// ── the derivation ────────────────────────────────────────────────────────
describe("per-source candidate cap derivation", () => {
  it("is pinned to the real reranker budget constant", () => {
    // hindsight-perf-defaults.ts holds a literal to avoid an import cycle with
    // hindsight.ts. If they drift, the two invariants below are computed
    // against a number the engine never sees.
    expect(HINDSIGHT_RERANKER_MAX_CANDIDATES_FOR_DERIVATION).toBe(
      HINDSIGHT_DEFAULT_RERANKER_MAX_CANDIDATES,
    );
  });

  it("stops ONE source filling the reranker budget on its own", () => {
    // Upstream's stated purpose for the knob, verbatim: "Prevents one
    // over-expanding backend from filling the reranker budget on its own."
    expect(HINDSIGHT_DEFAULT_RECALL_MAX_CANDIDATES_PER_SOURCE).toBeLessThan(
      HINDSIGHT_DEFAULT_RERANKER_MAX_CANDIDATES,
    );
  });

  it("still lets ALL sources together fill the reranker budget", () => {
    // The other half, and the one a naive "just make it small" tuning breaks:
    // if sources * perSource < rerankerMax, the cap silently shrinks the pool
    // that reaches the cross-encoder and costs recall quality even when no
    // single source is misbehaving.
    expect(
      HINDSIGHT_DEFAULT_RECALL_MAX_CANDIDATES_PER_SOURCE * HINDSIGHT_RECALL_SOURCE_COUNT,
    ).toBeGreaterThanOrEqual(HINDSIGHT_DEFAULT_RERANKER_MAX_CANDIDATES);
  });

  it("bounds the graph timeout below the client's per-bank recall timeout", () => {
    // At upstream's 10s default the knob is dead code: the auto-recall client
    // abandons the bank at 8s (vendor scripts/recall.py), so a graph stall
    // kills the WHOLE recall — including the semantic and BM25 results that
    // already returned — and writes no telemetry row. A bound strictly under
    // the client timeout is what lets the engine shed the stalling stage
    // before the client walks away. It is NOT a ceiling on recall: the knob
    // wraps only the entity-expansion query, and its fallback is untimed —
    // see the constant's doc comment for what the engine actually does.
    const PER_BANK_CLIENT_TIMEOUT_S = 8;
    expect(HINDSIGHT_DEFAULT_LINK_EXPANSION_TIMEOUT_S).toBeLessThan(PER_BANK_CLIENT_TIMEOUT_S);
  });

  it("caps graph fan-out strictly below upstream's default", () => {
    const UPSTREAM_DEFAULT = 200;
    expect(HINDSIGHT_DEFAULT_LINK_EXPANSION_PER_ENTITY_LIMIT).toBeLessThan(UPSTREAM_DEFAULT);
    // ...and at or above the measured mean links-per-unit (16,604,592 links /
    // 559,316 units = 29.7), so the cap only ever bites hub entities.
    expect(HINDSIGHT_DEFAULT_LINK_EXPANSION_PER_ENTITY_LIMIT).toBeGreaterThanOrEqual(30);
  });
});

// ── the gate ──────────────────────────────────────────────────────────────
describe("hindsightPerfEnv — capability gating", () => {
  const keys = (caps: { gpu: boolean; localLlm: boolean }) =>
    new Set(hindsightPerfEnv(caps).map(([k]) => k));

  it("emits the ungated defaults on every host", () => {
    // Spelled out, NOT derived from HINDSIGHT_PERF_DEFAULTS_UNGATED. Iterating
    // the array under test makes the assertion vacuous: deleting an entry
    // would delete the thing being checked and the test would still pass
    // (verified — mutation M23 stayed green until this was written out).
    const UNGATED = [
      "HINDSIGHT_API_RECALL_MAX_CANDIDATES_PER_SOURCE",
      "HINDSIGHT_API_LINK_EXPANSION_PER_ENTITY_LIMIT",
      "HINDSIGHT_API_LINK_EXPANSION_TIMEOUT",
      "HINDSIGHT_API_LLM_REASONING_EFFORT",
      "HINDSIGHT_API_CONSOLIDATION_LLM_PARALLELISM",
      "HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE",
      "HINDSIGHT_API_RERANKER_LOCAL_BUCKET_BATCHING",
      "HINDSIGHT_API_RERANKER_MAX_CANDIDATES",
      "HINDSIGHT_API_RERANKER_LOCAL_MAX_CONCURRENT",
      "HINDSIGHT_API_RECALL_MAX_CONCURRENT",
      "HINDSIGHT_API_REFLECT_WALL_TIMEOUT",
      "HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS",
      "HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT",
      "HINDSIGHT_API_CONSOLIDATION_MAX_MEMORIES_PER_ROUND",
      "HINDSIGHT_API_RECENCY_DECAY_FUNCTION",
      "HINDSIGHT_API_RECENCY_DECAY_HALFLIFE_DAYS",
      "HINDSIGHT_API_GRAPH_SEED_MIN_SIMILARITY",
    ];
    expect(HINDSIGHT_PERF_DEFAULTS_UNGATED.map(([k]) => k)).toEqual(UNGATED);
    for (const caps of [
      { gpu: false, localLlm: false },
      { gpu: true, localLlm: true },
    ]) {
      const got = keys(caps);
      for (const k of UNGATED) {
        expect(got, `${k} must be emitted for caps ${JSON.stringify(caps)}`).toContain(k);
      }
    }
  });

  it("emits the 2026-07-31 relief default of 250 memories per consolidation round", () => {
    // Outcome, not presence: the relief pass halved this 500 -> 250 to shorten
    // the per-round worker-slot hold under multi-bank contention (paired with
    // the pg buffer-pool resize and the DB housekeeping). Assert the VALUE the
    // container actually receives, on every host, with no operator override —
    // a revert to 500 or drift to any other value fails here. This is not gated
    // on caps, so it must hold for both extremes.
    for (const caps of [
      { gpu: false, localLlm: false },
      { gpu: true, localLlm: true },
    ] as const) {
      expect(hindsightPerfEnv(caps)).toContainEqual([
        "HINDSIGHT_API_CONSOLIDATION_MAX_MEMORIES_PER_ROUND",
        "250",
      ]);
    }
  });

  it("declares exactly the gated knobs this PR ships, by name", () => {
    // Same anti-vacuity discipline for the two gated groups: the GPU group
    // must be FP16 plus the CUDA rerank batch size and nothing else, and the
    // local-LLM group must be the three concurrency caps plus the two
    // local-endpoint LLM knobs and nothing else. Without this, quietly moving
    // a knob between groups (or dropping one) passes every other test here.
    expect(HINDSIGHT_PERF_DEFAULTS_GPU.map(([k]) => k)).toEqual([
      "HINDSIGHT_API_RERANKER_LOCAL_FP16",
      "HINDSIGHT_API_RERANKER_LOCAL_BATCH_SIZE",
    ]);
    expect(HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM.map(([k]) => k)).toEqual([
      "HINDSIGHT_API_LLM_MAX_CONCURRENT",
      "HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT",
      "HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT",
      "HINDSIGHT_API_LLM_STRICT_SCHEMA",
      "HINDSIGHT_API_LLM_MAX_RETRIES",
      "HINDSIGHT_API_LLM_SUPPORTS_MAX_ITEMS",
    ]);
  });

  it("withholds FP16 reranking from a host with no GPU", () => {
    // Upstream disables FP16 by default because "some CPUs lack native FP16
    // support". Emitting it CPU-side is the regression the gate exists for.
    const got = keys({ gpu: false, localLlm: true });
    for (const [k] of HINDSIGHT_PERF_DEFAULTS_GPU) expect(got).not.toContain(k);
  });

  it("emits FP16 reranking only when the container can reach a GPU", () => {
    const got = keys({ gpu: true, localLlm: false });
    for (const [k, v] of HINDSIGHT_PERF_DEFAULTS_GPU) {
      expect(got).toContain(k);
      expect(new Map(hindsightPerfEnv({ gpu: true, localLlm: false })).get(k)).toBe(v);
    }
  });

  it("withholds the LLM concurrency caps from a hosted endpoint", () => {
    // Upstream's 32 is sized for a cloud provider. Throttling one to 4 is a
    // pure throughput loss, so the absent-capability direction must be "leave
    // upstream's default alone".
    const got = keys({ gpu: true, localLlm: false });
    for (const [k] of HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM) expect(got).not.toContain(k);
  });

  it("emits the LLM concurrency caps only for a self-hosted endpoint", () => {
    const got = new Map(hindsightPerfEnv({ gpu: false, localLlm: true }));
    expect(got.get("HINDSIGHT_API_LLM_MAX_CONCURRENT")).toBe("4");
    expect(got.get("HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT")).toBe("1");
    // Derived from global 4 / retain 1, reserving one global permit for the
    // uncapped interactive lane: 4 - 1 - 1 = 2.
    expect(got.get("HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT")).toBe("2");
  });

  it("treats a non-boolean-true capability as NOT proven", () => {
    // Mirrors hindsightGpuEnabled's `=== true` discipline: a coerced verdict
    // (`"false"` is truthy) must not switch a group on.
    for (const bogus of ["false", "true", 1, "yes", {}]) {
      const caps = { gpu: bogus, localLlm: bogus } as unknown as {
        gpu: boolean;
        localLlm: boolean;
      };
      const got = keys(caps);
      for (const [k] of [...HINDSIGHT_PERF_DEFAULTS_GPU, ...HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM]) {
        expect(got, `capability ${JSON.stringify(bogus)} must not enable ${k}`).not.toContain(k);
      }
    }
  });

  it("never emits a managed key twice", () => {
    const pairs = hindsightPerfEnv({ gpu: true, localLlm: true });
    expect(new Set(pairs.map(([k]) => k)).size).toBe(pairs.length);
  });
});

// ── operator override ─────────────────────────────────────────────────────
describe("operator override wins", () => {
  it("replaces a default rather than appending after it", () => {
    const pairs = hindsightPerfEnv(
      { gpu: true, localLlm: true },
      new Map([["HINDSIGHT_API_LLM_MAX_CONCURRENT", "16"]]),
    );
    const hits = pairs.filter(([k]) => k === "HINDSIGHT_API_LLM_MAX_CONCURRENT");
    // Exactly one, so the winner never depends on docker's argv last-wins.
    expect(hits).toEqual([["HINDSIGHT_API_LLM_MAX_CONCURRENT", "16"]]);
  });

  it("still emits an override whose capability group is OFF", () => {
    // The nasty case: an operator forces FP16 on a box whose GPU verdict is
    // absent. Dropping it here would make "override" mean "override, unless".
    const pairs = hindsightPerfEnv(
      { gpu: false, localLlm: false },
      new Map([["HINDSIGHT_API_RERANKER_LOCAL_FP16", "true"]]),
    );
    expect(new Map(pairs).get("HINDSIGHT_API_RERANKER_LOCAL_FP16")).toBe("true");
  });

  it("prefers switchroom.yaml over the process environment", () => {
    const got = resolveHindsightPerfOverrides(
      { HINDSIGHT_API_LLM_MAX_CONCURRENT: 8 },
      { HINDSIGHT_API_LLM_MAX_CONCURRENT: "2" },
    );
    expect(got.get("HINDSIGHT_API_LLM_MAX_CONCURRENT")).toBe("8");
  });

  it("honours a bare process-environment export", () => {
    const got = resolveHindsightPerfOverrides(undefined, {
      HINDSIGHT_API_LINK_EXPANSION_TIMEOUT: "5",
    });
    expect(got.get("HINDSIGHT_API_LINK_EXPANSION_TIMEOUT")).toBe("5");
  });

  it("ignores unmanaged keys from BOTH sources", () => {
    // A blanket HINDSIGHT_API_* passthrough would let an operator's stale
    // export collide with the port / retain-budget vars startHindsight derives.
    const got = resolveHindsightPerfOverrides(
      { HINDSIGHT_API_PORT: "9999", NOT_HINDSIGHT: "x" },
      { HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS: "1" },
    );
    expect(got.size).toBe(0);
  });

  it("ignores an empty or whitespace-only value", () => {
    const got = resolveHindsightPerfOverrides(
      { HINDSIGHT_API_LLM_REASONING_EFFORT: "  " },
      { HINDSIGHT_API_LINK_EXPANSION_TIMEOUT: "" },
    );
    expect(got.size).toBe(0);
  });

  it("is overridable on exactly these forty-nine keys, by name", () => {
    // Spelled out, NOT derived from the three group arrays. HINDSIGHT_PERF_ENV_KEYS
    // is DEFINED as the union of those arrays, so asserting it equals that union
    // is a tautology — it passes no matter which keys are in the arrays. The
    // override surface is a documented contract (src/config/schema.ts's
    // `hindsight.env` description names these keys), so pin the literal list:
    // adding or dropping a managed key must fail here and force the doc update.
    expect([...HINDSIGHT_PERF_ENV_KEYS].sort()).toEqual([
      "HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT",
      "HINDSIGHT_API_CONSOLIDATION_LLM_PARALLELISM",
      "HINDSIGHT_API_CONSOLIDATION_MAX_MEMORIES_PER_ROUND",
      "HINDSIGHT_API_CONSOLIDATION_RECALL_MAX_CONCURRENT",
      "HINDSIGHT_API_GRAPH_SEED_MIN_SIMILARITY",
      "HINDSIGHT_API_LINK_EXPANSION_PER_ENTITY_LIMIT",
      "HINDSIGHT_API_LINK_EXPANSION_TIMEOUT",
      "HINDSIGHT_API_LLM_MAX_CONCURRENT",
      "HINDSIGHT_API_LLM_MAX_RETRIES",
      "HINDSIGHT_API_LLM_REASONING_EFFORT",
      "HINDSIGHT_API_LLM_STRICT_SCHEMA",
      "HINDSIGHT_API_LLM_SUPPORTS_MAX_ITEMS",
      "HINDSIGHT_API_LLM_TEMPERATURE_REFLECT",
      "HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE",
      "HINDSIGHT_API_RECALL_MAX_CANDIDATES_PER_SOURCE",
      "HINDSIGHT_API_RECALL_MAX_CONCURRENT",
      "HINDSIGHT_API_RECENCY_DECAY_FUNCTION",
      "HINDSIGHT_API_RECENCY_DECAY_HALFLIFE_DAYS",
      "HINDSIGHT_API_RECENCY_DECAY_LINEAR_WINDOW_DAYS",
      "HINDSIGHT_API_REFLECT_WALL_TIMEOUT",
      "HINDSIGHT_API_RERANKER_LOCAL_BATCH_SIZE",
      "HINDSIGHT_API_RERANKER_LOCAL_BUCKET_BATCHING",
      "HINDSIGHT_API_RERANKER_LOCAL_FP16",
      "HINDSIGHT_API_RERANKER_LOCAL_MAX_CONCURRENT",
      "HINDSIGHT_API_RERANKER_MAX_CANDIDATES",
      "HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT",
      "HINDSIGHT_API_RETAIN_WALL_TIMEOUT",
      "HINDSIGHT_API_SEMANTIC_MIN_SIMILARITY",
      "HINDSIGHT_API_TEMPORAL_LANGUAGES",
      "HINDSIGHT_API_TEMPORAL_MAX_QUERY_CHARS",
      "HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE",
      "HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY",
      // Both spellings of every per-type slot reservation are ACCEPTED as
      // input (see HINDSIGHT_WORKER_RESERVED_SLOT_ALIASES); only the
      // canonical ..._RESERVED_SLOTS name is ever emitted.
      "HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS",
      "HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS",
      "HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT",
      "HINDSIGHT_API_WORKER_FILE_CONVERT_RETAIN_MAX_SLOTS",
      "HINDSIGHT_API_WORKER_FILE_CONVERT_RETAIN_RESERVED_SLOTS",
      "HINDSIGHT_API_WORKER_GRAPH_MAINTENANCE_MAX_SLOTS",
      "HINDSIGHT_API_WORKER_GRAPH_MAINTENANCE_RESERVED_SLOTS",
      "HINDSIGHT_API_WORKER_IMPORT_DOCUMENTS_MAX_SLOTS",
      "HINDSIGHT_API_WORKER_IMPORT_DOCUMENTS_RESERVED_SLOTS",
      "HINDSIGHT_API_WORKER_MAX_SLOTS",
      "HINDSIGHT_API_WORKER_REFRESH_MENTAL_MODEL_MAX_SLOTS",
      "HINDSIGHT_API_WORKER_REFRESH_MENTAL_MODEL_RESERVED_SLOTS",
      "HINDSIGHT_API_WORKER_RETAIN_MAX_SLOTS",
      "HINDSIGHT_API_WORKER_RETAIN_RESERVED_SLOTS",
      // Not HINDSIGHT_API_* — switchroom-patch knobs (the CE-damping, MCP
      // recall-budget, and MM-refresh-debounce rollback hatches), read by the
      // patched modules, never by upstream's config parser. Sort last.
      "HINDSIGHT_CE_DECISIVE_RELATIVE_GAP",
      "HINDSIGHT_MCP_RECALL_BUDGET_MODE",
      "HINDSIGHT_MM_REFRESH_MIN_INTERVAL_S",
    ]);
  });

  it("accepts the override-only bank-priority key even though it has no default", () => {
    // Managed-but-defaultless: it is in HINDSIGHT_PERF_ENV_KEYS purely so an
    // operator has a DECLARATIVE channel for it. Without that it could only be
    // set imperatively on the container, which the next `switchroom apply`
    // silently drops — the exact regression class this file guards.
    const got = resolveHindsightPerfOverrides({
      HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY: "big-bank:3,busy-bank:2,*:1",
    });
    expect(got.get("HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY")).toBe(
      "big-bank:3,busy-bank:2,*:1",
    );
  });
});

// ── the override-only key ─────────────────────────────────────────────────
describe("HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY (override-only)", () => {
  const CAPS = [
    { gpu: false, localLlm: false },
    { gpu: true, localLlm: false },
    { gpu: false, localLlm: true },
    { gpu: true, localLlm: true },
  ];

  it("is in the managed set but in NO defaults group", () => {
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(
      "HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY",
    )).toBe(true);
    for (const group of [
      HINDSIGHT_PERF_DEFAULTS_UNGATED,
      HINDSIGHT_PERF_DEFAULTS_GPU,
      HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
    ]) {
      expect(group.map(([k]) => k)).not.toContain(
        "HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY",
      );
    }
    // …and every override-only key really is absent from every group, so the
    // "no shipped default" property can't be broken by adding one later.
    const defaulted = new Set(
      [
        ...HINDSIGHT_PERF_DEFAULTS_UNGATED,
        ...HINDSIGHT_PERF_DEFAULTS_GPU,
        ...HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
      ].map(([k]) => k),
    );
    for (const key of HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS) {
      expect(defaulted.has(key), `${key} must not have a shipped default`).toBe(false);
    }
  });

  it.each(CAPS)(
    "is NOT emitted on any host when unset (gpu=$gpu localLlm=$localLlm) — flat FIFO preserved",
    (caps) => {
      // Hard-coding one deployment's bank names into switchroom's shipped
      // defaults would push this install's agent names onto every operator.
      // Unset ⇒ upstream's flat `ORDER BY created_at`, i.e. no behaviour change.
      const keys = hindsightPerfEnv(caps).map(([k]) => k);
      expect(keys).not.toContain("HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY");
    },
  );

  it("reaches BOTH launch paths, with the operator's value, when set in hindsight.env", () => {
    const MAP = "big-bank:3,busy-bank:2,*:1";
    const perf = { env: { HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY: MAP }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
    );
    // Both paths, or the value dies on whichever recreate the operator uses.
    expect(fromRun.get("HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY")).toEqual([MAP]);
    expect(fromCompose.get("HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY")).toEqual([MAP]);
  });

  it("still reaches the container on a host with NO gated capability", () => {
    // The key belongs to no capability group, so a gate-shaped regression that
    // only emits grouped keys would silently drop it. Cloud endpoint + no GPU
    // is the harshest gating case.
    const MAP = "only-bank:2,*:1";
    const perf = { env: { HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY: MAP }, processEnv: {} };
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get("HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY")).toEqual([
      MAP,
    ]);
  });
});

describe("HINDSIGHT_API_WORKER_MAX_SLOTS (override-only)", () => {
  const KEY = "HINDSIGHT_API_WORKER_MAX_SLOTS";
  const CAPS = [
    { gpu: false, localLlm: false },
    { gpu: true, localLlm: false },
    { gpu: false, localLlm: true },
    { gpu: true, localLlm: true },
  ];

  it("is in the managed set but in NO defaults group", () => {
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(KEY)).toBe(true);
    for (const group of [
      HINDSIGHT_PERF_DEFAULTS_UNGATED,
      HINDSIGHT_PERF_DEFAULTS_GPU,
      HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
    ]) {
      expect(group.map(([k]) => k)).not.toContain(KEY);
    }
  });

  it.each(CAPS)(
    "is NOT emitted when unset (gpu=$gpu localLlm=$localLlm) — upstream's own default stands",
    (caps) => {
      expect(hindsightPerfEnv(caps).map(([k]) => k)).not.toContain(KEY);
    },
  );

  it("reaches BOTH launch paths, with the operator's value, when set in hindsight.env", () => {
    // The regression: this exact line sat in switchroom.yaml while the
    // container booted `max_slots=10`, because the key was outside
    // HINDSIGHT_PERF_ENV_KEYS and resolveHindsightPerfOverrides skipped it.
    // Asserting only membership in the key set would not catch a gate-shaped
    // regression on the emit side, so assert the launch argv itself.
    const perf = { env: { [KEY]: "16" }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
    );
    expect(fromRun.get(KEY)).toEqual(["16"]);
    expect(fromCompose.get(KEY)).toEqual(["16"]);
  });

  it("still reaches the container on a host with NO gated capability", () => {
    const perf = { env: { [KEY]: "16" }, processEnv: {} };
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual(["16"]);
  });

  it("carries the slot policy's other two terms alongside it", () => {
    // The point of managing this key at all: the reservation and the ceiling
    // were already reachable, so an operator could set two of the three terms
    // of one slot policy and silently lose the third. All three, or none.
    const perf = {
      env: {
        [KEY]: "16",
        HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS: "5",
        HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT: "6",
      },
      processEnv: {},
    };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    const fromRun = runEnv(runArgs());
    expect(fromRun.get(KEY)).toEqual(["16"]);
    expect(fromRun.get("HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS")).toEqual(["5"]);
    expect(fromRun.get("HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT")).toEqual(["6"]);
  });
});

describe("HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE (override-only)", () => {
  // The durable stopword config's env key. Override-only ON PURPOSE: switchroom
  // emits NO default, so a stock fleet keeps upstream's always-safe `english`
  // (guaranteed to exist on any Postgres) and never depends on the entrypoint's
  // new provisioning path. An operator opts into the junk-stopping index by
  // setting `hindsight_english` explicitly, and that value must then survive
  // `switchroom apply` — the exact drop-on-apply regression this file guards.
  const KEY = "HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE";
  const VALUE = "hindsight_english";
  const CAPS = [
    { gpu: false, localLlm: false },
    { gpu: true, localLlm: false },
    { gpu: false, localLlm: true },
    { gpu: true, localLlm: true },
  ];

  it("is in the managed set but in NO defaults group (no emitted default)", () => {
    expect(HINDSIGHT_PERF_ENV_KEYS.has(KEY)).toBe(true);
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(KEY)).toBe(true);
    for (const group of [
      HINDSIGHT_PERF_DEFAULTS_UNGATED,
      HINDSIGHT_PERF_DEFAULTS_GPU,
      HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
    ]) {
      expect(group.map(([k]) => k)).not.toContain(KEY);
    }
  });

  it.each(CAPS)(
    "is NOT emitted when unset (gpu=$gpu localLlm=$localLlm) — upstream's `english` stands",
    (caps) => {
      // Unset ⇒ no env emitted ⇒ the image's baked `english`. Critically, this
      // is what keeps a fresh fleet OFF the provisioning path: without the key
      // the backfill migration builds search_vector with the guaranteed-present
      // `english` regconfig, so it can never 42704 on an empty volume.
      expect(hindsightPerfEnv(caps).map(([k]) => k)).not.toContain(KEY);
    },
  );

  it("reaches BOTH launch paths, with the operator's value, when set in hindsight.env", () => {
    const perf = { env: { [KEY]: VALUE }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
    );
    // Both paths, or the value dies on whichever recreate the operator uses —
    // exactly the live-vs-durable gap this whole change closes.
    expect(fromRun.get(KEY)).toEqual([VALUE]);
    expect(fromCompose.get(KEY)).toEqual([VALUE]);
  });

  it("still reaches the container on a host with NO gated capability", () => {
    const perf = { env: { [KEY]: VALUE }, processEnv: {} };
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual([VALUE]);
  });
});

describe("HINDSIGHT_API_WORKER_RETAIN_RESERVED_SLOTS (override-only)", () => {
  const KEY = "HINDSIGHT_API_WORKER_RETAIN_RESERVED_SLOTS";
  const CAPS = [
    { gpu: false, localLlm: false },
    { gpu: true, localLlm: false },
    { gpu: false, localLlm: true },
    { gpu: true, localLlm: true },
  ];

  it("is in the managed set but in NO defaults group", () => {
    expect(HINDSIGHT_PERF_ENV_KEYS.has(KEY)).toBe(true);
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(KEY)).toBe(true);
    for (const group of [
      HINDSIGHT_PERF_DEFAULTS_UNGATED,
      HINDSIGHT_PERF_DEFAULTS_GPU,
      HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
    ]) {
      expect(group.map(([k]) => k)).not.toContain(KEY);
    }
  });

  it("survives resolveHindsightPerfOverrides from BOTH sources", () => {
    expect(resolveHindsightPerfOverrides({ [KEY]: "2" }).get(KEY)).toBe("2");
    expect(resolveHindsightPerfOverrides(undefined, { [KEY]: "2" }).get(KEY)).toBe("2");
  });

  it.each(CAPS)(
    "is NOT emitted when unset (gpu=$gpu localLlm=$localLlm) — upstream's own 0 stands",
    (caps) => {
      // No floor is upstream's default and switchroom ships no opinion on the
      // slot budget a floor would be carved from. Emitting anything here would
      // move every install off `retain: 0` for no measured reason.
      expect(hindsightPerfEnv(caps).map(([k]) => k)).not.toContain(KEY);
    },
  );

  it("reaches BOTH launch paths, with the operator's value, when set in hindsight.env", () => {
    // The outcome that matters. Without the key in the managed set both of
    // these are undefined — `resolveHindsightPerfOverrides` drops an unmanaged
    // key silently, so the operator's line reads as durable config in yaml and
    // never reaches the container. Membership alone would not catch a
    // gate-shaped regression on the emit side, so assert the launch argv.
    const perf = { env: { [KEY]: "2" }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
    );
    expect(fromRun.get(KEY)).toEqual(["2"]);
    expect(fromCompose.get(KEY)).toEqual(["2"]);
  });

  it("still reaches the container on a host with NO gated capability", () => {
    // It belongs to no capability group, so a gate-shaped regression that only
    // emits grouped keys would drop it. Cloud endpoint + no GPU is the harshest
    // gating case.
    const perf = { env: { [KEY]: "2" }, processEnv: {} };
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual(["2"]);
  });

  it("carries the whole slot policy — total, both reservations, and the ceiling", () => {
    // The retain floor is only meaningful against the total it is carved from
    // and the consolidation terms it competes with. All four reach the
    // container together, or an operator sets a coherent policy and loses part
    // of it silently. Upstream validates the combination at boot; it can only
    // do that for the terms it is actually handed.
    const perf = {
      env: {
        [KEY]: "2",
        HINDSIGHT_API_WORKER_MAX_SLOTS: "16",
        HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS: "5",
        HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT: "6",
      },
      processEnv: {},
    };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    const fromRun = runEnv(runArgs());
    expect(fromRun.get(KEY)).toEqual(["2"]);
    expect(fromRun.get("HINDSIGHT_API_WORKER_MAX_SLOTS")).toEqual(["16"]);
    expect(fromRun.get("HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS")).toEqual(["5"]);
    expect(fromRun.get("HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT")).toEqual(["6"]);
  });
});

describe("HINDSIGHT_API_SEMANTIC_MIN_SIMILARITY (override-only)", () => {
  const KEY = "HINDSIGHT_API_SEMANTIC_MIN_SIMILARITY";
  const CAPS = [
    { gpu: false, localLlm: false },
    { gpu: true, localLlm: false },
    { gpu: false, localLlm: true },
    { gpu: true, localLlm: true },
  ];

  it("is in the managed set but in NO defaults group", () => {
    expect(HINDSIGHT_PERF_ENV_KEYS.has(KEY)).toBe(true);
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(KEY)).toBe(true);
    for (const group of [
      HINDSIGHT_PERF_DEFAULTS_UNGATED,
      HINDSIGHT_PERF_DEFAULTS_GPU,
      HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
    ]) {
      expect(group.map(([k]) => k)).not.toContain(KEY);
    }
  });

  it("survives resolveHindsightPerfOverrides from BOTH sources", () => {
    expect(resolveHindsightPerfOverrides({ [KEY]: "0.2" }).get(KEY)).toBe("0.2");
    expect(resolveHindsightPerfOverrides(undefined, { [KEY]: "0.2" }).get(KEY)).toBe("0.2");
  });

  it.each(CAPS)(
    "is NOT emitted when unset (gpu=$gpu localLlm=$localLlm) — upstream's own 0.3 stands",
    (caps) => {
      // Override-only means REACHABLE, not changed: a host that sets nothing
      // keeps upstream's 0.3 floor byte-for-byte. Emitting a value here would
      // change retrieval behaviour on every install to fix a symptom measured
      // on one.
      expect(hindsightPerfEnv(caps).map(([k]) => k)).not.toContain(KEY);
    },
  );

  it("reaches BOTH launch paths, with the operator's value, when set in hindsight.env", () => {
    // The outcome that matters. Before this key entered the managed set, both
    // of these were undefined: resolveHindsightPerfOverrides drops an
    // unmanaged key silently, so the operator's line read as durable config in
    // yaml and never reached the container — the floor stayed at 0.3 and the
    // phrasing-sensitive semantic recall misses it causes stayed unfixable.
    const perf = { env: { [KEY]: "0.2" }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
    );
    expect(fromRun.get(KEY)).toEqual(["0.2"]);
    expect(fromCompose.get(KEY)).toEqual(["0.2"]);
  });

  it("still reaches the container on a host with NO gated capability", () => {
    // It belongs to no capability group, so a gate-shaped regression that only
    // emits grouped keys would drop it. Cloud endpoint + no GPU is the
    // harshest gating case.
    const perf = { env: { [KEY]: "0.25" }, processEnv: {} };
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual(["0.25"]);
  });
});

describe("HINDSIGHT_API_CONSOLIDATION_RECALL_MAX_CONCURRENT (override-only)", () => {
  const KEY = "HINDSIGHT_API_CONSOLIDATION_RECALL_MAX_CONCURRENT";
  const CAPS = [
    { gpu: false, localLlm: false },
    { gpu: true, localLlm: false },
    { gpu: false, localLlm: true },
    { gpu: true, localLlm: true },
  ];

  it("is in the managed set but in NO defaults group", () => {
    expect(HINDSIGHT_PERF_ENV_KEYS.has(KEY)).toBe(true);
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(KEY)).toBe(true);
    for (const group of [
      HINDSIGHT_PERF_DEFAULTS_UNGATED,
      HINDSIGHT_PERF_DEFAULTS_GPU,
      HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
    ]) {
      expect(group.map(([k]) => k)).not.toContain(KEY);
    }
  });

  it("survives resolveHindsightPerfOverrides from BOTH sources", () => {
    expect(resolveHindsightPerfOverrides({ [KEY]: "1" }).get(KEY)).toBe("1");
    expect(resolveHindsightPerfOverrides(undefined, { [KEY]: "1" }).get(KEY)).toBe("1");
  });

  it.each(CAPS)(
    "is NOT emitted when unset (gpu=$gpu localLlm=$localLlm) — the image's derived default stands",
    (caps) => {
      // Override-only means REACHABLE, not changed: a host that sets nothing
      // keeps the image's derived default (min(2, recall_max_concurrent - 1),
      // config.py _consolidation_recall_max_concurrent) byte-for-byte. Emitting
      // a value here would pin every install to a number measured on one, and
      // an explicit value forfeits the derivation's boot-safety clamp.
      expect(hindsightPerfEnv(caps).map(([k]) => k)).not.toContain(KEY);
    },
  );

  it("reaches BOTH launch paths, with the operator's value, when set in hindsight.env", () => {
    // The outcome that matters. Before this key entered the managed set,
    // resolveHindsightPerfOverrides dropped it silently: the operator's
    // hindsight.env line read as durable config in yaml yet never reached the
    // container, so the background-recall reservation stayed at the image
    // default and the standing consolidation load under foreground recall
    // could not be throttled from declarative config at all.
    const perf = { env: { [KEY]: "1" }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
    );
    expect(fromRun.get(KEY)).toEqual(["1"]);
    expect(fromCompose.get(KEY)).toEqual(["1"]);
  });

  it("still reaches the container on a host with NO gated capability", () => {
    // It belongs to no capability group, so a gate-shaped regression that only
    // emits grouped keys would drop it. Cloud endpoint + no GPU is the
    // harshest gating case.
    const perf = { env: { [KEY]: "1" }, processEnv: {} };
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual(["1"]);
  });
});

// ── the temporal-language pin ─────────────────────────────────────────────
describe("HINDSIGHT_API_TEMPORAL_LANGUAGES (override-only, i18n restore hatch)", () => {
  const KEY = "HINDSIGHT_API_TEMPORAL_LANGUAGES";
  const CAPS = [
    { gpu: false, localLlm: false },
    { gpu: true, localLlm: false },
    { gpu: false, localLlm: true },
    { gpu: true, localLlm: true },
  ];

  it("is in the managed set but in NO defaults group", () => {
    // switchroom's temporal-language image patch pins dateparser to this list
    // (default "en", baked in config.py) to end the 200+-locale auto-detection
    // pass that blocked the shared asyncio loop. Managed so an operator's
    // hindsight.env line restoring i18n is not silently dropped by
    // resolveHindsightPerfOverrides; override-only because the default lives in
    // the image, so emitting one here would only create a second copy to drift.
    expect(HINDSIGHT_PERF_ENV_KEYS.has(KEY)).toBe(true);
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(KEY)).toBe(true);
    for (const group of [
      HINDSIGHT_PERF_DEFAULTS_UNGATED,
      HINDSIGHT_PERF_DEFAULTS_GPU,
      HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
    ]) {
      expect(group.map(([k]) => k)).not.toContain(KEY);
    }
  });

  it("survives resolveHindsightPerfOverrides from BOTH sources", () => {
    expect(resolveHindsightPerfOverrides({ [KEY]: "en,es" }).get(KEY)).toBe("en,es");
    expect(resolveHindsightPerfOverrides(undefined, { [KEY]: "en,es" }).get(KEY)).toBe("en,es");
  });

  it.each(CAPS)(
    "is NOT emitted when unset (gpu=$gpu localLlm=$localLlm) — the image's baked English default stands",
    (caps) => {
      // Override-only means REACHABLE, not changed: a host that sets nothing
      // keeps the image's baked default "en". Emitting a value here would pin
      // every install to switchroom's copy of that opinion.
      expect(hindsightPerfEnv(caps).map(([k]) => k)).not.toContain(KEY);
    },
  );

  it("reaches BOTH launch paths, with the operator's value, when set in hindsight.env", () => {
    // The outcome that matters: an operator re-enabling i18n from declarative
    // yaml must actually reach the container. Before the key entered the managed
    // set, the line read as durable config yet was dropped and the pin stayed
    // English-only regardless.
    const perf = { env: { [KEY]: "en,es" }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
    );
    expect(fromRun.get(KEY)).toEqual(["en,es"]);
    expect(fromCompose.get(KEY)).toEqual(["en,es"]);
  });

  it("still reaches the container on a host with NO gated capability", () => {
    // It belongs to no capability group, so a gate-shaped regression that only
    // emits grouped keys would drop it. Cloud endpoint + no GPU is the harshest
    // gating case.
    const perf = { env: { [KEY]: "en,es" }, processEnv: {} };
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual(["en,es"]);
  });
});

describe("HINDSIGHT_API_TEMPORAL_MAX_QUERY_CHARS (override-only, temporal-offload input cap)", () => {
  const KEY = "HINDSIGHT_API_TEMPORAL_MAX_QUERY_CHARS";
  const CAPS = [
    { gpu: false, localLlm: false },
    { gpu: true, localLlm: false },
    { gpu: false, localLlm: true },
    { gpu: true, localLlm: true },
  ];
  /** The documented full back-out value: unbounded full scan (upstream shape). */
  const OFF = "0";

  it("is in the managed set but in NO defaults group", () => {
    // switchroom's temporal-offload image patch caps the query fed to
    // dateparser.search_dates (default 2000, baked in config.py) to bound the
    // per-call cost that blocked the shared asyncio loop on multi-KB
    // consolidation queries. Managed so an operator's hindsight.env line is not
    // silently dropped; override-only because the default lives in the image.
    expect(HINDSIGHT_PERF_ENV_KEYS.has(KEY)).toBe(true);
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(KEY)).toBe(true);
    for (const group of [
      HINDSIGHT_PERF_DEFAULTS_UNGATED,
      HINDSIGHT_PERF_DEFAULTS_GPU,
      HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
    ]) {
      expect(group.map(([k]) => k)).not.toContain(KEY);
    }
  });

  it("survives resolveHindsightPerfOverrides from BOTH sources", () => {
    expect(resolveHindsightPerfOverrides({ [KEY]: OFF }).get(KEY)).toBe(OFF);
    expect(resolveHindsightPerfOverrides(undefined, { [KEY]: OFF }).get(KEY)).toBe(OFF);
  });

  it.each(CAPS)(
    "is NOT emitted when unset (gpu=$gpu localLlm=$localLlm) — the image's baked 2000 stands",
    (caps) => {
      // Override-only means REACHABLE, not changed: a host that sets nothing
      // keeps the image's baked default 2000. Emitting a value here would pin
      // every install to switchroom's copy of that opinion.
      expect(hindsightPerfEnv(caps).map(([k]) => k)).not.toContain(KEY);
    },
  );

  it("reaches BOTH launch paths, with the operator's value, when set in hindsight.env", () => {
    // The outcome that matters: an operator restoring an unbounded scan from
    // declarative yaml must actually reach the container.
    const perf = { env: { [KEY]: OFF }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
    );
    expect(fromRun.get(KEY)).toEqual([OFF]);
    expect(fromCompose.get(KEY)).toEqual([OFF]);
  });

  it("still reaches the container on a host with NO gated capability", () => {
    // It belongs to no capability group, so a gate-shaped regression that only
    // emits grouped keys would drop it. Cloud endpoint + no GPU is the harshest
    // gating case.
    const perf = { env: { [KEY]: "4000" }, processEnv: {} };
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual(["4000"]);
  });
});

// ── the CE-damping rollback hatch ─────────────────────────────────────────
describe("HINDSIGHT_CE_DECISIVE_RELATIVE_GAP (override-only, patch rollback hatch)", () => {
  const KEY = "HINDSIGHT_CE_DECISIVE_RELATIVE_GAP";
  const CAPS = [
    { gpu: false, localLlm: false },
    { gpu: true, localLlm: false },
    { gpu: false, localLlm: true },
    { gpu: true, localLlm: true },
  ];
  /** ≥ ~0.65 clamps the damping exponent to 1.0 — the full back-out value. */
  const OFF = "1.0";

  it("is managed, so a hindsight.env line for it is not silently discarded", () => {
    // The bug: switchroom's CE-saturation damping patch documents this var as
    // its rollback knob, but the key was absent from HINDSIGHT_PERF_ENV_KEYS
    // and resolveHindsightPerfOverrides drops unmanaged keys without a word.
    // The patch reads the var ONCE at import, so an unreached value has no
    // runtime fallback: the documented escape hatch simply did not exist.
    expect(HINDSIGHT_PERF_ENV_KEYS.has(KEY)).toBe(true);
    // Override-only, not defaulted: shipping a value would replace the patch's
    // own derived gap with a hard-coded one on every host.
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(KEY)).toBe(true);
  });

  it("survives resolveHindsightPerfOverrides from BOTH sources", () => {
    expect(resolveHindsightPerfOverrides({ [KEY]: OFF }).get(KEY)).toBe(OFF);
    expect(resolveHindsightPerfOverrides(undefined, { [KEY]: OFF }).get(KEY)).toBe(OFF);
  });

  it.each(CAPS)(
    "is NOT emitted on any host when unset (gpu=$gpu localLlm=$localLlm)",
    (caps) => {
      // Unset ⇒ the patch's shipped derived gap. Emitting anything here would
      // turn a rollback hatch into a permanent calibration override.
      expect(hindsightPerfEnv(caps).map(([k]) => k)).not.toContain(KEY);
    },
  );

  it("reaches the docker-run argv AND the compose snippet with the operator's value", () => {
    // The outcome that matters: the value an operator writes in
    // switchroom.yaml is actually in the argv that launches the container.
    // Without the key in the managed set both of these are undefined.
    const perf = { env: { [KEY]: OFF }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual([OFF]);
    expect(
      composeEnv(
        generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
      ).get(KEY),
    ).toEqual([OFF]);
  });

  it("still reaches the container on a host with NO gated capability", () => {
    // Cloud endpoint + no GPU: the harshest gating case. A rollback hatch that
    // works only on GPU boxes is not a rollback hatch.
    const perf = { env: { [KEY]: "0.7" }, processEnv: {} };
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual(["0.7"]);
  });
});

// ── the MCP recall-budget rollback hatch ──────────────────────────────────
describe("HINDSIGHT_MCP_RECALL_BUDGET_MODE (override-only, patch rollback hatch)", () => {
  const KEY = "HINDSIGHT_MCP_RECALL_BUDGET_MODE";
  const CAPS = [
    { gpu: false, localLlm: false },
    { gpu: true, localLlm: false },
    { gpu: false, localLlm: true },
    { gpu: true, localLlm: true },
  ];
  /** The documented full back-out value: upstream's exact pre-patch returns. */
  const OFF = "legacy";

  it("is managed, so a hindsight.env line for it is not silently discarded", () => {
    // The bug: docker/Dockerfile.hindsight's mcp-recall-token-budget patch
    // documents this var as its restart-level rollback, but the key was absent
    // from HINDSIGHT_PERF_ENV_KEYS and resolveHindsightPerfOverrides drops
    // unmanaged keys without a word — the documented escape hatch simply did
    // not exist.
    expect(HINDSIGHT_PERF_ENV_KEYS.has(KEY)).toBe(true);
    // Override-only, not defaulted: unset ⇒ the honest-envelope mode the
    // patch ships; emitting a mode would hard-code it on every host.
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(KEY)).toBe(true);
    for (const group of [
      HINDSIGHT_PERF_DEFAULTS_UNGATED,
      HINDSIGHT_PERF_DEFAULTS_GPU,
      HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
    ]) {
      expect(group.map(([k]) => k)).not.toContain(KEY);
    }
  });

  it("survives resolveHindsightPerfOverrides from BOTH sources", () => {
    expect(resolveHindsightPerfOverrides({ [KEY]: OFF }).get(KEY)).toBe(OFF);
    expect(resolveHindsightPerfOverrides(undefined, { [KEY]: OFF }).get(KEY)).toBe(OFF);
  });

  it.each(CAPS)(
    "is NOT emitted on any host when unset (gpu=$gpu localLlm=$localLlm)",
    (caps) => {
      // Unset ⇒ the patch's honest-envelope mode. A host that sets nothing
      // must keep exactly the shipped behaviour.
      expect(hindsightPerfEnv(caps).map(([k]) => k)).not.toContain(KEY);
    },
  );

  it("reaches the docker-run argv AND the compose snippet with the operator's value", () => {
    // The outcome that matters: the value an operator writes in
    // switchroom.yaml is actually in the argv that launches the container.
    // Without the key in the managed set both of these are undefined.
    const perf = { env: { [KEY]: OFF }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual([OFF]);
    expect(
      composeEnv(
        generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
      ).get(KEY),
    ).toEqual([OFF]);
  });

  it("still reaches the container on a host with NO gated capability", () => {
    // Cloud endpoint + no GPU: the harshest gating case. A rollback hatch that
    // works only on GPU boxes is not a rollback hatch.
    const perf = { env: { [KEY]: OFF }, processEnv: {} };
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual([OFF]);
  });
});

// ── the MM-refresh-debounce rollback hatch ────────────────────────────────
describe("HINDSIGHT_MM_REFRESH_MIN_INTERVAL_S (override-only, patch rollback hatch)", () => {
  const KEY = "HINDSIGHT_MM_REFRESH_MIN_INTERVAL_S";
  const CAPS = [
    { gpu: false, localLlm: false },
    { gpu: true, localLlm: false },
    { gpu: false, localLlm: true },
    { gpu: true, localLlm: true },
  ];
  /** The documented full back-out value: upstream's refresh-every-round. */
  const OFF = "0";

  it("is managed, so a hindsight.env line for it is not silently discarded", () => {
    // docker/Dockerfile.hindsight's MM-refresh-debounce patch documents this
    // var as its restart-level rollback (0 = upstream behaviour), and the
    // patch reads it ONCE at import — an unreached value has no runtime
    // fallback, so absence from HINDSIGHT_PERF_ENV_KEYS would make the
    // documented escape hatch not exist (the CE-gap defect, re-run).
    expect(HINDSIGHT_PERF_ENV_KEYS.has(KEY)).toBe(true);
    // Override-only, not defaulted: the 3600s floor is baked into the image
    // where the patch lives; emitting it here too would be a second copy of
    // the same opinion to drift.
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(KEY)).toBe(true);
    for (const group of [
      HINDSIGHT_PERF_DEFAULTS_UNGATED,
      HINDSIGHT_PERF_DEFAULTS_GPU,
      HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
    ]) {
      expect(group.map(([k]) => k)).not.toContain(KEY);
    }
  });

  it("survives resolveHindsightPerfOverrides from BOTH sources", () => {
    expect(resolveHindsightPerfOverrides({ [KEY]: OFF }).get(KEY)).toBe(OFF);
    expect(resolveHindsightPerfOverrides(undefined, { [KEY]: OFF }).get(KEY)).toBe(OFF);
  });

  it.each(CAPS)(
    "is NOT emitted on any host when unset (gpu=$gpu localLlm=$localLlm)",
    (caps) => {
      // Unset ⇒ the image's baked 3600s floor. A host that sets nothing must
      // keep exactly the shipped behaviour.
      expect(hindsightPerfEnv(caps).map(([k]) => k)).not.toContain(KEY);
    },
  );

  it("reaches the docker-run argv AND the compose snippet with the operator's value", () => {
    // The outcome that matters: the value an operator writes in
    // switchroom.yaml is actually in the argv that launches the container.
    // Without the key in the managed set both of these are undefined.
    const perf = { env: { [KEY]: OFF }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual([OFF]);
    expect(
      composeEnv(
        generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
      ).get(KEY),
    ).toEqual([OFF]);
  });

  it("still reaches the container on a host with NO gated capability", () => {
    // Cloud endpoint + no GPU: the harshest gating case. A rollback hatch that
    // works only on GPU boxes is not a rollback hatch.
    const perf = { env: { [KEY]: "7200" }, processEnv: {} };
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual(["7200"]);
  });
});

// ── the reflect-temperature rollback/tuning knob ──────────────────────────
describe("HINDSIGHT_API_LLM_TEMPERATURE_REFLECT (override-only, patch rollback hatch)", () => {
  const KEY = "HINDSIGHT_API_LLM_TEMPERATURE_REFLECT";
  const CAPS = [
    { gpu: false, localLlm: false },
    { gpu: true, localLlm: false },
    { gpu: false, localLlm: true },
    { gpu: true, localLlm: true },
  ];
  /**
   * The documented full back-out value: upstream's own `none` sentinel omits
   * the temperature kwarg entirely — the provider default, i.e. upstream's
   * accidental pre-patch behaviour.
   */
  const OFF = "none";

  it("is managed, so a hindsight.env line for it is not silently discarded", () => {
    // The bug: docker/Dockerfile.hindsight's reflect-temperature patch
    // documents this var (upstream's own per-op key, parsed by upstream's
    // _resolve_operation_temperature) as its rollback, but the key was absent
    // from HINDSIGHT_PERF_ENV_KEYS and resolveHindsightPerfOverrides drops
    // unmanaged keys without a word.
    expect(HINDSIGHT_PERF_ENV_KEYS.has(KEY)).toBe(true);
    // Override-only, not defaulted: the 0.1 default is baked into the image
    // where the patch lives; emitting it here too would create a second copy
    // of the same opinion to drift.
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(KEY)).toBe(true);
    for (const group of [
      HINDSIGHT_PERF_DEFAULTS_UNGATED,
      HINDSIGHT_PERF_DEFAULTS_GPU,
      HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
    ]) {
      expect(group.map(([k]) => k)).not.toContain(KEY);
    }
  });

  it("survives resolveHindsightPerfOverrides from BOTH sources", () => {
    expect(resolveHindsightPerfOverrides({ [KEY]: OFF }).get(KEY)).toBe(OFF);
    expect(resolveHindsightPerfOverrides(undefined, { [KEY]: "0.3" }).get(KEY)).toBe("0.3");
  });

  it.each(CAPS)(
    "is NOT emitted on any host when unset (gpu=$gpu localLlm=$localLlm)",
    (caps) => {
      // Unset ⇒ the image's baked 0.1. A host that sets nothing must keep
      // exactly the shipped behaviour.
      expect(hindsightPerfEnv(caps).map(([k]) => k)).not.toContain(KEY);
    },
  );

  it("reaches the docker-run argv AND the compose snippet with the operator's value", () => {
    const perf = { env: { [KEY]: OFF }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual([OFF]);
    expect(
      composeEnv(
        generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
      ).get(KEY),
    ).toEqual([OFF]);
  });

  it("still reaches the container on a host with NO gated capability", () => {
    const perf = { env: { [KEY]: "0.3" }, processEnv: {} };
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual(["0.3"]);
  });
});

// ── the consolidation LLM concurrency ceiling ─────────────────────────────
describe("HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT (derived, was a literal 1)", () => {
  const KEY = "HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT";
  const GLOBAL = "HINDSIGHT_API_LLM_MAX_CONCURRENT";
  const RETAIN = "HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT";
  const LOCAL = { gpu: false, localLlm: true };

  it("no longer pins a fresh install to a single in-flight consolidation call", () => {
    // The regression this guards is the measured one: at 1 the process makes at
    // most ONE consolidation LLM call at a time regardless of worker slots, so
    // the backlog can only grow. Assert the OUTCOME (the emitted ceiling), and
    // assert it is strictly greater than the old hard throttle.
    const emitted = Number(new Map(hindsightPerfEnv(LOCAL)).get(KEY));
    expect(emitted).toBe(2);
    expect(emitted).toBeGreaterThan(1);
  });

  it("widens when the operator raises the global cap, without a second yaml line", () => {
    // The trap the old literal created: an operator measures their slot pool,
    // raises the global cap, and gets ZERO extra consolidation throughput.
    const wide = new Map(hindsightPerfEnv(LOCAL, new Map([[GLOBAL, "10"]])));
    // global 10, retain default 1 => 10 - 1 - 1 = 8.
    expect(wide.get(KEY)).toBe("8");
    expect(Number(wide.get(KEY))).toBeGreaterThan(
      Number(new Map(hindsightPerfEnv(LOCAL)).get(KEY)),
    );
  });

  it("yields to a raised retain cap so both lanes cannot oversubscribe the pool", () => {
    // The live fleet's shape: global 10, retain 6. The derived consolidation cap
    // must leave retain's reservation AND one interactive permit intact.
    const got = new Map(
      hindsightPerfEnv(
        LOCAL,
        new Map([
          [GLOBAL, "10"],
          [RETAIN, "6"],
        ]),
      ),
    );
    expect(got.get(KEY)).toBe("3");
    expect(Number(got.get(KEY)) + 6).toBeLessThan(10);
  });

  it("NEVER derives a default above the global cap, across the whole matrix", () => {
    // The load-bearing invariant. The engine composes the two semaphores
    // (llm_wrapper._semaphores_for_scope: per-op acquired first, THEN global),
    // so a consolidation cap at or above the global cap is inert and
    // advertises a ceiling the engine cannot honour — and leaves the uncapped
    // reflect/recall lane with no guaranteed permit at all.
    for (const global of [1, 2, 3, 4, 6, 8, 10, 16, 32]) {
      for (const retain of [0, 1, 2, 6, 9, 32]) {
        const got = new Map(
          hindsightPerfEnv(
            LOCAL,
            new Map([
              [GLOBAL, String(global)],
              [RETAIN, String(retain)],
            ]),
          ),
        );
        const cap = Number(got.get(KEY));
        const emittedGlobal = Number(got.get(GLOBAL));
        expect(cap, `global=${global} retain=${retain}`).toBeLessThanOrEqual(emittedGlobal);
        // Positive: the engine raises ValueError on a per-op cap <= 0
        // ("must be a positive integer"), which would refuse to boot.
        expect(cap, `global=${global} retain=${retain}`).toBeGreaterThanOrEqual(1);
        // Headroom: only a global cap of 1 can leave the interactive lane
        // sharing consolidation's single permit.
        if (emittedGlobal > 1) {
          expect(cap, `global=${global} retain=${retain}`).toBeLessThan(emittedGlobal);
        }
      }
    }
  });

  it("falls back to the shipped caps rather than deriving from junk", () => {
    for (const junk of ["", "banana", "0", "-4", "3.9.1"]) {
      const got = new Map(hindsightPerfEnv(LOCAL, new Map([[GLOBAL, junk]])));
      expect(Number(got.get(KEY)), `global=${JSON.stringify(junk)}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("an explicit operator value survives and is NOT clamped by the derivation", () => {
    // Overridability is the hard requirement: these are defaults. An operator
    // who has measured their endpoint may deliberately exceed our headroom
    // reserve, and we must not quietly rewrite their number.
    const got = new Map(
      hindsightPerfEnv(
        LOCAL,
        new Map([
          [GLOBAL, "10"],
          [KEY, "9"],
        ]),
      ),
    );
    expect(got.get(KEY)).toBe("9");
  });

  it("the operator's value REPLACES the default on BOTH launch paths", () => {
    const perf = { env: { [KEY]: "5" }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    // Exactly one value per path — a duplicate emission would be last-wins by
    // luck on docker-run and ambiguous in compose.
    expect(runEnv(runArgs()).get(KEY)).toEqual(["5"]);
    expect(
      composeEnv(
        generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
      ).get(KEY),
    ).toEqual(["5"]);
  });

  it("emits the derived default exactly once per path when NOT overridden", () => {
    const perf = { env: {}, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual(["2"]);
    expect(
      composeEnv(
        generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
      ).get(KEY),
    ).toEqual(["2"]);
  });

  it("stays absent on a cloud endpoint — it is a local-slot-pool knob", () => {
    expect(new Map(hindsightPerfEnv({ gpu: true, localLlm: false })).has(KEY)).toBe(false);
  });
});

// ── tag-group parallelism, moved into the managed set ─────────────────────
describe("HINDSIGHT_API_CONSOLIDATION_LLM_PARALLELISM (managed, was hard-coded)", () => {
  const KEY = "HINDSIGHT_API_CONSOLIDATION_LLM_PARALLELISM";
  const CAPS = [
    { gpu: false, localLlm: false },
    { gpu: true, localLlm: false },
    { gpu: false, localLlm: true },
    { gpu: true, localLlm: true },
  ];

  it("is in the managed set, so a hindsight.env line is not silently dropped", () => {
    // The bug this fixes: the key was emitted unconditionally from a bare
    // constant in hindsight.ts and was NOT in HINDSIGHT_PERF_ENV_KEYS, so an
    // operator's yaml line was discarded without a word — it read as durable
    // config while doing nothing.
    expect(HINDSIGHT_PERF_ENV_KEYS.has(KEY)).toBe(true);
    // Defaulted, not override-only: the previous emission was unconditional,
    // so dropping the default would be a silent behaviour change.
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(KEY)).toBe(false);
  });

  it.each(CAPS)(
    "keeps the historical default of 2 on every host (gpu=$gpu localLlm=$localLlm)",
    (caps) => {
      // Ungated on purpose. Behind a capability gate this would silently drop
      // to upstream's 4 on any host lacking the gate — a behaviour change
      // smuggled in by a refactor.
      expect(hindsightPerfEnv(caps)).toContainEqual([KEY, "2"]);
    },
  );

  it("the operator's value REPLACES the default on BOTH launch paths", () => {
    const perf = { env: { [KEY]: "3" }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
    );
    // Exactly one value, not the default AND the override: a duplicate emission
    // would be last-wins by luck on docker-run and ambiguous in compose.
    expect(fromRun.get(KEY)).toEqual(["3"]);
    expect(fromCompose.get(KEY)).toEqual(["3"]);
  });

  it("is emitted exactly once per path when NOT overridden", () => {
    // Guards the specific regression of moving the key without deleting the
    // old hard-coded emission: two `-e` flags for one var.
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, {
      env: {},
      processEnv: {},
    });
    expect(runEnv(runArgs()).get(KEY)).toEqual(["2"]);
    expect(
      composeEnv(
        generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, {
          env: {},
          processEnv: {},
        }),
      ).get(KEY),
    ).toEqual(["2"]);
  });

  it("still reaches the container on a host with NO gated capability", () => {
    const perf = { env: { [KEY]: "6" }, processEnv: {} };
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual(["6"]);
  });
});

// ── per-scope observation cap, moved into the managed set ─────────────────
describe("HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE (managed, was hard-coded)", () => {
  const KEY = "HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE";
  const CAPS = [
    { gpu: false, localLlm: false },
    { gpu: true, localLlm: false },
    { gpu: false, localLlm: true },
    { gpu: true, localLlm: true },
  ];

  it("is in the managed set, so a hindsight.env line is not silently dropped", () => {
    // The bug this fixes: the key was emitted unconditionally from a bare
    // constant in hindsight.ts and was NOT in HINDSIGHT_PERF_ENV_KEYS, so an
    // operator's yaml line was discarded without a word — it read as durable
    // config while doing nothing, and its own doc comment sent operators to
    // `docker run -e …` instead, which the next `switchroom apply` discards.
    expect(HINDSIGHT_PERF_ENV_KEYS.has(KEY)).toBe(true);
    // Defaulted, not override-only: the previous emission was unconditional,
    // so dropping the default would be a silent behaviour change.
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(KEY)).toBe(false);
  });

  it.each(CAPS)(
    "keeps the shipped default of 1000 on every host (gpu=$gpu localLlm=$localLlm)",
    (caps) => {
      // Ungated on purpose. Behind a capability gate this would silently revert
      // to upstream's -1 (unlimited) on any host lacking the gate — a behaviour
      // change smuggled in by a refactor, and the removal of the rail itself.
      expect(hindsightPerfEnv(caps)).toContainEqual([KEY, "1000"]);
    },
  );

  it("the operator's value REPLACES the default on BOTH launch paths", () => {
    const perf = { env: { [KEY]: "5000" }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
    );
    // Exactly one value, not the default AND the override: a duplicate emission
    // would be last-wins by luck on docker-run and ambiguous in compose.
    expect(fromRun.get(KEY)).toEqual(["5000"]);
    expect(fromCompose.get(KEY)).toEqual(["5000"]);
  });

  it("is emitted exactly once per path when NOT overridden", () => {
    // Guards the specific regression of moving the key without deleting the
    // old hard-coded emission: two `-e` flags for one var.
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, {
      env: {},
      processEnv: {},
    });
    expect(runEnv(runArgs()).get(KEY)).toEqual(["1000"]);
    expect(
      composeEnv(
        generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, {
          env: {},
          processEnv: {},
        }),
      ).get(KEY),
    ).toEqual(["1000"]);
  });

  it("still reaches the container on a host with NO gated capability", () => {
    const perf = { env: { [KEY]: "250" }, processEnv: {} };
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(KEY)).toEqual(["250"]);
  });
});

// ── recall freshness: the recency decay curve ─────────────────────────────
//
// The failure these protect against, measured on bank `klanker` 2026-07-28:
// "what version is the switchroom fleet running right now" returned 38 results
// topped by `Switchroom fleet is running image version v0.18.19` — retained
// 2026-07-19 and wrong by then — with the correct current value absent
// entirely. Upstream's `linear` curve over a 365-day window is nearly flat
// across the age range a real bank spans, so a nine-day-old state fact and
// today's are effectively tied on recency.
//
// These assert the RANKING-RELEVANT OUTCOME (how far apart the curve puts two
// facts a bank actually holds), not that a string got emitted, so they fail on
// upstream's default rather than merely on a typo.

/**
 * Port of the container's `compute_recency_decay`
 * (hindsight_api/engine/search/reranking.py) — age in days → freshness signal
 * in [0, 1], neutral 0.5. Mirrored rather than imported because it is Python
 * inside the hindsight image; the shapes are quoted from the upstream
 * docstring in hindsight-perf-defaults.ts.
 */
function computeRecencyDecay(
  daysAgo: number,
  fn: string,
  linearWindowDays: number,
  halflifeDays: number,
): number {
  if (fn === "none") return 0.5;
  if (fn === "exponential") {
    if (halflifeDays <= 0) return 0.5;
    return Math.min(1, 0.5 ** (daysAgo / halflifeDays));
  }
  const window = linearWindowDays > 0 ? linearWindowDays : 365;
  return Math.max(0.1, Math.min(1, 1 - daysAgo / window));
}

describe("recency decay defaults — freshness the reranker can actually see", () => {
  const FN_KEY = "HINDSIGHT_API_RECENCY_DECAY_FUNCTION";
  const HALFLIFE_KEY = "HINDSIGHT_API_RECENCY_DECAY_HALFLIFE_DAYS";
  const WINDOW_KEY = "HINDSIGHT_API_RECENCY_DECAY_LINEAR_WINDOW_DAYS";
  const CAPS = [
    { gpu: false, localLlm: false },
    { gpu: true, localLlm: false },
    { gpu: false, localLlm: true },
    { gpu: true, localLlm: true },
  ];

  // Upstream's shipped values (config.py DEFAULT_RECENCY_DECAY_*), i.e. exactly
  // what a bank gets with no switchroom default — the buggy baseline.
  const UPSTREAM_FN = "linear";
  const UPSTREAM_WINDOW = 365;
  const UPSTREAM_HALFLIFE = 90;

  /** The curve switchroom actually emits, read back out of the generator. */
  const shipped = () => {
    const pairs = new Map(hindsightPerfEnv({ gpu: false, localLlm: false }));
    return { fn: pairs.get(FN_KEY)!, halflife: Number(pairs.get(HALFLIFE_KEY)!) };
  };

  it.each(CAPS)(
    "ships an exponential curve on every host (gpu=$gpu localLlm=$localLlm)",
    (caps) => {
      // Ungated: the right curve does not depend on hardware, and behind a gate
      // this would silently fall back to upstream's flat linear window on any
      // host lacking the gate.
      const pairs = hindsightPerfEnv(caps);
      expect(pairs).toContainEqual([FN_KEY, HINDSIGHT_DEFAULT_RECENCY_DECAY_FUNCTION]);
      expect(pairs).toContainEqual([
        HALFLIFE_KEY,
        String(HINDSIGHT_DEFAULT_RECENCY_DECAY_HALFLIFE_DAYS),
      ]);
    },
  );

  it("only emits a curve name the container's validator accepts", () => {
    // config.py RECENCY_DECAY_FUNCTIONS — an unrecognised name is logged and
    // silently replaced with "linear", i.e. a typo here would ship as a no-op.
    expect(["linear", "exponential", "none"]).toContain(
      HINDSIGHT_DEFAULT_RECENCY_DECAY_FUNCTION,
    );
    expect(HINDSIGHT_DEFAULT_RECENCY_DECAY_HALFLIFE_DAYS).toBeGreaterThan(0);
  });

  // ── THE OUTCOME TEST ──
  //
  // Fails on the original bug: under upstream's linear/365 the two facts in the
  // measured klanker case (today's correct version vs the 9-day-old wrong one)
  // sit 0.022 apart on a [0,1] signal. Nothing downstream can recover a
  // preference the curve never expressed.
  it("separates a fresh state fact from a nine-day-old one, where upstream does not", () => {
    const { fn, halflife } = shipped();
    const fresh = 1;
    const stale = 9; // v0.19.27 (today) vs v0.18.19 (retained 2026-07-19)

    const shippedGap =
      computeRecencyDecay(fresh, fn, UPSTREAM_WINDOW, halflife) -
      computeRecencyDecay(stale, fn, UPSTREAM_WINDOW, halflife);
    const upstreamGap =
      computeRecencyDecay(fresh, UPSTREAM_FN, UPSTREAM_WINDOW, UPSTREAM_HALFLIFE) -
      computeRecencyDecay(stale, UPSTREAM_FN, UPSTREAM_WINDOW, UPSTREAM_HALFLIFE);

    // Absolute floor: the fresher fact must lead by a tenth of the signal
    // range, not by rounding noise.
    expect(shippedGap).toBeGreaterThan(0.1);
    // And by a large multiple of what upstream expresses, so a half-life
    // quietly raised back toward 90 fails here.
    expect(shippedGap).toBeGreaterThan(upstreamGap * 5);
    // Pin the baseline too, so this cannot start passing because the baseline
    // moved rather than because our curve is good.
    expect(upstreamGap).toBeLessThan(0.03);
  });

  it("puts the neutral point at the half-life, so it states how long state is presumed current", () => {
    const { fn, halflife } = shipped();
    // The half-life is defined as the age at which the signal is exactly
    // neutral (no boost, no penalty) — that is what makes it a legible
    // statement of policy rather than an opaque tuning constant.
    expect(computeRecencyDecay(halflife, fn, UPSTREAM_WINDOW, halflife)).toBeCloseTo(0.5, 10);
    // Older than that is actively penalised, not merely un-boosted.
    expect(computeRecencyDecay(halflife * 3, fn, UPSTREAM_WINDOW, halflife)).toBeLessThan(0.2);
  });

  it("does not penalise a future-dated memory", () => {
    // reranking.py clamps negative days_ago to maximum freshness; the
    // exponential branch relies on its min(1.0, ...) clamp to do it. A curve
    // returning >1 here would push a boost outside its documented range.
    const { fn, halflife } = shipped();
    expect(computeRecencyDecay(-30, fn, UPSTREAM_WINDOW, halflife)).toBe(1);
  });

  // ── HONESTY PIN ──
  //
  // The doc comment on HINDSIGHT_DEFAULT_RECENCY_DECAY_FUNCTION states plainly
  // that this default is ~a no-op TODAY, because switchroom's own
  // CE-saturation patch damps the boost product, and that the binding
  // constraint is the decisive gap. If that stops being true the doc must be
  // rewritten, so pin the arithmetic rather than trusting prose.
  it("is damped to under 1% by the CE-saturation patch until the decisive gap moves", () => {
    // Read the gap out of the patch source instead of duplicating it, so the
    // two cannot drift.
    const dockerfile = readFileSync(
      new URL("../../docker/Dockerfile.hindsight", import.meta.url),
      "utf-8",
    );
    const m = /_CE_DECISIVE_RELATIVE_GAP_DEFAULT: float = ([\d.]+)/.exec(dockerfile);
    expect(m, "CE-saturation patch no longer declares a decisive-gap default").not.toBeNull();
    const gap = Number(m![1]);

    // Alphas as shipped by upstream reranking.py (recency, temporal, proof).
    const alphas = [0.2, 0.2, 0.1];
    let hi = 1;
    let lo = 1;
    for (const a of alphas) {
      hi *= 1 + a / 2;
      lo *= 1 - a / 2;
    }
    const exponent = Math.min(1, Math.log1p(gap) / Math.log(hi / lo));

    const { fn, halflife } = shipped();
    const damped = (r: number) => (1 + alphas[0] * (r - 0.5)) ** exponent;
    const freshest = computeRecencyDecay(1, fn, UPSTREAM_WINDOW, halflife);
    const oldest = computeRecencyDecay(400, fn, UPSTREAM_WINDOW, halflife);

    // Under 1% end-to-end today. This is the number the doc comment quotes.
    expect(damped(freshest) / damped(oldest)).toBeLessThan(1.01);
    // Clamping the exponent to 1.0 (what raising the gap to ~0.65 does) unlocks
    // it — proving the curve is not itself the limiter, which is the whole
    // claim the doc comment makes.
    const undamped =
      (1 + alphas[0] * (freshest - 0.5)) / (1 + alphas[0] * (oldest - 0.5));
    expect(undamped).toBeGreaterThan(1.2);
  });

  // ── OVERRIDABILITY ──

  it("the operator's curve REPLACES the default on BOTH launch paths", () => {
    const perf = { env: { [FN_KEY]: "linear", [WINDOW_KEY]: "120" }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false, perf),
    );
    // Exactly one value, not the default AND the override.
    expect(fromRun.get(FN_KEY)).toEqual(["linear"]);
    expect(fromCompose.get(FN_KEY)).toEqual(["linear"]);
    // The linear window is override-only, so it appears only because the
    // operator asked — and it MUST appear, or a `linear` override would
    // silently take upstream's 365 back.
    expect(fromRun.get(WINDOW_KEY)).toEqual(["120"]);
    expect(fromCompose.get(WINDOW_KEY)).toEqual(["120"]);
  });

  it("an operator half-life survives and is not re-defaulted", () => {
    const perf = { env: { [HALFLIFE_KEY]: "7" }, processEnv: {} };
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(HALFLIFE_KEY)).toEqual(["7"]);
  });

  it("an operator value exported in switchroom's own environment also wins", () => {
    const overrides = resolveHindsightPerfOverrides({}, { [FN_KEY]: "none" });
    expect(
      new Map(hindsightPerfEnv({ gpu: false, localLlm: false }, overrides)).get(FN_KEY),
    ).toBe("none");
  });

  it("still reaches the container on a host with NO gated capability", () => {
    const perf = { env: { [FN_KEY]: "none" }, processEnv: {} };
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false, perf);
    expect(runEnv(runArgs()).get(FN_KEY)).toEqual(["none"]);
  });

  it("is emitted exactly once per path when NOT overridden", () => {
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false, {
      env: {},
      processEnv: {},
    });
    expect(runEnv(runArgs()).get(FN_KEY)).toEqual([HINDSIGHT_DEFAULT_RECENCY_DECAY_FUNCTION]);
    // The override-only linear window must NOT be emitted unasked — emitting
    // upstream's own 365 would add a hard-coded value for no behaviour change.
    expect(runEnv(runArgs()).get(WINDOW_KEY)).toBeUndefined();
  });

  it("keeps all three keys managed, so a hindsight.env line is never silently dropped", () => {
    expect(HINDSIGHT_PERF_ENV_KEYS.has(FN_KEY)).toBe(true);
    expect(HINDSIGHT_PERF_ENV_KEYS.has(HALFLIFE_KEY)).toBe(true);
    expect(HINDSIGHT_PERF_ENV_KEYS.has(WINDOW_KEY)).toBe(true);
    // Curve + half-life are defaulted; the linear window is override-only.
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(FN_KEY)).toBe(false);
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(HALFLIFE_KEY)).toBe(false);
    expect(HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS.has(WINDOW_KEY)).toBe(true);
  });

  it("leaves the consolidation dedup threshold alone", () => {
    // Deliberate: `_dedup_adjudicate` probes ["observation"] only, so this knob
    // cannot deduplicate the RAW-fact duplicates that motivated this work — it
    // would only merge distinct observations more aggressively. Managing it
    // here would imply we think it helps.
    expect(
      HINDSIGHT_PERF_ENV_KEYS.has("HINDSIGHT_API_CONSOLIDATION_DEDUP_THRESHOLD"),
    ).toBe(false);
  });
});

// ── the self-hosted-endpoint probe ────────────────────────────────────────
describe("isSelfHostedHttpUrl", () => {
  it.each([
    "http://127.0.0.1:4010",
    "http://localhost:4010",
    "http://[::1]:4010",
    // IPv6 unique-local (fc00::/7) and link-local (fe80::/10) literals — the
    // two regexes in isSelfHostedHttpUrl. Without these cases both regexes can
    // be deleted with the whole suite still green (mutation M1).
    "http://[fd00::1]:4010",
    "http://[fc00:abcd::5]:4010",
    "http://[fe80::1]:4010",
    "http://[feba::1]:4010",
    "http://10.1.2.3:8000",
    "http://192.168.1.10:11434",
    "http://172.16.0.5:4010",
    "http://172.31.255.254:4010",
    "http://169.254.10.1:4010",
    "http://host.docker.internal:4010",
    "http://ollama.local:11434",
  ])("treats %s as self-hosted", (url) => {
    expect(isSelfHostedHttpUrl(url)).toBe(true);
  });

  it.each([
    "https://api.openai.com/v1",
    "https://openrouter.ai/api/v1",
    "https://litellm.example.com",
    // 172.15 and 172.32 bracket the RFC1918 /12 — the classic off-by-one.
    "http://172.15.0.1:4010",
    "http://172.32.0.1:4010",
    // 11.x is NOT private, however much it looks like 10.x.
    "http://11.0.0.1:4010",
    // Bracket the two IPv6 ranges the same way: fb00 is one nibble below
    // fc00::/7, and fec0::/10 (deprecated site-local) is outside fe80::/10.
    "http://[fb00::1]:4010",
    "http://[fec0::1]:4010",
    "http://[2001:db8::1]:4010",
    "not a url",
    "",
  ])("treats %s as NOT self-hosted", (url) => {
    expect(isSelfHostedHttpUrl(url)).toBe(false);
  });
});

describe("isLoopbackHttpUrl — IPv6 bracket handling", () => {
  it("recognises the bracketed IPv6 loopback form", () => {
    // `new URL("http://[::1]:4010").hostname` is "[::1]", so the pre-existing
    // `h === "::1"` comparison never fired: an IPv6-loopback LiteLLM base read
    // as remote and hindsightNeedsHostNetwork() left hindsight on the bridge
    // network, where 127.0.0.1:4010 is unreachable — the silent-retain outage.
    expect(isLoopbackHttpUrl("http://[::1]:4010")).toBe(true);
    expect(hindsightNeedsHostNetwork({ retain: { base_url: "http://[::1]:4010" } })).toBe(true);
  });

  it("does not treat a non-loopback IPv6 literal as loopback", () => {
    expect(isLoopbackHttpUrl("http://[2001:db8::1]:4010")).toBe(false);
  });
});

describe("hindsightLocalLlmEnabled", () => {
  it("is FALSE with no LLM endpoint configured at all", () => {
    // Fail-safe: unknown ⇒ upstream's 32 stands, no throughput regression.
    expect(hindsightLocalLlmEnabled()).toBe(false);
  });

  it("is TRUE for this fleet's loopback LiteLLM", () => {
    expect(hindsightLocalLlmEnabled(undefined, LOOPBACK_LITELLM)).toBe(true);
  });

  it("is FALSE for a hosted LiteLLM", () => {
    expect(hindsightLocalLlmEnabled(undefined, CLOUD_LITELLM)).toBe(false);
  });

  it("is TRUE when any per-op base URL is self-hosted", () => {
    expect(
      hindsightLocalLlmEnabled(
        { retain: { base_url: "http://192.168.1.50:11434/v1" } },
        CLOUD_LITELLM,
      ),
    ).toBe(true);
  });

  it("honours an explicit override in both directions", () => {
    expect(hindsightLocalLlmEnabled(undefined, LOOPBACK_LITELLM, false)).toBe(false);
    expect(hindsightLocalLlmEnabled(undefined, CLOUD_LITELLM, true)).toBe(true);
  });
});

// ── the launch paths ──────────────────────────────────────────────────────
describe("startHindsight — performance defaults reach the container", () => {
  it("emits every gated knob on a GPU host with a local LLM", () => {
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, true);
    const env = runEnv(runArgs());
    expect(env.get("HINDSIGHT_API_RERANKER_LOCAL_FP16")).toEqual(["true"]);
    expect(env.get("HINDSIGHT_API_LLM_MAX_CONCURRENT")).toEqual(["4"]);
    expect(env.get("HINDSIGHT_API_RECALL_MAX_CANDIDATES_PER_SOURCE")).toEqual(["60"]);
  });

  it("emits NO GPU/local-LLM knob on a CPU host with a hosted endpoint", () => {
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false);
    const env = runEnv(runArgs());
    expect(env.has("HINDSIGHT_API_RERANKER_LOCAL_FP16")).toBe(false);
    expect(env.has("HINDSIGHT_API_LLM_MAX_CONCURRENT")).toBe(false);
    // ...while the ungated ones still land.
    expect(env.get("HINDSIGHT_API_LINK_EXPANSION_TIMEOUT")).toEqual(["2"]);
  });

  it("does NOT emit HINDSIGHT_API_DB_MAX_PARALLEL_WORKERS_PER_GATHER", () => {
    // Deliberate omission. Upstream scopes it to "every pool connection of
    // THIS process", and switchroom runs a single process (start-all.sh starts
    // only hindsight-api; HINDSIGHT_API_WORKER_ENABLED defaults true = worker
    // inside the API process). Setting it to 0 would serialise the recall path
    // this PR is speeding up, not just background consolidation.
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, true);
    expect(runEnv(runArgs()).has("HINDSIGHT_API_DB_MAX_PARALLEL_WORKERS_PER_GATHER")).toBe(false);
    expect(
      composeEnv(
        generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, true),
      ).has("HINDSIGHT_API_DB_MAX_PARALLEL_WORKERS_PER_GATHER"),
    ).toBe(false);
  });

  it("leaves the reranker candidate budget at 150 (documented follow-up)", () => {
    // src/setup/hindsight-reranker-budget.test.ts:111-118 records why cutting
    // this needs an answer-quality A/B first. This PR must not move it.
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, true);
    expect(runEnv(runArgs()).get("HINDSIGHT_API_RERANKER_MAX_CANDIDATES")).toEqual(["150"]);
  });

  it("emits an operator override once, with the operator's value", () => {
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, true, {
      env: { HINDSIGHT_API_LLM_MAX_CONCURRENT: 12 },
      processEnv: {},
    });
    expect(runEnv(runArgs()).get("HINDSIGHT_API_LLM_MAX_CONCURRENT")).toEqual(["12"]);
  });

  it("never emits a managed key twice in the final argv", () => {
    // Guards against a future edit that appends the perf block alongside a
    // hard-coded literal elsewhere in envArgs — where docker's last-wins would
    // decide the value silently.
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, true, {
      env: { HINDSIGHT_API_LINK_EXPANSION_TIMEOUT: 3 },
      processEnv: {},
    });
    const env = runEnv(runArgs());
    // The value FIRST: "at most once" alone cannot tell "emitted once with the
    // operator's 3" from "silently dropped", so a resolver that ignored
    // overrides for the ungated group passed this test (mutation M28).
    expect(env.get("HINDSIGHT_API_LINK_EXPANSION_TIMEOUT")).toEqual(["3"]);
    expect(String(HINDSIGHT_DEFAULT_LINK_EXPANSION_TIMEOUT_S)).not.toBe("3");
    for (const key of HINDSIGHT_PERF_ENV_KEYS) {
      expect(env.get(key)?.length ?? 0, `${key} must appear at most once`).toBeLessThanOrEqual(1);
    }
  });

  it("reads a self-hosted per-op LLM base URL when there is no litellm block", () => {
    // The `llm` argument's wiring into hindsightLocalLlmEnabled. Every other
    // launch-path case configures the endpoint through `litellm`, so dropping
    // `llm` from hindsightPerfEnvPairs left the suite green (mutation M29).
    // Here `llm` carries the ONLY base URL and it is LAN-private, so the
    // local-LLM group must switch on from that argument alone.
    const llm = { retain: { base_url: "http://192.168.1.50:11434" } };
    startHindsight(undefined, undefined, undefined, llm, undefined, false);
    const fromRun = runEnv(runArgs());
    expect(fromRun.get("HINDSIGHT_API_LLM_MAX_CONCURRENT")).toEqual(["4"]);
    expect(fromRun.get("HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT")).toEqual(["1"]);
    // Derived from global 4 / retain 1 — see the consolidation-cap block below.
    expect(fromRun.get("HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT")).toEqual(["2"]);
    // ...and the compose twin reads the same argument the same way.
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(llm, undefined, undefined, false),
    );
    expect(fromCompose.get("HINDSIGHT_API_LLM_MAX_CONCURRENT")).toEqual(["4"]);
  });

  it("leaves the LLM concurrency caps alone when the only per-op base URL is cloud", () => {
    // The control for the case above: same argument position, hosted URL, so a
    // predicate that just returned `true` whenever `llm` was present would fail.
    startHindsight(
      undefined,
      undefined,
      undefined,
      { retain: { base_url: "https://api.openai.com/v1" } },
      undefined,
      false,
    );
    expect(runEnv(runArgs()).has("HINDSIGHT_API_LLM_MAX_CONCURRENT")).toBe(false);
  });
});

// ── the tunings that used to exist only on the live container ─────────────
describe("hand-applied container tunings are now emitted by both launch paths", () => {
  /**
   * These five values were applied imperatively with `docker exec`/`docker run`
   * on the live fleet and were therefore destroyed by the next
   * `switchroom memory setup` (the installed 0.19.23 CLI emits no reference to
   * any of them). Each is measured-good, so the regression this block guards is
   * "the recreate silently reverts the fix":
   *
   *   • LLM_STRICT_SCHEMA=true    — without it gpt-oss:20b prefixes prose to its
   *     JSON and ~45% of local retain/consolidation calls fail to parse.
   *   • LLM_MAX_RETRIES=2         — a local endpoint isn't rate-limited, so
   *     upstream's 3 mostly adds latency to a call that will fail again.
   *   • RERANKER_LOCAL_BATCH_SIZE=128 — CUDA value; rerank of 150 candidates
   *     went 4.347s → 0.174s, recall p50 3.2s → 0.8s.
   *   • REFLECT_MAX_CONTEXT_TOKENS / CONSOLIDATION_MAX_COMPLETION_TOKENS — now
   *     DERIVED from the declared context window
   *     (tests/setup/hindsight-context-budget.test.ts owns their values); here
   *     we only assert they reach both containers ungated.
   */
  const GATED_LOCAL_LLM = [
    ["HINDSIGHT_API_LLM_STRICT_SCHEMA", "true"],
    ["HINDSIGHT_API_LLM_MAX_RETRIES", "2"],
  ] as const;
  const GATED_GPU = [["HINDSIGHT_API_RERANKER_LOCAL_BATCH_SIZE", "128"]] as const;

  it("emits the local-LLM tunings on BOTH paths when the endpoint is self-hosted", () => {
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false);
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false),
    );
    for (const [key, value] of GATED_LOCAL_LLM) {
      expect(fromRun.get(key), `${key} on docker run`).toEqual([value]);
      expect(fromCompose.get(key), `${key} on compose`).toEqual([value]);
    }
  });

  it("withholds the local-LLM tunings from a cloud endpoint on BOTH paths", () => {
    // strict-schema costs nothing on a frontier model but IS a hard constraint
    // some hosted providers reject outright, and retries=2 is a reliability
    // downgrade against a rate-limited API. Absent capability ⇒ upstream default.
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, true);
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, CLOUD_LITELLM, true),
    );
    for (const [key] of GATED_LOCAL_LLM) {
      expect(fromRun.has(key), `${key} must be absent on docker run`).toBe(false);
      expect(fromCompose.has(key), `${key} must be absent on compose`).toBe(false);
    }
  });

  it("emits the CUDA rerank batch size on BOTH paths only for a GPU host", () => {
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, true);
    const withGpu = runEnv(runArgs());
    const withGpuCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, CLOUD_LITELLM, true),
    );
    for (const [key, value] of GATED_GPU) {
      expect(withGpu.get(key), `${key} on docker run`).toEqual([value]);
      expect(withGpuCompose.get(key), `${key} on compose`).toEqual([value]);
    }

    execFileSyncMock.mockClear();
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, false);
    const noGpu = runEnv(runArgs());
    const noGpuCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, false),
    );
    for (const [key] of GATED_GPU) {
      // 32 (upstream's CPU/MPS default) is correct without CUDA — a 128-wide
      // batch on CPU is a latency regression, not a speed-up.
      expect(noGpu.has(key), `${key} must be absent on docker run`).toBe(false);
      expect(noGpuCompose.has(key), `${key} must be absent on compose`).toBe(false);
    }
  });

  it("emits the derived context-budget knobs on BOTH paths, ungated", () => {
    // Unlike the two groups above these are NOT capability-gated: an oversized
    // prompt corrupts memory on any backend, so the cap ships everywhere. The
    // cloud/CPU host is the hostile case — if they were gated they'd vanish here.
    startHindsight(undefined, CLOUD_LITELLM, undefined, undefined, undefined, false);
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, CLOUD_LITELLM, false),
    );
    for (const key of [
      "HINDSIGHT_API_REFLECT_MAX_CONTEXT_TOKENS",
      "HINDSIGHT_API_CONSOLIDATION_MAX_COMPLETION_TOKENS",
      "HINDSIGHT_API_CONSOLIDATION_LLM_BATCH_SIZE",
    ]) {
      expect(fromRun.get(key)?.length, `${key} exactly once on docker run`).toBe(1);
      expect(fromCompose.get(key), `${key} must match across paths`).toEqual(fromRun.get(key));
    }
  });
});

describe("run ⇄ compose parity for the performance defaults", () => {
  /**
   * An operator override carried through EVERY parity cell.
   *
   * Without it both generators were called with `perf` undefined, so the
   * compose path could ignore its `perf` argument entirely and still agree
   * with the run path (mutation M17 — dropping `perf` from the
   * hindsightPerfEnvPairs call inside generateHindsightComposeSnippet left the
   * suite green). Two keys on purpose:
   *   • LINK_EXPANSION_TIMEOUT is ungated, so it exercises the REPLACE path in
   *     every cell.
   *   • RETAIN_LLM_MAX_CONCURRENT is in the local-LLM group, so with
   *     CLOUD_LITELLM it exercises the "group OFF, override still emitted"
   *     append path across both generators too.
   * Neither key is one of the two the matrix assertions below probe, so the
   * gated-knob divergence check is unaffected.
   */
  const OPERATOR_PERF = {
    env: {
      HINDSIGHT_API_LINK_EXPANSION_TIMEOUT: 7,
      HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT: 3,
    },
    processEnv: {},
  };

  for (const gpu of [true, false]) {
    for (const litellm of [LOOPBACK_LITELLM, CLOUD_LITELLM]) {
      it(`agree for gpu=${gpu} litellm=${litellm.baseUrl}`, () => {
        startHindsight(undefined, litellm, undefined, undefined, undefined, gpu, OPERATOR_PERF);
        const fromRun = runEnv(runArgs());
        const fromCompose = composeEnv(
          generateHindsightComposeSnippet(undefined, undefined, litellm, gpu, OPERATOR_PERF),
        );
        // Compare the OUTCOME of both generators, key by key, for every knob
        // this module manages — not merely that both called the resolver.
        for (const key of HINDSIGHT_PERF_ENV_KEYS) {
          expect(fromCompose.get(key) ?? null, `${key} must match across paths`).toEqual(
            fromRun.get(key) ?? null,
          );
        }
        // Parity alone is symmetric — two paths that BOTH dropped `perf` would
        // still agree. Pin the operator's values on the compose side directly.
        // Guard first: the pins below only prove the override travelled if the
        // override value DIFFERS from the default it replaces. Should either
        // default ever drift onto the override literal, the pin would pass
        // against a generator that ignored `perf` entirely — so fail loudly
        // here instead of going quietly vacuous (same guard as mutation M28).
        expect(String(HINDSIGHT_DEFAULT_LINK_EXPANSION_TIMEOUT_S)).not.toBe(
          String(OPERATOR_PERF.env.HINDSIGHT_API_LINK_EXPANSION_TIMEOUT),
        );
        expect(String(HINDSIGHT_DEFAULT_RETAIN_LLM_MAX_CONCURRENT)).not.toBe(
          String(OPERATOR_PERF.env.HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT),
        );
        expect(fromCompose.get("HINDSIGHT_API_LINK_EXPANSION_TIMEOUT")).toEqual(["7"]);
        expect(fromCompose.get("HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT")).toEqual(["3"]);
        // ...and at least one gated knob genuinely differs across the matrix,
        // so a resolver that returned {} for everything wouldn't pass.
        expect(fromRun.has("HINDSIGHT_API_RERANKER_LOCAL_FP16")).toBe(gpu);
        expect(fromRun.has("HINDSIGHT_API_LLM_MAX_CONCURRENT")).toBe(
          litellm === LOOPBACK_LITELLM,
        );
      });
    }
  }

  it("both paths derive from hindsightPerfEnvPairs for the same inputs", () => {
    const expected = new Map(hindsightPerfEnvPairs(undefined, LOOPBACK_LITELLM, true));
    startHindsight(undefined, LOOPBACK_LITELLM, undefined, undefined, undefined, true);
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, LOOPBACK_LITELLM, true),
    );
    expect(expected.size).toBeGreaterThan(0);
    for (const [key, value] of expected) {
      expect(fromRun.get(key)).toEqual([value]);
      expect(fromCompose.get(key)).toEqual([value]);
    }
  });
});

// ─── Per-type worker slot reservations: MAX_SLOTS -> RESERVED_SLOTS ─────────
//
// Upstream v0.8.6 (#3016) renamed HINDSIGHT_API_WORKER_<TYPE>_MAX_SLOTS to
// ..._RESERVED_SLOTS and kept the old name as a deprecated alias. Setting BOTH
// names for the same operation type is a HARD BOOT ValueError in the engine —
// verified live against the pinned 0.8.6 digest — so "never emit both" is not a
// style preference, it is the difference between a hindsight container that
// boots and one that does not.
//
// These tests assert the OUTCOME (what reaches the container), not that a
// helper was called. Each one fails on a specific, plausible implementation
// mistake: a bare rename (drops the operator's value), a regex-based alias rule
// (eats the unrelated global HINDSIGHT_API_WORKER_MAX_SLOTS), or emitting the
// alias alongside the canonical name (bricks the boot).
describe("worker slot reservation env rename (upstream #3016)", () => {
  const CAPS = { gpu: false, localLlm: false } as const;

  it("NEVER emits both spellings for the same operation type", () => {
    // The load-bearing one. Both names present in hindsight.env is exactly the
    // shape an operator lands on mid-migration, and it is the shape that must
    // not be forwarded: the engine rejects it at boot.
    for (const type of HINDSIGHT_WORKER_SLOT_TYPES) {
      const legacy = `HINDSIGHT_API_WORKER_${type.toUpperCase()}_MAX_SLOTS`;
      const canonical = `HINDSIGHT_API_WORKER_${type.toUpperCase()}_RESERVED_SLOTS`;
      for (const configEnv of [
        { [legacy]: "3", [canonical]: "7" },
        { [canonical]: "7", [legacy]: "3" },
        { [legacy]: "3" },
        { [canonical]: "7" },
      ]) {
        const emitted = hindsightPerfEnv(CAPS, resolveHindsightPerfOverrides(configEnv, {}));
        const names = emitted.map(([k]) => k);
        expect(
          names.includes(legacy),
          `${legacy} must never be emitted (input ${JSON.stringify(configEnv)})`,
        ).toBe(false);
        expect(
          names.filter((k) => k === canonical).length,
          `${canonical} must be emitted exactly once`,
        ).toBe(1);
      }
    }
  });

  it("keeps the operator's legacy value instead of silently dropping it", () => {
    // The regression a bare rename would have shipped: this fleet's
    // switchroom.yaml carries HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS: 20.
    // Unmanaged => resolveHindsightPerfOverrides skips it => the container runs
    // on switchroom's default 1 while the yaml says 20.
    const overrides = resolveHindsightPerfOverrides(
      { HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS: "20" },
      {},
    );
    expect(overrides.get("HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS")).toBe("20");
    const emitted = new Map(hindsightPerfEnv(CAPS, overrides));
    expect(emitted.get("HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS")).toBe("20");
  });

  it("prefers the canonical name when both are set, in either yaml order", () => {
    for (const configEnv of [
      {
        HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS: "3",
        HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS: "7",
      },
      {
        HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS: "7",
        HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS: "3",
      },
    ]) {
      const emitted = new Map(hindsightPerfEnv(CAPS, resolveHindsightPerfOverrides(configEnv, {})));
      expect(emitted.get("HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS")).toBe("7");
    }
  });

  it("does NOT alias the global HINDSIGHT_API_WORKER_MAX_SLOTS", () => {
    // A regex on /_MAX_SLOTS$/ would rewrite the worker's TOTAL slot budget to
    // a key upstream does not define, silently reverting the pool to its
    // default. The alias map is keyed on the six operation types for this
    // reason.
    expect(HINDSIGHT_WORKER_RESERVED_SLOT_ALIASES.has("HINDSIGHT_API_WORKER_MAX_SLOTS")).toBe(false);
    const emitted = new Map(
      hindsightPerfEnv(CAPS, resolveHindsightPerfOverrides({ HINDSIGHT_API_WORKER_MAX_SLOTS: "16" }, {})),
    );
    expect(emitted.get("HINDSIGHT_API_WORKER_MAX_SLOTS")).toBe("16");
    expect(emitted.has("HINDSIGHT_API_WORKER_RESERVED_SLOTS")).toBe(false);
  });

  it("emits the consolidation reservation under the canonical name by default", () => {
    const emitted = new Map(hindsightPerfEnv(CAPS));
    expect(emitted.get("HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS")).toBe("1");
    expect(emitted.has("HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS")).toBe(false);
  });
});

// ─── Keys that replaced retired image patches ──────────────────────────────
describe("keys that replaced retired Dockerfile patches (v0.8.6)", () => {
  it("pins the graph seed floor rather than inheriting upstream's default", () => {
    // The retired #2968 carry hardcoded 0.3 and asserted upstream had no config
    // key for it. v0.8.6 adds the key, so the pin has to move here or the value
    // becomes "whatever the next image bump decides".
    const emitted = new Map(hindsightPerfEnv({ gpu: false, localLlm: false }));
    expect(emitted.get("HINDSIGHT_API_GRAPH_SEED_MIN_SIMILARITY")).toBe("0.3");
  });

  it("disables the maxItems schema hint on a local (GBNF) backend only", () => {
    // This is the data-egress control that replaced the maxItems grammar patch:
    // an uncompilable grammar made LiteLLM fall back to a METERED provider with
    // verbatim private corpus text. A hosted structured-output backend has no
    // GBNF step, so it keeps upstream's default.
    const local = new Map(hindsightPerfEnv({ gpu: false, localLlm: true }));
    expect(local.get("HINDSIGHT_API_LLM_SUPPORTS_MAX_ITEMS")).toBe("false");
    const hosted = new Map(hindsightPerfEnv({ gpu: false, localLlm: false }));
    expect(hosted.has("HINDSIGHT_API_LLM_SUPPORTS_MAX_ITEMS")).toBe(false);
  });
});

describe("newly adopted v0.8.6 keys", () => {
  /**
   * The reachability half, which is the whole point of adopting an
   * override-only key: an unmanaged `hindsight.env` line is DISCARDED silently
   * (no error, no warning), so before this adoption an operator raising the
   * retain wall timeout in yaml would have believed they had changed something
   * they had not.
   */
  it("makes HINDSIGHT_API_RETAIN_WALL_TIMEOUT reachable from switchroom.yaml", () => {
    expect(
      resolveHindsightPerfOverrides({
        HINDSIGHT_API_RETAIN_WALL_TIMEOUT: "7200",
      }).get("HINDSIGHT_API_RETAIN_WALL_TIMEOUT"),
    ).toBe("7200");
  });

  it("does NOT bake a default for it — upstream's 3600 stands unless overridden", () => {
    // Reflect's counterpart IS defaulted (600s, chosen against measured local-LLM
    // latency). Retain's has no measurement behind it, so emitting a number here
    // would be a second copy of upstream's opinion, free to drift from it.
    for (const opts of [
      { gpu: false, localLlm: false },
      { gpu: false, localLlm: true },
      { gpu: true, localLlm: true },
    ]) {
      const emitted = new Map(hindsightPerfEnv(opts));
      expect(emitted.has("HINDSIGHT_API_RETAIN_WALL_TIMEOUT")).toBe(false);
      // The asymmetry is deliberate, not an oversight — pin the contrast so
      // "we forgot retain" and "we decided about retain" stay distinguishable.
      expect(emitted.get("HINDSIGHT_API_REFLECT_WALL_TIMEOUT")).toBe("600");
    }
  });
});
