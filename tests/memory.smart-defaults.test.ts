import { describe, it, expect } from "vitest";
import {
  FLEET_DEFAULT_DISPOSITION,
  PROFILE_MEMORY_DEFAULTS,
  resolveBankMissionExtras,
  decideDispositionPush,
  fleetOnlyDispositionTraits,
  fetchBankDisposition,
} from "../src/memory/hindsight.js";
import {
  ANTI_CONFABULATION_DIRECTIVE,
  ANTI_CONFABULATION_DIRECTIVE_NAME,
  ANTI_CONFABULATION_DIRECTIVE_PRIORITY,
  SUPERSEDED_ANTI_CONFABULATION_DIRECTIVES,
  SWITCHROOM_SEEDED_TAG,
  decideDirectiveSeed,
  ensureAntiConfabulationDirective,
  resolveAntiConfabulationDirective,
  type SeededDirectiveRecord,
} from "../src/memory/hindsight-seed-directives.js";
import { MAX_DIRECTIVES } from "../src/memory/hindsight-directive-admin.js";
import { AgentMemorySchema } from "../src/config/schema.js";
import { mergeAgentConfig } from "../src/config/merge.js";

/**
 * Smart memory defaults: what an agent gets with ZERO yaml, and what an
 * operator can do about it.
 *
 * Every assertion here is on an outcome — the disposition that would be
 * PUSHED to a bank, the HTTP requests a seed actually issues — not on whether
 * a code path ran.
 */

describe("fleet default disposition", () => {
  it("gives a zero-config agent skepticism 4 and nothing else", () => {
    const extras = resolveBankMissionExtras(undefined, "default");
    expect(extras.disposition).toEqual({ skepticism: 4 });
  });

  it("leaves literalism and empathy at the engine default (unset on the wire)", () => {
    // Sending 3/3 would be indistinguishable from the engine default in effect
    // but would pin the bank against a future engine change, for no benefit.
    const extras = resolveBankMissionExtras(undefined, "default");
    expect(extras.disposition).not.toHaveProperty("literalism");
    expect(extras.disposition).not.toHaveProperty("empathy");
  });

  it("is overridden per-trait by a profile that sets skepticism on purpose", () => {
    // health-coach is the interesting direction: it wants LESS skepticism than
    // the fleet floor, so a floor that could not be lowered would break it.
    const extras = resolveBankMissionExtras(undefined, "health-coach");
    expect(extras.disposition).toEqual(
      PROFILE_MEMORY_DEFAULTS["health-coach"].disposition,
    );
    expect(extras.disposition?.skepticism).toBe(2);
  });

  it("is overridden by operator yaml, including back down to the engine default", () => {
    const extras = resolveBankMissionExtras({ disposition: { skepticism: 3 } }, "default");
    expect(extras.disposition).toEqual({ skepticism: 3 });
  });

  it("merges per-trait rather than replacing: yaml empathy keeps the fleet skepticism", () => {
    const extras = resolveBankMissionExtras({ disposition: { empathy: 5 } }, "default");
    expect(extras.disposition).toEqual({ skepticism: 4, empathy: 5 });
  });

  it("layers fleet under profile under yaml, all three at once", () => {
    const extras = resolveBankMissionExtras({ disposition: { empathy: 1 } }, "coding");
    // coding pins 4/5/2; yaml overrides empathy only; skepticism 4 agrees with
    // the fleet floor by construction.
    expect(extras.disposition).toEqual({ skepticism: 4, literalism: 5, empathy: 1 });
  });

  it("no profile default is weaker than a deliberate choice — the floor never invents literalism/empathy", () => {
    expect(Object.keys(FLEET_DEFAULT_DISPOSITION)).toEqual(["skepticism"]);
    expect(FLEET_DEFAULT_DISPOSITION.skepticism).toBe(4);
  });
});

