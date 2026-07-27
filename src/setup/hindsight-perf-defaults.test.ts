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
  HINDSIGHT_DEFAULT_RETAIN_LLM_MAX_CONCURRENT,
  HINDSIGHT_PERF_DEFAULTS_GPU,
  HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
  HINDSIGHT_PERF_DEFAULTS_UNGATED,
  HINDSIGHT_PERF_ENV_KEYS,
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
    expect(got.get("HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT")).toBe("1");
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

  it("is overridable on exactly these eleven keys, by name", () => {
    // Spelled out, NOT derived from the three group arrays. HINDSIGHT_PERF_ENV_KEYS
    // is DEFINED as the union of those arrays, so asserting it equals that union
    // is a tautology — it passes no matter which keys are in the arrays. The
    // override surface is a documented contract (src/config/schema.ts's
    // `hindsight.env` description names these keys), so pin the literal list:
    // adding or dropping a managed key must fail here and force the doc update.
    expect([...HINDSIGHT_PERF_ENV_KEYS].sort()).toEqual([
      "HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT",
      "HINDSIGHT_API_LINK_EXPANSION_PER_ENTITY_LIMIT",
      "HINDSIGHT_API_LINK_EXPANSION_TIMEOUT",
      "HINDSIGHT_API_LLM_MAX_CONCURRENT",
      "HINDSIGHT_API_LLM_MAX_RETRIES",
      "HINDSIGHT_API_LLM_REASONING_EFFORT",
      "HINDSIGHT_API_LLM_STRICT_SCHEMA",
      "HINDSIGHT_API_RECALL_MAX_CANDIDATES_PER_SOURCE",
      "HINDSIGHT_API_RERANKER_LOCAL_BATCH_SIZE",
      "HINDSIGHT_API_RERANKER_LOCAL_FP16",
      "HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT",
    ]);
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
    expect(fromRun.get("HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT")).toEqual(["1"]);
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
