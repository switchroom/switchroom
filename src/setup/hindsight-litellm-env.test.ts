/**
 * Hindsight's LiteLLM routing env must be identical on every launch path, and
 * its absence must never be silent.
 *
 * ## The two failures pinned here
 *
 * **1. Drift between the launch paths.** `ANTHROPIC_BASE_URL` +
 * `ANTHROPIC_CUSTOM_HEADERS` are what make hindsight's `claude-code` provider
 * transit the LiteLLM proxy and be METERED there (the
 * `x-litellm-customer-id` header is what produces the `end_user=hindsight`
 * rows in `LiteLLM_SpendLogs`). The header literal used to be written out
 * twice — once in `hindsightContainerEnvPairs` (docker-run / `memory setup
 * --recreate`) and once in `generateHindsightComposeSnippet`. Two copies of a
 * credential-bearing string is the shape that drifts, and only one of them is
 * the one the fleet actually runs. These tests assert the OUTCOME on both
 * artefacts — the `docker run` argv and the emitted compose text — not that
 * some helper was called.
 *
 * **2. A silently dropped key.** `resolveLiteLLMForHindsight` used to collapse
 * "LiteLLM is off", "the broker denied the key" and "the broker is down" into
 * the same bare `undefined`, so a denied grant launched hindsight with NO
 * routing env and said nothing. The container comes up healthy, reflect and
 * consolidation go straight to the provider, and the spend just stops
 * appearing under `end_user=hindsight`. Observed live 2026-08-07:
 * `litellm/hindsight/api-key` denied to a caller with no standing grant. The
 * only visible trace was the env-drift report listing the two vars as
 * dropped — which reads as operator drift and was misdiagnosed as exactly
 * that. So the resolver must now DISTINGUISH the enabled-but-unresolved case
 * and hand the caller a reference to warn with.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

import {
  generateHindsightComposeSnippet,
  hindsightContainerEnvPairs,
  hindsightLiteLlmDroppedKeyWarning,
  hindsightLiteLlmEnvPairs,
  resolveHindsightLiteLlm,
  startHindsight,
  HINDSIGHT_DEFAULT_API_PORT,
  HINDSIGHT_LITELLM_CUSTOMER_ID,
  HINDSIGHT_LITELLM_KEY_VAULT_REF,
  type LiteLLMHindsightConfig,
} from "./hindsight.js";
import { HINDSIGHT_KEY_VAULT_REF } from "../litellm/key-allowlist-check.js";

/** Not a credential — assembled at runtime so push-protection scanners stay quiet. */
const KEY = "sk-" + "hindsight-not-a-real-key";
const BASE = "http://127.0.0.1:4010";

const CFG: LiteLLMHindsightConfig = { baseUrl: BASE, apiKey: KEY, model: "claude-sonnet-5" };

/** The exact header value the proxy must receive, spelled out (not re-derived). */
const EXPECTED_HEADERS =
  `x-litellm-api-key: Bearer ${KEY}\n` +
  "x-litellm-customer-id: hindsight\n" +
  "x-litellm-tags: service:hindsight";

/** `docker run` argv → the env map the container is actually launched with. */
function runEnv(litellm?: LiteLLMHindsightConfig): Map<string, string> {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue(Buffer.from(""));
  startHindsight({ apiPort: HINDSIGHT_DEFAULT_API_PORT, uiPort: 19999 }, litellm);
  const argv = execFileSyncMock.mock.calls.map((c) => c[1] as string[]).find((a) => a?.[0] === "run");
  expect(argv, "startHindsight never issued a `docker run`").toBeDefined();
  const env = new Map<string, string>();
  for (let i = 0; i < argv!.length - 1; i++) {
    if (argv![i] !== "-e") continue;
    const eq = argv![i + 1]!.indexOf("=");
    env.set(argv![i + 1]!.slice(0, eq), argv![i + 1]!.slice(eq + 1));
  }
  return env;
}

