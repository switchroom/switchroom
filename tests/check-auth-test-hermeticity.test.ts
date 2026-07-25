/**
 * Unit tests for `scripts/check-auth-test-hermeticity.mjs` (#3612).
 *
 * These assert the gate's OUTCOME — that it fails on each shape of the
 * defect and passes on the fixed shape — against synthetic tmp repo roots,
 * not that it merely runs. A gate nobody has seen fail is not a gate.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error — plain-ESM lint script, no type declarations.
import { checkRepo } from "../scripts/check-auth-test-hermeticity.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) {
    try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** A minimal but faithful checkout: the real guard files + a config. */
function makeRepo(opts: { setupFiles?: string[]; exclude?: string[] } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "auth-hermeticity-lint-"));
  roots.push(root);
  mkdirSync(join(root, "tests", "vitest-setup"), { recursive: true });
  mkdirSync(join(root, "src", "auth", "broker"), { recursive: true });
  for (const f of ["auth-net-guard.mjs", "auth-net-guard-core.mjs"]) {
    cpSync(join(REPO_ROOT, "tests", "vitest-setup", f), join(root, "tests", "vitest-setup", f));
  }
  const setupFiles = opts.setupFiles ?? ["./tests/vitest-setup/auth-net-guard.mjs"];
  const exclude = opts.exclude ?? ["**/node_modules/**"];
  writeFileSync(
    join(root, "vitest.config.ts"),
    "export default {\n" +
      "  test: {\n" +
      `    setupFiles: [${setupFiles.map((s) => `"${s}"`).join(", ")}],\n` +
      "    exclude: [\n" +
      exclude.map((e) => `      "${e}",\n`).join("") +
      "    ],\n" +
      "  },\n" +
      "};\n",
  );
  return root;
}

function addTest(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

const BROKER_TEST = `
import { AuthBroker } from "./server.js";
it("rolls", async () => {
  const broker = new AuthBroker(config, { home, stateDir });
  await broker.start();
});
`;

describe("check-auth-test-hermeticity", () => {
  it("passes on a checkout where the guard is wired and every reachable test is vitest-run", async () => {
    const root = makeRepo();
    addTest(root, "src/auth/broker/server.test.ts", BROKER_TEST);
    const r = await checkRepo(root);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    // …and it actually SAW the broker test — a zero here would make the
    // pass vacuous.
    expect(r.reachable).toBe(1);
  });

  it("fails when the setupFiles wiring is removed from vitest.config.ts", async () => {
    const root = makeRepo({ setupFiles: [] });
    addTest(root, "src/auth/broker/server.test.ts", BROKER_TEST);
    const r = await checkRepo(root);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f: { kind: string }) => f.kind)).toContain("wiring");
    expect(r.failures[0].detail).toContain("does not load tests/vitest-setup/auth-net-guard.mjs");
  });

  it("fails when the guard file itself is deleted", async () => {
    const root = makeRepo();
    rmSync(join(root, "tests", "vitest-setup", "auth-net-guard.mjs"));
    addTest(root, "src/auth/broker/server.test.ts", BROKER_TEST);
    const r = await checkRepo(root);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f: { detail: string }) => f.detail.includes("missing guard file"))).toBe(true);
  });

  it("fails when a broker test is excluded from the vitest run (bun-only) — the guard cannot load there", async () => {
    const root = makeRepo({
      exclude: ["**/node_modules/**", "**/src/auth/broker/server-bun.test.ts"],
    });
    addTest(root, "src/auth/broker/server-bun.test.ts", BROKER_TEST);
    const r = await checkRepo(root);
    expect(r.ok).toBe(false);
    const gap = r.failures.find((f: { kind: string }) => f.kind === "outside-vitest");
    expect(gap.file).toBe("src/auth/broker/server-bun.test.ts");
  });

  it("clears an excluded reachable test only via an explicit allowlist entry", async () => {
    const root = makeRepo({
      exclude: ["**/node_modules/**", "**/src/auth/broker/server-bun.test.ts"],
    });
    addTest(root, "src/auth/broker/server-bun.test.ts", BROKER_TEST);
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "check-auth-test-hermeticity-allowlist.txt"),
      "# justified in review\nsrc/auth/broker/server-bun.test.ts\n",
    );
    const r = await checkRepo(root);
    expect(r.ok).toBe(true);
    expect(r.allowed.map((a: { file: string }) => a.file)).toEqual([
      "src/auth/broker/server-bun.test.ts",
    ]);
  });

  it("ignores a test that cannot reach fetchQuota, and a prose-only mention of it", async () => {
    const root = makeRepo();
    addTest(root, "src/misc/adder.test.ts", `it("adds", () => expect(1 + 1).toBe(2));\n`);
    addTest(
      root,
      "src/misc/notes.test.ts",
      `// probeQuota now uses fetchQuota under the hood\nit("x", () => expect(true).toBe(true));\n`,
    );
    const r = await checkRepo(root);
    expect(r.ok).toBe(true);
    expect(r.reachable).toBe(0);
    expect(r.scanned).toBe(2);
  });

  it("passes on the real checkout", async () => {
    const r = await checkRepo(REPO_ROOT);
    expect(r.failures).toEqual([]);
    // The real repo has broker/quota suites; if this drops to 0 the
    // predicate has stopped matching and the gate is inert.
    expect(r.reachable).toBeGreaterThan(0);
  });
});