describe("decideDispositionPush — what the floor may and may not overwrite", () => {
  const FLEET_ONLY: ("skepticism" | "literalism" | "empathy")[] = ["skepticism"];

  it("seeds the floor onto a bank that has no disposition at all", () => {
    expect(decideDispositionPush({ skepticism: 4 }, {}, FLEET_ONLY)).toEqual({
      skepticism: 4,
    });
  });

  it("seeds over the ENGINE default, which is not a choice anybody made", () => {
    expect(
      decideDispositionPush({ skepticism: 4 }, { skepticism: 3 }, FLEET_ONLY),
    ).toEqual({ skepticism: 4 });
  });

  it("REFUSES to lower a bank an operator tuned to 5", () => {
    // The live `overlord` bank is at skepticism 5 (read 2026-08-02). A fleet
    // floor that silently rewrote it to 4 would be a regression dressed as a
    // default. This is the assertion that forbids it.
    expect(
      decideDispositionPush({ skepticism: 4 }, { skepticism: 5 }, FLEET_ONLY),
    ).toBeUndefined();
  });

  it("REFUSES to raise a bank an operator tuned to 2", () => {
    expect(
      decideDispositionPush({ skepticism: 4 }, { skepticism: 2 }, FLEET_ONLY),
    ).toBeUndefined();
  });

  it("sends nothing when the bank already carries the value (silences the no-op apply)", () => {
    expect(
      decideDispositionPush({ skepticism: 4 }, { skepticism: 4 }, FLEET_ONLY),
    ).toBeUndefined();
  });

  it("a trait from a PROFILE or from yaml is authoritative and overwrites a tuned bank", () => {
    // Not fleet-only ⇒ not a default ⇒ the operator's config wins, which is
    // the pre-existing contract for disposition and must not change.
    expect(
      decideDispositionPush({ skepticism: 2 }, { skepticism: 5 }, []),
    ).toEqual({ skepticism: 2 });
  });

  it("decides per-trait: pushes the changed one, drops the current one", () => {
    expect(
      decideDispositionPush(
        { skepticism: 4, literalism: 5, empathy: 2 },
        { skepticism: 4, literalism: 3 },
        FLEET_ONLY,
      ),
    ).toEqual({ literalism: 5, empathy: 2 });
  });
});

describe("fleetOnlyDispositionTraits", () => {
  it("is the whole floor for a bare agent", () => {
    expect(fleetOnlyDispositionTraits(undefined, "default")).toEqual(["skepticism"]);
  });

  it("is empty when the PROFILE sets the trait — the profile made a choice", () => {
    expect(fleetOnlyDispositionTraits(undefined, "coding")).toEqual([]);
  });

  it("is empty when YAML sets the trait", () => {
    expect(
      fleetOnlyDispositionTraits({ disposition: { skepticism: 5 } }, "default"),
    ).toEqual([]);
  });
});

