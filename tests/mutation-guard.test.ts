/**
 * Proves the mutation guard actually fires — on the two defect shapes v0.21.8
 * shipped, and only on them.
 *
 * A guard against vacuous tests must not itself be vacuous, so nothing here
 * asserts "some mutant survived". Every case pins the EXACT survivor set
 * (operator + line), and each positive fixture is paired with a negative one
 * whose PRODUCTION SOURCE IS BYTE-IDENTICAL and whose test suite is the real
 * follow-up's. Identical source, opposite verdict: the only way that can hold
 * is if the guard is reading the tests, which is the whole claim.
 *
 * The fixtures run end-to-end — real files in a real tmpdir, real child
 * processes, real apply/run/restore — not against a stubbed `runTests`. A
 * simulated runner would prove the bookkeeping and nothing about the mechanism.
 *
 * Fixture ↔ incident map:
 *   vacuous-tier / covered-tier  → #4663 `ca7d9b69`, fixed in `2338c280`.
 *       Tiered selection whose tiers 2 and 3 agree on every in-order queue.
 *   seam-mirror  / seam-real     → #4670 `22e0a4d5`, fixed at
 *       tests/host-control/config-propose-edit.test.ts:1439.
 *       A value referenced twice: once by the real call, once by a test seam.
 */

import { describe, it, expect } from "vitest";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { enumerateMutants } from "../scripts/mutation/operators.mjs";
import { runMutationTarget } from "../scripts/mutation/run.mjs";
import {
  arm,
  disarm,
  recover,
  SENTINEL_NAME,
} from "../scripts/mutation/restore-sentinel.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(REPO, "tests", "fixtures", "mutation-guard");

/** Copy a fixture pair to a scratch dir and run the harness against it for
 *  real: `node tests.mjs` is the scoped suite, `module.mjs` is the target. */
