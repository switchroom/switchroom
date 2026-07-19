import { describe, it, expect } from "vitest";
import {
  isExplicitLitellmRoute,
  collectReferencedModels,
  validateModelReferences,
  classifyModelReferences,
  fetchProxyModels,
  runLitellmModelChecks,
  type ModelReference,
} from "../src/litellm/model-validation.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

/** Minimal config builder — cast through unknown so tests stay terse without
 *  restating the whole (large) schema shape. */
function cfg(partial: Record<string, unknown>): SwitchroomConfig {
  return partial as unknown as SwitchroomConfig;
}

describe("isExplicitLitellmRoute", () => {
  it("treats provider-prefixed ids (with `/`) as explicit routes", () => {
    expect(isExplicitLitellmRoute("openrouter/google/gemini-3.1-flash-lite")).toBe(true);
    expect(isExplicitLitellmRoute("anthropic/claude-sonnet-5")).toBe(true);
  });
  it("excludes bare CLI aliases (no `/`) — passthrough-served, would false-positive", () => {
    expect(isExplicitLitellmRoute("sonnet")).toBe(false);
    expect(isExplicitLitellmRoute("opus")).toBe(false);
    expect(isExplicitLitellmRoute("claude-sonnet-5")).toBe(false);
  });
});

describe("collectReferencedModels", () => {
  it("returns [] when the litellm carve-out is off", () => {
    const c = cfg({
      litellm: { enabled: false },
      hindsight: { llm: { model: "openrouter/x/y" } },
    });
    expect(collectReferencedModels(c)).toEqual([]);
  });

  it("collects hindsight global + per-op models verbatim when enabled", () => {
    const c = cfg({
      litellm: { enabled: true, base_url: "http://p:4010", admin_key: "sk-master" },
      hindsight: {
        llm: {
          model: "openrouter/google/gemini-3.1-flash-lite",
          retain: { model: "claude-haiku-5" },
          reflect: { model: "openrouter/z-ai/glm-5.2" },
          consolidation: {},
        },
      },
    });
    const refs = collectReferencedModels(c);
    expect(refs).toEqual([
      { model: "openrouter/google/gemini-3.1-flash-lite", consumer: "hindsight.llm.model (global)" },
      { model: "claude-haiku-5", consumer: "hindsight.llm.retain" },
      { model: "openrouter/z-ai/glm-5.2", consumer: "hindsight.llm.reflect" },
    ]);
  });

  it("collects only explicit-route agent pins (with `/`), skipping bare aliases", () => {
    const c = cfg({
      litellm: { enabled: true, base_url: "http://p:4010", admin_key: "sk" },
      agents: {
        clerk: { model: "openrouter/z-ai/glm-5.2", fallback_model: "sonnet" },
        scribe: { model: "opus" },
        router: { fallback_model: "openrouter/x/fallback" },
      },
    });
    const refs = collectReferencedModels(c);
    expect(refs).toEqual([
      { model: "openrouter/z-ai/glm-5.2", consumer: "agents.clerk.model" },
      { model: "openrouter/x/fallback", consumer: "agents.router.fallback_model" },
    ]);
  });

  it("skips an agent that opted out with litellm.enabled: false", () => {
    const c = cfg({
      litellm: { enabled: true, base_url: "http://p", admin_key: "sk" },
      agents: {
        offgrid: { model: "openrouter/a/b", litellm: { enabled: false } },
        online: { model: "openrouter/c/d" },
      },
    });
    const refs = collectReferencedModels(c);
    expect(refs.map((r) => r.consumer)).toEqual(["agents.online.model"]);
  });
});

describe("validateModelReferences", () => {
  const refs: ModelReference[] = [
    { model: "openrouter/gemini", consumer: "hindsight.llm.model (global)" },
    { model: "openrouter/gemini", consumer: "hindsight.llm.retain" },
    { model: "claude-sonnet-5", consumer: "agents.clerk.model" },
  ];
  it("groups a missing model with ALL its consumers, deduped", () => {
    const missing = validateModelReferences(refs, new Set(["claude-sonnet-5"]));
    expect(missing).toEqual([
      {
        model: "openrouter/gemini",
        consumers: ["hindsight.llm.model (global)", "hindsight.llm.retain"],
      },
    ]);
  });
  it("returns [] when every reference is present", () => {
    const present = new Set(["openrouter/gemini", "claude-sonnet-5"]);
    expect(validateModelReferences(refs, present)).toEqual([]);
  });
});

