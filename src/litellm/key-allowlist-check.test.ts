import { describe, it, expect } from "vitest";
import { runLitellmKeyAllowlistChecks } from "./key-allowlist-check.js";
import type { SwitchroomConfig } from "../config/schema.js";

/** The groups the proxy advertises on `/v1/models`. */
const PROXY_MODELS = [
  "gpt-oss-20b",
  "gpt-oss-20b-openrouter",
  "gpt-oss-20b-retain",
  "gpt-oss-20b-retain-openrouter",
  "gpt-oss-20b-consolidation",
  "gpt-oss-120b",
  "claude-sonnet-5-openrouter",
];

/** The allowlist the live key actually carried on 2026-07-26. */
const LIVE_ALLOWLIST_20260726 = [
  "gpt-oss-20b",
  "gpt-oss-20b-openrouter",
  "gpt-oss-120b",
  "claude-sonnet-5-openrouter",
];

/**
 * Three litellm-routed lanes presenting one declared key — the shape a fleet
 * has to be in for reachability to be checkable at all.
 *
 * Each op names its `api_key`, because a lane that declares none presents a
 * credential switchroom cannot identify (no global `HINDSIGHT_API_LLM_API_KEY`
 * is ever emitted, and the global `hindsight.llm` block has no `api_key` field
 * in the schema). That case has its own describe block below and must WARN, not
 * report on some other key.
 */
function cfg(over: Partial<SwitchroomConfig> = {}): SwitchroomConfig {
  return {
    litellm: {
      enabled: true,
      base_url: "http://proxy.local",
      admin_key: "vault:litellm/admin",
    },
    memory: { backend: "hindsight" },
    hindsight: {
      llm: {
        provider: "litellm",
        retain: { model: "openai/gpt-oss-20b-retain", api_key: "sk-lane" },
        reflect: { model: "openai/gpt-oss-20b", api_key: "sk-lane" },
        consolidation: {
          model: "openai/gpt-oss-20b-consolidation",
          api_key: "sk-lane",
        },
      },
    },
    ...over,
  } as unknown as SwitchroomConfig;
}

/**
 * A fetch stub covering both endpoints the check touches:
 * `/v1/models` (proxy inventory) and `/key/info` (the key's allowlist).
 */
