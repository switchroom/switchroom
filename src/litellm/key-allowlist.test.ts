import { describe, it, expect } from "vitest";
import {
  modelCandidates,
  resolveGroup,
  requiredKeyModels,
  requiredKeyDemands,
  isUnrestrictedAllowlist,
  classifyAllowlist,
  allowlistCovers,
  unreachableModels,
  reconciledAllowlist,
} from "./key-allowlist.js";
import type { SwitchroomConfig } from "../config/schema.js";

/**
 * The exact live state on 2026-07-26, which is what these tests are FOR.
 *
 * The hindsight virtual key carried this allowlist while `switchroom.yaml`
 * declared `gpt-oss-20b-retain` and `gpt-oss-20b-consolidation` as the retain
 * and consolidation models. Both groups existed in the proxy and served
 * nobody: every request to them was rejected at request auth with
 * `key not allowed to access model`, so the lanes recorded ZERO calls since
 * creation. Not unused — unreachable, silently, for weeks.
 */
const LIVE_ALLOWLIST_20260726 = [
  "gpt-oss-20b",
  "gpt-oss-20b-openrouter",
  "gpt-oss-120b",
  "claude-sonnet-5-openrouter",
];

/** The groups the proxy actually advertises on `/v1/models`. */
const PROXY_MODELS = new Set([
  "gpt-oss-20b",
  "gpt-oss-20b-openrouter",
  "gpt-oss-20b-retain",
  "gpt-oss-20b-retain-openrouter",
  "gpt-oss-20b-consolidation",
  "gpt-oss-20b-consolidation-openrouter",
  "gpt-oss-120b",
  "claude-sonnet-5-openrouter",
  "openrouter/openai/gpt-oss-20b",
]);

/** The live config shape: litellm on, hindsight backend, per-op overrides. */
function liveConfig(over: Record<string, unknown> = {}): SwitchroomConfig {
  return {
    litellm: { enabled: true },
    memory: { backend: "hindsight" },
    hindsight: {
      llm: {
        provider: "litellm",
        model: "openai/gpt-oss-20b",
        retain: { model: "openai/gpt-oss-20b-retain" },
        consolidation: { model: "openai/gpt-oss-20b-consolidation" },
        ...over,
      },
    },
  } as unknown as SwitchroomConfig;
}

describe("modelCandidates", () => {
  it("offers the verbatim value first, then the provider-stripped one", () => {
    expect(modelCandidates("openai/gpt-oss-20b-retain")).toEqual([
      "openai/gpt-oss-20b-retain",
      "gpt-oss-20b-retain",
    ]);
  });

  it("leaves a bare model id alone", () => {
    expect(modelCandidates("gpt-oss-20b")).toEqual(["gpt-oss-20b"]);
  });

  it("strips exactly ONE segment, so nested provider ids survive", () => {
    // `openrouter/openai/gpt-oss-20b` is a real group in this fleet. Greedy
    // stripping would invent `gpt-oss-20b`, a DIFFERENT group with a
    // different deployment and a different timeout.
    expect(modelCandidates("openrouter/openai/gpt-oss-20b")).toEqual([
      "openrouter/openai/gpt-oss-20b",
      "openai/gpt-oss-20b",
    ]);
  });

  it("does not invent candidates from degenerate values", () => {
    expect(modelCandidates("")).toEqual([]);
    expect(modelCandidates("   ")).toEqual([]);
    expect(modelCandidates("/leading")).toEqual(["/leading"]);
    expect(modelCandidates("trailing/")).toEqual(["trailing/"]);
  });
});

describe("resolveGroup", () => {
  it("prefers an exact proxy match over the stripped spelling", () => {
    const proxy = new Set(["openrouter/openai/gpt-oss-20b", "openai/gpt-oss-20b"]);
    expect(resolveGroup("openrouter/openai/gpt-oss-20b", proxy)).toBe(
      "openrouter/openai/gpt-oss-20b",
    );
  });

  it("falls back to the provider-stripped spelling the proxy actually serves", () => {
    expect(resolveGroup("openai/gpt-oss-20b-retain", PROXY_MODELS)).toBe(
      "gpt-oss-20b-retain",
    );
  });

  it("returns null when the proxy serves neither spelling", () => {
    // A model the proxy does not have at all is #3407's defect, not this
    // module's — reporting it here would produce a second, worse message.
    expect(resolveGroup("openai/does-not-exist", PROXY_MODELS)).toBeNull();
  });
});

