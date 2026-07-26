/**
 * The invariant these tests exist to enforce:
 *
 *   localTimeoutS + fallbackTimeoutS + margin  <=  clientBudgetS
 *
 * Every test here is written so that it FAILS on the real historical bug, not
 * merely exercises the code that produces the number. Two live violations
 * motivated them, both of which these assertions catch:
 *
 *   - retain      (#3611): client 204s vs chain 200 + 90 = 290
 *   - interactive (2026-07-26): client 120s (vendor default) vs chain 90 + 60 = 150
 */

import { describe, it, expect } from "vitest";

import {
  LITELLM_ROUTER_MARGIN_S,
  LITELLM_TIMEOUT_TIERS,
  assertClientBudget,
  clientBudgetSeconds,
  detectLitellmTimeoutDrift,
  extractGroupTimeouts,
  litellmChainSeconds,
  minimumClientBudgetSeconds,
  type LitellmTimeoutTier,
} from "./timeout-budget.js";
import { parseLitellmConfig } from "./header-passthrough-guard.js";

const RETAIN = LITELLM_TIMEOUT_TIERS.retain;
const INTERACTIVE = LITELLM_TIMEOUT_TIERS.interactive;
const CONSOLIDATION = LITELLM_TIMEOUT_TIERS.consolidation;

describe("litellm timeout budget — chain arithmetic", () => {
  it("counts the FULL fallback hop, not just the primary timeout", () => {
    // The whole defect class is treating `local < client` as the invariant.
    // The router's fallback runs inside the same client request, so the chain
    // is the sum.
    expect(litellmChainSeconds(RETAIN)).toBe(290);
    expect(litellmChainSeconds(INTERACTIVE)).toBe(150);
    expect(litellmChainSeconds(CONSOLIDATION)).toBe(290);
    // Not the primary alone — the bug's arithmetic.
    expect(litellmChainSeconds(RETAIN)).not.toBe(RETAIN.localTimeoutS);
  });

  it("collapses to the primary timeout when a group has no fallback", () => {
    const noFallback: LitellmTimeoutTier = {
      group: "solo",
      localTimeoutS: 45,
      fallbackGroup: null,
      fallbackTimeoutS: 0,
    };
    expect(litellmChainSeconds(noFallback)).toBe(45);
    expect(minimumClientBudgetSeconds(noFallback)).toBe(45 + LITELLM_ROUTER_MARGIN_S);
  });

  it("rejects a non-positive or non-finite timeout rather than silently underbudgeting", () => {
    expect(() =>
      litellmChainSeconds({ ...RETAIN, localTimeoutS: 0 }),
    ).toThrow(/must be a positive number/);
    expect(() =>
      litellmChainSeconds({ ...RETAIN, fallbackTimeoutS: -1 }),
    ).toThrow(/must be a positive number/);
    expect(() =>
      litellmChainSeconds({ ...RETAIN, localTimeoutS: Number.NaN }),
    ).toThrow(/must be a positive number/);
  });
});

