/**
 * budget.test.ts — outcome tests for the per-agent LiteLLM virtual-key spend
 * caps.
 *
 * THE RISK. A per-agent virtual key without a budget is a bearer token for the
 * whole upstream account balance. A runaway loop or a compromised agent can
 * spend it all, and the first symptom is every OTHER agent failing — they share
 * that balance. These assert the OBSERVABLE result: the exact JSON that reaches
 * LiteLLM's `/key/generate` and `/key/update`, because that payload is the only
 * thing that actually enforces anything.
 *
 * The LiteLLM contract asserted here was read from `litellm/proxy/_types.py`
 * on 2026-07-28:
 *   GenerateRequestBase.max_budget      → /key/generate ✅  /key/update ✅
 *   GenerateRequestBase.budget_duration → /key/generate ✅  /key/update ✅
 *   GenerateKeyRequest.soft_budget      → /key/generate ✅  /key/update ❌
 * (`UpdateKeyRequest` extends `KeyRequestBase`, a SIBLING of
 * `GenerateKeyRequest` — so `soft_budget` has no update path at all.)
 */

import { describe, it, expect } from "vitest";

import {
  DEFAULT_KEY_BUDGET_DURATION,
  DEFAULT_KEY_MAX_BUDGET_USD,
  DEFAULT_KEY_SOFT_BUDGET_USD,
  describeKeyBudget,
  resolveKeyBudget,
} from "./budget.js";
import { ensureKey, updateKeyBudget, type FetchFn } from "./provision.js";

/** Capture the exact body posted to LiteLLM. */
function recordingFetch(
  respond: (url: string) => { status: number; body: unknown },
): { fetchFn: FetchFn; calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
    const r = respond(url);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as unknown as Response;
  }) as unknown as FetchFn;
  return { fetchFn, calls };
}

const OK_KEY = { status: 200, body: { key: "sk-fake-virtual-key" } };

describe("resolveKeyBudget — a misconfiguration degrades toward SAFER", () => {
  it("caps by DEFAULT when config says nothing (opting out must be explicit)", () => {
    const b = resolveKeyBudget(undefined);
    expect(b).not.toBeNull();
    expect(b!.maxBudget).toBe(DEFAULT_KEY_MAX_BUDGET_USD);
    expect(b!.softBudget).toBe(DEFAULT_KEY_SOFT_BUDGET_USD);
    expect(b!.budgetDuration).toBe(DEFAULT_KEY_BUDGET_DURATION);
  });

  it("ALWAYS pairs a window with a cap — a lifetime cap is a permanent kill-switch", () => {
    // LiteLLM never resets a max_budget that has no budget_duration, so the key
    // dies for good the first time it is reached. There must be no config path
    // that produces one.
    for (const cfg of [
      undefined,
      {},
      { max_budget: 5 },
      { max_budget: 5, soft_budget: 1 },
      { budget_duration: "" },
    ]) {
      const b = resolveKeyBudget(cfg);
      if (b == null) continue;
      expect(b.budgetDuration.length, `no window for ${JSON.stringify(cfg)}`).toBeGreaterThan(0);
    }
  });

  it("treats max_budget: 0 as 'uncapped' rather than 'zero dollars'", () => {
    // A literal 0 sent to LiteLLM would block EVERY request instantly. The only
    // safe reading of 0 is the explicit opt-out.
    expect(resolveKeyBudget({ max_budget: 0 })).toBeNull();
    expect(resolveKeyBudget({ max_budget: -5 })).toBeNull();
  });

  it("drops a soft budget that could never fire before the hard stop", () => {
    expect(resolveKeyBudget({ max_budget: 10, soft_budget: 10 })?.softBudget).toBeUndefined();
    expect(resolveKeyBudget({ max_budget: 10, soft_budget: 25 })?.softBudget).toBeUndefined();
    expect(resolveKeyBudget({ max_budget: 10, soft_budget: 4 })?.softBudget).toBe(4);
  });

  it("keeps the default soft budget strictly under the default hard cap", () => {
    expect(DEFAULT_KEY_SOFT_BUDGET_USD).toBeLessThan(DEFAULT_KEY_MAX_BUDGET_USD);
  });

  it("honours an explicit per-agent override", () => {
    const b = resolveKeyBudget({ max_budget: 100, soft_budget: 80, budget_duration: "1mo" });
    expect(b).toEqual({ maxBudget: 100, softBudget: 80, budgetDuration: "1mo" });
  });

  it("describes the cap for the apply transcript", () => {
    expect(describeKeyBudget(resolveKeyBudget({ max_budget: 10, soft_budget: 4 }))).toBe(
      "cap $10/30d, alert at $4",
    );
    expect(describeKeyBudget(null)).toContain("no spend cap");
  });
});

