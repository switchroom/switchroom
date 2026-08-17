/**
 * Integration tests for `switchroom memory directive reconcile <agent> <name>
 * <content...>` — Memory v2 M2's real entry point for the windows-boxes-class
 * fix (PR #4760 review M4: the skill previously pointed at a script that did
 * not exist).
 *
 * Shells out to the built CLI under bun, matching the `memory demote` CLI
 * test pattern (`tests/cli.memory.demote.test.ts`). Preflight/wiring only —
 * the actual create-first/deactivate-second mechanics are covered against a
 * hermetic mock REST server in
 * `tests/memory.directive-triage-executor.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(__dirname, "..", "dist", "cli", "switchroom.js");
const BUN = process.env.BUN_PATH ?? "bun";

let cfgDir: string;
let cfgPath: string;

function run(
  args: string[],
  opts: { expectError?: boolean } = {},
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(BUN, [CLI, "--config", cfgPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: process.env as Record<string, string>,
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
      stdout:
        typeof e.stdout === "string"
          ? e.stdout
          : (e.stdout ?? Buffer.alloc(0)).toString(),
      stderr:
        typeof e.stderr === "string"
          ? e.stderr
          : (e.stderr ?? Buffer.alloc(0)).toString(),
      status: e.status ?? 1,
    };
  }
}

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), "memory-directive-cli-"));
  cfgPath = join(cfgDir, "switchroom.yaml");
  // Hindsight pointed at a closed port so the reconcile call fails fast
  // (ECONNREFUSED) rather than hitting a real service — sufficient to prove
  // the dispatcher reaches the DirectiveAdmin/reconcile layer.
  writeFileSync(
    cfgPath,
    [
      "switchroom:",
      "  version: 1",
      "telegram:",
      '  bot_token: "vault:telegram-bot-token"',
      '  forum_chat_id: "-100"',
      "memory:",
      "  backend: hindsight",
      "  config:",
      "    url: http://127.0.0.1:1/mcp/",
      "agents:",
      "  clerk:",
      '    topic_name: "Test"',
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  rmSync(cfgDir, { recursive: true, force: true });
});

describe("memory directive reconcile — argument validation", () => {
  it("--help lists the verb and its arguments", () => {
    const { stdout, status } = run(["memory", "directive", "reconcile", "--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("reconcile");
    expect(stdout).toContain("name");
    expect(stdout).toContain("content");
    expect(stdout).toContain("--priority");
  });

  it("rejects unknown agent with non-zero exit and helpful stderr", () => {
    const { status, stderr } = run(
      ["memory", "directive", "reconcile", "ghost-agent", "some-name", "new content"],
      { expectError: true },
    );
    expect(status).toBe(1);
    expect(stderr).toContain("ghost-agent");
    expect(stderr).toMatch(/not defined in switchroom\.yaml/);
  });

  it("commander rejects when content positional is missing", () => {
    const { status, stderr } = run(
      ["memory", "directive", "reconcile", "clerk", "some-name"],
      { expectError: true },
    );
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/missing required argument|usage/i);
  });

  it("rejects empty (whitespace-only) content", () => {
    const { status, stderr } = run(
      ["memory", "directive", "reconcile", "clerk", "some-name", "   "],
      { expectError: true },
    );
    expect(status).toBe(1);
    expect(stderr).toMatch(/must not be empty/);
  });
});

describe("memory directive reconcile — happy-path wiring", () => {
  it("attempts the API call when agent + name + content are valid (network failure surfaces cleanly)", () => {
    // Hindsight is pointed at port 1 (closed) so the call fails fast with a
    // connection error. A non-zero exit with a clear failure line tells us
    // the dispatcher reached DirectiveAdmin/reconcileDirectiveSuperset; the
    // actual create-first/deactivate-second wire shape is covered by
    // tests/memory.directive-triage-executor.test.ts against a hermetic
    // mock server.
    const { status, stderr } = run(
      ["memory", "directive", "reconcile", "clerk", "windows-boxes-access-and-full-stop", "new superset text"],
      { expectError: true },
    );
    expect(status).toBe(1);
    expect(stderr).toMatch(/✗/);
  });

  it("--json emits a machine-readable error envelope on failure", () => {
    const { status, stdout } = run(
      [
        "memory",
        "directive",
        "reconcile",
        "clerk",
        "windows-boxes-access-and-full-stop",
        "new superset text",
        "--json",
      ],
      { expectError: true },
    );
    expect(status).toBe(1);
    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
      ok: boolean;
      error: string;
    };
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
  });
});