describe("litellm timeout budget — assertClientBudget FAILS on the shipped bugs", () => {
  it("rejects #3611's live retain budget (204s under a 290s chain)", () => {
    // This is the exact number `hindsightRetainLlmTimeoutSeconds()` produced
    // and that `docker inspect switchroom-hindsight` showed live on
    // 2026-07-26: HINDSIGHT_API_RETAIN_LLM_TIMEOUT=204. The retain OpenRouter
    // fallback had 4s of headroom.
    expect(() =>
      assertClientBudget({ role: "retain", tier: RETAIN, clientBudgetS: 204 }),
    ).toThrow(/client budget 204s is below the 300s the routing chain needs/);
  });

  it("rejects the interactive lane's 120s vendor default under the raised 60s fallback", () => {
    // hindsight_api/config.py DEFAULT_LLM_TIMEOUT = 120.0, taken because
    // HINDSIGHT_API_LLM_TIMEOUT was never emitted. Chain 90 + 60 = 150.
    expect(() =>
      assertClientBudget({ role: "interactive", tier: INTERACTIVE, clientBudgetS: 120 }),
    ).toThrow(/client budget 120s is below the 160s the routing chain needs/);
  });

  it("rejects the consolidation lane's 120s vendor default under a 290s chain", () => {
    expect(() =>
      assertClientBudget({ role: "consolidation", tier: CONSOLIDATION, clientBudgetS: 120 }),
    ).toThrow(/client budget 120s is below the 300s the routing chain needs/);
  });

  it("rejects a budget that covers the chain but not the margin", () => {
    // Exactly the chain is NOT enough: litellm's own routing, connection setup
    // on the fallback hop, and response assembly happen inside the same
    // request. (Not the fleet pacer — it does not pace these groups; see
    // LITELLM_ROUTER_MARGIN_S.)
    expect(() =>
      assertClientBudget({ role: "retain", tier: RETAIN, clientBudgetS: 290 }),
    ).toThrow(/below the 300s/);
    expect(() =>
      assertClientBudget({ role: "retain", tier: RETAIN, clientBudgetS: 299 }),
    ).toThrow(/below the 300s/);
  });

  it("accepts exactly the required budget and anything above it", () => {
    expect(() =>
      assertClientBudget({ role: "retain", tier: RETAIN, clientBudgetS: 300 }),
    ).not.toThrow();
    expect(() =>
      assertClientBudget({ role: "retain", tier: RETAIN, clientBudgetS: 600 }),
    ).not.toThrow();
  });

  it("names both halves and the file to edit, so the error is actionable", () => {
    let msg = "";
    try {
      assertClientBudget({ role: "retain", tier: RETAIN, clientBudgetS: 204 });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain("200s (gpt-oss-20b-retain)");
    expect(msg).toContain("90s (gpt-oss-20b-retain-openrouter)");
    expect(msg).toContain("src/litellm/timeout-budget.ts");
  });
});

describe("litellm timeout budget — derivation, not hand-set constants", () => {
  it("derives the interactive budget to exactly the 160s Ken set", () => {
    // 90 + 60 + 10. The point is that nobody typed 160.
    expect(clientBudgetSeconds(INTERACTIVE)).toBe(160);
  });

  it("derives retain and consolidation to 300s from their 290s chains", () => {
    expect(clientBudgetSeconds(RETAIN)).toBe(300);
    expect(clientBudgetSeconds(CONSOLIDATION)).toBe(300);
  });

  it("PRESERVES #3611: the token-derived value is kept as a floor, not discarded", () => {
    // A tier whose chain is tiny must still not go below the token-derived
    // floor, or a legitimately full-length extraction is starved by its own
    // deadline — the reasoning #3611 shipped.
    const tinyChain: LitellmTimeoutTier = {
      group: "tiny",
      localTimeoutS: 10,
      fallbackGroup: "tiny-fallback",
      fallbackTimeoutS: 10,
    };
    expect(minimumClientBudgetSeconds(tinyChain)).toBe(30);
    expect(clientBudgetSeconds(tinyChain, 204)).toBe(204); // floor wins
    expect(clientBudgetSeconds(tinyChain, 5)).toBe(30); // chain wins
    // And on the real retain tier the chain is the larger of the two.
    expect(clientBudgetSeconds(RETAIN, 204)).toBe(300);
  });

  it("moves the budget when a tier moves — the drift this prevents", () => {
    // Raise the fallback hop and the client budget follows, with no second
    // edit. This is the mechanism; everything else is bookkeeping.
    const raised: LitellmTimeoutTier = { ...INTERACTIVE, fallbackTimeoutS: 90 };
    expect(clientBudgetSeconds(raised)).toBe(190);
    expect(clientBudgetSeconds(raised)).not.toBe(clientBudgetSeconds(INTERACTIVE));
  });

  it("rounds a fractional floor UP, never down into a violation", () => {
    const t: LitellmTimeoutTier = {
      group: "t",
      localTimeoutS: 5,
      fallbackGroup: null,
      fallbackTimeoutS: 0,
    };
    expect(clientBudgetSeconds(t, 203.2)).toBe(204);
  });

  it("every declared tier's derived budget satisfies its own assertion", () => {
    for (const [role, tier] of Object.entries(LITELLM_TIMEOUT_TIERS)) {
      const budget = clientBudgetSeconds(tier);
      expect(() => assertClientBudget({ role, tier, clientBudgetS: budget })).not.toThrow();
    }
  });
});

describe("litellm timeout budget — drift detection against the live proxy config", () => {
  const live = (entries: Array<[string, number | null]>) => new Map(entries);

  it("reports NOTHING when the live config matches the declaration", () => {
    expect(
      detectLitellmTimeoutDrift(
        live([
          ["gpt-oss-20b", 90],
          ["gpt-oss-20b-openrouter", 60],
          ["gpt-oss-20b-retain", 200],
          ["gpt-oss-20b-retain-openrouter", 90],
          ["gpt-oss-20b-consolidation", 200],
          ["gpt-oss-20b-consolidation-openrouter", 90],
        ]),
      ),
    ).toEqual([]);
  });

  it("catches the 2026-07-26 change: the fallback hop moved and nothing else did", () => {
    // The operator raises the interactive fallback 60 → 90 on the host without
    // touching the declaration. Every interactive budget switchroom emits is
    // now 30s short, silently.
    const drifts = detectLitellmTimeoutDrift(
      live([
        ["gpt-oss-20b", 90],
        ["gpt-oss-20b-openrouter", 90],
      ]),
    );
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      role: "interactive",
      group: "gpt-oss-20b-openrouter",
      declaredS: 60,
      actualS: 90,
    });
    expect(drifts[0]!.detail).toContain("drifted apart");
  });

  it("catches a group with NO timeout at all (inherits request_timeout: 600)", () => {
    // The state `gpt-oss-20b-openrouter` shipped in until this change gave it
    // `timeout: 60` — the most dangerous shape, because a group with no
    // timeout inherits 600s and blows every client budget on the lane.
    const drifts = detectLitellmTimeoutDrift(live([["gpt-oss-20b-openrouter", null]]));
    expect(drifts).toHaveLength(1);
    expect(drifts[0]!.actualS).toBeNull();
    expect(drifts[0]!.detail).toContain("carries NO per-deployment timeout");
  });

  it("stays silent about groups the live config does not define at all", () => {
    // A missing model group is a DIFFERENT signal with a different owner
    // (src/litellm/model-validation.ts, #3407). Reporting it here would make
    // this check noisy on any partial config and train people to ignore it.
    expect(detectLitellmTimeoutDrift(live([]))).toEqual([]);
    expect(detectLitellmTimeoutDrift(live([["gpt-oss-20b", 90]]))).toEqual([]);
  });

  it("reports every drifted group, not just the first", () => {
    const drifts = detectLitellmTimeoutDrift(
      live([
        ["gpt-oss-20b", 45],
        ["gpt-oss-20b-openrouter", 25],
        ["gpt-oss-20b-retain", 90],
      ]),
    );
    expect(drifts.map((d) => d.group).sort()).toEqual([
      "gpt-oss-20b",
      "gpt-oss-20b-openrouter",
      "gpt-oss-20b-retain",
    ]);
  });
});