describe("requiredKeyModels", () => {
  it("derives every litellm-routed hindsight lane from switchroom.yaml", () => {
    const required = requiredKeyModels(liveConfig(), PROXY_MODELS);
    expect(required.map((r) => r.group).sort()).toEqual([
      "gpt-oss-20b",
      "gpt-oss-20b-consolidation",
      "gpt-oss-20b-retain",
    ]);
    // The consumer is named so the operator can find the declaration.
    expect(required.find((r) => r.group === "gpt-oss-20b-retain")?.consumer).toBe(
      "hindsight.llm.retain",
    );
  });

  it("does NOT demand a grant for an op routed away from the proxy", () => {
    // `consolidation` sat on provider: claude-code for three days in July
    // 2026. That lane reaches Anthropic through the OAuth passthrough with
    // the caller's own header and never presents the virtual key, so
    // demanding an allowlist entry for it is a false positive — and a check
    // that cries wolf is a check the operator learns to ignore.
    const required = requiredKeyModels(
      liveConfig({
        consolidation: { model: "claude-sonnet-5", provider: "claude-code" },
      }),
      PROXY_MODELS,
    );
    expect(required.map((r) => r.group)).not.toContain("gpt-oss-20b-consolidation");
    expect(required.map((r) => r.group)).toContain("gpt-oss-20b-retain");
  });

  it("does not require router FALLBACK targets", () => {
    // Verified against the running proxy (LiteLLM v1.91.0):
    // `can_key_call_model` (auth_checks.py:2959) is reached only from
    // `user_api_key_auth.py:2690` — REQUEST auth, on the model the client
    // asked for. The router's fallback dispatch does not re-enter it, and
    // `Router._filter_deployments_by_model_access_groups` (router.py:10052)
    // returns candidates unchanged when the requested model is allowed.
    // So the allowlist stays exactly as narrow as the config.
    const groups = requiredKeyModels(liveConfig(), PROXY_MODELS).map((r) => r.group);
    expect(groups).not.toContain("gpt-oss-20b-retain-openrouter");
    expect(groups).not.toContain("gpt-oss-20b-openrouter");
  });

  it("is silent when there is no proxy, no hindsight, or no llm block", () => {
    expect(
      requiredKeyModels(
        { ...liveConfig(), litellm: { enabled: false } } as SwitchroomConfig,
        PROXY_MODELS,
      ),
    ).toEqual([]);
    expect(
      requiredKeyModels(
        { ...liveConfig(), memory: { backend: "none" } } as unknown as SwitchroomConfig,
        PROXY_MODELS,
      ),
    ).toEqual([]);
    expect(requiredKeyModels({} as SwitchroomConfig, PROXY_MODELS)).toEqual([]);
  });

  it("inherits the global provider for an op that does not set one", () => {
    // A per-op block that overrides only `model` still routes through
    // whatever the global provider says.
    const off = requiredKeyModels(
      liveConfig({ provider: "claude-code" }),
      PROXY_MODELS,
    );
    expect(off).toEqual([]);
  });
});

describe("isUnrestrictedAllowlist", () => {
  it("treats empty / wildcard / all-proxy-models as unrestricted", () => {
    // Getting this backwards fires the check on every unrestricted key,
    // which is the fastest way to train an operator to ignore it.
    expect(isUnrestrictedAllowlist([])).toBe(true);
    expect(isUnrestrictedAllowlist(["*"])).toBe(true);
    expect(isUnrestrictedAllowlist(["all-proxy-models"])).toBe(true);
    expect(isUnrestrictedAllowlist(["gpt-oss-20b", "*"])).toBe(true);
  });

  it("treats a concrete list as restricted", () => {
    expect(isUnrestrictedAllowlist(LIVE_ALLOWLIST_20260726)).toBe(false);
  });
});

