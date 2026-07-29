/**
 * #3963 — switchroom must be able to re-invoke ITSELF from the published
 * static binary.
 *
 * The shipped artifact is a `bun build --compile` single-file executable.
 * Inside it, `process.execPath` is the binary and `process.argv[1]` is the
 * VIRTUAL bundle path `/$bunfs/root/switchroom-linux-amd64`. Every
 * self-spawning command used to build its child argv as
 * `[process.execPath, process.argv[1], ...args]`, which produced
 *
 *     switchroom /$bunfs/root/switchroom-linux-amd64 apply …
 *
 * and commander answered `error: unknown command
 * '/$bunfs/root/switchroom-linux-amd64'`. `switchroom rollout` therefore
 * died on step 1 with zero agents rolled on every binary install.
 *
 * These assertions are on the ARGV that reaches `spawn`, for BOTH modes,
 * so they fail on the bug rather than merely walking the code path. A
 * bunfs path appearing anywhere in a child's argv is the regression.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCompiledBinaryPath,
  resolveSelfInvocation,
  selfInvokeArgv,
} from "./self-invoke.js";
import { createRolloutDeps, type RolloutSpawnSync } from "./rollout.js";
import { planUpdate } from "./update.js";
import { buildSelfElevateArgv } from "./apply.js";

/** What a compiled binary actually reports for these two values. */
const COMPILED = {
  execPath: "/usr/local/bin/switchroom",
  scriptPath: "/$bunfs/root/switchroom-linux-amd64",
};
/** What a JS install (npm global, `bun dist/cli/switchroom.js`) reports. */
const JS_INSTALL = {
  execPath: "/usr/local/bin/bun",
  scriptPath: "/opt/switchroom/dist/cli/switchroom.js",
};

/** The tell: no child argv may ever contain a bunfs path. */
function expectNoBunfs(argv: readonly string[]): void {
  for (const a of argv) {
    expect(a).not.toMatch(/\$bunfs/);
    expect(a).not.toMatch(/~BUN/);
  }
}

describe("isCompiledBinaryPath", () => {
  it("recognises the POSIX bunfs virtual root", () => {
    expect(isCompiledBinaryPath("/$bunfs/root/switchroom-linux-amd64")).toBe(true);
    expect(isCompiledBinaryPath("/$bunfs/root/switchroom-macos-arm64")).toBe(true);
  });

  it("recognises the Windows bunfs virtual root", () => {
    expect(isCompiledBinaryPath("B:\\~BUN\\root\\switchroom.exe")).toBe(true);
  });

  it("does not claim a real script path", () => {
    expect(isCompiledBinaryPath("/opt/switchroom/dist/cli/switchroom.js")).toBe(false);
    expect(isCompiledBinaryPath("/home/op/src/switchroom/src/cli/switchroom.ts")).toBe(false);
  });

  it("does not claim an absent path", () => {
    expect(isCompiledBinaryPath(undefined)).toBe(false);
    expect(isCompiledBinaryPath("")).toBe(false);
  });
});

describe("resolveSelfInvocation", () => {
  it("compiled binary: spawns the binary with NO script argument", () => {
    const inv = resolveSelfInvocation(COMPILED);
    expect(inv.compiled).toBe(true);
    expect(inv.command).toBe(COMPILED.execPath);
    // The whole bug: this must be empty, not [scriptPath].
    expect(inv.prefixArgs).toEqual([]);
  });

  it("JS install: spawns the interpreter with the script path in front", () => {
    const inv = resolveSelfInvocation(JS_INSTALL);
    expect(inv.compiled).toBe(false);
    expect(inv.command).toBe(JS_INSTALL.execPath);
    expect(inv.prefixArgs).toEqual([JS_INSTALL.scriptPath]);
  });

  it("falls back to $PATH resolution rather than spawning an empty string", () => {
    expect(resolveSelfInvocation({ execPath: "", scriptPath: "" })).toEqual({
      command: "switchroom",
      prefixArgs: [],
      compiled: false,
    });
    expect(resolveSelfInvocation({ execPath: "", ...{ scriptPath: COMPILED.scriptPath } }))
      .toEqual({ command: "switchroom", prefixArgs: [], compiled: true });
  });

  it("selfInvokeArgv puts the subcommand FIRST for a compiled binary", () => {
    const { command, argv } = selfInvokeArgv(["apply", "--non-interactive"], COMPILED);
    expect(command).toBe(COMPILED.execPath);
    expect(argv).toEqual(["apply", "--non-interactive"]);
    expectNoBunfs(argv);
  });

  it("selfInvokeArgv keeps the script path for a JS install", () => {
    const { command, argv } = selfInvokeArgv(["apply", "--non-interactive"], JS_INSTALL);
    expect(command).toBe(JS_INSTALL.execPath);
    expect(argv).toEqual([JS_INSTALL.scriptPath, "apply", "--non-interactive"]);
  });
});

