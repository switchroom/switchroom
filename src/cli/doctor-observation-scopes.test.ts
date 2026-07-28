import { describe, expect, it } from "vitest";

import {
  OBSERVATION_SCOPE_CHECK_NAME,
  OBSERVATION_SCOPE_WARN_RATIO,
  checkObservationScopeSaturation,
  classifyObservationScopeSaturation,
  computeScopeSaturation,
  inspectBankScopes,
  type BankScopeReport,
  type ObservationScope,
} from "./doctor-observation-scopes.js";

/**
 * The defect these tests guard.
 *
 * On 2026-07-29 `docker logs switchroom-hindsight` was repeating, roughly every
 * 40 seconds:
 *
 *   [CONSOLIDATION] bank=overlord scope=['0f3640d5-089f-4ea1-b5b0-165fe9ae81bf']
 *     at observation limit (1009/1000), only updates/deletes allowed
 *
 * Consolidation kept running against that full scope — recall, a full
 * extraction-model call, then a batch that could only update or delete
 * (engine/consolidation/consolidator.py:1604-1613). It logs at INFO with no
 * metric attached, so no switchroom surface could report it; a human found it
 * by reading container logs. Meanwhile overlord carried ~43,700 memories
 * pending consolidation.
 *
 * So the assertions below are about the OUTCOME an operator needs — does the
 * row go RED, and does it name the bank, the scope and the real numbers — not
 * about whether the new functions can be called.
 */

const scope = (tags: string[], count: number): ObservationScope => ({ tags, count });

/** Overlord's live scope table on 2026-07-29, trimmed to the load-bearing rows. */
const OVERLORD_SCOPES: ObservationScope[] = [
  scope(["0f3640d5-089f-4ea1-b5b0-165fe9ae81bf"], 1009),
  scope(["ca9b3dd6-4ff7-47f7-b185-b045bbc87ff7"], 1000),
  scope(["7c62ce38-ee4b-45d0-8a4e-d407b064d3b5"], 963),
  scope(["7c62ce38-ee4b-45d0-8a4e-d407b064d3b5", "anti-pattern"], 201),
  scope(["c7905e1b-0db6-4862-86b6-6b7d3e457bc6"], 935),
  scope(["d52ae253-2d26-42e5-a86b-9a354cc0ace5"], 641),
  // The untagged/global scope. The engine never caps it.
  scope([], 241),
];

const report = (over: Partial<BankScopeReport> & { bankId: string }): BankScopeReport => ({
  ok: true,
  cap: 1000,
  observationsEnabled: true,
  hasScopeLimitRules: false,
  scopeCount: 0,
  saturated: [],
  pendingConsolidation: null,
  ...over,
});

/** Build the report the probe would produce for a bank, from raw scope rows. */
const reportFor = (
  bankId: string,
  scopes: ObservationScope[],
  cap = 1000,
  pendingConsolidation: number | null = null,
): BankScopeReport =>
  report({
    bankId,
    cap,
    scopeCount: scopes.length,
    saturated: computeScopeSaturation(scopes, cap).filter((s) => s.status !== "ok"),
    pendingConsolidation,
  });

