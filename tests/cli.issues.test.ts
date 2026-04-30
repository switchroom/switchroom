import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Integration tests for the `switchroom issues` CLI verb. These shell
 * out to the built CLI under bun (the same runtime the binary's
 * shebang resolves to in production) so we exercise commander
 * argument parsing and the actual binary path that hooks call.
 *
 * Tests use --state-dir to isolate so concurrent test runs don't
 * collide on a real $TELEGRAM_STATE_DIR.
 */

const CLI = resolve(__dirname, "..", "dist", "cli", "switchroom.js");
const BUN = process.env.BUN_PATH ?? "bun";

let stateDir: string;

function run(
  args: string[],
  opts: { stdin?: string; expectError?: boolean; env?: Record<string, string | undefined> } = {},
): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...opts.env })) {
    if (v !== undefined) env[k] = v;
  }
  try {
    const stdout = execFileSync(BUN, [CLI, ...args], {
      stdio: opts.stdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      input: opts.stdin,
      encoding: "utf-8",
      env,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
    };
    if (!opts.expectError) throw err;
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : (e.stdout ?? Buffer.alloc(0)).toString(),
      stderr: typeof e.stderr === "string" ? e.stderr : (e.stderr ?? Buffer.alloc(0)).toString(),
      status: e.status ?? 1,
    };
  }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "issues-cli-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("issues record", () => {
  it("appends a new event and prints the fingerprint", () => {
    const { stdout, status } = run([
      "issues",
      "record",
      "--severity", "error",
      "--source", "hook:test",
      "--code", "boom",
      "--summary", "first failure",
      "--agent", "agent1",
      "--state-dir", stateDir,
    ]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("hook:test::boom");
    const file = readFileSync(join(stateDir, "issues.jsonl"), "utf-8");
    expect(file).toContain('"first failure"');
  });

  it("rejects invalid severity", () => {
    const { status, stderr } = run(
      [
        "issues",
        "record",
        "--severity", "OOPS",
        "--source", "s",
        "--code", "c",
        "--summary", "x",
        "--agent", "a",
        "--state-dir", stateDir,
      ],
      { expectError: true },
    );
    expect(status).toBe(2);
    expect(stderr).toContain("invalid --severity");
  });

  it("reads detail from stdin with --detail-stdin", () => {
    run([
      "issues",
      "record",
      "--severity", "warn",
      "--source", "hook:t",
      "--code", "c",
      "--summary", "x",
      "--detail-stdin",
      "--agent", "a",
      "--state-dir", stateDir,
    ], { stdin: "captured stderr\nmultiple lines\n" });
    const file = readFileSync(join(stateDir, "issues.jsonl"), "utf-8");
    expect(file).toContain("captured stderr");
    expect(file).toContain("multiple lines");
  });

  it("--quiet suppresses fingerprint output", () => {
    const { stdout } = run([
      "issues",
      "record",
      "--severity", "info",
      "--source", "s",
      "--code", "c",
      "--summary", "x",
      "--quiet",
      "--agent", "a",
      "--state-dir", stateDir,
    ]);
    expect(stdout.trim()).toBe("");
  });
});

