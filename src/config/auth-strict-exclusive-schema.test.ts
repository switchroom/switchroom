/**
 * Schema validation for per-agent auth pin hardening: `strict` (never
 * serve this agent from another account) and `exclusive` (never serve
 * this account to anyone else). Both are modifiers of `override` and
 * exclusivity must be unroutable-by-construction: any config path that
 * would serve an exclusive account elsewhere is a load-time error.
 * Runtime (hot-mutation) enforcement is pinned in
 * src/auth/broker/server-override-strict-exclusive.test.ts.
 */

import { describe, expect, it } from "vitest";

import { SwitchroomConfigSchema } from "./schema.js";

const base = {
  switchroom: { version: 1 },
  telegram: { bot_token: "x", forum_chat_id: "1" },
};

function agent(auth?: object): object {
  return { topic_name: "T", ...(auth ? { auth } : {}) };
}

describe("agent auth pin hardening — accept forms", () => {
  it("accepts override alone (existing behavior)", () => {
    const r = SwitchroomConfigSchema.safeParse({
      ...base,
      agents: { workbot: agent({ override: "work" }) },
    });
    expect(r.success).toBe(true);
  });

  it("accepts override + strict + exclusive when nothing else routes to the account", () => {
    const r = SwitchroomConfigSchema.safeParse({
      ...base,
      auth: { active: "personal", fallback_order: ["personal", "backup"] },
      agents: {
        workbot: agent({ override: "work", strict: true, exclusive: true }),
        other: agent(),
      },
    });
    expect(r.success).toBe(true);
  });

  it("accepts strict without exclusive (one-way isolation)", () => {
    const r = SwitchroomConfigSchema.safeParse({
      ...base,
      agents: { workbot: agent({ override: "work", strict: true }) },
    });
    expect(r.success).toBe(true);
  });
});

describe("agent auth pin hardening — reject forms", () => {
  it("rejects strict without override", () => {
    const r = SwitchroomConfigSchema.safeParse({
      ...base,
      agents: { workbot: agent({ strict: true }) },
    });
    expect(r.success).toBe(false);
    expect(
      !r.success && r.error.issues.some((i) => /`auth\.strict: true` requires/.test(i.message)),
    ).toBe(true);
  });

  it("rejects exclusive without override", () => {
    const r = SwitchroomConfigSchema.safeParse({
      ...base,
      agents: { workbot: agent({ exclusive: true }) },
    });
    expect(r.success).toBe(false);
    expect(
      !r.success && r.error.issues.some((i) => /`auth\.exclusive: true` requires/.test(i.message)),
    ).toBe(true);
  });

  it("rejects an exclusive account as the fleet auth.active", () => {
    const r = SwitchroomConfigSchema.safeParse({
      ...base,
      auth: { active: "work" },
      agents: { workbot: agent({ override: "work", exclusive: true }) },
    });
    expect(r.success).toBe(false);
    expect(
      !r.success &&
        r.error.issues.some((i) => /cannot be the fleet `auth\.active`/.test(i.message)),
    ).toBe(true);
  });

  it("rejects an exclusive account in auth.fallback_order", () => {
    const r = SwitchroomConfigSchema.safeParse({
      ...base,
      auth: { active: "personal", fallback_order: ["personal", "work"] },
      agents: { workbot: agent({ override: "work", exclusive: true }) },
    });
    expect(r.success).toBe(false);
    expect(
      !r.success &&
        r.error.issues.some((i) => /cannot appear in `auth\.fallback_order`/.test(i.message)),
    ).toBe(true);
  });

  it("rejects another agent pinned to an exclusive account", () => {
    const r = SwitchroomConfigSchema.safeParse({
      ...base,
      agents: {
        workbot: agent({ override: "work", exclusive: true }),
        freeloader: agent({ override: "work" }),
      },
    });
    expect(r.success).toBe(false);
    expect(
      !r.success && r.error.issues.some((i) => /agent 'freeloader' cannot pin it/.test(i.message)),
    ).toBe(true);
  });

  it("rejects a consumer pinned to an exclusive account", () => {
    const r = SwitchroomConfigSchema.safeParse({
      ...base,
      auth: { consumers: [{ name: "hindsight", account: "work" }] },
      agents: { workbot: agent({ override: "work", exclusive: true }) },
    });
    expect(r.success).toBe(false);
    expect(
      !r.success &&
        r.error.issues.some((i) => /consumer 'hindsight' cannot pin it/.test(i.message)),
    ).toBe(true);
  });

  it("rejects two agents both exclusive on the same account (symmetric)", () => {
    const r = SwitchroomConfigSchema.safeParse({
      ...base,
      agents: {
        workbot: agent({ override: "work", exclusive: true }),
        rival: agent({ override: "work", exclusive: true }),
      },
    });
    expect(r.success).toBe(false);
    // Each side flags the other's override path.
    expect(
      !r.success && r.error.issues.filter((i) => /cannot pin it/.test(i.message)).length,
    ).toBe(2);
  });
});
