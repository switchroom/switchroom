/**
 * Callsite regression guard for singleton stale-container cleanup.
 *
 * WHAT THIS TESTS
 * ───────────────
 * `removeStaleContainerIfNeeded` in singleton-stale-cleanup.ts accepts an
 * injectable DockerRunner for testing, but `doInstall` in hostd.ts and
 * webd.ts is a private (non-exported) function that hardwires the real
 * spawnSync-backed runner — there is no injection seam in the call chain
 * reachable without invoking docker at runtime.
 *
 * Because we cannot intercept docker calls through `doInstall`, these tests
 * are STRUCTURAL: they read the source text and assert the invariants that a
 * behavioral test would exercise. Specifically:
 *
 *   1. The stale-cleanup call appears in source BEFORE the `compose ... up`
 *      call (ordering guard — a future reorder would fail this).
 *   2. The container name passed to `removeStaleContainerIfNeeded` is the
 *      same string literal as the one used in `container_name:` inside the
 *      compose template (constant-mismatch guard).
 *   3. The project name passed to `removeStaleContainerIfNeeded` is the same
 *      string literal as the one passed to `compose -p` for the `up` command
 *      (wrong-project-constant guard).
 *
 * These are the exact two regression scenarios named in the PR review:
 *   a) a future reorder puts cleanup AFTER `compose up` (silent breakage)
 *   b) a wrong-constant edit passes a different project to cleanup vs `up`
 *
 * If a future refactor adds a docker-runner injection seam to `doInstall`,
 * replace these structural assertions with behavioral ones and note the
 * improved coverage.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSource(filename: string): string {
  return readFileSync(join(__dirname, filename), "utf8");
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Return the character index of the FIRST occurrence of `needle` in `src`,
 * or throw so the test fails with a clear message rather than a confusing
 * -1 comparison.
 */
function indexOf(src: string, needle: string, label: string): number {
  const idx = src.indexOf(needle);
  if (idx === -1) {
    throw new Error(`Could not find ${label} in source:\n  pattern: ${JSON.stringify(needle)}`);
  }
  return idx;
}

// ─── hostd.ts ────────────────────────────────────────────────────────────────

describe("hostd.ts callsite: removeStaleContainerIfNeeded before compose up", () => {
  const src = readSource("hostd.ts");

  it("calls removeStaleContainerIfNeeded with container name 'switchroom-hostd'", () => {
    // The call must name the container exactly; a wrong constant goes
    // undetected by the unit tests in singleton-stale-cleanup.test.ts.
    expect(src).toContain('removeStaleContainerIfNeeded("switchroom-hostd"');
  });

  it("HOSTD_COMPOSE_PROJECT constant equals 'switchroom-hostd'", () => {
    // Verify the constant declaration itself — the project name the
    // singleton is installed under.
    expect(src).toContain('const HOSTD_COMPOSE_PROJECT = "switchroom-hostd"');
  });

  it("passes HOSTD_COMPOSE_PROJECT (not a different literal) as the targetProject arg", () => {
    // The second argument to removeStaleContainerIfNeeded must be the
    // SAME constant that is passed to `compose -p`.  We assert the call
    // site uses the identifier, not a re-typed string literal that could
    // diverge from the constant.
    expect(src).toContain('removeStaleContainerIfNeeded("switchroom-hostd", HOSTD_COMPOSE_PROJECT');
  });

  it("compose -p for the up command uses HOSTD_COMPOSE_PROJECT (same constant)", () => {
    // Both the cleanup and the up command must reference the same project.
    // This pattern matches the `up -d` invocation that uses the constant.
    expect(src).toContain('"compose", "-p", HOSTD_COMPOSE_PROJECT');
  });

  it("removeStaleContainerIfNeeded call appears BEFORE the compose up call in source", () => {
    // Ordering guard: cleanup must precede the up step.  A reorder
    // (even accidentally, e.g. cut-paste) would flip these indices and
    // fail this test.
    const cleanupIdx = indexOf(
      src,
      'removeStaleContainerIfNeeded("switchroom-hostd"',
      "removeStaleContainerIfNeeded call",
    );
    // The `up -d` invocation — use the unique `"up", "-d"` args.
    const upIdx = indexOf(
      src,
      '"up", "-d"',
      'compose up -d call',
    );
    expect(cleanupIdx).toBeLessThan(upIdx);
  });

  it("container_name in compose template matches the literal passed to removeStaleContainerIfNeeded", () => {
    // The compose template must declare the same name the cleanup probes,
    // or the cleanup targets the wrong container.
    expect(src).toContain("container_name: switchroom-hostd");
  });
});

// ─── webd.ts ─────────────────────────────────────────────────────────────────

describe("webd.ts callsite: removeStaleContainerIfNeeded before compose up", () => {
  const src = readSource("webd.ts");

  it("calls removeStaleContainerIfNeeded with container name 'switchroom-web'", () => {
    expect(src).toContain('removeStaleContainerIfNeeded("switchroom-web"');
  });

  it("WEB_COMPOSE_PROJECT constant equals 'switchroom-web'", () => {
    expect(src).toContain('const WEB_COMPOSE_PROJECT = "switchroom-web"');
  });

  it("passes WEB_COMPOSE_PROJECT (not a different literal) as the targetProject arg", () => {
    expect(src).toContain('removeStaleContainerIfNeeded("switchroom-web", WEB_COMPOSE_PROJECT');
  });

  it("compose -p for the up command uses WEB_COMPOSE_PROJECT (same constant)", () => {
    expect(src).toContain('"compose", "-p", WEB_COMPOSE_PROJECT');
  });

  it("removeStaleContainerIfNeeded call appears BEFORE the compose up call in source", () => {
    const cleanupIdx = indexOf(
      src,
      'removeStaleContainerIfNeeded("switchroom-web"',
      "removeStaleContainerIfNeeded call",
    );
    const upIdx = indexOf(
      src,
      '"up", "-d"',
      'compose up -d call',
    );
    expect(cleanupIdx).toBeLessThan(upIdx);
  });

  it("container_name in compose template matches the literal passed to removeStaleContainerIfNeeded", () => {
    expect(src).toContain("container_name: switchroom-web");
  });
});