describe("the live overlord failure", () => {
  it("FAILS, and names the bank, the scope and 1009/1000", () => {
    // This is the whole point of the module. A scope at 1009 against a cap of
    // 1000 with consolidation still running must be RED — the 2026-07 incident
    // was already a warning-shaped signal (an INFO log) that nobody read.
    const result = classifyObservationScopeSaturation([
      reportFor("overlord", OVERLORD_SCOPES, 1000, 43_734),
    ]);

    expect(result.status).toBe("fail");
    expect(result.name).toBe(OBSERVATION_SCOPE_CHECK_NAME);
    expect(result.detail).toContain("overlord");
    expect(result.detail).toContain("0f3640d5-089f-4ea1-b5b0-165fe9ae81bf");
    expect(result.detail).toContain("1009/1000");
  });

  it("reports the pending-consolidation backlog alongside the scope id", () => {
    // A bare uuid is cryptic. "overlord 43,734" is the symptom an operator
    // recognises, and it is what made the incident legible in the first place.
    const result = classifyObservationScopeSaturation([
      reportFor("overlord", OVERLORD_SCOPES, 1000, 43_734),
    ]);
    expect(result.detail).toContain("43,734");
    expect(result.detail).toContain("pending consolidation");
  });

  it("carries a fix that points at the cap and at the real counts", () => {
    const result = classifyObservationScopeSaturation([
      reportFor("overlord", OVERLORD_SCOPES, 1000, 43_734),
    ]);
    expect(result.fix).toContain("HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE");
    expect(result.fix).toContain("observations/scopes");
  });

  it("never presents the bank-wide observations DELETE as a per-scope prune", () => {
    // `DELETE /v1/default/banks/<bank>/observations` is "Clear all
    // observations": it takes no scope parameter and wipes the bank's entire
    // consolidated knowledge (verified against the live OpenAPI 2026-07-29).
    // An earlier draft of this fix string told the operator to call it "for the
    // scope you are retiring", which is a data-loss instruction dressed as
    // remediation. This assertion is the guard so it cannot come back.
    const fix = classifyObservationScopeSaturation([
      reportFor("overlord", OVERLORD_SCOPES, 1000, 43_734),
    ]).fix as string;
    expect(fix).toContain("clears the WHOLE bank");
    expect(fix).not.toMatch(/DELETE [^.]*observations for the scope/i);
  });
});

describe("counting the way the engine counts", () => {
  it("counts observations whose tags CONTAIN the scope, not just those that equal it", () => {
    // engine/consolidation/consolidator.py:598-603 —
    //   WHERE bank_id = $1 AND fact_type = 'observation' AND tags @> $2::varchar[]
    // `GET /observations/scopes` reports EXACT tag sets instead, so a scope
    // with tagged children reads far lower than the number the engine enforces.
    // Live overlord: exact 963, engine-visible 1164 (963 + 201 under the
    // `anti-pattern` child scope).
    const sat = computeScopeSaturation(OVERLORD_SCOPES, 1000);
    const parent = sat.find(
      (s) => s.tags.length === 1 && s.tags[0] === "7c62ce38-ee4b-45d0-8a4e-d407b064d3b5",
    );
    expect(parent).toBeDefined();
    expect(parent?.exact).toBe(963);
    expect(parent?.effective).toBe(1164);
    expect(parent?.status).toBe("fail");
  });

  it("would report the naive exact count as GREEN on the live klanker scope", () => {
    // klanker `0291c461-…` on 2026-07-29: exact 792 — 79.2% of the cap, i.e.
    // BELOW the 80% warn line, so an exact-count check reports it ok — against
    // an engine-visible 1413, 41% past the cap. This assertion is the reason
    // the containment fold exists at all.
    const klanker: ObservationScope[] = [
      scope(["0291c461-8640-4b6a-9f4e-2f0e5a5f1b7c"], 792),
      scope(["0291c461-8640-4b6a-9f4e-2f0e5a5f1b7c", "sidechain"], 400),
      scope(["0291c461-8640-4b6a-9f4e-2f0e5a5f1b7c", "worker"], 221),
    ];
    const exactRatio = 792 / 1000;
    expect(exactRatio).toBeLessThan(OBSERVATION_SCOPE_WARN_RATIO);

    const sat = computeScopeSaturation(klanker, 1000);
    const worst = sat[0];
    expect(worst?.effective).toBe(1413);
    expect(worst?.status).toBe("fail");
    expect(classifyObservationScopeSaturation([reportFor("klanker", klanker)]).status).toBe(
      "fail",
    );
  });

  it("gives a child scope its own smaller count rather than the parent's", () => {
    // `[session, anti-pattern]` is a scope in its own right; only observations
    // carrying BOTH tags count toward it. Folding the parent's 963 into it
    // would fail a scope with 201 observations and 799 free slots.
    const sat = computeScopeSaturation(OVERLORD_SCOPES, 1000);
    const child = sat.find((s) => s.tags.includes("anti-pattern"));
    expect(child?.effective).toBe(201);
    expect(child?.status).toBe("ok");
  });

  it("never counts the untagged scope, which the engine does not cap", () => {
    // consolidator.py:1605 guards with `if max_obs >= 0 and fact_tags:`, and
    // _count_observations_for_scope documents "Observations with no tags are
    // not counted". A bank whose global scope is huge is behaving as designed;
    // reporting it would be a permanent false FAIL.
    const sat = computeScopeSaturation([scope([], 50_000), scope(["a"], 10)], 1000);
    expect(sat.some((s) => s.tags.length === 0)).toBe(false);
    expect(classifyObservationScopeSaturation([
      reportFor("bank", [scope([], 50_000), scope(["a"], 10)]),
    ]).status).toBe("ok");
  });

  it("is order-insensitive across scopes that share tags", () => {
    // Tag order is normalized server-side, but containment must not depend on
    // the order rows arrive in.
    const forward = computeScopeSaturation(
      [scope(["a"], 600), scope(["a", "b"], 500)],
      1000,
    );
    const reverse = computeScopeSaturation(
      [scope(["a", "b"], 500), scope(["a"], 600)],
      1000,
    );
    const pick = (rows: ReturnType<typeof computeScopeSaturation>) =>
      rows.find((s) => s.tags.length === 1)?.effective;
    expect(pick(forward)).toBe(1100);
    expect(pick(reverse)).toBe(1100);
  });
});