function runFixture(name: string, opts: { symbols?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `mutation-guard-${name}-`));
  try {
    cpSync(join(FIXTURES, name), dir, { recursive: true });
    const modulePath = join(dir, "module.mjs");
    return runMutationTarget({
      file: "module.mjs",
      symbols: opts.symbols,
      readSource: () => readFileSync(modulePath, "utf8"),
      writeSource: (t: string) => writeFileSync(modulePath, t, "utf8"),
      runTests: () => {
        const r = spawnSync(process.execPath, [join(dir, "tests.mjs")], {
          encoding: "utf8",
          timeout: 20_000,
        });
        return { passed: r.status === 0, detail: r.stderr ?? "" };
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ids = (r: { survivors: Array<{ id: string }> }) =>
  r.survivors.map((s) => s.id).sort();

describe("mutation guard — #4663 shape (a branch no test distinguishes)", () => {
  it("flags the tier-2 bound the pre-follow-up suite could not tell from tier 3", () => {
    const r = runFixture("vacuous-tier");
    // The suite only ever builds ts-ASCENDING queues, where tier 2 and tier 3
    // select the same index. Both perturbations of tier 2's condition are
    // therefore invisible. Tier 1 is genuinely asserted and both of ITS
    // mutants die — which is what makes this a coverage hole and not a broken
    // suite.
    expect(ids(r)).toEqual(["force-false@16", "force-true@16"]);
    // Pin the mutated expression too, so an unrelated fixture edit that shifts
    // line 16 fails loudly rather than silently re-aiming the assertion.
    expect(new Set(r.survivors.map((s) => s.original))).toEqual(
      new Set(["nowMs - queue[i].ts >= PROTECT_MS"]),
    );
    expect(r.total).toBe(4);
    expect(r.killed).toBe(2);
  });

  it("does NOT flag it once the discriminating out-of-order case exists", () => {
    const r = runFixture("covered-tier");
    expect(r.survivors).toEqual([]);
    expect(r.killed).toBe(4);
  });

  it("reads the TESTS, not the code: identical production source, opposite verdicts", () => {
    const a = readFileSync(join(FIXTURES, "vacuous-tier", "module.mjs"), "utf8");
    const b = readFileSync(join(FIXTURES, "covered-tier", "module.mjs"), "utf8");
    // Only the fixture-header comment differs; the logic must be byte-identical
    // from `export const PROTECT_MS` down.
    const logic = (s: string) => s.slice(s.indexOf("export const PROTECT_MS"));
    expect(logic(a)).toBe(logic(b));
    expect(logic(a).length).toBeGreaterThan(0);
  });
});

describe("mutation guard — #4670 shape (a test asserting a seam's mirror)", () => {
  it("flags the real call's argument when only the seam's copy is asserted", () => {
    const r = runFixture("seam-mirror");
    // `spawnChild(["apply", "--non-interactive"], reconcileEnv)` — production's
    // only real use of the variable. Dropping it leaves the seam-asserting
    // suite green, exactly as it did in #4670.
    expect(ids(r)).toEqual(["drop-last-arg@25"]);
    expect(r.survivors[0]!.original).toBe("reconcileEnv");
    expect(r.survivors[0]!.mutated).toBe("undefined");
    expect(r.total).toBe(1);
  });

  it("does NOT flag it once a test drives the un-seamed production path", () => {
    const r = runFixture("seam-real");
    expect(r.survivors).toEqual([]);
    expect(r.killed).toBe(1);
  });

  it("reads the TESTS, not the code: identical production source, opposite verdicts", () => {
    const a = readFileSync(join(FIXTURES, "seam-mirror", "module.mjs"), "utf8");
    const b = readFileSync(join(FIXTURES, "seam-real", "module.mjs"), "utf8");
    expect(a).toBe(b);
  });
});

describe("mutation guard — negative space (what it must NOT do)", () => {
  it("emits no mutants for straight-line code with no branch and no multi-arg call", () => {
    const { mutants } = enumerateMutants(
      "x.ts",
      `export const add = (a: number, b: number) => a + b;\n` +
        `export function greet(n: string) { return \`hi \${n}\`; }\n`,
    );
    expect(mutants).toEqual([]);
  });

  it("leaves single-argument and callback-tail calls alone", () => {
    const { mutants } = enumerateMutants(
      "x.ts",
      `f(a);\n` +
        `g(a, () => b);\n` + // trailing callback: a seam, not a value
        `h(a, 42);\n` + // trailing literal: type error or trivial kill
        `k(a, b);\n`, // the only droppable one
    );
    expect(mutants.map((m) => m.id)).toEqual(["drop-last-arg@4"]);
  });

  it("honours `// mutation-allow: <reason>` and reports the reason", () => {
    const src =
      `export function f(v: number) {\n` +
      `  // mutation-allow: inert by construction — see log-rotation.ts:641\n` +
      `  if (v < 0) return null;\n` +
      `  if (v > 100) return null;\n` +
      `  return v;\n` +
      `}\n`;
    const { mutants, allowedMutants } = enumerateMutants("x.ts", src);
    expect(mutants.map((m) => m.id)).toEqual(["force-false@4", "force-true@4"]);
    expect(allowedMutants.map((m) => m.id)).toEqual([
      "force-false@3",
      "force-true@3",
    ]);
    expect(allowedMutants[0]!.allowReason).toBe(
      "inert by construction — see log-rotation.ts:641",
    );
  });

  it("refuses a reasonless `// mutation-allow:` — an unargued hatch suppresses nothing", () => {
    const src = `export function f(v: number) {\n  // mutation-allow:\n  if (v < 0) return null;\n  return v;\n}\n`;
    const { mutants, allowedMutants } = enumerateMutants("x.ts", src);
    expect(allowedMutants).toEqual([]);
    expect(mutants.map((m) => m.id)).toEqual(["force-false@3", "force-true@3"]);
  });

  it("scopes mutation to the named symbol", () => {
    const src =
      `export function wanted(v: number) {\n  if (v < 0) return 0;\n  return v;\n}\n` +
      `export function other(v: number) {\n  if (v > 9) return 9;\n  return v;\n}\n`;
    expect(
      enumerateMutants("x.ts", src, { symbols: ["wanted"] }).mutants.map((m) => m.line),
    ).toEqual([2, 2]);
    expect(enumerateMutants("x.ts", src).mutants.length).toBe(4);
  });
});

describe("mutation guard — refuses to pass for the wrong reason", () => {
  it("hard-errors when the baseline suite is already red", () => {
    expect(() =>
      runMutationTarget({
        file: "m.ts",
        readSource: () => `export function f(v: number) {\n  if (v) return 1;\n  return 0;\n}\n`,
        writeSource: () => {},
        runTests: () => ({ passed: false, detail: "boom" }),
      }),
    ).toThrow(/BASELINE IS RED/);
  });

  it("hard-errors when a manifest symbol no longer exists", () => {
    expect(() =>
      runMutationTarget({
        file: "m.ts",
        symbols: ["renamedAway"],
        readSource: () => `export function f(v: number) {\n  if (v) return 1;\n  return 0;\n}\n`,
        writeSource: () => {},
        runTests: () => ({ passed: true }),
      }),
    ).toThrow(/do not exist: renamedAway/);
  });

  it("hard-errors when a target enumerates zero mutants", () => {
    expect(() =>
      runMutationTarget({
        file: "m.ts",
        readSource: () => `export const x = 1;\n`,
        writeSource: () => {},
        runTests: () => ({ passed: true }),
      }),
    ).toThrow(/enumerated 0 mutants/);
  });

  it("restores the original source even when a mutant run throws", () => {
    let onDisk = `export function f(v: number) {\n  if (v) return 1;\n  return 0;\n}\n`;
    const original = onDisk;
    let call = 0;
    expect(() =>
      runMutationTarget({
        file: "m.ts",
        readSource: () => onDisk,
        writeSource: (t: string) => {
          onDisk = t;
        },
        runTests: () => {
          if (++call === 1) return { passed: true }; // baseline
          throw new Error("runner exploded");
        },
      }),
    ).toThrow(/runner exploded/);
    expect(onDisk).toBe(original);
  });
});

describe("mutation guard — crash recovery (the check writes the real tree)", () => {
  // Measured, not assumed: a SIGTERM delivered while the runner is blocked in
  // `spawnSync` terminated the process at exit 143 (default disposition)
  // without entering a registered handler, so in-process signal cleanup does
  // not close this gap. The sentinel does, and covers SIGKILL too.
  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), "mutation-sentinel-"));
    return {
      dir,
      sentinel: join(dir, ".mutation-restore.json"),
      target: join(dir, "prod.ts"),
    };
  }

  it("restores a file a killed run left mutated", () => {
    const { dir, sentinel, target } = scratch();
    try {
      const pristine = `if (v) return 1;\n`;
      writeFileSync(target, pristine, "utf8");
      arm(sentinel, { file: "prod.ts", path: target, original: pristine });
      // …the run dies here, mid-mutant.
      writeFileSync(target, `if (false && (v)) return 1;\n`, "utf8");

      const r = recover(sentinel);
      expect(r).toEqual({ file: "prod.ts", restored: true });
      expect(readFileSync(target, "utf8")).toBe(pristine);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the benign case (died after restoring, before disarming) distinctly", () => {
    const { dir, sentinel, target } = scratch();
    try {
      const pristine = `if (v) return 1;\n`;
      writeFileSync(target, pristine, "utf8");
      arm(sentinel, { file: "prod.ts", path: target, original: pristine });
      expect(recover(sentinel)).toEqual({ file: "prod.ts", restored: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when no run was interrupted", () => {
    const { dir, sentinel } = scratch();
    try {
      expect(recover(sentinel)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to silently delete a truncated sentinel", () => {
    const { dir, sentinel } = scratch();
    try {
      writeFileSync(sentinel, `{"file": "prod.ts", "orig`, "utf8");
      expect(() => recover(sentinel)).toThrow(/unreadable/);
      // Still there: the operator has to look at `git diff`, because the
      // sentinel no longer knows what to restore.
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disarm is idempotent", () => {
    const { dir, sentinel, target } = scratch();
    try {
      arm(sentinel, { file: "prod.ts", path: target, original: "x" });
      disarm(sentinel);
      expect(existsSync(sentinel)).toBe(false);
      expect(() => disarm(sentinel)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the sentinel is gitignored — a leftover must never be committable", () => {
    const ignore = readFileSync(join(REPO, ".gitignore"), "utf8");
    expect(ignore).toContain(SENTINEL_NAME);
  });
});

describe("mutation guard — the curated manifest stays honest", () => {
  const manifest = JSON.parse(
    readFileSync(join(REPO, "scripts", "mutation-targets.json"), "utf8"),
  ) as {
    targets: Array<{ file: string; symbols?: string[]; tests: string[]; why: string }>;
  };

  it("every target names a file, a scoped suite, and a reason", () => {
    expect(manifest.targets.length).toBeGreaterThan(0);
    for (const t of manifest.targets) {
      expect(readFileSync(join(REPO, t.file), "utf8").length).toBeGreaterThan(0);
      expect(t.tests.length).toBeGreaterThan(0);
      for (const p of t.tests) {
        expect(readFileSync(join(REPO, p), "utf8").length).toBeGreaterThan(0);
      }
      // A target with no stated blast radius is a coverage wishlist entry, and
      // those are what make a curated guard rot into a slow one.
      expect(t.why.length).toBeGreaterThan(40);
    }
  });

  it("every target's symbols resolve and produce mutants in the CURRENT source", () => {
    // The failure this pins: a rename lands, the symbol stops matching, the
    // target silently drops to zero mutants and CI keeps reporting green.
    for (const t of manifest.targets) {
      const src = readFileSync(join(REPO, t.file), "utf8");
      const { mutants, missingSymbols } = enumerateMutants(t.file, src, {
        symbols: t.symbols,
      });
      expect(missingSymbols).toEqual([]);
      expect(mutants.length).toBeGreaterThan(0);
    }
  });
});
