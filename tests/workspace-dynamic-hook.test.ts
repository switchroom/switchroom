import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Exercises bin/workspace-dynamic-hook.sh end-to-end with a stub
 * `switchroom` shim on PATH that we control. Verifies:
 *   - byte-stable output across two consecutive invocations with
 *     identical render input (the whole point of the dedupe sidecar)
 *   - empty render → empty stdout AND no cache file written (we don't
 *     want to re-emit empty forever)
 *   - changed render → updated cache + new body emitted
 */
const HOOK = resolve(__dirname, "../bin/workspace-dynamic-hook.sh");

interface RunResult {
  stdout: string;
  exitCode: number;
}

function runHook(opts: {
  agentName?: string;
  cacheDir: string;
  shimDir: string;
}): RunResult {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PATH: `${opts.shimDir}:${process.env.PATH ?? ""}`,
    CLAUDE_CONFIG_DIR: opts.cacheDir,
  };
  if (opts.agentName !== undefined) {
    env.SWITCHROOM_AGENT_NAME = opts.agentName;
  } else {
    delete env.SWITCHROOM_AGENT_NAME;
  }
  try {
    const stdout = execFileSync("bash", [HOOK], { env, encoding: "utf-8" });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; status?: number };
    return {
      stdout: e.stdout ? String(e.stdout) : "",
      exitCode: e.status ?? 1,
    };
  }
}

/**
 * Write a `switchroom` shim that prints a fixed payload when invoked
 * with `workspace render <agent> --dynamic ...`. The hook only inspects
 * stdout, so the shim doesn't need to be a real CLI — just a bash
 * script that echoes whatever we tell it to.
 */
function makeShim(shimDir: string, payload: string): void {
  mkdirSync(shimDir, { recursive: true });
  const shimPath = join(shimDir, "switchroom");
  // Use a tiny heredoc-driven shell script. Escape single quotes in the
  // payload by closing/reopening the quoted block.
  const escaped = payload.replace(/'/g, `'"'"'`);
  writeFileSync(
    shimPath,
    `#!/bin/bash\nprintf '%s' '${escaped}'\n`,
    { mode: 0o755 },
  );
  chmodSync(shimPath, 0o755);
}

describe("workspace-dynamic-hook.sh", () => {
  let tmp: string;
  let cacheDir: string;
  let shimDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ws-dyn-hook-"));
    cacheDir = join(tmp, "claude");
    shimDir = join(tmp, "bin");
    mkdirSync(cacheDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty stdout and writes no cache when render is empty", () => {
    makeShim(shimDir, "");
    const r = runHook({ agentName: "klanker", cacheDir, shimDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    // Critically: NO cache file. Otherwise we'd re-emit empty forever.
    const hookCache = join(cacheDir, "switchroom-hookcache", "workspace-dynamic.hash");
    expect(existsSync(hookCache)).toBe(false);
  });

  it("emits the rendered payload and caches it", () => {
    const payload = "MEMORY:\n  - thing one\n  - thing two\n";
    makeShim(shimDir, payload);
    const r = runHook({ agentName: "klanker", cacheDir, shimDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("thing one");
    expect(r.stdout).toContain("thing two");

    const hashFile = join(cacheDir, "switchroom-hookcache", "workspace-dynamic.hash");
    const bodyFile = join(cacheDir, "switchroom-hookcache", "workspace-dynamic.body");
    expect(existsSync(hashFile)).toBe(true);
    expect(existsSync(bodyFile)).toBe(true);
    expect(readFileSync(bodyFile, "utf-8")).toContain("thing one");
  });

  it("emits byte-identical stdout for back-to-back invocations with the same render", () => {
    const payload = "stable-payload-" + "X".repeat(50);
    makeShim(shimDir, payload);
    const a = runHook({ agentName: "klanker", cacheDir, shimDir });
    const b = runHook({ agentName: "klanker", cacheDir, shimDir });
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(b.stdout).toBe(a.stdout);
    expect(a.stdout).toContain("stable-payload-");
  });

  it("re-emits and re-caches when the render output changes", () => {
    makeShim(shimDir, "first body content");
    const a = runHook({ agentName: "klanker", cacheDir, shimDir });
    expect(a.stdout).toContain("first body");

    makeShim(shimDir, "second body content");
    const b = runHook({ agentName: "klanker", cacheDir, shimDir });
    expect(b.stdout).toContain("second body");
    expect(b.stdout).not.toBe(a.stdout);

    const bodyFile = join(cacheDir, "switchroom-hookcache", "workspace-dynamic.body");
    expect(readFileSync(bodyFile, "utf-8")).toContain("second body");
  });

  it("exits silently with no output when SWITCHROOM_AGENT_NAME is unset", () => {
    makeShim(shimDir, "should not run");
    const r = runHook({ cacheDir, shimDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
});