describe("thresholds", () => {
  it("warns before the wall, while the scope is still writable", () => {
    const sat = computeScopeSaturation([scope(["s"], 800)], 1000);
    expect(sat[0]?.status).toBe("warn");
    const result = classifyObservationScopeSaturation([
      reportFor("carrie", [scope(["s"], 800)]),
    ]);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("carrie/s (800/1000)");
  });

  it("stays quiet below the warn ratio", () => {
    expect(computeScopeSaturation([scope(["s"], 799)], 1000)[0]?.status).toBe("ok");
    expect(
      classifyObservationScopeSaturation([reportFor("carrie", [scope(["s"], 799)])]).status,
    ).toBe("ok");
  });

  it("fails AT the cap, not only past it", () => {
    // The engine blocks creates when remaining slots hit zero — i.e. at
    // count == cap, not count > cap (consolidator.py:1608). A `>` here would
    // report the exact moment output starts being discarded as merely a warn.
    expect(computeScopeSaturation([scope(["s"], 1000)], 1000)[0]?.status).toBe("fail");
  });

  it("puts the worst scope first so the top of the row is the real problem", () => {
    const result = classifyObservationScopeSaturation([
      reportFor("overlord", OVERLORD_SCOPES, 1000, 43_734),
    ]);
    const firstListed = result.detail?.indexOf("7c62ce38-ee4b-45d0-8a4e-d407b064d3b5");
    const secondListed = result.detail?.indexOf("0f3640d5-089f-4ea1-b5b0-165fe9ae81bf");
    // 1164 > 1009, so the containment-heavy scope leads.
    expect(firstListed).toBeGreaterThanOrEqual(0);
    expect(firstListed).toBeLessThan(secondListed as number);
  });
});