/** Compose text → the `environment:` entries, as raw `KEY=value` strings. */
function composeEnv(litellm?: LiteLLMHindsightConfig): Map<string, string> {
  const snippet = generateHindsightComposeSnippet(undefined, undefined, litellm);
  const env = new Map<string, string>();
  for (const line of snippet.split("\n")) {
    const m = /^\s+- ([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) env.set(m[1]!, m[2]!);
  }
  return env;
}

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue(Buffer.from(""));
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("LiteLLM routing env reaches the container that memory setup --recreate launches", () => {
  it("the docker run argv carries both vars, with the metering headers", () => {
    // The assertion that goes red if the recreate path ever stops injecting:
    // this is `docker inspect switchroom-hindsight`'s Config.Env, ahead of time.
    const env = runEnv(CFG);
    expect(env.get("ANTHROPIC_BASE_URL")).toBe(`${BASE}/anthropic`);
    expect(env.get("ANTHROPIC_CUSTOM_HEADERS")).toBe(EXPECTED_HEADERS);
  });

  it("omits BOTH vars cleanly when LiteLLM is not configured", () => {
    const env = runEnv(undefined);
    expect(env.has("ANTHROPIC_BASE_URL")).toBe(false);
    expect(env.has("ANTHROPIC_CUSTOM_HEADERS")).toBe(false);
  });

  it("omits both rather than emitting an empty `Bearer ` when the key is blank", () => {
    // A blank key means the vault ref did not resolve. Baking
    // `x-litellm-api-key: Bearer ` in anyway produces a container that LOOKS
    // routed and is rejected at LiteLLM auth on every call — strictly worse
    // than an obviously-unrouted one.
    const env = runEnv({ baseUrl: BASE, apiKey: "  ", model: "claude-sonnet-5" });
    expect(env.has("ANTHROPIC_CUSTOM_HEADERS")).toBe(false);
    expect(env.has("ANTHROPIC_BASE_URL")).toBe(false);
    expect([...env.values()].join("\n")).not.toContain("Bearer ");
  });

  it("never bakes a literal `vault:` ref as the bearer", () => {
    const env = runEnv(CFG);
    expect(env.get("ANTHROPIC_CUSTOM_HEADERS")).not.toContain("vault:");
  });
});

describe("compose and docker-run cannot drift on the routing env", () => {
  it("compose emits the same two vars, newline-escaped for the YAML scalar", () => {
    const env = composeEnv(CFG);
    expect(env.get("ANTHROPIC_BASE_URL")).toBe(`${BASE}/anthropic`);
    // Byte-for-byte what the emitter produced before the shared helper landed:
    // a raw newline inside an unquoted compose scalar would end the entry.
    expect(env.get("ANTHROPIC_CUSTOM_HEADERS")).toBe(
      `x-litellm-api-key: Bearer ${KEY}\\nx-litellm-customer-id: hindsight` +
        "\\nx-litellm-tags: service:hindsight",
    );
  });

  it("the two paths agree var-for-var, modulo that escaping", () => {
    const run = runEnv(CFG);
    const compose = composeEnv(CFG);
    for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS"]) {
      expect(compose.get(key), `${key} missing from compose`).toBe(
        run.get(key)!.replace(/\n/g, "\\n"),
      );
    }
  });

  it("compose omits both when the key is absent, exactly as docker-run does", () => {
    const compose = composeEnv({ baseUrl: BASE, apiKey: "", model: "claude-sonnet-5" });
    expect(compose.has("ANTHROPIC_BASE_URL")).toBe(false);
    expect(compose.has("ANTHROPIC_CUSTOM_HEADERS")).toBe(false);
  });
});

describe("hindsightLiteLlmEnvPairs — route selection and tagging", () => {
  it("a Claude model rides the /anthropic pass-through", () => {
    const pairs = new Map(hindsightLiteLlmEnvPairs(CFG, "claude-sonnet-5"));
    expect(pairs.get("ANTHROPIC_BASE_URL")).toBe(`${BASE}/anthropic`);
  });

  it("a non-Claude model rides the model-mapped root", () => {
    const pairs = new Map(hindsightLiteLlmEnvPairs(CFG, "openai/gpt-oss-20b"));
    expect(pairs.get("ANTHROPIC_BASE_URL")).toBe(BASE);
  });

  it("strips trailing slashes off the configured base URL", () => {
    const pairs = new Map(
      hindsightLiteLlmEnvPairs({ ...CFG, baseUrl: `${BASE}///` }, "claude-sonnet-5"),
    );
    expect(pairs.get("ANTHROPIC_BASE_URL")).toBe(`${BASE}/anthropic`);
  });

  it("tags spend to the `hindsight` customer — the end_user rows depend on it", () => {
    const headers = new Map(hindsightLiteLlmEnvPairs(CFG, "claude-sonnet-5")).get(
      "ANTHROPIC_CUSTOM_HEADERS",
    )!;
    expect(headers).toContain(`x-litellm-customer-id: ${HINDSIGHT_LITELLM_CUSTOMER_ID}`);
    expect(headers).toContain(`x-litellm-tags: service:${HINDSIGHT_LITELLM_CUSTOMER_ID}`);
    expect(HINDSIGHT_LITELLM_CUSTOMER_ID).toBe("hindsight");
  });
});