describe("issues resolve", () => {
  beforeEach(() => {
    run([
      "issues",
      "record",
      "--severity", "error",
      "--source", "hook:t",
      "--code", "c",
      "--summary", "x",
      "--agent", "a",
      "--state-dir", stateDir,
      "--quiet",
    ]);
  });

  it("resolves by --source + --code", () => {
    const { stdout, status } = run([
      "issues",
      "resolve",
      "--source", "hook:t",
      "--code", "c",
      "--state-dir", stateDir,
    ]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("1");
  });

  it("resolves by positional fingerprint", () => {
    const { stdout, status } = run([
      "issues",
      "resolve",
      "hook:t::c",
      "--state-dir", stateDir,
    ]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("1");
  });

  it("returns 0 when nothing matches (idempotent)", () => {
    const { stdout, status } = run([
      "issues",
      "resolve",
      "nope::no",
      "--state-dir", stateDir,
    ]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("0");
  });

  it("errors when neither fingerprint nor --source/--code given", () => {
    const { status, stderr } = run(
      ["issues", "resolve", "--state-dir", stateDir],
      { expectError: true },
    );
    expect(status).toBe(2);
    expect(stderr).toContain("need either");
  });
});

describe("issues list", () => {
  beforeEach(() => {
    for (const [src, code, sev] of [
      ["s1", "c1", "info"],
      ["s2", "c2", "warn"],
      ["s3", "c3", "error"],
      ["s4", "c4", "critical"],
    ] as const) {
      run([
        "issues",
        "record",
        "--severity", sev,
        "--source", src,
        "--code", code,
        "--summary", `${src} ${sev}`,
        "--agent", "a",
        "--state-dir", stateDir,
        "--quiet",
      ]);
    }
  });

  it("lists all current entries (text)", () => {
    const { stdout } = run([
      "issues", "list",
      "--state-dir", stateDir,
    ]);
    expect(stdout).toContain("s1::c1");
    expect(stdout).toContain("s4::c4");
  });

  it("filters by --severity", () => {
    const { stdout } = run([
      "issues", "list",
      "--severity", "error",
      "--state-dir", stateDir,
    ]);
    expect(stdout).not.toContain("s1::c1");
    expect(stdout).not.toContain("s2::c2");
    expect(stdout).toContain("s3::c3");
    expect(stdout).toContain("s4::c4");
  });

  it("--json emits machine-readable output", () => {
    const { stdout } = run([
      "issues", "list",
      "--json",
      "--state-dir", stateDir,
    ]);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(4);
  });

  it("hides resolved by default", () => {
    run([
      "issues", "resolve",
      "--source", "s1", "--code", "c1",
      "--state-dir", stateDir,
    ]);
    const { stdout } = run([
      "issues", "list",
      "--state-dir", stateDir,
    ]);
    expect(stdout).not.toContain("s1::c1");
  });

  it("--include-resolved shows resolved", () => {
    run([
      "issues", "resolve",
      "--source", "s1", "--code", "c1",
      "--state-dir", stateDir,
    ]);
    const { stdout } = run([
      "issues", "list",
      "--include-resolved",
      "--state-dir", stateDir,
    ]);
    expect(stdout).toContain("s1::c1");
    expect(stdout).toContain("[resolved]");
  });
});

describe("issues prune", () => {
  it("returns the count of removed entries", () => {
    const { stdout } = run([
      "issues",
      "prune",
      "--resolved-older-than-days", "0",
      "--state-dir", stateDir,
    ]);
    expect(stdout.trim()).toBe("pruned 0");
  });
});

describe("env-driven defaults", () => {
  it("uses TELEGRAM_STATE_DIR + SWITCHROOM_AGENT_NAME when flags are omitted", () => {
    run(
      [
        "issues", "record",
        "--severity", "warn",
        "--source", "envtest",
        "--code", "c",
        "--summary", "x",
        "--quiet",
      ],
      {
        env: {
          TELEGRAM_STATE_DIR: stateDir,
          SWITCHROOM_AGENT_NAME: "myagent",
        },
      },
    );
    const { stdout } = run([
      "issues", "list", "--json", "--state-dir", stateDir,
    ]);
    const all = JSON.parse(stdout);
    expect(all[0].agent).toBe("myagent");
  });

  it("errors when neither env nor flags provide --state-dir", () => {
    const { status, stderr } = run(
      [
        "issues", "record",
        "--severity", "warn",
        "--source", "s",
        "--code", "c",
        "--summary", "x",
        "--agent", "a",
      ],
      {
        expectError: true,
        env: { TELEGRAM_STATE_DIR: "" },
      },
    );
    expect(status).toBe(1);
    expect(stderr).toContain("TELEGRAM_STATE_DIR is unset");
  });
});
