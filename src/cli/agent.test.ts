/**
 * Tests for the reconcile-all batch summary helper.
 *
 * The reconcile-all loop in `agent.ts` aggregates per-agent failures
 * (rather than aborting the batch on the first failure) and exits
 * non-zero when any agent failed. This test pins the helper's
 * formatting contract so the summary stays parseable for callers /
 * CI grep.
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { summarizeReconcileBatch } from "./agent.js";
import { registerAgentCommand } from "./agent.js";

describe("agent logs command options", () => {
  // Outcome test for the #logs Telegram-drift bug: the gateway builds
  // `switchroom agent logs <name> --lines <n>`, but the CLI only exposed
  // `-f/--follow` and rejected `--lines` with `error: unknown option
  // '--lines'`. This asserts the option is actually registered on the
  // command — a test that fails on the drift, not just exercises the path.
  function findLogsCommand(): Command {
    const program = new Command();
    registerAgentCommand(program);
    const agent = program.commands.find((c) => c.name() === "agent")!;
    return agent.commands.find((c) => c.name() === "logs")!;
  }

  it("registers a --lines / -n option accepting a value", () => {
    const logs = findLogsCommand();
    const opt = logs.options.find((o) => o.long === "--lines");
    expect(opt).toBeDefined();
    expect(opt!.short).toBe("-n");
    // takes a value (not a boolean flag)
    expect(opt!.required || opt!.optional).toBe(true);
  });

  it("still exposes -f / --follow", () => {
    const logs = findLogsCommand();
    expect(logs.options.find((o) => o.long === "--follow")).toBeDefined();
  });

  it("advertises --lines in its help output", () => {
    const logs = findLogsCommand();
    expect(logs.helpInformation()).toContain("--lines");
  });
});

describe("summarizeReconcileBatch", () => {
  it("returns null when no agents failed", () => {
    expect(summarizeReconcileBatch(3, [])).toBeNull();
  });

  it("reports success / fail counts when at least one agent failed", () => {
    const out = summarizeReconcileBatch(3, [
      { name: "alice", error: "boom" },
    ]);
    expect(out).not.toBeNull();
    expect(out!.header).toBe("Summary: 2 succeeded, 1 failed");
    expect(out!.lines).toEqual(["alice: boom"]);
  });

  it("lists every failure when multiple agents fail", () => {
    const out = summarizeReconcileBatch(4, [
      { name: "alice", error: "boom" },
      { name: "bob", error: "permission denied" },
    ]);
    expect(out!.header).toBe("Summary: 2 succeeded, 2 failed");
    expect(out!.lines).toEqual([
      "alice: boom",
      "bob: permission denied",
    ]);
  });

  it("handles the case where every agent failed", () => {
    const out = summarizeReconcileBatch(2, [
      { name: "alice", error: "x" },
      { name: "bob", error: "y" },
    ]);
    expect(out!.header).toBe("Summary: 0 succeeded, 2 failed");
  });
});
