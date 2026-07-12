/**
 * Tests for the pure cron quota-preflight decision. The wiring (broker
 * listState + bounded retry) is covered in agent-scheduler/index.test.ts via
 * an injected gate; here we pin the decision itself.
 */
import { describe, it, expect } from "vitest";
import { decideQuotaPreflight } from "./quota-preflight.js";
import type { ListStateData } from "../auth/broker/client.js";

function state(
  accounts: Array<{ label: string; exhausted: boolean; throttled_until?: number }>,
  opts: { agents?: Array<{ name: string; account: string; override: string | null }> } = {},
): ListStateData {
  return {
    active: accounts[0]?.label ?? "",
    fallback_order: accounts.map((a) => a.label),
    accounts,
    agents: opts.agents ?? [],
    consumers: [],
  };
}

describe("decideQuotaPreflight", () => {
  it("defers when EVERY account is exhausted (the true wall)", () => {
    const d = decideQuotaPreflight(state([
      { label: "a", exhausted: true },
      { label: "b", exhausted: true },
    ]));
    expect(d.defer).toBe(true);
    expect(d.reason).toContain("all 2");
  });

  it("does NOT defer when at least one account is healthy", () => {
    const d = decideQuotaPreflight(state([
      { label: "a", exhausted: true },
      { label: "b", exhausted: false },
    ]));
    expect(d.defer).toBe(false);
    expect(d.reason).toContain("1/2");
  });

  it("does NOT defer when all accounts are healthy", () => {
    expect(decideQuotaPreflight(state([{ label: "a", exhausted: false }])).defer).toBe(false);
  });

  it("does NOT defer when there are no accounts (never block on emptiness)", () => {
    expect(decideQuotaPreflight(state([])).defer).toBe(false);
  });
});

describe("decideQuotaPreflight — 429 throttle-tier soft-defer", () => {
  const NOW = 1_750_000_000_000;

  it("soft-defers while the ACTIVE account is throttled, carrying retryAtMs", () => {
    const until = NOW + 90_000;
    const d = decideQuotaPreflight(
      state([
        { label: "a", exhausted: false, throttled_until: until },
        { label: "b", exhausted: false },
      ]),
      { now: NOW },
    );
    expect(d.defer).toBe(true);
    expect(d.reason).toContain("'a' rate-throttled");
    expect(d.retryAtMs).toBe(until);
  });

  it("uses the AGENT's effective (override) account, not the fleet active", () => {
    const until = NOW + 60_000;
    const s = state(
      [
        { label: "a", exhausted: false },
        { label: "pinned", exhausted: false, throttled_until: until },
      ],
      { agents: [{ name: "ziggy", account: "pinned", override: "pinned" }] },
    );
    // ziggy rides the throttled pinned account → defer…
    const dz = decideQuotaPreflight(s, { agent: "ziggy", now: NOW });
    expect(dz.defer).toBe(true);
    expect(dz.retryAtMs).toBe(until);
    // …but an agent on the (healthy) fleet active dispatches.
    const da = decideQuotaPreflight(s, { agent: "other", now: NOW });
    expect(da.defer).toBe(false);
  });

  it("does NOT defer once the throttle has expired", () => {
    const d = decideQuotaPreflight(
      state([{ label: "a", exhausted: false, throttled_until: NOW - 1 }]),
      { now: NOW },
    );
    expect(d.defer).toBe(false);
  });

  it("does NOT throttle-defer on a NON-effective account's throttle", () => {
    const d = decideQuotaPreflight(
      state([
        { label: "a", exhausted: false },
        { label: "b", exhausted: false, throttled_until: NOW + 60_000 },
      ]),
      { now: NOW },
    );
    expect(d.defer).toBe(false);
  });

  it("all-exhausted still wins over throttle (harder condition first)", () => {
    const d = decideQuotaPreflight(
      state([
        { label: "a", exhausted: true, throttled_until: NOW + 60_000 },
        { label: "b", exhausted: true },
      ]),
      { now: NOW },
    );
    expect(d.defer).toBe(true);
    expect(d.reason).toContain("all 2");
    expect(d.retryAtMs).toBeUndefined();
  });

  it("an exhausted effective account with a stale throttle does not double-flag", () => {
    // Effective account exhausted (mark) but another healthy → no defer via
    // throttle rule (rule 2 requires !exhausted).
    const d = decideQuotaPreflight(
      state([
        { label: "a", exhausted: true, throttled_until: NOW + 60_000 },
        { label: "b", exhausted: false },
      ]),
      { now: NOW },
    );
    expect(d.defer).toBe(false);
  });
});