describe("configurations this check must not judge", () => {
  it("treats an unlimited cap (-1) as nothing to saturate", () => {
    expect(computeScopeSaturation([scope(["s"], 999_999)], -1)).toEqual([]);
    const result = classifyObservationScopeSaturation([
      reportFor("big", [scope(["s"], 999_999)], -1),
    ]);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("uncapped");
  });

  it("treats cap 0 as a deliberate close, not a failure", () => {
    // 0 means "no new observations in this scope" — an operator choice. Every
    // scope is trivially at it, so failing would make the row permanently red
    // on a correctly-configured bank.
    const result = classifyObservationScopeSaturation([
      reportFor("closed", [scope(["s"], 5)], 0),
    ]);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("closed");
  });

  it("refuses to judge a bank carrying observation_scope_limits rules", () => {
    // Those rules resolve a DIFFERENT cap per scope via fnmatch exact-cover
    // (consolidator.py:670-683). A rule that RAISES a scope's limit would make
    // the bank-wide comparison invent a FAIL, so the bank is excluded and the
    // gap is stated instead of guessed at.
    const result = classifyObservationScopeSaturation([
      report({
        bankId: "ruled",
        hasScopeLimitRules: true,
        scopeCount: 1,
        saturated: computeScopeSaturation([scope(["s"], 5000)], 1000),
      }),
    ]);
    expect(result.status).toBe("skip");
    expect(result.detail).toContain("observation_scope_limits");
    expect(result.detail).toContain("ruled");
  });

  it("does not judge a bank with observations disabled", () => {
    const result = classifyObservationScopeSaturation([
      report({
        bankId: "off",
        observationsEnabled: false,
        scopeCount: 1,
        saturated: computeScopeSaturation([scope(["s"], 5000)], 1000),
      }),
    ]);
    expect(result.status).toBe("skip");
    expect(result.detail).toContain("observations disabled");
  });
});

describe("partial visibility", () => {
  it("does not turn an unreachable bank into a failure, but does say so", () => {
    // "couldn't look" is not "saturated". A check that reddens when the server
    // is down teaches operators to ignore the column.
    const result = classifyObservationScopeSaturation([
      report({ bankId: "healthy", scopeCount: 3 }),
      { ...report({ bankId: "down" }), ok: false, reason: "Timeout" },
    ]);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("down");
    expect(result.detail).toContain("Timeout");
  });

  it("still FAILS on a saturated bank when a sibling bank is unreachable", () => {
    const result = classifyObservationScopeSaturation([
      { ...report({ bankId: "down" }), ok: false, reason: "Timeout" },
      reportFor("overlord", OVERLORD_SCOPES, 1000, 43_734),
    ]);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("1009/1000");
  });

  it("skips when nothing at all could be read", () => {
    const result = classifyObservationScopeSaturation([
      { ...report({ bankId: "a" }), ok: false, reason: "HTTP 500" },
    ]);
    expect(result.status).toBe("skip");
  });

  it("skips when there are no banks", () => {
    expect(classifyObservationScopeSaturation([]).status).toBe("skip");
  });

  it("elides a long saturated list rather than printing every scope", () => {
    const many = Array.from({ length: 10 }, (_, i) => scope([`s${i}`], 1000 + i));
    const result = classifyObservationScopeSaturation([reportFor("noisy", many)]);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("more");
    expect(result.detail).toContain("10 observation scope(s) at or over the cap");
  });
});