/**
 * These pin the checker to what the PROXY actually enforces. A checker stricter
 * than the thing it checks does not fail safe — it fails LOUD and wrong, and an
 * operator who sees one bogus FAIL stops reading the section that was supposed
 * to catch a silent outage.
 *
 * Ground truth, read out of the running proxy (LiteLLM v1.91.0):
 * `_check_model_access_helper` (auth_checks.py:2808),
 * `_resolve_key_models_for_auth_check` (:2940),
 * `is_model_allowed_by_pattern` (:4277), `_is_wildcard_pattern` (:4346),
 * and `SpecialModelNames` (proxy/_types.py:2876).
 */
describe("classifyAllowlist — parity with the proxy's own predicate", () => {
  it("calls `all-team-models` INDETERMINATE, not restricted and not unrestricted", () => {
    // The proxy REPLACES the list with the parent team's before comparing, so
    // the effective allowlist is not on the row this module reads. Calling it
    // restricted invents a FAIL on a healthy fleet; calling it unrestricted
    // hides the very defect the check exists for.
    expect(classifyAllowlist(["all-team-models"])).toBe("indeterminate");
    expect(classifyAllowlist(["gpt-oss-20b", "all-team-models"])).toBe("indeterminate");
  });

  it("still recognises the genuinely unrestricted spellings", () => {
    expect(classifyAllowlist([])).toBe("unrestricted");
    expect(classifyAllowlist(["*"])).toBe("unrestricted");
    expect(classifyAllowlist(["all-proxy-models"])).toBe("unrestricted");
  });

  it("lets the team sentinel DOMINATE an accompanying `*` — it replaces, not merges", () => {
    // Read out of the running proxy, `_resolve_key_models_for_auth_check`:
    //
    //   if SpecialModelNames.all_team_models.value in models:
    //       if valid_token.team_id is None: return []
    //       return list(valid_token.team_models or [])
    //
    // It RETURNS EARLY. Every other entry — `"*"` and `all-proxy-models`
    // included — is thrown away before `_check_model_access_helper` ever looks
    // for them, so a key on a team with a narrow `team_models` is NOT
    // unrestricted no matter what else its own row says. Classifying this as
    // unrestricted is the unsafe direction: it reports a lane reachable that
    // the proxy would reject at auth. Ordering inside `classifyAllowlist` is
    // therefore load-bearing, not stylistic.
    expect(classifyAllowlist(["all-team-models", "*"])).toBe("indeterminate");
    expect(classifyAllowlist(["*", "all-team-models"])).toBe("indeterminate");
    expect(classifyAllowlist(["all-proxy-models", "all-team-models"])).toBe("indeterminate");
  });

  it("reports no findings and writes nothing for an indeterminate allowlist", () => {
    const required = requiredKeyModels(liveConfig(), PROXY_MODELS);
    expect(unreachableModels(required, ["all-team-models"])).toEqual([]);
    // Load-bearing: appending to a list carrying the sentinel is DISCARDED by
    // `_resolve_key_models_for_auth_check`, so the write would report "granted"
    // while granting nothing.
    expect(reconciledAllowlist(["all-team-models"], required)).toBeNull();
  });
});

describe("allowlistCovers — wildcard entries are patterns, not literals", () => {
  it("matches a provider wildcard the way the proxy does", () => {
    expect(allowlistCovers(["openrouter/*"], "openrouter/openai/gpt-oss-20b")).toBe(true);
    expect(allowlistCovers(["gpt-oss-20b-*"], "gpt-oss-20b-retain")).toBe(true);
    expect(allowlistCovers(["bedrock/*"], "bedrockzzzz/nova")).toBe(false);
  });

  it("still requires an exact match for a non-wildcard entry", () => {
    expect(allowlistCovers(["gpt-oss-20b"], "gpt-oss-20b")).toBe(true);
    expect(allowlistCovers(["gpt-oss-20b"], "gpt-oss-20b-retain")).toBe(false);
  });

  it("does not throw on an entry that is not valid regex", () => {
    // Raw interpolation (what the proxy does) would blow up here; a checker
    // that throws takes the whole doctor section down with it.
    expect(() => allowlistCovers(["gpt-4(o*"], "gpt-4o")).not.toThrow();
  });

  it("stops a wildcard-granted key being reported as unreachable", () => {
    const required = requiredKeyModels(liveConfig(), PROXY_MODELS);
    expect(unreachableModels(required, ["gpt-oss-20b*"])).toEqual([]);
    expect(reconciledAllowlist(["gpt-oss-20b*"], required)).toBeNull();
  });
});

