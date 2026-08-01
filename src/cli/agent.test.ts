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
import { summarizeReconcileBatch, resolveLogsTail, registerAgentCommand, shouldAutoRestartAfterReconcile } from "./agent.js";
import { buildAgentLogsArgs } from "../agents/lifecycle.js";

describe("resolveLogsTail (agent logs --lines clamp contract)", () => {
  it("defaults to 50 when --lines is omitted", () => {
    expect(resolveLogsTail(undefined)).toBe(50);
  });

  it("passes through an in-range value", () => {
    expect(resolveLogsTail("30")).toBe(30);
    expect(resolveLogsTail("1")).toBe(1); // floor
    expect(resolveLogsTail("1000")).toBe(1000); // cap boundary
  });

  it("caps at 1000", () => {
    expect(resolveLogsTail("1001")).toBe(1000);
    expect(resolveLogsTail("999999")).toBe(1000);
  });

  it("falls back to the default of 50 for non-numeric input", () => {
    expect(resolveLogsTail("abc")).toBe(50);
    expect(resolveLogsTail("")).toBe(50);
  });

  it("falls back to the default of 50 for values below the floor", () => {
    expect(resolveLogsTail("0")).toBe(50);
    expect(resolveLogsTail("-5")).toBe(50);
  });
});

describe("buildAgentLogsArgs (docker argv contract)", () => {
  it("emits docker logs --tail <n> for a bounded dump", () => {
    expect(buildAgentLogsArgs("coach", false, 30)).toEqual([
      "logs", "--tail", "30", "switchroom-coach",
    ]);
  });

  it("threads the resolved default (50) through as --tail 50", () => {
    expect(buildAgentLogsArgs("coach", false, resolveLogsTail(undefined))).toEqual([
      "logs", "--tail", "50", "switchroom-coach",
    ]);
  });

  it("threads a clamped oversize value through as --tail 1000", () => {
    expect(buildAgentLogsArgs("coach", false, resolveLogsTail("5000"))).toEqual([
      "logs", "--tail", "1000", "switchroom-coach",
    ]);
  });

  it("bounds the follow backlog too (-f + --tail)", () => {
    expect(buildAgentLogsArgs("coach", true, 50)).toEqual([
      "logs", "-f", "--tail", "50", "switchroom-coach",
    ]);
  });

  it("omits --tail entirely when no tail is given (full-dump escape hatch)", () => {
    expect(buildAgentLogsArgs("coach", false, undefined)).toEqual([
      "logs", "switchroom-coach",
    ]);
  });

  // #tz-fix audit gap 2: the Telegram /logs local-time render depends on
  // docker's own UTC ISO-Z per-line stamp, which ONLY exists when the argv
  // carries --timestamps. Without this, raw lines have no leading ISO-Z
  // stamp and the display transform is dead code.
  it("emits --timestamps when requested (the Telegram /logs shape)", () => {
    expect(buildAgentLogsArgs("coach", false, 20, true)).toEqual([
      "logs", "--tail", "20", "--timestamps", "switchroom-coach",
    ]);
  });

  it("omits --timestamps by default (plain CLI dump unchanged)", () => {
    expect(buildAgentLogsArgs("coach", false, 20)).toEqual([
      "logs", "--tail", "20", "switchroom-coach",
    ]);
  });
});

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

  // Same drift-class outcome test for --timestamps: the gateway's /logs now
  // builds `agent logs <name> --lines <n> --timestamps`; an unregistered
  // option would make every /logs invocation error out.
  it("registers a --timestamps / -t boolean option", () => {
    const logs = findLogsCommand();
    const opt = logs.options.find((o) => o.long === "--timestamps");
    expect(opt).toBeDefined();
    expect(opt!.short).toBe("-t");
    // boolean flag (takes no value)
    expect(opt!.required || opt!.optional).toBe(false);
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

describe("agent effective-model command", () => {
  // The launcher (start.sh) shells `switchroom agent effective-model <name>`
  // at every boot — an unregistered verb would silently fail the live read
  // on EVERY agent and drop the whole fleet to baked/LKG fallbacks. Same
  // drift-class outcome test as the /logs options above.
  function findCommand(): Command | undefined {
    const program = new Command();
    registerAgentCommand(program);
    const agent = program.commands.find((c) => c.name() === "agent")!;
    return agent.commands.find((c) => c.name() === "effective-model");
  }

  it("is registered with a required <name> argument", () => {
    const cmd = findCommand();
    expect(cmd).toBeDefined();
    expect(cmd!.registeredArguments.map((a) => `${a.name()}:${a.required}`)).toEqual(["name:true"]);
  });
});

describe("shouldAutoRestartAfterReconcile (--no-restart opt-out, switchroom#3903)", () => {
  // Regression: reconcile declared `--no-restart` but read the flag via
  // `opts.noRestart`, which Commander never sets (it exposes the negated
  // flag as `opts.restart === false`). So `--no-restart` was silently
  // ignored and the agent auto-restarted anyway whenever a
  // restart-required change was present. This pins the corrected
  // `opts.restart !== false` decision.

  it("--no-restart (opts.restart === false) suppresses the auto-restart", () => {
    // restart-required changes present, but user opted out → no restart.
    expect(shouldAutoRestartAfterReconcile({ restart: false }, 3)).toBe(false);
  });

  it("default (flag absent) auto-restarts when restart-required changes exist", () => {
    expect(shouldAutoRestartAfterReconcile({}, 3)).toBe(true);
    expect(shouldAutoRestartAfterReconcile({ restart: undefined }, 3)).toBe(true);
  });

  it("--restart (opts.restart === true) auto-restarts when changes exist", () => {
    expect(shouldAutoRestartAfterReconcile({ restart: true }, 3)).toBe(true);
  });

  it("no restart-required changes → never auto-restarts, regardless of flag", () => {
    expect(shouldAutoRestartAfterReconcile({}, 0)).toBe(false);
    expect(shouldAutoRestartAfterReconcile({ restart: false }, 0)).toBe(false);
    expect(shouldAutoRestartAfterReconcile({ restart: true }, 0)).toBe(false);
  });

  it("Commander parses --no-restart into opts.restart === false (not opts.noRestart)", () => {
    // Pins the root-cause fact: the camelCase-negation read the fix removes
    // (`opts.noRestart`) never exists — only `opts.restart` does.
    const cmd = new Command();
    cmd
      .command("reconcile <name>")
      .option("--restart", "restart")
      .option("--no-restart", "skip restart")
      .action(() => {});
    cmd.parse(["node", "test", "reconcile", "agentx", "--no-restart"]);
    const opts = cmd.commands.find((c) => c.name() === "reconcile")!.opts();
    expect(opts.restart).toBe(false);
    expect(opts.noRestart).toBeUndefined();
  });
});
