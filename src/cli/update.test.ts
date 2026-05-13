/**
 * Unit tests for `switchroom update` (#918). Drives the planUpdate
 * step builder + runUpdate dispatch with a fake runner so no real
 * docker / git / bun is invoked.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planUpdate, runUpdate, isGitCheckout } from "./update.js";

function fakeRunner() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let nextStatus = 0;
  return {
    calls,
    setNextStatus(n: number) { nextStatus = n; },
    fn: (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const s = nextStatus;
      nextStatus = 0;
      return { status: s };
    },
  };
}

describe("planUpdate", () => {
  it("produces 6 steps in default mode (no --rebuild)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-plan-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const steps = planUpdate({ composePath });
      expect(steps.map((s) => s.name)).toEqual([
        "pull-images",
        "apply-config",
        "sync-bundled-skills",
        "stamp-restart-marker",
        "recreate-containers",
        "doctor",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("inserts the rebuild-source step when --rebuild is set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-rebuild-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const steps = planUpdate({ composePath, rebuild: true });
      expect(steps.map((s) => s.name)).toEqual([
        "pull-images",
        "rebuild-source",
        "apply-config",
        "sync-bundled-skills",
        "stamp-restart-marker",
        "recreate-containers",
        "doctor",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stamp-restart-marker runs before recreate-containers and writes a marker per agent", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-stamp-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const writes: Array<{ agent: string; reason: string }> = [];
      const steps = planUpdate({
        composePath,
        agentNamesFn: () => ["clerk", "klanker", "test-harness"],
        writeMarkerFn: (agent, reason) => { writes.push({ agent, reason }); },
      });
      const stampIdx = steps.findIndex((s) => s.name === "stamp-restart-marker");
      const recreateIdx = steps.findIndex((s) => s.name === "recreate-containers");
      expect(stampIdx).toBeGreaterThan(-1);
      expect(stampIdx).toBeLessThan(recreateIdx);
      // Execute the stamp step in isolation.
      steps[stampIdx]?.run();
      expect(writes).toEqual([
        { agent: "clerk", reason: "operator: switchroom update" },
        { agent: "klanker", reason: "operator: switchroom update" },
        { agent: "test-harness", reason: "operator: switchroom update" },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stamp-restart-marker uses docker exec by default (Docker-runtime fix: host-side write fails with EACCES on UID-owned dirs)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-stamp-exec-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const runner = fakeRunner();
      const steps = planUpdate({
        composePath,
        agentNamesFn: () => ["carrie", "klanker"],
        runner: runner.fn,
      });
      const stamp = steps.find((s) => s.name === "stamp-restart-marker");
      stamp?.run();
      expect(runner.calls).toHaveLength(2);
      // Both calls target docker exec into the named container.
      expect(runner.calls[0]?.cmd).toBe("docker");
      expect(runner.calls[0]?.args[0]).toBe("exec");
      expect(runner.calls[0]?.args[1]).toBe("switchroom-carrie");
      expect(runner.calls[0]?.args[2]).toBe("sh");
      expect(runner.calls[0]?.args[3]).toBe("-c");
      // The command writes a JSON marker with the canonical reason text
      // to the in-container path (which is the same file the host sees
      // via the compose bind-mount).
      expect(runner.calls[0]?.args[4]).toMatch(/printf/);
      expect(runner.calls[0]?.args[4]).toMatch(/"reason":"operator: switchroom update"/);
      expect(runner.calls[0]?.args[4]).toMatch(/\/state\/agent\/telegram\/clean-shutdown\.json/);
      expect(runner.calls[1]?.args[1]).toBe("switchroom-klanker");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stamp-restart-marker falls back to host-writer when docker exec fails (systemd-runtime / no-container path)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-stamp-fallback-"));
    const prevAgentsDir = process.env.SWITCHROOM_AGENTS_DIR;
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      // Point the host writer at our tmp dir so we can observe what
      // would normally land in ~/.switchroom/agents/<name>/telegram/.
      process.env.SWITCHROOM_AGENTS_DIR = tmp;
      mkdirSync(join(tmp, "carrie", "telegram"), { recursive: true });
      const runner = fakeRunner();
      // Force every docker exec to fail (status 127 == "sh not found"
      // / no such container in practice).
      runner.setNextStatus(127);
      const steps = planUpdate({
        composePath,
        agentNamesFn: () => ["carrie"],
        runner: runner.fn,
      });
      const stamp = steps.find((s) => s.name === "stamp-restart-marker");
      stamp?.run();
      // Exactly one docker exec attempt, then fallback fires.
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]?.args[0]).toBe("exec");
      // Host writer must have produced the marker file at the
      // bind-mount location — that's the regression-catch: if the
      // fallback ever gets accidentally removed (e.g. someone inverts
      // the status check), this assertion fails.
      const markerPath = join(tmp, "carrie", "telegram", "clean-shutdown.json");
      expect(existsSync(markerPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(markerPath, "utf-8")) as {
        reason?: string;
        signal?: string;
      };
      expect(parsed.reason).toBe("operator: switchroom update");
      expect(parsed.signal).toBe("SIGTERM");
    } finally {
      if (prevAgentsDir === undefined) {
        delete process.env.SWITCHROOM_AGENTS_DIR;
      } else {
        process.env.SWITCHROOM_AGENTS_DIR = prevAgentsDir;
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stamp-restart-marker tolerates per-agent write failures without aborting", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-stamp-err-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const writes: string[] = [];
      const steps = planUpdate({
        composePath,
        agentNamesFn: () => ["a", "b", "c"],
        writeMarkerFn: (agent) => {
          if (agent === "b") throw new Error("simulated EACCES");
          writes.push(agent);
        },
      });
      const stamp = steps.find((s) => s.name === "stamp-restart-marker");
      // Should NOT throw — failures are best-effort.
      expect(() => stamp?.run()).not.toThrow();
      expect(writes).toEqual(["a", "c"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips pull-images with a clear reason when --skip-images is set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-skip-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const steps = planUpdate({ composePath, skipImages: true });
      const pull = steps.find((s) => s.name === "pull-images");
      expect(pull?.skipReason).toContain("--skip-images");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips pull-images with the right reason when compose file doesn't exist", () => {
    const steps = planUpdate({ composePath: "/nonexistent/compose.yml" });
    const pull = steps.find((s) => s.name === "pull-images");
    expect(pull?.skipReason).toContain("compose file not found");
    expect(pull?.skipReason).toContain("apply --compose-only");
  });

  it("never skips recreate-containers — even with --skip-images, apply may have changed compose (#923 reviewer)", () => {
    const steps = planUpdate({ skipImages: true });
    const recreate = steps.find((s) => s.name === "recreate-containers");
    expect(recreate?.skipReason).toBeUndefined();
  });
});

describe("--status (#927)", () => {
  it("formatStatusReport renders CLI version + per-service ages", async () => {
    const { formatStatusReport } = await import("./update.js");
    // Fixed clock for deterministic age strings.
    const now = Date.parse("2026-05-10T18:00:00Z");
    const out = formatStatusReport({
      cliVersion: "0.7.7",
      cliBuiltAt: new Date(now - 30 * 60 * 1000).toISOString(), // 30m ago
      services: [
        {
          name: "agent-clerk",
          image: "ghcr.io/x/switchroom-agent:latest",
          imageDigestShort: "abc123def456",
          imagePulledAt: new Date(now - 4 * 3600 * 1000).toISOString(), // 4h
          containerCreatedAt: new Date(now - 1 * 3600 * 1000).toISOString(), // 1h
          status: "running",
        },
      ],
      warnings: [],
    });
    expect(out).toContain("CLI: 0.7.7");
    expect(out).toContain("agent-clerk");
    expect(out).toContain("running");
    expect(out).toContain("[abc123def456]");
  });

  it("runUpdate --status uses statusProbe seam, never invokes runner", async () => {
    const { runUpdate } = await import("./update.js");
    const out: string[] = [];
    let runnerCalled = false;
    let probedComposePath = "";
    const code = await runUpdate({
      status: true,
      composePath: "/some/compose.yml",
      stdout: (s) => out.push(s),
      stderr: (s) => out.push(s),
      runner: () => { runnerCalled = true; return { status: 0 }; },
      statusProbe: (p) => {
        probedComposePath = p;
        return {
          cliVersion: "test",
          cliBuiltAt: null,
          services: [],
          warnings: [],
        };
      },
    });
    expect(code).toBe(0);
    expect(runnerCalled).toBe(false); // status mode runs no steps
    expect(probedComposePath).toBe("/some/compose.yml");
    expect(out.join("")).toContain("CLI: test");
  });

  it("runUpdate --json without --status fails loud (exit 2) — #938 reviewer", async () => {
    const { runUpdate } = await import("./update.js");
    const out: string[] = [];
    const err: string[] = [];
    const code = await runUpdate({
      json: true,
      composePath: "/x.yml",
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      runner: () => ({ status: 0 }),
    });
    expect(code).toBe(2);
    expect(err.join("")).toMatch(/--json is only honored under --status/);
  });

  it("runUpdate --status --json emits parseable JSON with the report shape", async () => {
    const { runUpdate } = await import("./update.js");
    const out: string[] = [];
    await runUpdate({
      status: true,
      json: true,
      composePath: "/x.yml",
      stdout: (s) => out.push(s),
      runner: () => ({ status: 0 }),
      statusProbe: () => ({
        cliVersion: "0.7.8",
        cliBuiltAt: "2026-05-10T18:00:00Z",
        services: [
          { name: "vault-broker", image: "ghcr.io/x:latest", imageDigestShort: "deadbeef", imagePulledAt: null, containerCreatedAt: null, status: "running" },
        ],
        warnings: ["test warning"],
      }),
    });
    const parsed = JSON.parse(out.join(""));
    expect(parsed.cliVersion).toBe("0.7.8");
    expect(parsed.services).toHaveLength(1);
    expect(parsed.services[0].name).toBe("vault-broker");
    expect(parsed.warnings).toEqual(["test warning"]);
  });
});

describe("--rebuild against a non-checkout install fails loudly (#923 reviewer)", () => {
  it("rebuild-source step throws when scriptPath has no .git ancestor", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rebuild-no-git-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      // Spoof argv[1] to a path with no .git ancestor for the duration
      // of the plan() + run() calls.
      const origArgv1 = process.argv[1];
      process.argv[1] = join(tmp, "fake-installed-cli.js");
      try {
        const steps = planUpdate({ composePath, rebuild: true });
        const rebuild = steps.find((s) => s.name === "rebuild-source");
        expect(rebuild).toBeDefined();
        expect(rebuild?.skipReason).toBeUndefined(); // not silently skipped
        expect(() => rebuild!.run()).toThrow(/--rebuild requires a git checkout/);
      } finally {
        process.argv[1] = origArgv1;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("runUpdate", () => {
  it("dry-runs cleanly under --check, no runner calls", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-check-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const out: string[] = [];
      const runner = fakeRunner();
      const code = await runUpdate({
        check: true,
        composePath,
        stdout: (s) => out.push(s),
        stderr: (s) => out.push(s),
        runner: runner.fn,
      });
      expect(code).toBe(0);
      expect(runner.calls).toHaveLength(0);
      const joined = out.join("");
      expect(joined).toMatch(/dry-run/);
      expect(joined).toMatch(/pull-images/);
      expect(joined).toMatch(/apply-config/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runs the steps in order via the injected runner", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-run-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const out: string[] = [];
      const runner = fakeRunner();
      const code = await runUpdate({
        composePath,
        stdout: (s) => out.push(s),
        stderr: (s) => out.push(s),
        runner: runner.fn,
        // Stamp-marker step fans out to `docker exec` per agent; pin the
        // agent set deterministically here so the assertions don't read
        // the host's real switchroom.yaml.
        agentNamesFn: () => ["a", "b"],
        // No-op the sync-bundled-skills filesystem effect under tests.
        syncBundledSkillsFn: () => { /* intentional no-op */ },
      });
      expect(code).toBe(0);
      // 6 calls total:
      //   [0] docker compose pull
      //   [1] <execPath> apply --non-interactive --no-doctor
      //   [2] docker exec switchroom-a sh -c '…'  ← stamp-restart-marker
      //   [3] docker exec switchroom-b sh -c '…'  ← stamp-restart-marker
      //   [4] docker compose up -d --remove-orphans
      //   [5] <execPath> doctor
      expect(runner.calls).toHaveLength(6);
      expect(runner.calls[0]?.cmd).toBe("docker");
      expect(runner.calls[0]?.args).toContain("pull");
      expect(runner.calls[1]?.cmd).toBe(process.execPath);
      expect(runner.calls[1]?.args).toContain("apply");
      expect(runner.calls[1]?.args).toContain("--non-interactive");
      expect(runner.calls[1]?.args).toContain("--no-doctor");
      // Marker writes: one docker exec per agent, targeting the
      // in-container clean-shutdown.json path.
      expect(runner.calls[2]?.cmd).toBe("docker");
      expect(runner.calls[2]?.args.slice(0, 3)).toEqual(["exec", "switchroom-a", "sh"]);
      expect(runner.calls[2]?.args.at(-1)).toMatch(/operator: switchroom update/);
      expect(runner.calls[2]?.args.at(-1)).toMatch(/\/state\/agent\/telegram\/clean-shutdown\.json/);
      expect(runner.calls[3]?.cmd).toBe("docker");
      expect(runner.calls[3]?.args.slice(0, 3)).toEqual(["exec", "switchroom-b", "sh"]);
      // [4] docker compose up -d --remove-orphans
      expect(runner.calls[4]?.cmd).toBe("docker");
      expect(runner.calls[4]?.args).toContain("up");
      expect(runner.calls[4]?.args).toContain("--remove-orphans");
      // [5] <execPath> doctor
      expect(runner.calls[5]?.cmd).toBe(process.execPath);
      expect(runner.calls[5]?.args).toContain("doctor");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails fast on a step error and reports which step", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-fail-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const out: string[] = [];
      const runner = fakeRunner();
      runner.setNextStatus(1); // first call (pull) fails
      const code = await runUpdate({
        composePath,
        stdout: (s) => out.push(s),
        stderr: (s) => out.push(s),
        runner: runner.fn,
      });
      expect(code).toBe(1);
      // Should NOT have proceeded to apply / up / doctor.
      expect(runner.calls).toHaveLength(1);
      expect(out.join("")).toMatch(/pull-images failed/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("isGitCheckout", () => {
  it("returns true for a path under a directory containing .git", () => {
    const tmp = mkdtempSync(join(tmpdir(), "git-detect-"));
    try {
      mkdirSync(join(tmp, ".git"), { recursive: true });
      mkdirSync(join(tmp, "dist", "cli"), { recursive: true });
      const scriptPath = join(tmp, "dist", "cli", "switchroom.js");
      writeFileSync(scriptPath, "");
      expect(isGitCheckout(scriptPath)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns false for a path with no .git ancestor", () => {
    const tmp = mkdtempSync(join(tmpdir(), "no-git-detect-"));
    try {
      mkdirSync(join(tmp, "dist", "cli"), { recursive: true });
      const scriptPath = join(tmp, "dist", "cli", "switchroom.js");
      writeFileSync(scriptPath, "");
      expect(isGitCheckout(scriptPath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
