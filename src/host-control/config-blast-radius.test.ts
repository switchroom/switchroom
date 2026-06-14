/**
 * Tests for classifyBlastRadius — which agents must restart for an applied
 * config edit to take effect. Pins the fail-safe (unknown → fleet-wide) and
 * the agents.<X> → agent X mapping.
 */

import { describe, it, expect } from "vitest";
import { classifyBlastRadius, changedConfigPaths } from "./config-blast-radius.js";

const yaml = (agents: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ agents, ...extra }); // JSON is valid YAML — fine for the parser

describe("classifyBlastRadius", () => {
  it("maps a self-scoped agent change to that single agent", () => {
    const before = yaml({ clerk: { tools: { allow: ["Read"] } }, gymbro: {} });
    const after = yaml({ clerk: { tools: { allow: ["Read", "Edit(/x)"] } }, gymbro: {} });
    const r = classifyBlastRadius(before, after);
    expect(r.fleetWide).toBe(false);
    expect(r.agents).toEqual(["clerk"]);
  });

  it("maps changes to multiple agents to that exact set", () => {
    const before = yaml({ clerk: { model: "sonnet" }, gymbro: { model: "sonnet" }, finn: {} });
    const after = yaml({ clerk: { model: "opus" }, gymbro: { model: "opus" }, finn: {} });
    const r = classifyBlastRadius(before, after);
    expect(r.fleetWide).toBe(false);
    expect(r.agents).toEqual(["clerk", "gymbro"]);
  });

  it("treats adding a new agent block as that agent", () => {
    const before = yaml({ clerk: {} });
    const after = yaml({ clerk: {}, newbie: { model: "haiku" } });
    const r = classifyBlastRadius(before, after);
    expect(r.fleetWide).toBe(false);
    expect(r.agents).toEqual(["newbie"]);
  });

  it("classifies a defaults change as FLEET-WIDE", () => {
    const before = yaml({ clerk: {} }, { defaults: { model: "sonnet" } });
    const after = yaml({ clerk: {} }, { defaults: { model: "opus" } });
    const r = classifyBlastRadius(before, after);
    expect(r.fleetWide).toBe(true);
    expect(r.agents).toEqual([]);
  });

  it("classifies a profiles / top-level (telegram, mcp_servers) change as FLEET-WIDE", () => {
    expect(
      classifyBlastRadius(
        yaml({ clerk: {} }, { profiles: { base: { model: "a" } } }),
        yaml({ clerk: {} }, { profiles: { base: { model: "b" } } }),
      ).fleetWide,
    ).toBe(true);
    expect(
      classifyBlastRadius(
        yaml({ clerk: {} }, { mcp_servers: { x: { url: "a" } } }),
        yaml({ clerk: {} }, { mcp_servers: { x: { url: "b" } } }),
      ).fleetWide,
    ).toBe(true);
  });

  it("a mixed agent + shared change is fleet-wide (over-inclusive, fail-safe)", () => {
    const before = yaml({ clerk: { model: "a" } }, { defaults: { model: "a" } });
    const after = yaml({ clerk: { model: "b" } }, { defaults: { model: "b" } });
    const r = classifyBlastRadius(before, after);
    expect(r.fleetWide).toBe(true);
    expect(r.agents).toEqual([]);
  });

  it("fails safe to fleet-wide on unparseable input", () => {
    const r = classifyBlastRadius("agents: {", ": : not yaml");
    expect(r.fleetWide).toBe(true);
  });

  it("no change → no agents, not fleet-wide", () => {
    const same = yaml({ clerk: { model: "a" } });
    const r = classifyBlastRadius(same, same);
    expect(r.fleetWide).toBe(false);
    expect(r.agents).toEqual([]);
    expect(r.changedPaths).toEqual([]);
  });
});

describe("changedConfigPaths", () => {
  it("reports the shallowest diverging dotted path", () => {
    expect(
      changedConfigPaths({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } }),
    ).toEqual(["a.c"]);
  });
  it("reports added and removed keys", () => {
    expect(changedConfigPaths({ a: 1 }, { a: 1, b: 2 }).sort()).toEqual(["b"]);
    expect(changedConfigPaths({ a: 1, b: 2 }, { a: 1 }).sort()).toEqual(["b"]);
  });
});