describe("resolveHindsightLiteLlm — a dropped key is reported, never swallowed", () => {
  const enabled = {
    litellm: { enabled: true, base_url: BASE },
    memory: { config: { llm_model: "claude-sonnet-5" } },
  };
  const ok = vi.fn(async () => ({ kind: "ok", entry: { kind: "string", value: KEY } })) as never;
  const denied = vi.fn(async () => ({ kind: "denied", reason: "no grant" })) as never;
  const down = vi.fn(async () => {
    throw new Error("broker socket unavailable");
  }) as never;

  it("resolves the per-service virtual key when the broker allows it", async () => {
    const res = await resolveHindsightLiteLlm(enabled, { getViaBrokerStructured: ok });
    expect(res.litellm).toEqual({ baseUrl: BASE, apiKey: KEY, model: "claude-sonnet-5" });
    expect(res.droppedRef).toBeUndefined();
  });

  it("reports the DROPPED ref (not silence) when the broker denies", async () => {
    // The live 2026-08-07 shape. Pre-fix this returned a bare `undefined`,
    // indistinguishable from "LiteLLM is off", and the launch said nothing.
    const res = await resolveHindsightLiteLlm(enabled, { getViaBrokerStructured: denied });
    expect(res.litellm).toBeUndefined();
    expect(res.droppedRef).toBe(`vault:${HINDSIGHT_LITELLM_KEY_VAULT_REF}`);
  });

  it("reports the dropped ref when the broker is unreachable", async () => {
    const res = await resolveHindsightLiteLlm(enabled, { getViaBrokerStructured: down });
    expect(res.litellm).toBeUndefined();
    expect(res.droppedRef).toBe(`vault:${HINDSIGHT_LITELLM_KEY_VAULT_REF}`);
  });

  it("stays silent when LiteLLM is simply not enabled — that is not a drop", async () => {
    for (const cfg of [
      undefined,
      {},
      { litellm: { enabled: false, base_url: BASE } },
      { litellm: { enabled: true, base_url: "   " } },
    ]) {
      const res = await resolveHindsightLiteLlm(cfg, { getViaBrokerStructured: ok });
      expect(res.litellm).toBeUndefined();
      expect(res.droppedRef).toBeUndefined();
    }
  });

  it("drops a blank resolved key rather than passing it on", async () => {
    const blank = vi.fn(async () => ({
      kind: "ok",
      entry: { kind: "string", value: "   " },
    })) as never;
    const res = await resolveHindsightLiteLlm(enabled, { getViaBrokerStructured: blank });
    expect(res.litellm).toBeUndefined();
    expect(res.droppedRef).toBe(`vault:${HINDSIGHT_LITELLM_KEY_VAULT_REF}`);
  });

  it("asks for the per-service virtual key, NOT the proxy master key", async () => {
    // `litellm.admin_key` (vault:litellm/master-key) must never reach a service
    // container. Pinned against the doctor check's own copy of the ref so the
    // two constants cannot drift apart.
    const spy = vi.fn(async () => ({ kind: "ok", entry: { kind: "string", value: KEY } }));
    await resolveHindsightLiteLlm(enabled, { getViaBrokerStructured: spy as never });
    expect(spy).toHaveBeenCalledWith(HINDSIGHT_LITELLM_KEY_VAULT_REF, expect.anything());
    expect(HINDSIGHT_LITELLM_KEY_VAULT_REF).toBe(HINDSIGHT_KEY_VAULT_REF);
    expect(HINDSIGHT_LITELLM_KEY_VAULT_REF).not.toContain("master");
  });
});

describe("hindsightLiteLlmDroppedKeyWarning", () => {
  const ref = `vault:${HINDSIGHT_LITELLM_KEY_VAULT_REF}`;

  it("names the reference, the two vars, and the metering consequence", () => {
    const msg = hindsightLiteLlmDroppedKeyWarning(ref);
    expect(msg).toContain(ref);
    expect(msg).toContain("ANTHROPIC_BASE_URL");
    expect(msg).toContain("ANTHROPIC_CUSTOM_HEADERS");
    expect(msg).toMatch(/meter/i);
  });

  it("tells the operator this is NOT env drift — the misdiagnosis it exists to stop", () => {
    expect(hindsightLiteLlmDroppedKeyWarning(ref)).toMatch(/NOT operator env drift/);
    expect(hindsightLiteLlmDroppedKeyWarning(ref)).toMatch(/ENV DRIFT/);
  });

  it("never carries a secret — only the reference it was handed", () => {
    expect(hindsightLiteLlmDroppedKeyWarning(ref)).not.toContain(KEY);
    expect(hindsightLiteLlmDroppedKeyWarning(ref)).not.toContain("sk-");
  });
});