// ─── call sites ──────────────────────────────────────────────────────────
//
// The helper being right is necessary but not sufficient: the bug was in
// the call sites. Each block below asserts the argv that actually reaches
// spawn, under BOTH execution modes.

describe("rollout self-spawn (#3963 — the reproduced failure)", () => {
  function spy(): {
    calls: Array<{ cmd: string; args: string[] }>;
    spawn: RolloutSpawnSync;
  } {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawn: RolloutSpawnSync = (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: "" };
    };
    return { calls, spawn };
  }

  it("compiled binary: `apply` is the subcommand, not the bunfs path", () => {
    const { calls, spawn } = spy();
    const deps = createRolloutDeps({
      configPath: "/nope/switchroom.yaml",
      scriptPath: COMPILED.scriptPath,
      execPath: COMPILED.execPath,
      hostdCtx: false,
      spawn,
      warn: () => undefined,
    });
    deps.run(["apply", "--pin", "v0.19.32", "--non-interactive"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(COMPILED.execPath);
    // Pre-fix this was ["/$bunfs/root/switchroom-linux-amd64", "apply", …]
    // and the child exited with `unknown command '/$bunfs/root/…'`.
    expect(calls[0]!.args[0]).toBe("apply");
    expect(calls[0]!.args).toEqual(["apply", "--pin", "v0.19.32", "--non-interactive"]);
    expectNoBunfs(calls[0]!.args);
  });

  it("compiled binary: the per-agent restart step is intact too", () => {
    const { calls, spawn } = spy();
    const deps = createRolloutDeps({
      configPath: "/nope/switchroom.yaml",
      scriptPath: COMPILED.scriptPath,
      execPath: COMPILED.execPath,
      hostdCtx: false,
      spawn,
      warn: () => undefined,
    });
    deps.run(["agent", "restart", "clerk", "--wait", "--force"]);
    expect(calls[0]!.args).toEqual(["agent", "restart", "clerk", "--wait", "--force"]);
  });

  it("JS install: unchanged — interpreter + script path + subcommand", () => {
    const { calls, spawn } = spy();
    const deps = createRolloutDeps({
      configPath: "/nope/switchroom.yaml",
      scriptPath: JS_INSTALL.scriptPath,
      execPath: JS_INSTALL.execPath,
      hostdCtx: false,
      spawn,
      warn: () => undefined,
    });
    deps.run(["apply"]);
    expect(calls[0]!.cmd).toBe(JS_INSTALL.execPath);
    expect(calls[0]!.args).toEqual([JS_INSTALL.scriptPath, "apply"]);
  });
});

describe("update self-spawn steps (#3963)", () => {
  function planWith(mode: { execPath: string; scriptPath: string }) {
    const tmp = mkdtempSync(join(tmpdir(), "self-invoke-update-"));
    const composePath = join(tmp, "docker-compose.yml");
    writeFileSync(composePath, "services: {}\n");
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const steps = planUpdate({
      composePath,
      execPath: mode.execPath,
      scriptPath: mode.scriptPath,
      skipSelfUpdate: true,
      hostControlEnabled: true,
      webServiceManaged: true,
      memoryBackendHindsight: true,
      hostdContext: false,
      runner: (cmd, args) => {
        calls.push({ cmd, args });
        return { status: 0 };
      },
    });
    rmSync(tmp, { recursive: true, force: true });
    return { steps, calls };
  }

  const selfInvoking = [
    ["apply-config", ["apply", "--non-interactive", "--no-doctor"]],
    ["refresh-hostd", ["hostd", "install"]],
    ["refresh-web", ["webd", "install"]],
  ] as const;

  for (const [stepName, expectedArgs] of selfInvoking) {
    it(`compiled binary: ${stepName} passes "${expectedArgs[0]}" as the subcommand`, async () => {
      const { steps, calls } = planWith(COMPILED);
      const step = steps.find((s) => s.name === stepName)!;
      expect(step).toBeDefined();
      await step.run();
      const self = calls.find((c) => c.cmd === COMPILED.execPath);
      expect(self, `${stepName} did not spawn the binary`).toBeDefined();
      expect(self!.args).toEqual([...expectedArgs]);
      expectNoBunfs(self!.args);
    });

    it(`JS install: ${stepName} keeps the interpreter + script path`, async () => {
      const { steps, calls } = planWith(JS_INSTALL);
      const step = steps.find((s) => s.name === stepName)!;
      await step.run();
      const self = calls.find((c) => c.cmd === JS_INSTALL.execPath);
      expect(self).toBeDefined();
      expect(self!.args).toEqual([JS_INSTALL.scriptPath, ...expectedArgs]);
    });
  }

  it("compiled binary: refresh-hindsight passes `memory setup --recreate`", async () => {
    const { steps, calls } = planWith(COMPILED);
    const step = steps.find((s) => s.name === "refresh-hindsight")!;
    await step.run();
    const self = calls.find((c) => c.cmd === COMPILED.execPath)!;
    expect(self.args.slice(0, 3)).toEqual(["memory", "setup", "--recreate"]);
    expectNoBunfs(self.args);
  });

  it("compiled binary: no update step can ever hand a child a bunfs path", async () => {
    const { steps, calls } = planWith(COMPILED);
    for (const step of steps) {
      if (step.skipReason) continue;
      try {
        await step.run();
      } catch {
        // Steps that shell out to docker/fs fail in a unit environment;
        // we only care about the argv they built before failing.
      }
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expectNoBunfs(c.args);
  });
});

/**
 * Structural guard. The five broken call sites all shared ONE spelling:
 * `spawn(process.execPath, [<argv[1]-derived path>, …])`. Nothing stops a
 * sixth from being written the same way, and no behavioural test can see a
 * call site that does not exist yet — so pin the spelling itself. Every
 * self-invocation must route through `self-invoke.ts`.
 */
describe("no source file re-invokes switchroom by hand (#3963)", () => {
  const FORBIDDEN = [
    /\bspawn(?:Sync)?\s*\(\s*process\.execPath\b/,
    /\bspawn(?:Sync)?\s*\(\s*process\.argv0\b/,
    /\bexecFile(?:Sync)?\s*\(\s*process\.execPath\b/,
  ];

  it("routes every self-spawn through resolveSelfInvocation", () => {
    const srcRoot = join(import.meta.dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        if (entry.name.endsWith(".test.ts")) continue;
        const text = readFileSync(p, "utf-8");
        text.split("\n").forEach((line, i) => {
          // Comments may quote the broken shape to explain it.
          const t = line.trim();
          if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return;
          if (FORBIDDEN.some((re) => re.test(line))) {
            offenders.push(`${p}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    };
    walk(srcRoot);
    expect(
      offenders,
      "spawn the result of resolveSelfInvocation()/selfInvokeArgv() instead — " +
        "process.argv[1] is a virtual /$bunfs path in the published binary (#3963)",
    ).toEqual([]);
  });
});

describe("apply --self-elevate sudo argv (#3963)", () => {
  it("compiled binary: sudo runs the binary with the subcommand directly", () => {
    const argv = buildSelfElevateArgv(COMPILED);
    const execIdx = argv.indexOf(COMPILED.execPath);
    expect(execIdx).toBeGreaterThanOrEqual(0);
    // Immediately after the binary comes the passthrough argv, never a
    // bunfs bundle path.
    expectNoBunfs(argv);
    expect(argv[argv.length - 1]).toBe("--skip-self-elevate");
  });

  it("JS install: sudo runs interpreter + script path (unchanged)", () => {
    const argv = buildSelfElevateArgv(JS_INSTALL);
    const execIdx = argv.indexOf(JS_INSTALL.execPath);
    expect(execIdx).toBeGreaterThanOrEqual(0);
    expect(argv[execIdx + 1]).toBe(JS_INSTALL.scriptPath);
  });
});