describe("/key/generate carries the full cap", () => {
  it("posts max_budget, budget_duration AND soft_budget", async () => {
    const { fetchFn, calls } = recordingFetch(() => OK_KEY);
    await ensureKey(
      {
        baseUrl: "http://proxy:4010",
        masterKey: "sk-master",
        alias: "agent:klanker",
        budget: resolveKeyBudget(undefined)!,
      },
      fetchFn,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://proxy:4010/key/generate");
    expect(calls[0].body.max_budget).toBe(DEFAULT_KEY_MAX_BUDGET_USD);
    expect(calls[0].body.budget_duration).toBe(DEFAULT_KEY_BUDGET_DURATION);
    expect(calls[0].body.soft_budget).toBe(DEFAULT_KEY_SOFT_BUDGET_USD);
  });

  it("never posts a cap with no window", async () => {
    const { fetchFn, calls } = recordingFetch(() => OK_KEY);
    await ensureKey(
      {
        baseUrl: "http://proxy:4010",
        masterKey: "sk-master",
        alias: "agent:klanker",
        budget: { maxBudget: 7, budgetDuration: "24h" },
      },
      fetchFn,
    );
    expect(calls[0].body.max_budget).toBe(7);
    expect(calls[0].body.budget_duration).toBe("24h");
    // No soft budget configured ⇒ the field is absent, not null/0.
    expect("soft_budget" in calls[0].body).toBe(false);
  });

  it("sends NO budget fields at all for an explicitly uncapped key", async () => {
    // Sending max_budget: 0 would block every request — an uncapped key must
    // simply omit the fields.
    const { fetchFn, calls } = recordingFetch(() => OK_KEY);
    await ensureKey(
      { baseUrl: "http://proxy:4010", masterKey: "sk-master", alias: "agent:klanker" },
      fetchFn,
    );
    for (const field of ["max_budget", "soft_budget", "budget_duration"]) {
      expect(field in calls[0].body, `${field} leaked onto an uncapped key`).toBe(false);
    }
  });
});

describe("/key/update heals an EXISTING key — the pre-existing-agent case", () => {
  it("posts max_budget + budget_duration for a key already in the vault", async () => {
    const { fetchFn, calls } = recordingFetch(() => ({ status: 200, body: {} }));
    const res = await updateKeyBudget(
      {
        baseUrl: "http://proxy:4010",
        masterKey: "sk-master",
        key: "sk-existing",
        budget: { maxBudget: 25, softBudget: 15, budgetDuration: "30d" },
      },
      fetchFn,
    );
    expect(res.kind).toBe("ok");
    expect(calls[0].url).toBe("http://proxy:4010/key/update");
    expect(calls[0].body).toMatchObject({
      key: "sk-existing",
      max_budget: 25,
      budget_duration: "30d",
    });
  });

  it("does NOT post soft_budget — UpdateKeyRequest has no such field", async () => {
    // Verified against litellm/proxy/_types.py: UpdateKeyRequest extends
    // KeyRequestBase, a SIBLING of GenerateKeyRequest. Sending soft_budget here
    // would be silently ignored, leaving the operator believing an advisory
    // alert was armed when none was.
    const { fetchFn, calls } = recordingFetch(() => ({ status: 200, body: {} }));
    await updateKeyBudget(
      {
        baseUrl: "http://proxy:4010",
        masterKey: "sk-master",
        key: "sk-existing",
        budget: { maxBudget: 25, softBudget: 15, budgetDuration: "30d" },
      },
      fetchFn,
    );
    expect("soft_budget" in calls[0].body).toBe(false);
  });

  it("is LOUD, not fatal, when the proxy refuses the cap", async () => {
    const { fetchFn } = recordingFetch(() => ({ status: 500, body: { error: "boom" } }));
    const res = await updateKeyBudget(
      {
        baseUrl: "http://proxy:4010",
        masterKey: "sk-master",
        key: "sk-existing",
        budget: { maxBudget: 25, budgetDuration: "30d" },
      },
      fetchFn,
    );
    expect(res.kind).toBe("error");
    expect(res.kind === "error" && res.detail).toContain("500");
  });

  it("never throws on a transport failure (apply must not die on a cap)", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchFn;
    const res = await updateKeyBudget(
      {
        baseUrl: "http://proxy:4010",
        masterKey: "sk-master",
        key: "sk-existing",
        budget: { maxBudget: 25, budgetDuration: "30d" },
      },
      fetchFn,
    );
    expect(res.kind).toBe("error");
  });
});

describe("the default is conservative but usable", () => {
  it("is a real number of dollars, not unlimited and not pennies", () => {
    expect(DEFAULT_KEY_MAX_BUDGET_USD).toBeGreaterThan(0);
    expect(DEFAULT_KEY_MAX_BUDGET_USD).toBeLessThanOrEqual(50);
  });

  it("resets on a window that matches how the upstream accounts are billed", () => {
    expect(DEFAULT_KEY_BUDGET_DURATION).toMatch(/^\d+(s|m|h|d|mo)$/);
  });
});