describe("fetchBankDisposition", () => {
  const respond = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("reads the engine's flat trait fields off the bank config endpoint", async () => {
    let seen = "";
    const fetchImpl = (async (url: string) => {
      seen = url;
      return new Response(
        JSON.stringify({
          config: { disposition_skepticism: 5, disposition_literalism: 4, disposition_empathy: 2 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await fetchBankDisposition("http://h:18888/mcp/", "probe", { fetchImpl });
    expect(seen).toBe("http://h:18888/v1/default/banks/probe/config");
    expect(r).toEqual({
      ok: true,
      disposition: { skepticism: 5, literalism: 4, empathy: 2 },
    });
  });

  it("reports an unset trait as absent, not as a number", async () => {
    const r = await fetchBankDisposition("http://h:18888/mcp/", "probe", {
      fetchImpl: respond({ config: { disposition_skepticism: null } }),
    });
    expect(r).toEqual({ ok: true, disposition: {} });
  });

  it("an unrecognised shape is a FAILED read, never 'everything unset'", async () => {
    // The dangerous confusion: "unset" makes every trait pushable, so a
    // renamed upstream field would rewrite the fleet.
    const r = await fetchBankDisposition("http://h:18888/mcp/", "probe", {
      fetchImpl: respond({ notConfig: {} }),
    });
    expect(r).toEqual({ ok: false, reason: "Unexpected shape" });
  });

  it("an HTTP error is a failed read", async () => {
    const r = await fetchBankDisposition("http://h:18888/mcp/", "probe", {
      fetchImpl: respond({}, 503),
    });
    expect(r).toEqual({ ok: false, reason: "HTTP 503" });
  });
});

describe("anti_confabulation_directive — yaml surface", () => {
  it("accepts unset, true, false, and operator text", () => {
    for (const v of [undefined, true, false, "house rule"]) {
      const parsed = AgentMemorySchema.parse({
        collection: "probe",
        ...(v === undefined ? {} : { anti_confabulation_directive: v }),
      });
      expect(parsed.anti_confabulation_directive).toBe(v);
    }
  });

  it("rejects an empty string (that is `false`, said ambiguously)", () => {
    expect(() =>
      AgentMemorySchema.parse({ collection: "probe", anti_confabulation_directive: "" }),
    ).toThrow();
  });

  it("cascades from defaults to an agent, and the agent wins", () => {
    const merged = mergeAgentConfig(
      { memory: { anti_confabulation_directive: false } },
      { memory: { anti_confabulation_directive: true } },
    );
    expect(merged.memory?.anti_confabulation_directive).toBe(true);
  });

  it("a fleet-tier opt-out reaches an agent that says nothing", () => {
    const merged = mergeAgentConfig(
      { memory: { anti_confabulation_directive: false } },
      { memory: {} },
    );
    expect(merged.memory?.anti_confabulation_directive).toBe(false);
  });
});

describe("resolveAntiConfabulationDirective", () => {
  it("seeds the shipped default with zero config", () => {
    const r = resolveAntiConfabulationDirective(undefined);
    expect(r.enabled).toBe(true);
    expect(r.desired).toBe(ANTI_CONFABULATION_DIRECTIVE);
    expect(r.operatorText).toBeUndefined();
  });

  it("treats a string as operator-authored text that wins outright", () => {
    const r = resolveAntiConfabulationDirective("never guess");
    expect(r.operatorText).toBe("never guess");
    expect(r.desired).toBe("never guess");
  });

  it("false disables", () => {
    expect(resolveAntiConfabulationDirective(false).enabled).toBe(false);
  });
});

describe("decideDirectiveSeed — never clobber a human", () => {
  const rec = (content: string): SeededDirectiveRecord => ({
    id: "d1",
    name: ANTI_CONFABULATION_DIRECTIVE_NAME,
    content,
  });

  it("creates when the bank has no directive of that name", () => {
    expect(decideDirectiveSeed(undefined, undefined, { activeCount: 0 })).toEqual({
      action: "create",
      content: ANTI_CONFABULATION_DIRECTIVE,
    });
  });

  it("does nothing when the bank already carries the current default", () => {
    expect(
      decideDirectiveSeed(rec(ANTI_CONFABULATION_DIRECTIVE), undefined, { activeCount: 1 }),
    ).toEqual({ action: "none" });
  });

  it("upgrades a bank still carrying a PREVIOUS switchroom default", () => {
    const old = "an older switchroom default";
    const d = decideDirectiveSeed(rec(old), undefined, {
      activeCount: 1,
      shipped: [old],
    });
    expect(d).toEqual({ action: "upgrade", content: ANTI_CONFABULATION_DIRECTIVE });
  });

  it("LEAVES ALONE text a human edited — even by one character", () => {
    const edited = ANTI_CONFABULATION_DIRECTIVE + " ";
    expect(decideDirectiveSeed(rec(edited), undefined, { activeCount: 1 })).toEqual({
      action: "none",
    });
  });

  it("pushes operator yaml text over a switchroom default", () => {
    const d = decideDirectiveSeed(rec(ANTI_CONFABULATION_DIRECTIVE), "house rule", {
      activeCount: 1,
    });
    expect(d).toEqual({ action: "upgrade", content: "house rule" });
  });

  it("does nothing once operator yaml text is already in place", () => {
    expect(
      decideDirectiveSeed(rec("house rule"), "house rule", { activeCount: 1 }),
    ).toEqual({ action: "none" });
  });

  it("false leaves an existing directive untouched (opting out is not a delete)", () => {
    expect(decideDirectiveSeed(rec("anything"), false, { activeCount: 1 })).toEqual({
      action: "none",
      reason: "disabled",
    });
  });

  it("refuses to CREATE past MAX_DIRECTIVES rather than truncate somebody's rule", () => {
    const d = decideDirectiveSeed(undefined, undefined, { activeCount: MAX_DIRECTIVES });
    expect(d.action).toBe("skip");
    expect(d.reason).toContain(String(MAX_DIRECTIVES));
  });

  it("still creates at one slot below the cap", () => {
    expect(
      decideDirectiveSeed(undefined, undefined, { activeCount: MAX_DIRECTIVES - 1 }).action,
    ).toBe("create");
  });

  it("upgrades a full bank — an upgrade consumes no slot", () => {
    const old = "older default";
    const d = decideDirectiveSeed(rec(old), undefined, {
      activeCount: MAX_DIRECTIVES + 5,
      shipped: [old],
    });
    expect(d.action).toBe("upgrade");
  });

  it("the shipped registry is append-only and starts empty", () => {
    expect(SUPERSEDED_ANTI_CONFABULATION_DIRECTIVES).toEqual([]);
    expect(SUPERSEDED_ANTI_CONFABULATION_DIRECTIVES).not.toContain(
      ANTI_CONFABULATION_DIRECTIVE,
    );
  });
});

describe("ensureAntiConfabulationDirective — what actually goes on the wire", () => {
  type Call = { url: string; method: string; body?: unknown };

  function harness(listItems: SeededDirectiveRecord[], opts?: { listStatus?: number }) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (method === "GET") {
        const status = opts?.listStatus ?? 200;
        return new Response(JSON.stringify({ items: listItems }), { status });
      }
      return new Response(JSON.stringify({ id: "d1" }), { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("POSTs the directive to the agent's own bank, tagged and prioritised", async () => {
    const { calls, fetchImpl } = harness([]);
    const out = await ensureAntiConfabulationDirective(
      "http://h:18888/mcp/",
      "probe",
      undefined,
      { fetchImpl },
    );
    expect(out).toEqual({ action: "created", name: ANTI_CONFABULATION_DIRECTIVE_NAME });

    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("http://h:18888/v1/default/banks/probe/directives");
    expect(post?.body).toEqual({
      name: ANTI_CONFABULATION_DIRECTIVE_NAME,
      content: ANTI_CONFABULATION_DIRECTIVE,
      priority: ANTI_CONFABULATION_DIRECTIVE_PRIORITY,
      is_active: true,
      tags: [SWITCHROOM_SEEDED_TAG],
    });
  });

  it("lists with active_only=false so a DEACTIVATED directive is not reseeded", async () => {
    const { calls, fetchImpl } = harness([
      {
        id: "d1",
        name: ANTI_CONFABULATION_DIRECTIVE_NAME,
        content: ANTI_CONFABULATION_DIRECTIVE,
        is_active: false,
      },
    ]);
    const out = await ensureAntiConfabulationDirective(
      "http://h:18888/mcp/",
      "probe",
      undefined,
      { fetchImpl },
    );
    expect(calls[0].url).toContain("active_only=false");
    expect(out.action).toBe("unchanged");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("is idempotent: a second apply issues no write at all", async () => {
    const { calls, fetchImpl } = harness([
      {
        id: "d1",
        name: ANTI_CONFABULATION_DIRECTIVE_NAME,
        content: ANTI_CONFABULATION_DIRECTIVE,
      },
    ]);
    const out = await ensureAntiConfabulationDirective(
      "http://h:18888/mcp/",
      "probe",
      undefined,
      { fetchImpl },
    );
    expect(out.action).toBe("unchanged");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("PATCHes only `content` when upgrading — never name, priority or tags", async () => {
    const { calls, fetchImpl } = harness([
      { id: "d1", name: ANTI_CONFABULATION_DIRECTIVE_NAME, content: "old text" },
    ]);
    await ensureAntiConfabulationDirective(
      "http://h:18888/mcp/",
      "probe",
      "operator text",
      { fetchImpl },
    );
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("http://h:18888/v1/default/banks/probe/directives/d1");
    expect(Object.keys(patch?.body as object)).toEqual(["content"]);
    expect((patch?.body as { content: string }).content).toBe("operator text");
  });

  it("issues NO request when disabled", async () => {
    const { calls, fetchImpl } = harness([]);
    const out = await ensureAntiConfabulationDirective(
      "http://h:18888/mcp/",
      "probe",
      false,
      { fetchImpl },
    );
    expect(out).toEqual({
      action: "skipped",
      name: ANTI_CONFABULATION_DIRECTIVE_NAME,
      reason: "disabled",
    });
    expect(calls).toEqual([]);
  });

  it("writes NOTHING when the list read fails — unknown is never treated as unset", async () => {
    const { calls, fetchImpl } = harness([], { listStatus: 503 });
    const out = await ensureAntiConfabulationDirective(
      "http://h:18888/mcp/",
      "probe",
      undefined,
      { fetchImpl },
    );
    expect(out.action).toBe("failed");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("never throws when the transport explodes", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const out = await ensureAntiConfabulationDirective(
      "http://h:18888/mcp/",
      "probe",
      undefined,
      { fetchImpl },
    );
    expect(out.action).toBe("failed");
  });

  it("addresses ONLY the bank it was given (path-pinned)", async () => {
    const { calls, fetchImpl } = harness([]);
    await ensureAntiConfabulationDirective("http://h:18888/mcp/", "other agent", undefined, {
      fetchImpl,
    });
    for (const c of calls) {
      expect(c.url).toContain("/banks/other%20agent/directives");
    }
  });
});

describe("the directive text itself", () => {
  it("names both failures it exists to stop", () => {
    // If someone rewrites the text into vague encouragement, these fail.
    expect(ANTI_CONFABULATION_DIRECTIVE).toMatch(/does not know/i);
    expect(ANTI_CONFABULATION_DIRECTIVE).toMatch(/presupposes/i);
  });

  it("is a directive, not a mission — small enough to ride every reflect", () => {
    // Directives are injected into the prompt on every recall/reflect and are
    // capped at MAX_DIRECTIVES; a page-long guardrail crowds out the operator's.
    expect(ANTI_CONFABULATION_DIRECTIVE.length).toBeLessThan(1500);
  });
});