/** Minimal `fetch` stand-in keyed by URL substring. */
function stubFetch(routes: Record<string, unknown>, seen?: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    seen?.push(url);
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return {
          ok: true,
          status: 200,
          json: async () => body,
        } as unknown as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("probing a bank over REST", () => {
  const cfgBody = {
    config: {
      max_observations_per_scope: 1000,
      observation_scope_limits: null,
      enable_observations: true,
    },
  };

  it("reads the cap the BANK carries, not switchroom's pushed default", () => {
    // An operator override, or a bank created before the default moved, makes
    // the two diverge exactly when the numbers matter. Assuming the constant
    // would print a ratio no log line agrees with.
    return inspectBankScopes(
      "http://h:1/mcp",
      "overlord",
      {
        fetchImpl: stubFetch({
          "/config": {
            config: { max_observations_per_scope: 4000, observation_scope_limits: null },
          },
          "/observations/scopes": { scopes: OVERLORD_SCOPES },
        }),
      },
    ).then((r) => {
      expect(r.ok).toBe(true);
      expect(r.cap).toBe(4000);
      // 1164 is 29% of 4000 — nothing is saturated at that cap.
      expect(r.saturated).toEqual([]);
    });
  });

  it("produces the saturated set for the live overlord shape", async () => {
    const r = await inspectBankScopes("http://h:1/mcp", "overlord", {
      fetchImpl: stubFetch({
        "/config": cfgBody,
        "/observations/scopes": { scopes: OVERLORD_SCOPES },
        "/stats": { pending_consolidation: 43_734 },
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.pendingConsolidation).toBe(43_734);
    expect(r.saturated.map((s) => s.effective)).toEqual([1164, 1009, 1000, 935]);
  });

  it("does NOT pay for /stats when nothing is saturated", async () => {
    // /stats measured at 1.4-2.1s against ~150ms for the scopes query, and
    // doctor runs it across a whole fleet. A healthy bank must cost two cheap
    // calls, not three.
    const seen: string[] = [];
    const r = await inspectBankScopes("http://h:1/mcp", "quiet", {
      fetchImpl: stubFetch(
        {
          "/config": cfgBody,
          "/observations/scopes": { scopes: [scope(["s"], 12)] },
          "/stats": { pending_consolidation: 5 },
        },
        seen,
      ),
    });
    expect(r.saturated).toEqual([]);
    expect(seen.some((u) => u.includes("/stats"))).toBe(false);
  });

  it("refuses to guess a cap when the config shape is unrecognised", async () => {
    // A defaulted cap yields a confident, wrong verdict on every scope.
    const r = await inspectBankScopes("http://h:1/mcp", "weird", {
      fetchImpl: stubFetch({
        "/config": { config: { observation_scope_limits: null } },
        "/observations/scopes": { scopes: OVERLORD_SCOPES },
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Unexpected shape");
  });

  it("surfaces an HTTP error as unreadable rather than healthy", async () => {
    const r = await inspectBankScopes("http://h:1/mcp", "gone", {
      fetchImpl: stubFetch({}),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("HTTP 404");
  });

  it("drops malformed scope rows instead of throwing", async () => {
    const r = await inspectBankScopes("http://h:1/mcp", "messy", {
      fetchImpl: stubFetch({
        "/config": cfgBody,
        "/observations/scopes": {
          scopes: [{ tags: ["ok"], count: 1200 }, { tags: "nope", count: 1 }, { count: 2 }, null],
        },
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.scopeCount).toBe(1);
    expect(r.saturated[0]?.effective).toBe(1200);
  });
});

describe("the fleet sweep", () => {
  it("probes each agent's bank and the profile banks, deduped", async () => {
    const seen: string[] = [];
    const config = {
      agents: {
        overlord: {},
        klanker: {},
        // Two agents sharing one bank must be probed once.
        alpha: { memory: { collection: "shared" } },
        beta: { memory: { collection: "shared" } },
      },
      users: { ken: { profile_bank: "ken-profile" } },
    } as never;

    const result = await checkObservationScopeSaturation(config, "http://h:1/mcp", {
      fetchImpl: stubFetch(
        {
          "/config": {
            config: {
              max_observations_per_scope: 1000,
              observation_scope_limits: null,
              enable_observations: true,
            },
          },
          "banks/overlord/observations/scopes": { scopes: OVERLORD_SCOPES },
          "/observations/scopes": { scopes: [scope(["quiet"], 3)] },
          "/stats": { pending_consolidation: 43_734 },
        },
        seen,
      ),
    });

    const scopeCalls = seen.filter((u) => u.includes("/observations/scopes"));
    expect(scopeCalls).toHaveLength(4);
    expect(scopeCalls.filter((u) => u.includes("/shared/"))).toHaveLength(1);
    expect(seen.some((u) => u.includes("/ken-profile/"))).toBe(true);

    // And the live overlord state still comes out red through the full path.
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("overlord/0f3640d5-089f-4ea1-b5b0-165fe9ae81bf (1009/1000)");
  });
});
