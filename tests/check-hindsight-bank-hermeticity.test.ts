/**
 * Unit tests for `scripts/check-hindsight-bank-hermeticity.mjs`.
 *
 * These assert the gate's OUTCOME — that it fails on each shape of the defect
 * (a runner whose guard wiring was deleted; a fleet port repointed in src/ and
 * not mirrored into the guard) and passes on the fixed shape — against
 * synthetic tmp repo roots. A gate nobody has seen fail is not a gate.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error — plain-ESM lint script, no type declarations.
import { checkRepo } from "../scripts/check-hindsight-bank-hermeticity.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = "tests/vitest-setup/hindsight-bank-guard.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

interface RepoOpts {
  setupFiles?: string[];
  /** null ⇒ omit the file entirely. */
  rootPreload?: string[] | null;
  pluginPreload?: string[] | null;
  guardFiles?: boolean;
  /** Body written to src/setup/hindsight.ts. */
  hindsightSrc?: string;
}

function makeRepo(opts: RepoOpts = {}): string {
  const root = mkdtempSync(join(tmpdir(), "hindsight-bank-hermeticity-lint-"));
  roots.push(root);
  mkdirSync(join(root, "tests", "vitest-setup"), { recursive: true });
  mkdirSync(join(root, "telegram-plugin"), { recursive: true });
  mkdirSync(join(root, "src", "setup"), { recursive: true });
  if (opts.guardFiles !== false) {
    for (const f of ["hindsight-bank-guard.mjs", "hindsight-bank-guard-core.mjs"]) {
      cpSync(join(REPO_ROOT, "tests", "vitest-setup", f), join(root, "tests", "vitest-setup", f));
    }
  }
  writeFileSync(
    join(root, "src", "setup", "hindsight.ts"),
    opts.hindsightSrc ?? "export const HINDSIGHT_DEFAULT_API_PORT = 18888;\n",
  );
  const setupFiles = opts.setupFiles ?? [`./${GUARD}`];
  writeFileSync(
    join(root, "vitest.config.ts"),
    `export default {\n  test: {\n    setupFiles: [${setupFiles
      .map((s) => `"${s}"`)
      .join(", ")}],\n  },\n};\n`,
  );
  const toml = (entries: string[]) =>
    `[test]\npreload = [${entries.map((e) => `"${e}"`).join(", ")}]\n`;
  const rootPreload = opts.rootPreload === undefined ? [`./${GUARD}`] : opts.rootPreload;
  const pluginPreload = opts.pluginPreload === undefined ? [`../${GUARD}`] : opts.pluginPreload;
  if (rootPreload) writeFileSync(join(root, "bunfig.toml"), toml(rootPreload));
  if (pluginPreload) {
    writeFileSync(join(root, "telegram-plugin", "bunfig.toml"), toml(pluginPreload));
  }
  return root;
}

const kinds = (r: { failures: { kind: string }[] }) => r.failures.map((f) => f.kind);

describe("check-hindsight-bank-hermeticity", () => {
  it("passes on a checkout where both runners load the guard", () => {
    expect(checkRepo(makeRepo())).toEqual({ ok: true, failures: [] });
  });

  it("passes on the REAL repo (the wiring this PR ships is the wiring it demands)", () => {
    expect(checkRepo(REPO_ROOT).ok).toBe(true);
  });

  it("fails when the vitest setupFiles entry is deleted", () => {
    const r = checkRepo(makeRepo({ setupFiles: ["./tests/vitest-setup/auth-net-guard.mjs"] }));
    expect(r.ok).toBe(false);
    expect(kinds(r)).toContain("vitest-wiring");
  });

  it("fails when setupFiles is gone entirely", () => {
    const root = makeRepo();
    writeFileSync(join(root, "vitest.config.ts"), "export default { test: {} };\n");
    const r = checkRepo(root);
    expect(r.ok).toBe(false);
    expect(kinds(r)).toContain("vitest-wiring");
  });

  it("fails when the repo-root bunfig is deleted (npm run test:bun would be unguarded)", () => {
    const r = checkRepo(makeRepo({ rootPreload: null }));
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.kind === "bun-wiring" && f.detail.includes("bunfig.toml"))).toBe(
      true,
    );
  });

  it("fails when telegram-plugin/bunfig is deleted (CI's bun-test-run would be unguarded)", () => {
    const r = checkRepo(makeRepo({ pluginPreload: null }));
    expect(r.ok).toBe(false);
    expect(
      r.failures.some(
        (f) => f.kind === "bun-wiring" && f.detail.includes("telegram-plugin/bunfig.toml"),
      ),
    ).toBe(true);
  });

  it("fails when a bunfig preloads only the sibling state-dir guard", () => {
    const r = checkRepo(
      makeRepo({ rootPreload: ["./tests/vitest-setup/agent-state-dir-guard.mjs"] }),
    );
    expect(r.ok).toBe(false);
    expect(kinds(r)).toContain("bun-wiring");
  });

  it("fails when a bunfig has no preload key at all", () => {
    const root = makeRepo();
    writeFileSync(join(root, "bunfig.toml"), '[test]\nroot = "./tests"\n');
    const r = checkRepo(root);
    expect(r.ok).toBe(false);
    expect(kinds(r)).toContain("bun-wiring");
  });

  it("fails when the guard files themselves are gone", () => {
    const r = checkRepo(makeRepo({ guardFiles: false }));
    expect(r.ok).toBe(false);
    expect(kinds(r)).toContain("missing-guard");
  });

  it("fails when the fleet API port is repointed in src/ but not in the guard", () => {
    // The regression that would otherwise pass every other check: the guard
    // keeps blocking 18888, the fleet has moved to 28888, and a test sweep
    // walks straight into the live instance again.
    const r = checkRepo(
      makeRepo({ hindsightSrc: "export const HINDSIGHT_DEFAULT_API_PORT = 28888;\n" }),
    );
    expect(r.ok).toBe(false);
    expect(kinds(r)).toContain("fleet-ports");
    expect(r.failures.some((f) => f.detail.includes("28888"))).toBe(true);
  });
});
