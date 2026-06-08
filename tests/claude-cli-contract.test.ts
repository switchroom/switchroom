/**
 * Claude CLI contract — the flags + subcommands switchroom's agent boot depends
 * on, asserted against the ACTUALLY-INSTALLED `claude` binary.
 *
 * Why this exists: a `claude` version bump is the one change where every other
 * gate (lint, vitest against our fixtures, image builds) can pass while the
 * runtime silently breaks — because those gates never exercise the real binary's
 * surface. switchroom boots each agent with a fixed set of CLI flags
 * (`profiles/_base/start.sh.hbs`); if a new claude version removes or renames one
 * of them, the agent fails to boot and CI is none the wiser.
 *
 * This test introspects `claude --help` (credential-free — no turn, no OAuth, no
 * network) and asserts every flag switchroom relies on is still present. It is
 * the credential-free half of the CLI-bump safety net; the behavioural half (a
 * real round-trip turn) lives in the UAT + the nightly latest-claude canary.
 *
 * SELF-SKIP: when `claude` is not on PATH (the normal `vitest` CI job doesn't
 * install it), the suite skips green. It RUNS for real where claude is present:
 * a local dev box, the docker images, and — the point — the nightly canary,
 * which installs `claude@latest` and runs exactly this file to detect a
 * surface change in the next version BEFORE the pin is bumped.
 *
 * MAINTENANCE: when switchroom starts (or stops) depending on a claude flag,
 * update REQUIRED_FLAGS to match `profiles/_base/start.sh.hbs`. The list is the
 * contract; this test is its enforcement.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

/** Resolve the `claude` binary, or null when not installed (→ self-skip). */
function claudeOnPath(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "pipe", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function claudeHelp(): string {
  return execFileSync("claude", ["--help"], {
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 20_000,
  });
}

function claudeVersion(): string {
  return execFileSync("claude", ["--version"], { stdio: "pipe", encoding: "utf-8" }).trim();
}

/**
 * Flags switchroom passes to `claude` at agent boot (the `exec claude` lines in
 * profiles/_base/start.sh.hbs; --add-dir comes via SR_FLEET_ARG).
 * Each must remain present in `claude --help` or the agent won't boot the way
 * switchroom expects. The two channel-load flags
 * (`--dangerously-load-development-channels` / `--channels`) are deliberately
 * NOT here — they're hidden/experimental and absent from `--help`; their
 * removal is caught by the canary's agent-boot smoke instead.
 */
const REQUIRED_FLAGS = [
  "--add-dir",
  "--append-system-prompt",
  "--model",
  "--effort",
  "--permission-mode",
  "--fallback-model",
  "--plugin-dir",
  "--dangerously-skip-permissions",
  "--continue",
] as const;

const HAS_CLAUDE = claudeOnPath();

describe.skipIf(!HAS_CLAUDE)("claude CLI contract (installed binary)", () => {
  it(`reports a version (${HAS_CLAUDE ? claudeVersion() : "n/a"})`, () => {
    expect(claudeVersion()).toMatch(/\d+\.\d+\.\d+/);
  });

  it("--help still documents every flag switchroom's agent boot depends on", () => {
    const help = claudeHelp();
    const missing = REQUIRED_FLAGS.filter((f) => !help.includes(f));
    expect(
      missing,
      `claude ${HAS_CLAUDE ? claudeVersion() : ""} dropped flag(s) switchroom depends on: ${missing.join(
        ", ",
      )}. Update profiles/_base/start.sh.hbs (and REQUIRED_FLAGS) or pin to a version that still has them.`,
    ).toEqual([]);
  });

  it("exposes the `mcp` subcommand (switchroom wires MCP servers)", () => {
    // `claude mcp --help` exits 0 and prints usage when the subcommand exists.
    const out = execFileSync("claude", ["mcp", "--help"], {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 20_000,
    });
    expect(out.toLowerCase()).toContain("mcp");
  });
});

describe.skipIf(HAS_CLAUDE)("claude CLI contract (self-skip)", () => {
  it("skips cleanly when claude is not installed (normal CI job)", () => {
    // Documents the self-skip so the suite never reads as silently empty.
    expect(HAS_CLAUDE).toBe(false);
  });
});