/**
 * A `provider: litellm` op presents `hindsight.llm.<op>.api_key`
 * (`HINDSIGHT_API_<OP>_LLM_API_KEY`), NOT the provisioned
 * `litellm/hindsight/api-key` — that one authenticates the claude-code
 * passthrough. Two different keys on a live fleet, so the unit of work has to
 * be (key, lanes).
 *
 * And an op that declares no `api_key` is a THIRD case: `null` here means
 * UNKNOWN, not the service key. Nothing emits a global
 * `HINDSIGHT_API_LLM_API_KEY`, so such a lane presents no credential this
 * module can name; consumers must warn rather than act on another key.
 */
describe("requiredKeyDemands — group by the key that must reach the lane", () => {
  it("carries the api_key each op is configured to present", () => {
    const required = requiredKeyModels(
      liveConfig({
        retain: { model: "openai/gpt-oss-20b-retain", api_key: "sk-lane" },
      }),
      PROXY_MODELS,
    );
    expect(required.find((r) => r.group === "gpt-oss-20b-retain")?.apiKeyRef).toBe("sk-lane");
    // The global block has no `api_key` field in the schema, so the global lane
    // is always `null` — UNKNOWN, not "the provisioned service key". Callers
    // must warn on it rather than reconciling or failing another key by proxy.
    expect(required.find((r) => r.group === "gpt-oss-20b")?.apiKeyRef).toBeNull();
  });

  it("splits lanes across the distinct keys that serve them", () => {
    const demands = requiredKeyDemands(
      requiredKeyModels(
        liveConfig({
          retain: { model: "openai/gpt-oss-20b-retain", api_key: "sk-retain" },
          consolidation: {
            model: "openai/gpt-oss-20b-consolidation",
            api_key: "sk-consolidation",
          },
        }),
        PROXY_MODELS,
      ),
    );
    expect(new Set(demands.map((d) => d.apiKeyRef))).toEqual(
      new Set([null, "sk-retain", "sk-consolidation"]),
    );
    const retain = demands.find((d) => d.apiKeyRef === "sk-retain")!;
    expect(retain.required.map((r) => r.group)).toEqual(["gpt-oss-20b-retain"]);
    expect(retain.declaredBy).toEqual(["hindsight.llm.retain"]);
  });

  it("collapses ops that share one key into a single demand", () => {
    const demands = requiredKeyDemands(
      requiredKeyModels(
        liveConfig({
          retain: { model: "openai/gpt-oss-20b-retain", api_key: "sk-shared" },
          consolidation: {
            model: "openai/gpt-oss-20b-consolidation",
            api_key: "sk-shared",
          },
        }),
        PROXY_MODELS,
      ),
    );
    const shared = demands.find((d) => d.apiKeyRef === "sk-shared")!;
    expect(shared.required.map((r) => r.group).sort()).toEqual([
      "gpt-oss-20b-consolidation",
      "gpt-oss-20b-retain",
    ]);
    expect(shared.declaredBy).toEqual([
      "hindsight.llm.retain",
      "hindsight.llm.consolidation",
    ]);
  });

  it("treats a blank api_key as 'declares none', not as a key called ''", () => {
    const required = requiredKeyModels(
      liveConfig({ retain: { model: "openai/gpt-oss-20b-retain", api_key: "   " } }),
      PROXY_MODELS,
    );
    expect(required.find((r) => r.group === "gpt-oss-20b-retain")?.apiKeyRef).toBeNull();
  });
});

