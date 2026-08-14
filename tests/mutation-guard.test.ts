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
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { enumerateMutants } from "../scripts/mutation/operators.mjs";
import { runMutationTarget, classifyRun } from "../scripts/mutation/run.mjs";
import { changedFiles } from "../scripts/mutation/changed-files.mjs";
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
    // Pin `killed` too, like the paired seam-real case below. Without it the
    // claim is only "one mutant, and it survived"; with it the claim is "one
    // mutant, and NOTHING killed it", which is what the fixture exists to say.
    expect(r.killed).toBe(0);
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

  it("ignores a `// mutation-allow:` that is only string-literal CONTENT", () => {
    // The hatch must be real source, not text. A fixture, a log template, or a
    // test that embeds the marker in a literal would otherwise switch off a
    // genuine adjacent site with nobody having written a suppression — a
    // silent no-op of the guard, which is the one failure mode it exists to
    // make impossible.
    const src =
      `export function f(v: number) {\n` +
      `  log("// mutation-allow: not a real hatch");\n` +
      `  if (v < 0) return null;\n` +
      "  const t = `// mutation-allow: nor is this`;\n" +
      `  if (v > 100) return null;\n` +
      `  return v;\n` +
      `}\n`;
    const { mutants, allowedMutants } = enumerateMutants("x.ts", src);
    expect(allowedMutants).toEqual([]);
    expect(mutants.map((m) => m.id)).toEqual([
      "force-false@3",
      "force-true@3",
      "force-false@5",
      "force-true@5",
    ]);
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

  // The blind spot the recorded count exists to close. The operators only
  // visit `if` statements and multi-arg calls, so a semantics-preserving
  // rewrite to a ternary REMOVES mutants from the site rather than surviving
  // one — and a smaller all-killed set reports a clean pass over logic nothing
  // perturbed. Reproduced on the real target: tier 2 of `selectEvictionVictim`
  // as `findIndex` + `staleIdx >= 0 ? … : …`, with 2338c280's test additions
  // reverted so the tier is genuinely unasserted, ran `2/2 mutants killed —
  // OK` at exit 0, down from `4/4`.
  const TWO_IFS =
    `export function pick(v: number, w: number) {\n` +
    `  if (v > 0) return 'a';\n` +
    `  if (w > 0) return 'b';\n` +
    `  return 'c';\n` +
    `}\n`;
  const ONE_IF_ONE_TERNARY =
    `export function pick(v: number, w: number) {\n` +
    `  if (v > 0) return 'a';\n` +
    `  return w > 0 ? 'b' : 'c';\n` +
    `}\n`;

  it("hard-errors when a semantics-preserving refactor SHRINKS the mutant set", () => {
    // Same behaviour, half the mutants. Every remaining mutant would still be
    // killed, so survivors alone cannot see this.
    expect(enumerateMutants("m.ts", TWO_IFS).mutants.length).toBe(4);
    expect(enumerateMutants("m.ts", ONE_IF_ONE_TERNARY).mutants.length).toBe(2);

    expect(() =>
      runMutationTarget({
        file: "m.ts",
        expectedMutants: 4,
        readSource: () => ONE_IF_ONE_TERNARY,
        writeSource: () => {},
        runTests: () => ({ passed: true }),
      }),
    ).toThrow(/MUTANT COUNT DRIFTED — the manifest records 4, enumeration produced 2/);
  });

  it("hard-errors on GROWTH too — a new branch is not assumed to be covered", () => {
    expect(() =>
      runMutationTarget({
        file: "m.ts",
        expectedMutants: 2,
        readSource: () => TWO_IFS,
        writeSource: () => {},
        runTests: () => ({ passed: true }),
      }),
    ).toThrow(/MUTANT COUNT DRIFTED — the manifest records 2, enumeration produced 4/);
  });

  it("runs normally when the count matches", () => {
    let call = 0;
    const r = runMutationTarget({
      file: "m.ts",
      expectedMutants: 4,
      readSource: () => TWO_IFS,
      writeSource: () => {},
      // First call is the baseline (must be green); every mutant after it is
      // killed.
      runTests: () => ({ passed: ++call === 1 }),
    });
    expect(r.total).toBe(4);
    expect(r.killed).toBe(4);
    expect(r.survivors).toEqual([]);
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

describe("mutation guard — the check script's own error surface", () => {
  it("reports a stale target file as a curated error, not a raw ENOENT stack", () => {
    // A renamed or deleted target is the ordinary way a manifest goes stale.
    // Before the fix the first `readFileSync` sat outside the try, so this
    // crashed the process with `Error: ENOENT … at main (…:186:56)` and a
    // Node version banner — output that names the script's internals instead
    // of the manifest the reader has to edit. Driven through the ad-hoc
    // `--file` path, which shares the loop with the manifest path.
    const r = spawnSync(
      process.execPath,
      [
        join(REPO, "scripts", "check-mutation-coverage.mjs"),
        "--file",
        "telegram-plugin/gateway/does-not-exist.ts",
        "--tests",
        "tests/mutation-guard.test.ts",
      ],
      { cwd: REPO, encoding: "utf8", timeout: 60_000 },
    );
    expect(r.status).toBe(1);
    const err = r.stderr ?? "";
    expect(err).toContain("STALE MANIFEST — no such file");
    expect(err).toContain("telegram-plugin/gateway/does-not-exist.ts");
    // The tell for the unhandled-throw path: a stack frame in the script and
    // Node's crash banner.
    expect(err).not.toMatch(/at main \(/);
    expect(err).not.toMatch(/^Node\.js v/m);
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

  it("refuses to overwrite a file the developer edited after a killed run", () => {
    // The data-loss path, and it is an ordinary sequence, not a contrived one:
    // a run is killed (so the sentinel survives — it dies before `disarm`), the
    // developer then does real work in that same file, and the next
    // `npm run lint` starts by "recovering". An unconditional
    // `writeFileSync(rec.path, rec.original)` silently reverts that work behind
    // a `console.warn`. Restore only what is demonstrably a mutant.
    const { dir, sentinel, target } = scratch();
    try {
      const pristine = `if (v) return 1;\n`;
      writeFileSync(target, pristine, "utf8");
      arm(sentinel, { file: "prod.ts", path: target, original: pristine });
      // …the run is killed. The developer then edits the file for real.
      const humanEdit = `if (v) return 2; // a real change, hours of work\n`;
      writeFileSync(target, humanEdit, "utf8");

      expect(() => recover(sentinel)).toThrow(/would DELETE those edits/);
      expect(readFileSync(target, "utf8")).toBe(humanEdit);
      // Left armed on purpose: the human reconciles and deletes it, exactly
      // like the truncated-sentinel path.
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still restores every operator's mutant, including drop-last-arg", () => {
    // The recognition set must be the mutants the runner can actually write,
    // or the guard trades data loss for a refusal to clean up after itself.
    const { dir, sentinel, target } = scratch();
    try {
      const pristine = `f(a, b);\n`;
      writeFileSync(target, pristine, "utf8");
      arm(sentinel, { file: "prod.ts", path: target, original: pristine });
      writeFileSync(target, `f(a, undefined);\n`, "utf8");
      expect(recover(sentinel)).toEqual({ file: "prod.ts", restored: true });
      expect(readFileSync(target, "utf8")).toBe(pristine);
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
    targets: Array<{
      file: string;
      symbols?: string[];
      tests: string[];
      why: string;
      mutants: number;
    }>;
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

  it("every target's symbols resolve and produce EXACTLY the recorded mutant count", () => {
    // Two failures this pins. A rename lands, the symbol stops matching, the
    // target silently drops to zero mutants and CI keeps reporting green —
    // and the subtler one: a semantics-preserving refactor (ternary, `&&`,
    // `switch`, loop guard) moves the logic to a site no operator visits, so
    // the count SHRINKS while every remaining mutant still dies. `> 0` cannot
    // see the second; the recorded count can.
    for (const t of manifest.targets) {
      const src = readFileSync(join(REPO, t.file), "utf8");
      const { mutants, missingSymbols } = enumerateMutants(t.file, src, {
        symbols: t.symbols,
      });
      expect(missingSymbols).toEqual([]);
      expect(mutants.length).toBeGreaterThan(0);
      expect({ file: t.file, mutants: mutants.length }).toEqual({
        file: t.file,
        mutants: t.mutants,
      });
    }
  });

  it("every target records a positive integer mutant count", () => {
    for (const t of manifest.targets) {
      expect(Number.isInteger(t.mutants) && t.mutants > 0).toBe(true);
    }
  });

  it("the check is still wired into `npm run lint` — the guard must actually run", () => {
    // This PR's own argument is "a narrow guard that runs beats a broad one
    // that gets disabled". Everything else here tests the LIBRARY, so deleting
    // the call from package.json would leave this suite 100% green with the
    // guard switched off. This is the assertion that notices.
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.lint).toContain("node scripts/check-mutation-coverage.mjs");
  });
});

describe("mutation guard — the guard's OWN files must not skip the required gates", () => {
  // The hole this closes, and it is the guard's own: `scripts/check-*.mjs`
  // matched the entry point and NOTHING else. `scripts/mutation/**` and
  // `scripts/mutation-targets.json` matched no pattern in either required
  // filter key, so a PR touching only the operator set and the manifest — the
  // exact shape of the filed follow-ups #4704 and #4705 — evaluated to
  // `lint == 'false'` AND `core == 'false'`. Both sentinels then report
  // SUCCESS on a skipped body (ci-lint.yml's `lint`, ci-tests-core.yml's
  // `vitest`), so the operator set could be neutered to a no-op, or the
  // manifest emptied and its `mutants` ratchet lowered to match, on a fully
  // green PR that ran zero of these tests and zero mutants. The `mutants`
  // ratchet cannot save that: it is enforced by the script that would not run
  // and by this file, which would not run either.
  //
  // Asserting the FILTER, not the yaml text, is the point: a rename of
  // scripts/mutation/ that leaves the patterns behind must fail here.
  const filters = parseYaml(
    readFileSync(join(REPO, ".github", "path-filters.yml"), "utf8"),
  ) as Record<string, unknown>;

  /** dorny/paths-filter flattens nested arrays (the `*ws9f1-security` anchor
   *  expands to one), so flatten before matching — same as the action does. */
  const patternsFor = (key: string): string[] =>
    (filters[key] as unknown[]).flat(Infinity) as string[];

  /**
   * Minimal glob→RegExp covering the two shapes this filter file actually
   * uses: literal paths and `*` / `**`. Any pattern containing another glob
   * metacharacter yields `null` and is treated as NO MATCH — the fail-closed
   * direction, because an unanalysable pattern can then only turn this test
   * RED, never green. Verified against picomatch 2.3.1 (the matcher
   * dorny/paths-filter@ceb8a2b8 compiles with, `{dot: true}`) over every
   * pattern in the `lint` and `core` keys.
   */
  const globToRe = (pattern: string): RegExp | null => {
    if (/[?![\](){}+@!]/.test(pattern)) return null;
    const body = pattern
      .split(/(\*\*\/|\*\*|\*)/)
      .map((part) => {
        if (part === "**/") return "(?:.*/)?";
        if (part === "**") return ".*";
        if (part === "*") return "[^/]*";
        return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    return new RegExp(`^${body}$`);
  };

  const matches = (key: string, file: string): boolean =>
    patternsFor(key).some((p) => globToRe(p)?.test(file) ?? false);

  // Every file `bun lint`'s mutation check and this suite actually load.
  // Derived from the directory, not hand-listed, so a new module added to
  // scripts/mutation/ is covered the moment it lands.
  const GUARD_FILES = [
    "scripts/check-mutation-coverage.mjs",
    "scripts/mutation-targets.json",
    ...readdirSync(join(REPO, "scripts", "mutation"))
      .filter((f) => f.endsWith(".mjs"))
      .sort()
      .map((f) => `scripts/mutation/${f}`),
  ];

  it("enumerates every load-bearing file, including the runner modules", () => {
    // Guards the guard: if readdirSync ever returns nothing the loop below
    // passes vacuously over an empty list.
    expect(GUARD_FILES).toContain("scripts/mutation/operators.mjs");
    expect(GUARD_FILES).toContain("scripts/mutation/run.mjs");
    expect(GUARD_FILES).toContain("scripts/mutation/restore-sentinel.mjs");
    expect(GUARD_FILES).toContain("scripts/mutation/changed-files.mjs");
    expect(GUARD_FILES.length).toBeGreaterThanOrEqual(6);
  });

  it("matches every one against `lint` — the key gating the job that RUNS the check", () => {
    expect(GUARD_FILES.filter((f) => !matches("lint", f))).toEqual([]);
  });

  it("matches every one against `core` — the key gating the tests that COVER it", () => {
    expect(GUARD_FILES.filter((f) => !matches("core", f))).toEqual([]);
  });

  it("would flag the follow-up-PR shape that skipped both gates", () => {
    // #4704 (extend the operator set) + #4705 (add the #4670 target). Each
    // required key is an OR over the diff, so this is the whole gate decision
    // for that PR.
    const diff = ["scripts/mutation/operators.mjs", "scripts/mutation-targets.json"];
    expect(diff.some((f) => matches("lint", f))).toBe(true);
    expect(diff.some((f) => matches("core", f))).toBe(true);
  });

  it("has not turned the filters into a match-everything (the tests above would pass either way)", () => {
    // Without this, deleting every pattern and replacing it with `**` would
    // make the three assertions above green while destroying the path gate.
    for (const key of ["lint", "core"]) {
      for (const f of ["README.md", "docs/architecture.md", "CHANGELOG.md"]) {
        expect({ key, f, matched: matches(key, f) }).toEqual({
          key,
          f,
          matched: false,
        });
      }
    }
  });
});

describe("mutation guard — a timed-out mutant is INDETERMINATE, never a kill", () => {
  it("classifies a real timed-out child as timedOut, not as a red suite", () => {
    // A real hanging subprocess, not a fabricated spawnSync result: the claim
    // is about Node's behaviour, so asserting a hand-built
    // `{status: null, error: {code: 'ETIMEDOUT'}}` would only assert this
    // test's own assumption.
    const hung = spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      timeout: 300,
      encoding: "utf8",
    });
    expect(classifyRun(hung)).toEqual({ passed: false, timedOut: true });
  });

  it("classifies a genuinely red suite as a kill, not a timeout", () => {
    const red = spawnSync(process.execPath, ["-e", "process.exit(1)"], {
      timeout: 30_000,
      encoding: "utf8",
    });
    expect(classifyRun(red)).toEqual({ passed: false, timedOut: false });
  });

  it("classifies a green suite as passed", () => {
    const green = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      timeout: 30_000,
      encoding: "utf8",
    });
    expect(classifyRun(green)).toEqual({ passed: true, timedOut: false });
  });

  it("keeps a timed-out mutant out of BOTH counts", () => {
    // The bug: `passed: r.status === 0` made a timeout false, so the mutant was
    // counted as killed and the target reported `4/4 mutants killed — OK` at
    // exit 0. A mutation that only makes the suite too slow to finish is then
    // indistinguishable from one the tests actually caught.
    let call = 0;
    const r = runMutationTarget({
      file: "m.ts",
      expectedMutants: 4,
      readSource: () =>
        `export function pick(v: number, w: number) {\n` +
        `  if (v > 0) return 'a';\n` +
        `  if (w > 0) return 'b';\n` +
        `  return 'c';\n` +
        `}\n`,
      writeSource: () => {},
      // Mutants are emitted in source order: force-false@2, force-true@2,
      // force-false@3, force-true@3 — so call 1 is the baseline and calls 2..5
      // are those four in that order.
      //   1 baseline green | 2 killed | 3 TIMED OUT | 4 survivor | 5 killed
      runTests: () => {
        const verdicts = [
          { passed: true }, // baseline
          { passed: false }, // force-false@2 — killed
          { passed: false, timedOut: true }, // force-true@2 — indeterminate
          { passed: true }, // force-false@3 — survivor
          { passed: false }, // force-true@3 — killed
        ];
        return verdicts[call++]!;
      },
    });
    expect(r.timedOut.map((m: { id: string }) => m.id)).toEqual(["force-true@2"]);
    expect(r.survivors.map((m: { id: string }) => m.id)).toEqual(["force-false@3"]);
    expect(r.killed).toBe(2);
    // The invariant: nothing is silently absorbed into a verdict it did not earn.
    expect(r.killed + r.survivors.length + r.timedOut.length).toBe(r.total);
  });

  it("hard-errors when the BASELINE times out — every mutant would too", () => {
    expect(() =>
      runMutationTarget({
        file: "m.ts",
        readSource: () => `export function f(v: number) {\n  if (v) return 1;\n  return 0;\n}\n`,
        writeSource: () => {},
        runTests: () => ({ passed: false, timedOut: true }),
      }),
    ).toThrow(/BASELINE TIMED OUT/);
  });
});

describe("mutation guard — the diff gate fails towards RUNNING, never towards skipping", () => {
  // `changedFiles` is the one function whose failure mode is "run nothing":
  // every other failure in the harness is loud (red baseline, stale symbol,
  // drifted count, survivor), while getting this wrong prints
  // `0/1 target(s) touched by this diff` and exits 0 having perturbed nothing.
  function gitRepo() {
    const dir = mkdtempSync(join(tmpdir(), "mutation-diff-"));
    const git = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "base.txt"), "base\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "base");
    return { dir, git };
  }

  it("returns exactly the files changed against a resolvable base", () => {
    const { dir, git } = gitRepo();
    try {
      git("checkout", "-qb", "feature");
      writeFileSync(join(dir, "scripts", "..", "changed.txt"), "x\n", "utf8");
      git("add", "-A");
      git("commit", "-qm", "change");
      // Real git, real subprocess, real fallback chain: `origin/main...HEAD`
      // fails (no remote), `main...HEAD` succeeds.
      expect(changedFiles("main", { cwd: dir })).toEqual(new Set(["changed.txt"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null — RUN EVERYTHING — when the base ref cannot be resolved", () => {
    const { dir } = gitRepo();
    const warnings: string[] = [];
    try {
      // Shallow checkout, deleted base branch, renamed default: every one of
      // these lands here, and every one must run the whole manifest rather
      // than quietly certifying a diff it could not compute.
      expect(
        changedFiles("no-such-base-ref", { cwd: dir, warn: (m: string) => warnings.push(m) }),
      ).toBeNull();
      expect(warnings.join("\n")).toContain("could not diff against");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no base is given at all (push to main, merge_group, local)", () => {
    const saved = process.env.GITHUB_BASE_REF;
    delete process.env.GITHUB_BASE_REF;
    try {
      expect(changedFiles(null, { cwd: REPO })).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.GITHUB_BASE_REF;
      else process.env.GITHUB_BASE_REF = saved;
    }
  });

  it("falls back to GITHUB_BASE_REF when no explicit base is passed", () => {
    const { dir, git } = gitRepo();
    const saved = process.env.GITHUB_BASE_REF;
    process.env.GITHUB_BASE_REF = "main";
    try {
      git("checkout", "-qb", "feature");
      writeFileSync(join(dir, "from-env.txt"), "x\n", "utf8");
      git("add", "-A");
      git("commit", "-qm", "change");
      expect(changedFiles(null, { cwd: dir })).toEqual(new Set(["from-env.txt"]));
    } finally {
      if (saved === undefined) delete process.env.GITHUB_BASE_REF;
      else process.env.GITHUB_BASE_REF = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mutation guard — `// mutation-allow:` does not depend on the line ending", () => {
  it("still suppresses on a CRLF file", () => {
    // `text.split("\n")` leaves a trailing "\r" on every line of a CRLF file.
    // "\r" is a JS line terminator, so `.` will not consume it and a
    // non-multiline `$` will not match before it: `(\S.*)$` failed outright
    // and the hatch silently stopped suppressing anything on that file.
    const lf =
      `export function f(v) {\n` +
      `  // mutation-allow: inert by construction\n` +
      `  if (v < 0) return null;\n` +
      `  return v;\n` +
      `}\n`;
    const crlf = lf.replace(/\n/g, "\r\n");
    const a = enumerateMutants("x.ts", lf);
    const b = enumerateMutants("x.ts", crlf);
    expect(a.allowedMutants.map((m: { id: string }) => m.id)).toEqual([
      "force-false@3",
      "force-true@3",
    ]);
    expect(b.allowedMutants.map((m: { id: string }) => m.id)).toEqual(
      a.allowedMutants.map((m: { id: string }) => m.id),
    );
    expect(b.allowedMutants[0]!.allowReason).toBe("inert by construction");
    expect(b.mutants).toEqual([]);
  });

  it("still refuses a reasonless hatch on a CRLF file", () => {
    // The `m` flag must not turn "\r" itself into the mandatory reason.
    const crlf = `export function f(v) {\r\n  // mutation-allow:\r\n  if (v < 0) return null;\r\n  return v;\r\n}\r\n`;
    const { mutants, allowedMutants } = enumerateMutants("x.ts", crlf);
    expect(allowedMutants).toEqual([]);
    expect(mutants.map((m: { id: string }) => m.id)).toEqual([
      "force-false@3",
      "force-true@3",
    ]);
  });
});

describe("mutation guard — an unrecoverable interrupted run is a curated error", () => {
  // `recover()` throws two hard errors that are addressed to a human with a
  // dirty working tree ("unreadable sentinel", "would DELETE those edits"), and
  // both already say exactly what to do. Thrown out of an unwrapped `main()`
  // they arrived buried in a raw Node stack plus a crash banner — the same
  // output shape the STALE MANIFEST read was fixed to avoid, so this was an
  // internal inconsistency as well as bad UX.
  const SENTINEL = join(REPO, SENTINEL_NAME);

  it("reports a truncated sentinel without a stack or a crash banner", () => {
    // Never clobber a real one: a leftover sentinel means the developer's tree
    // may hold a mutant, and that is exactly what must not be silently eaten.
    expect(existsSync(SENTINEL)).toBe(false);
    try {
      writeFileSync(SENTINEL, `{"file": "prod.ts", "orig`, "utf8");
      const r = spawnSync(
        process.execPath,
        [
          join(REPO, "scripts", "check-mutation-coverage.mjs"),
          "--file",
          "scripts/mutation/operators.mjs",
          "--tests",
          "tests/mutation-guard.test.ts",
        ],
        { cwd: REPO, encoding: "utf8", timeout: 60_000 },
      );
      expect(r.status).toBe(1);
      const err = r.stderr ?? "";
      expect(err).toContain("INTERRUPTED RUN NOT RECOVERED");
      expect(err).toContain("is unreadable");
      // The instruction the human needs must survive, not be buried.
      expect(err).toContain("check `git diff`");
      // The tells for the unhandled-throw path.
      expect(err).not.toMatch(/at main \(/);
      expect(err).not.toMatch(/^Node\.js v/m);
      // Fail closed: the tree may still hold a mutant, so the run must abort
      // rather than fall through and mutate more source.
      expect(r.stdout ?? "").not.toContain("mutants killed");
      // Left armed on purpose — the human reconciles and deletes it.
      expect(existsSync(SENTINEL)).toBe(true);
    } finally {
      rmSync(SENTINEL, { force: true });
    }
  });

  it("reports an edited-since-killed-run target the same way", () => {
    expect(existsSync(SENTINEL)).toBe(false);
    const target = join(REPO, "scripts", "mutation", "operators.mjs");
    try {
      writeFileSync(
        SENTINEL,
        JSON.stringify({
          file: "scripts/mutation/operators.mjs",
          path: target,
          original: "// a stale pristine copy that is not the current text\n",
          armed_at: Date.now(),
        }),
        "utf8",
      );
      const before = readFileSync(target, "utf8");
      const r = spawnSync(
        process.execPath,
        [join(REPO, "scripts", "check-mutation-coverage.mjs"), "--all"],
        { cwd: REPO, encoding: "utf8", timeout: 60_000 },
      );
      expect(r.status).toBe(1);
      const err = r.stderr ?? "";
      expect(err).toContain("INTERRUPTED RUN NOT RECOVERED");
      expect(err).toContain("would DELETE those edits");
      expect(err).not.toMatch(/at main \(/);
      expect(err).not.toMatch(/^Node\.js v/m);
      // The data-loss path stays shut: the file is untouched.
      expect(readFileSync(target, "utf8")).toBe(before);
      expect(existsSync(SENTINEL)).toBe(true);
    } finally {
      rmSync(SENTINEL, { force: true });
    }
  });
});