function stubFetch(opts: {
  models?: string[];
  keyModels?: string[];
  modelsStatus?: number;
  keyStatus?: number;
  keyBody?: unknown;
  throwOn?: "models" | "key";
}) {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/models")) {
      if (opts.throwOn === "models") throw new Error("ECONNREFUSED");
      const status = opts.modelsStatus ?? 200;
      return new Response(
        JSON.stringify({ data: (opts.models ?? PROXY_MODELS).map((id) => ({ id })) }),
        { status, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("/key/info")) {
      if (opts.throwOn === "key") throw new Error("socket hang up");
      const status = opts.keyStatus ?? 200;
      const body =
        opts.keyBody ?? { info: { team_id: "t1", models: opts.keyModels ?? [] } };
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;
}

const SECRETS = {
  // The admin key resolves from the vault; a literal lane key passes through.
  resolveSecret: (ref: string) => (ref === "vault:litellm/admin" ? "sk-master" : ref),
};

describe("runLitellmKeyAllowlistChecks — the guard that must FAIL on the shipped bug", () => {
  it("FAILS when a config-declared model group is not in the key's allowlist", async () => {
    // The exact 2026-07-26 state. Before this check existed, doctor was green
    // while two declared, deployed, healthy lanes recorded zero traffic.
    const results = await runLitellmKeyAllowlistChecks(cfg(), {
      ...SECRETS,
      fetchFn: stubFetch({ keyModels: LIVE_ALLOWLIST_20260726 }),
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("fail");
    // Names the group AND the config key that declared it — an operator with
    // only the group name has to go hunting.
    expect(results[0]!.detail).toContain("gpt-oss-20b-retain");
    expect(results[0]!.detail).toContain("hindsight.llm.retain");
    expect(results[0]!.detail).toContain("gpt-oss-20b-consolidation");
    expect(results[0]!.detail).toContain("hindsight.llm.consolidation");
    // And explains WHY it was invisible, which is the whole point.
    expect(results[0]!.detail).toContain("key not allowed to access model");
  });

  it("passes once the key can reach every declared lane", async () => {
    const results = await runLitellmKeyAllowlistChecks(cfg(), {
      ...SECRETS,
      fetchFn: stubFetch({
        keyModels: [
          ...LIVE_ALLOWLIST_20260726,
          "gpt-oss-20b-retain",
          "gpt-oss-20b-consolidation",
        ],
      }),
    });
    expect(results[0]!.status).toBe("ok");
    expect(results[0]!.detail).toContain("3 declared model group(s) reachable");
  });

  it("does not demand the router's FALLBACK targets", async () => {
    // `gpt-oss-20b-retain-openrouter` is a fallback the router dispatches to
    // internally; it is never the model a client asks for, so it is never
    // checked by `can_key_call_model`. Demanding it would be an unfixable
    // false FAIL for any correctly-provisioned fleet.
    const results = await runLitellmKeyAllowlistChecks(cfg(), {
      ...SECRETS,
      fetchFn: stubFetch({
        keyModels: ["gpt-oss-20b", "gpt-oss-20b-retain", "gpt-oss-20b-consolidation"],
      }),
    });
    expect(results[0]!.status).toBe("ok");
  });

  it("treats an EMPTY allowlist as unrestricted, not as 'no models'", async () => {
    // LiteLLM's `[]` means "inherit team/proxy access". Reading it as
    // "reaches nothing" would FAIL every unrestricted fleet on day one.
    const results = await runLitellmKeyAllowlistChecks(cfg(), {
      ...SECRETS,
      fetchFn: stubFetch({ keyModels: [] }),
    });
    expect(results[0]!.status).toBe("ok");
    expect(results[0]!.detail).toContain("unrestricted");
  });

  it("treats a wildcard allowlist as unrestricted", async () => {
    const results = await runLitellmKeyAllowlistChecks(cfg(), {
      ...SECRETS,
      fetchFn: stubFetch({ keyModels: ["all-proxy-models"] }),
    });
    expect(results[0]!.status).toBe("ok");
  });
});

describe("runLitellmKeyAllowlistChecks — availability discipline", () => {
  it("WARNs, never fails, when the proxy is unreachable", async () => {
    const results = await runLitellmKeyAllowlistChecks(cfg(), {
      ...SECRETS,
      fetchFn: stubFetch({ throwOn: "models" }),
    });
    expect(results[0]!.status).toBe("warn");
    expect(results[0]!.detail).toContain("unreachable");
  });

  it("WARNs when /key/info cannot be read", async () => {
    const results = await runLitellmKeyAllowlistChecks(cfg(), {
      ...SECRETS,
      fetchFn: stubFetch({ throwOn: "key" }),
    });
    expect(results[0]!.status).toBe("warn");
  });

  it("WARNs when the admin key cannot be resolved from the vault", async () => {
    const results = await runLitellmKeyAllowlistChecks(cfg(), {
      resolveSecret: () => null,
      fetchFn: stubFetch({}),
    });
    expect(results[0]!.status).toBe("warn");
    expect(results[0]!.detail).toContain("admin_key");
  });

  it("WARNs when the lane's own api_key cannot be resolved", async () => {
    const results = await runLitellmKeyAllowlistChecks(cfg(), {
      resolveSecret: (ref) => (ref === "vault:litellm/admin" ? "sk-master" : null),
      fetchFn: stubFetch({}),
    });
    expect(results[0]!.status).toBe("warn");
    expect(results[0]!.detail).toContain("could not resolve");
    expect(results.some((r) => r.status === "ok")).toBe(false);
  });

  it("WARNs (does not double-report) when the proxy does not know the key", async () => {
    // DB drift is a real defect, but it belongs to the key-provisioning
    // check, which has the right remedy. Saying it twice in two vocabularies
    // is worse than saying it once.
    const results = await runLitellmKeyAllowlistChecks(cfg(), {
      ...SECRETS,
      fetchFn: stubFetch({ keyStatus: 400, keyBody: { error: "Invalid proxy server token" } }),
    });
    expect(results[0]!.status).toBe("warn");
    expect(results[0]!.status).not.toBe("fail");
  });

  it("WARNs when base_url or admin_key is unset", async () => {
    const results = await runLitellmKeyAllowlistChecks(
      cfg({ litellm: { enabled: true } } as unknown as Partial<SwitchroomConfig>),
      { ...SECRETS, fetchFn: stubFetch({}) },
    );
    expect(results[0]!.status).toBe("warn");
  });
});

/**
 * The check is only worth its FAIL if it inspects the key the failing lane
 * PRESENTS. A `provider: litellm` op sends `hindsight.llm.<op>.api_key`
 * (`HINDSIGHT_API_<OP>_LLM_API_KEY`); the provisioned `litellm/hindsight/api-key`
 * authenticates the claude-code passthrough. On a live fleet those were already
 * two different keys, so reading the provisioned one and reporting OK is a false
 * negative on exactly the silent-unreachable-lane defect this check exists for.
 */
describe("runLitellmKeyAllowlistChecks — which key gets checked", () => {
  /** `/key/info?key=…` — answer per key, so "wrong key" is observable. */
  const perKeyFetch = (byKey: Record<string, string[]>) =>
    (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/models")) {
        return new Response(JSON.stringify({ data: PROXY_MODELS.map((id) => ({ id })) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const key = decodeURIComponent(new URL(u).searchParams.get("key") ?? "");
      return new Response(
        JSON.stringify({ info: { team_id: "t1", models: byKey[key] ?? [] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

  it("FAILS on the lane key even when the provisioned service key is healthy", async () => {
    const results = await runLitellmKeyAllowlistChecks(
      cfg({
        hindsight: {
          llm: {
            provider: "litellm",
            model: "openai/gpt-oss-20b",
            retain: { model: "openai/gpt-oss-20b-retain", api_key: "sk-lane" },
          },
        },
      } as unknown as Partial<SwitchroomConfig>),
      {
        resolveSecret: (ref) => (ref === "sk-lane" ? "sk-lane" : "sk-master"),
        // The provisioned key reaches everything; the key the retain lane
        // actually presents reaches nothing. Reading only the former is green
        // on a dead lane.
        fetchFn: perKeyFetch({
          "sk-hindsight": ["gpt-oss-20b", "gpt-oss-20b-retain"],
          "sk-lane": ["gpt-oss-20b"],
        }),
      },
    );
    const failed = results.filter((r) => r.status === "fail");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.detail).toContain("gpt-oss-20b-retain");
    expect(failed[0]!.detail).toContain("hindsight.llm.retain");
    expect(failed[0]!.name).toContain("hindsight.llm.retain");
  });

  it("resolves a `vault:` api_key instead of probing the reference verbatim", async () => {
    const seen: string[] = [];
    const results = await runLitellmKeyAllowlistChecks(
      cfg({
        hindsight: {
          llm: {
            provider: "litellm",
            retain: { model: "openai/gpt-oss-20b-retain", api_key: "vault:litellm/lane" },
          },
        },
      } as unknown as Partial<SwitchroomConfig>),
      {
        resolveSecret: (ref) => {
          seen.push(ref);
          return ref === "vault:litellm/lane" ? "sk-lane-real" : "sk-master";
        },
        fetchFn: perKeyFetch({ "sk-lane-real": ["gpt-oss-20b-retain"] }),
      },
    );
    expect(seen).toContain("vault:litellm/lane");
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("WARNs — never claims OK — when a lane's api_key cannot be resolved", async () => {
    const results = await runLitellmKeyAllowlistChecks(
      cfg({
        hindsight: {
          llm: {
            provider: "litellm",
            retain: { model: "openai/gpt-oss-20b-retain", api_key: "vault:missing" },
          },
        },
      } as unknown as Partial<SwitchroomConfig>),
      {
        resolveSecret: (ref) => (ref === "vault:missing" ? null : "sk-master"),
        fetchFn: perKeyFetch({}),
      },
    );
    expect(results.some((r) => r.status === "warn")).toBe(true);
    expect(results.some((r) => r.status === "ok")).toBe(false);
  });
});

/**
 * The third credential case, and the one that is easiest to get backwards.
 *
 * A `provider: litellm` op that declares no `api_key` does NOT fall back to the
 * provisioned service key. Verified against the running stack:
 *  - switchroom emits `HINDSIGHT_API_<OP>_LLM_API_KEY` only for an op that
 *    declares one, and never a global `HINDSIGHT_API_LLM_API_KEY`
 *    (`resolveHindsightPerOpLlm`; `src/cli/setup.ts` calls the global name "no
 *    longer used"). The live container has `HINDSIGHT_API_LLM_MODEL` and
 *    `_PROVIDER` and no `_API_KEY`.
 *  - hindsight reads the global as a bare `os.getenv(ENV_LLM_API_KEY)` with no
 *    default (`config.py`, `llm_api_key=`), and `litellm` is in the engine's
 *    `_PROVIDERS_WITHOUT_API_KEY`, so nothing raises to make the gap visible.
 *  - the provider then omits it entirely (`if self.api_key:` in
 *    `engine/providers/litellm_llm.py`).
 *  - the provisioned `litellm/hindsight/api-key` is injected ONLY as the
 *    `ANTHROPIC_CUSTOM_HEADERS` bearer (`src/setup/hindsight.ts`), i.e. for the
 *    claude-code passthrough — a lane `can_key_call_model` never sees.
 *
 * So verifying that key here would report OK (or FAIL) about a key the lane
 * never sends: the same false attribution this check exists to remove, aimed
 * the other way.
 */
describe("runLitellmKeyAllowlistChecks — a lane that declares no api_key", () => {
  const noKeyCfg = () =>
    cfg({
      hindsight: {
        llm: {
          provider: "litellm",
          model: "openai/gpt-oss-20b",
          retain: { model: "openai/gpt-oss-20b-retain" },
        },
      },
    } as unknown as Partial<SwitchroomConfig>);

  it("WARNs, and never FAILs, instead of reporting on the service key", async () => {
    // The stub would answer /key/info for ANY key with an allowlist missing
    // `gpt-oss-20b-retain`. A check that probed a key here would FAIL.
    const results = await runLitellmKeyAllowlistChecks(noKeyCfg(), {
      ...SECRETS,
      fetchFn: stubFetch({ keyModels: LIVE_ALLOWLIST_20260726 }),
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("warn");
    expect(results[0]!.status).not.toBe("fail");
  });

  it("never probes a key on the lane's behalf", async () => {
    // The observable half: no /key/info request at all. Under the old
    // "fall back to the service key" model this fired once per keyless demand.
    const seen: string[] = [];
    await runLitellmKeyAllowlistChecks(noKeyCfg(), {
      ...SECRETS,
      fetchFn: (async (url: string | URL) => {
        const u = String(url);
        seen.push(u);
        return new Response(
          JSON.stringify({ data: PROXY_MODELS.map((id) => ({ id })) }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    expect(seen.some((u) => u.includes("/key/info"))).toBe(false);
  });

  it("names the lanes and the config that would make them checkable", async () => {
    const results = await runLitellmKeyAllowlistChecks(noKeyCfg(), {
      ...SECRETS,
      fetchFn: stubFetch({ keyModels: LIVE_ALLOWLIST_20260726 }),
    });
    const d = results[0]!.detail;
    expect(d).toContain("hindsight.llm.retain");
    expect(d).toContain("gpt-oss-20b-retain");
    expect(d).toContain("declare no `api_key`");
    expect(d).toContain("hindsight.llm.<op>.api_key");
    // And explicitly denies the fallback, so nobody re-derives the wrong model.
    expect(d).toContain("is NOT the fallback");
  });

  it("still reports honestly on a sibling lane that DOES declare a key", async () => {
    const results = await runLitellmKeyAllowlistChecks(
      cfg({
        hindsight: {
          llm: {
            provider: "litellm",
            model: "openai/gpt-oss-20b", // keyless global lane
            retain: { model: "openai/gpt-oss-20b-retain", api_key: "sk-lane" },
          },
        },
      } as unknown as Partial<SwitchroomConfig>),
      { ...SECRETS, fetchFn: stubFetch({ keyModels: LIVE_ALLOWLIST_20260726 }) },
    );
    expect(results).toHaveLength(2);
    expect(results.filter((r) => r.status === "warn")).toHaveLength(1);
    const failed = results.filter((r) => r.status === "fail");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.detail).toContain("gpt-oss-20b-retain");
  });
});

describe("runLitellmKeyAllowlistChecks — allowlist postures the proxy actually has", () => {
  it("WARNs on `all-team-models` — it can neither confirm nor deny reachability", async () => {
    // The proxy swaps the sentinel for the parent TEAM's allowlist before
    // comparing (`_resolve_key_models_for_auth_check`, auth_checks.py:2940),
    // and this check never reads the team row. FAIL would be a fabricated
    // outage; OK would hide a real one.
    const results = await runLitellmKeyAllowlistChecks(cfg(), {
      ...SECRETS,
      fetchFn: stubFetch({ keyModels: ["all-team-models"] }),
    });
    expect(results[0]!.status).toBe("warn");
    expect(results[0]!.detail).toContain("all-team-models");
  });

  it("does not FAIL a key granted by wildcard pattern", async () => {
    // `gpt-oss-20b*` covers every declared lane via
    // `is_model_allowed_by_pattern` (auth_checks.py:4277). Treating the entry
    // as a literal invents a FAIL on a correctly-provisioned fleet.
    const results = await runLitellmKeyAllowlistChecks(cfg(), {
      ...SECRETS,
      fetchFn: stubFetch({ keyModels: ["gpt-oss-20b*"] }),
    });
    expect(results[0]!.status).toBe("ok");
  });
});

describe("runLitellmKeyAllowlistChecks — scope", () => {
  it("is silent for a fleet with no litellm carve-out", async () => {
    const results = await runLitellmKeyAllowlistChecks(
      cfg({ litellm: { enabled: false } } as unknown as Partial<SwitchroomConfig>),
      { ...SECRETS, fetchFn: stubFetch({}) },
    );
    expect(results).toEqual([]);
  });

  it("is silent for a fleet not on the hindsight backend", async () => {
    const results = await runLitellmKeyAllowlistChecks(
      cfg({ memory: { backend: "none" } } as unknown as Partial<SwitchroomConfig>),
      { ...SECRETS, fetchFn: stubFetch({}) },
    );
    expect(results).toEqual([]);
  });

  it("reports OK, not FAIL, when nothing litellm-routed is declared", async () => {
    const results = await runLitellmKeyAllowlistChecks(
      cfg({
        hindsight: { llm: { provider: "claude-code", model: "claude-sonnet-5" } },
      } as unknown as Partial<SwitchroomConfig>),
      { ...SECRETS, fetchFn: stubFetch({ keyModels: LIVE_ALLOWLIST_20260726 }) },
    );
    expect(results[0]!.status).toBe("ok");
  });
});
