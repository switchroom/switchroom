/**
 * Integration tests for `switchroom memory demote <agent> <memory-id>`.
 *
 * Shells out to the built CLI under bun (matches what hooks invoke in
 * production). The HTTP path to Hindsight is NOT exercised here —
 * `tests/memory.add-memory-tag.test.ts` covers the wire shape with a
 * mocked fetch. These tests exercise the commander wiring + arg
 * validation + agent-existence preflight.
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
  cfgDir = mkdtempSync(join(tmpdir(), "memory-demote-cli-"));
  cfgPath = join(cfgDir, "switchroom.yaml");
  // Minimal valid switchroom.yaml with one agent. The `clerk` collection
  // defaults from agent name (no explicit `memory.collection`).
  // Hindsight is pointed at a closed port so the demote call fails fast
  // (ECONNREFUSED) rather than hitting a real service — sufficient to
  // verify the dispatcher reaches the API layer.
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

describe("memory demote — argument validation", () => {
  it("--help lists the verb and shows the default tag", () => {
    const { stdout, status } = run(["memory", "demote", "--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("demote");
    expect(stdout).toContain("memory-id");
    expect(stdout).toContain("[demote-from-recall]");
    expect(stdout).toContain("--tag");
    expect(stdout).toContain("--timeout");
  });

  it("rejects unknown agent with non-zero exit and helpful stderr", () => {
    const { status, stderr } = run(
      ["memory", "demote", "ghost-agent", "mem-abc"],
      { expectError: true },
    );
    expect(status).toBe(1);
    expect(stderr).toContain("ghost-agent");
    expect(stderr).toMatch(/not defined in switchroom\.yaml/);
  });

  it("commander rejects when memory-id positional is missing", () => {
    const { status, stderr } = run(["memory", "demote", "clerk"], {
      expectError: true,
    });
    // Commander exits non-zero with usage on missing required arg.
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/missing required argument|usage/i);
  });
});

describe("memory demote — happy-path wiring", () => {
  it("attempts the API call when agent + memory-id are valid (network failure surfaces cleanly)", () => {
    // Hindsight is pointed at port 1 (closed) so the call fails fast
    // with a connection error. Exit 1 with a clear "Tag failed:" line
    // tells us the dispatcher reached the API layer; the actual API
    // wire shape is covered by tests/memory.add-memory-tag.test.ts.
    const { status, stdout, stderr } = run(
      ["memory", "demote", "clerk", "mem-abc-123", "--timeout", "2000"],
      { expectError: true },
    );
    expect(status).toBe(1);
    // Banner lines are on stdout (chalk-coloured but readable).
    expect(stdout).toContain("Demoting memory");
    expect(stdout).toContain("mem-abc-123");
    expect(stdout).toContain("clerk");
    expect(stdout).toContain("[demote-from-recall]");
    // Failure line is on stderr.
    expect(stderr).toMatch(/Tag failed/);
    // Hint references the recall-log workflow so operators know how to
    // verify the ID is valid.
    expect(stderr).toContain("recall-log clerk");
  });

  it("respects a custom --tag override", () => {
    const { stdout } = run(
      [
        "memory",
        "demote",
        "clerk",
        "mem-abc-123",
        "--tag",
        "anti-pattern:misleading",
        "--timeout",
        "2000",
      ],
      { expectError: true },
    );
    expect(stdout).toContain("anti-pattern:misleading");
    // Default tag should not appear when --tag overrides it.
    expect(stdout).not.toContain("[demote-from-recall]");
  });
});