describe("unreachableModels — the guard that must FAIL on the shipped bug", () => {
  it("reports the exact lanes that were silently unreachable on 2026-07-26", () => {
    const required = requiredKeyModels(liveConfig(), PROXY_MODELS);
    const missing = unreachableModels(required, LIVE_ALLOWLIST_20260726);

    expect(missing.map((m) => m.group).sort()).toEqual([
      "gpt-oss-20b-consolidation",
      "gpt-oss-20b-retain",
    ]);
    // The message has to point at the DECLARATION, not just the group, or
    // the operator has nowhere to go.
    expect(missing.find((m) => m.group === "gpt-oss-20b-retain")?.consumers).toEqual([
      "hindsight.llm.retain",
    ]);
    expect(missing.find((m) => m.group === "gpt-oss-20b-retain")?.configured).toBe(
      "openai/gpt-oss-20b-retain",
    );
  });

  it("is silent once the key can reach every declared lane", () => {
    const required = requiredKeyModels(liveConfig(), PROXY_MODELS);
    const fixed = [
      ...LIVE_ALLOWLIST_20260726,
      "gpt-oss-20b-retain",
      "gpt-oss-20b-consolidation",
    ];
    expect(unreachableModels(required, fixed)).toEqual([]);
  });

  it("is silent for an unrestricted key", () => {
    const required = requiredKeyModels(liveConfig(), PROXY_MODELS);
    expect(unreachableModels(required, [])).toEqual([]);
    expect(unreachableModels(required, ["*"])).toEqual([]);
  });

  it("collapses two consumers of one group into a single finding", () => {
    const required = requiredKeyModels(
      liveConfig({
        model: "openai/gpt-oss-20b-retain",
        retain: { model: "openai/gpt-oss-20b-retain" },
        consolidation: undefined,
      }),
      PROXY_MODELS,
    );
    const missing = unreachableModels(required, LIVE_ALLOWLIST_20260726);
    expect(missing).toHaveLength(1);
    expect(missing[0]!.consumers).toEqual([
      "hindsight.llm.model (global)",
      "hindsight.llm.retain",
    ]);
  });
});

describe("reconciledAllowlist", () => {
  it("UNIONS the missing lanes in without truncating the operator's entries", () => {
    // The key may legitimately carry groups switchroom does not manage.
    // Truncating to exactly the derived set would turn a routine `apply`
    // into an outage for whatever else was on it.
    const required = requiredKeyModels(liveConfig(), PROXY_MODELS);
    const next = reconciledAllowlist(LIVE_ALLOWLIST_20260726, required);
    expect(next).not.toBeNull();
    for (const kept of LIVE_ALLOWLIST_20260726) {
      expect(next).toContain(kept);
    }
    expect(next).toContain("gpt-oss-20b-retain");
    expect(next).toContain("gpt-oss-20b-consolidation");
    expect(next).toHaveLength(LIVE_ALLOWLIST_20260726.length + 2);
  });

  it("returns a sorted list, so the request body is stable and diffable", () => {
    const required = requiredKeyModels(liveConfig(), PROXY_MODELS);
    const next = reconciledAllowlist(LIVE_ALLOWLIST_20260726, required)!;
    expect(next).toEqual([...next].sort());
  });

  it("returns null — no write at all — when nothing is missing", () => {
    const required = requiredKeyModels(liveConfig(), PROXY_MODELS);
    expect(
      reconciledAllowlist(
        [...LIVE_ALLOWLIST_20260726, "gpt-oss-20b-retain", "gpt-oss-20b-consolidation"],
        required,
      ),
    ).toBeNull();
    expect(reconciledAllowlist([], required)).toBeNull();
    expect(reconciledAllowlist(LIVE_ALLOWLIST_20260726, [])).toBeNull();
  });

  it("never turns an unrestricted key into a restricted one", () => {
    // `[]` means "inherit team/proxy access". Writing the derived set over
    // it would REVOKE everything else the key could reach — a silent
    // downgrade dressed up as a fix.
    const required = requiredKeyModels(liveConfig(), PROXY_MODELS);
    expect(reconciledAllowlist([], required)).toBeNull();
    expect(reconciledAllowlist(["*"], required)).toBeNull();
  });
});