describe("litellm timeout budget — extractGroupTimeouts over real config shapes", () => {
  const yaml = (s: string) => extractGroupTimeouts(parseLitellmConfig(s));

  it("reads the per-deployment timeout for each model group", () => {
    const got = yaml(`
model_list:
  - model_name: gpt-oss-20b
    litellm_params:
      model: openai/gpt-oss-20b
      timeout: 90
  - model_name: gpt-oss-20b-retain
    litellm_params:
      model: openai/gpt-oss-20b
      timeout: 200
`);
    expect(got.get("gpt-oss-20b")).toBe(90);
    expect(got.get("gpt-oss-20b-retain")).toBe(200);
  });

  it("reports null for a group whose deployment carries NO timeout", () => {
    // The shape docker/litellm-proxy/litellm-config.yaml shipped for
    // `gpt-oss-20b-openrouter` before this change: no timeout ⇒ inherits
    // request_timeout: 600.
    const got = yaml(`
model_list:
  - model_name: gpt-oss-20b-openrouter
    litellm_params:
      model: openrouter/openai/gpt-oss-20b
`);
    expect(got.has("gpt-oss-20b-openrouter")).toBe(true);
    expect(got.get("gpt-oss-20b-openrouter")).toBeNull();
  });

  it("takes the WORST case across a load-balanced group's deployments", () => {
    // The router may pick either deployment, so the budget must survive the
    // slower one. An unbounded sibling makes the whole group unbounded.
    const balanced = yaml(`
model_list:
  - model_name: g
    litellm_params: { model: a, timeout: 90 }
  - model_name: g
    litellm_params: { model: b, timeout: 200 }
`);
    expect(balanced.get("g")).toBe(200);

    const oneUnbounded = yaml(`
model_list:
  - model_name: g
    litellm_params: { model: a, timeout: 90 }
  - model_name: g
    litellm_params: { model: b }
`);
    expect(oneUnbounded.get("g")).toBeNull();
  });

  it("treats a non-positive or unparseable timeout as unbounded, not as a bound", () => {
    const got = yaml(`
model_list:
  - model_name: zero
    litellm_params: { model: a, timeout: 0 }
  - model_name: junk
    litellm_params: { model: a, timeout: "soon" }
`);
    expect(got.get("zero")).toBeNull();
    expect(got.get("junk")).toBeNull();
  });

  it("accepts a numeric string timeout (YAML quoting is not a semantic change)", () => {
    expect(yaml(`
model_list:
  - model_name: g
    litellm_params: { model: a, timeout: "90" }
`).get("g")).toBe(90);
  });

  it("returns empty (never throws) for configs with no model_list at all", () => {
    expect(extractGroupTimeouts(null).size).toBe(0);
    expect(extractGroupTimeouts(undefined).size).toBe(0);
    expect(extractGroupTimeouts("not a config").size).toBe(0);
    expect(yaml("litellm_settings: { request_timeout: 600 }").size).toBe(0);
    expect(yaml("model_list: not-a-list").size).toBe(0);
    expect(yaml("model_list: [null, 3, {}, {model_name: 1}]").size).toBe(0);
  });

  it("end to end: a config whose fallback hop drifted is caught", () => {
    const drifts = detectLitellmTimeoutDrift(
      yaml(`
model_list:
  - model_name: gpt-oss-20b
    litellm_params: { model: a, timeout: 90 }
  - model_name: gpt-oss-20b-openrouter
    litellm_params: { model: b, timeout: 25 }
`),
    );
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      role: "interactive",
      group: "gpt-oss-20b-openrouter",
      declaredS: 60,
      actualS: 25,
    });
  });
});