describe("classifyModelReferences", () => {
  it("OK names the count when nothing is missing", () => {
    const r = classifyModelReferences([], 3);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("3");
  });
  it("FAIL names the model and its consumers", () => {
    const r = classifyModelReferences(
      [{ model: "openrouter/gemini", consumers: ["hindsight.llm.model (global)"] }],
      2,
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("openrouter/gemini");
    expect(r.detail).toContain("hindsight.llm.model (global)");
    expect(r.fix).toContain("model_list");
  });
});

describe("fetchProxyModels", () => {
  const okResponse = (ids: string[]) =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ data: ids.map((id) => ({ id })) }),
    }) as unknown as Response;

  it("parses the OpenAI-format id list and sends a Bearer auth header", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const res = await fetchProxyModels("http://proxy:4010/", "sk-master", async (url, init) => {
      seenUrl = url;
      seenAuth = (init?.headers?.Authorization as string) ?? "";
      return okResponse(["sonnet", "openrouter/gemini"]);
    });
    expect(seenUrl).toBe("http://proxy:4010/v1/models"); // trailing slash normalized
    expect(seenAuth).toBe("Bearer sk-master");
    expect(res).toEqual({ kind: "ok", models: ["sonnet", "openrouter/gemini"] });
  });

  it("degrades a non-200 to unreachable (never throws)", async () => {
    const res = await fetchProxyModels("http://p", "sk", async () =>
      ({ ok: false, status: 401 }) as unknown as Response,
    );
    expect(res.kind).toBe("unreachable");
    expect(res.kind === "unreachable" && res.msg).toContain("401");
  });

  it("degrades a network error to unreachable", async () => {
    const res = await fetchProxyModels("http://p", "sk", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(res).toEqual({ kind: "unreachable", msg: "ECONNREFUSED" });
  });

  it("degrades a malformed body (no data array) to unreachable", async () => {
    const res = await fetchProxyModels("http://p", "sk", async () =>
      ({ ok: true, status: 200, json: async () => ({ oops: true }) }) as unknown as Response,
    );
    expect(res.kind).toBe("unreachable");
  });
});

describe("runLitellmModelChecks (orchestration)", () => {
  const baseCfg = (extra: Record<string, unknown> = {}) =>
    cfg({
      litellm: { enabled: true, base_url: "http://p:4010", admin_key: "vault:litellm/master-key" },
      hindsight: { llm: { model: "openrouter/google/gemini-3.1-flash-lite" } },
      ...extra,
    });

  it("returns [] when there are no references (litellm off)", async () => {
    const out = await runLitellmModelChecks(cfg({ litellm: { enabled: false } }), {
      resolveSecret: () => "sk",
    });
    expect(out).toEqual([]);
  });

  it("WARNs when base_url/admin_key is unresolved", async () => {
    const out = await runLitellmModelChecks(
      cfg({
        litellm: { enabled: true },
        hindsight: { llm: { model: "openrouter/x/y" } },
      }),
      { resolveSecret: () => "sk" },
    );
    expect(out[0].status).toBe("warn");
    expect(out[0].detail).toContain("unresolved");
  });

  it("WARNs when the admin_key can't be resolved to a secret", async () => {
    const out = await runLitellmModelChecks(baseCfg(), { resolveSecret: () => null });
    expect(out[0].status).toBe("warn");
    expect(out[0].detail).toContain("admin_key");
  });

  it("WARNs (never fails) when the proxy is unreachable", async () => {
    const out = await runLitellmModelChecks(baseCfg(), {
      resolveSecret: () => "sk-master",
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(out[0].status).toBe("warn");
    expect(out[0].detail).toContain("unreachable");
  });

  it("FAILs loudly, naming the missing model + consumer, on real drift", async () => {
    const out = await runLitellmModelChecks(baseCfg(), {
      resolveSecret: () => "sk-master",
      // proxy no longer lists the gemini model (the degemini edit)
      fetchFn: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "claude-sonnet-5" }, { id: "sonnet" }] }),
        }) as unknown as Response,
    });
    expect(out[0].status).toBe("fail");
    expect(out[0].detail).toContain("openrouter/google/gemini-3.1-flash-lite");
    expect(out[0].detail).toContain("hindsight.llm.model (global)");
  });

  it("is OK when the proxy lists every referenced model", async () => {
    const out = await runLitellmModelChecks(baseCfg(), {
      resolveSecret: () => "sk-master",
      fetchFn: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "openrouter/google/gemini-3.1-flash-lite" }] }),
        }) as unknown as Response,
    });
    expect(out[0].status).toBe("ok");
  });

  it("passes the resolved admin_key vault ref through resolveSecret", async () => {
    let seenRef = "";
    await runLitellmModelChecks(baseCfg(), {
      resolveSecret: (ref) => {
        seenRef = ref;
        return "sk-master";
      },
      fetchFn: async () =>
        ({ ok: true, status: 200, json: async () => ({ data: [] }) }) as unknown as Response,
    });
    expect(seenRef).toBe("vault:litellm/master-key");
  });
});
