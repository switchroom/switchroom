/**
 * Tests for the pure cron quota-preflight decision. The wiring (broker
 * listState + bounded retry) is covered in agent-scheduler/index.test.ts via
 * an injected gate; here we pin the decision itself.
 */
import { describe, it, expect } from "vitest";
import { decideQuotaPreflight } from "./quota-preflight.js";
import type { ListStateData } from "../auth/broker/client.js";

function state(accounts: Array<{ label: string; exhausted: boolean }>): ListStateData {
  return {
    active: accounts[0]?.label ?? "",
    fallback_order: accounts.map((a) => a.label),
    accounts,
    agents: [],
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
