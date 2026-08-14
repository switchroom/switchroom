/**
 * Outcome tests for the Telegram-supergroup-id rule in
 * `scripts/check-no-pii-secrets.mjs`.
 *
 * The guarantee under test is "a real-looking `-100…` chat id cannot reach
 * `main`, and the guard cannot degrade into a silent no-op". Every case runs
 * the REAL script as a subprocess over a REAL throwaway git repo and asserts
 * its exit code, so a neutered rule (allowlist widened to everything, scan
 * loop short-circuited, verdict inverted) flips these red.
 *
 * Non-vacuity notes:
 *   - `rejects the -100-prefixed form of an id on the literal denylist` FAILS
 *     against the pre-fix `\b<digits>\b` matcher: in the marked form the
 *     character before the id is the `0` of `-100`, a word character, so `\b`
 *     never matched and a denylisted id sat in a tracked file with lint green.
 *   - `rejects a scrubbed id spelled as a plain negative with -100 stripped`
 *     and `rejects a scrubbed id in its bare, unprefixed spelling` both FAIL
 *     when `KNOWN_REAL_ID_BODIES` omits those two ids: neither spelling is
 *     visible to the structural `-100(\d{8,13})` rule, so with the literal
 *     entries removed the guard reports `clean` and exits 0.
 *   - the fail-closed cases assert exit 1 on *degradation*, which is the
 *     failure mode a `catch { continue }` would hide.
 *
 * Every real-shaped id below is assembled from fragments at runtime — the same
 * discipline the script itself uses — so this file never contains a contiguous
 * id literal for the guard (or GitHub Push Protection) to trip over.
 */
import { describe, expect, it, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const CHECK_REL = join("scripts", "check-no-pii-secrets.mjs");
const CHECK_ABS = join(repoRoot, CHECK_REL);

/** A real-shaped id that is NOT on the literal denylist — the case the
 *  structural rule exists for (nobody has audited it yet). */
const UNAUDITED_BODY = "48151" + "62342";
/** An id the literal RULES table already names, used to pin the `-100`
 *  prefix hole. */
const DENYLISTED_BODY = "38527" + "47971";
/**
 * A real id scrubbed by #4712, which historically appeared in
 * `tests/scaffold.reconcile-group.test.ts` as a plain negative with the `-100`
 * prefix STRIPPED (`-<body>`). The structural `-100(\d{8,13})` rule cannot see
 * that spelling at all, so only a literal `KNOWN_REAL_ID_BODIES` entry catches
 * it. Without one, rebasing a pre-scrub branch restores the real id with lint
 * green — the exact recurrence the scrub exists to prevent.
 */
const UNMARKED_BODY = "51642" + "17975";
/** The other id scrubbed by #4712, exercised in its BARE spelling — likewise
 *  invisible to the structural rule. */
const BARE_ONLY_BODY = "42234" + "64247";

const scratchRoots: string[] = [];

interface Fixture {
  dir: string;
  writeFile: (rel: string, body: string) => void;
  run: () => { code: number; out: string };
}

/** A throwaway git repo carrying a copy of the real guard. */
function makeFixture(prefix: string, opts: { withGuard?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "you@example.com");
  git("config", "user.name", "Example");

  const writeFile = (rel: string, body: string) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };

  if (opts.withGuard !== false) {
    writeFile(CHECK_REL, execFileSync("cat", [CHECK_ABS], { encoding: "utf-8" }));
  }

  return {
    dir: root,
    writeFile,
    run: () => {
      // Stage everything so `git ls-files` sees it, then run the real guard.
      execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
      const r = spawnSync(process.execPath, [CHECK_REL], {
        cwd: root,
        encoding: "utf-8",
      });
      return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    },
  };
}

afterAll(() => {
  for (const d of scratchRoots) rmSync(d, { recursive: true, force: true });
});

describe("check-no-pii-secrets — Telegram supergroup id rule", () => {
  it("rejects an unsanctioned, never-before-seen -100 id", () => {
    const f = makeFixture("pii-id-reject-");
    f.writeFile("src/fixture.ts", `export const CHAT = -100${UNAUDITED_BODY}\n`);
    const r = f.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("unsanctioned Telegram supergroup id");
    expect(r.out).toContain("src/fixture.ts:1");
    // The message must tell the author what to do instead.
    expect(r.out).toContain("-1001234567890");
  });

  it("rejects the -100-prefixed form of an id on the literal denylist (the \\b hole)", () => {
    const f = makeFixture("pii-id-prefix-");
    f.writeFile("src/fixture.ts", `export const CHAT = "-100${DENYLISTED_BODY}"\n`);
    const r = f.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("real Telegram id (group)");
  });

  it("still rejects the bare form of a denylisted id", () => {
    const f = makeFixture("pii-id-bare-");
    f.writeFile("docs/note.md", `the turn key was ${DENYLISTED_BODY}:_#1\n`);
    const r = f.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("real Telegram id (group)");
  });

  it("rejects a scrubbed id spelled as a plain negative with -100 stripped", () => {
    // The spelling the structural `-100(\d{8,13})` rule is blind to. This is
    // how the id actually sat in the tree before it was scrubbed, so it is
    // also what a rebase of a pre-scrub branch would restore.
    const f = makeFixture("pii-id-unmarked-");
    f.writeFile(
      "tests/scaffold.fixture.ts",
      `const groups = { "-${UNMARKED_BODY}": { requireMention: false } };\n`,
    );
    const r = f.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("real Telegram id (fleet forum)");
    expect(r.out).toContain("tests/scaffold.fixture.ts:1");
  });

  it("rejects a scrubbed id in its bare, unprefixed spelling", () => {
    const f = makeFixture("pii-id-bare-scrubbed-");
    f.writeFile("docs/note.md", `the pin key was ${BARE_ONLY_BODY}:_#1078\n`);
    const r = f.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("real Telegram id (supergroup)");
  });

  it("rejects an unsanctioned id spelled as a t.me/c/ deep link", () => {
    const f = makeFixture("pii-id-tme-");
    f.writeFile("docs/note.md", `see https://t.me/c/${UNAUDITED_BODY}/1078\n`);
    const r = f.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("t.me/c/ link");
  });

  it("passes on the sanctioned synthetic example ids", () => {
    const f = makeFixture("pii-id-ok-");
    f.writeFile(
      "src/fixture.ts",
      [
        "export const CANONICAL = -1001234567890",
        "export const OTHER = -1005555555555",
        "export const NUMBERED = -1009000000004",
        "export const ROUND = -1002000000000",
        'export const LINK = "https://t.me/c/111/7"',
        "",
      ].join("\n"),
    );
    const r = f.run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("clean");
  });

  it("is clean on the real tree (the guard must not block its own repo)", () => {
    const r = spawnSync(process.execPath, [CHECK_ABS], { cwd: repoRoot, encoding: "utf-8" });
    expect(`${r.stdout}${r.stderr}`).toContain("clean");
    expect(r.status).toBe(0);
  });

  // ── fail-closed: a degraded guard must never report clean ────────────────
  it("fails closed when the tracked-file list is empty", () => {
    // Guard copy on disk but nothing staged → `git ls-files` yields nothing.
    // The pre-fix script printed "clean (0 tracked files scanned)" and exit 0.
    const f = makeFixture("pii-id-empty-");
    const r = spawnSync(process.execPath, [CHECK_REL], { cwd: f.dir, encoding: "utf-8" });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("FAILED CLOSED");
  });

  it("fails closed when a tracked file cannot be read", () => {
    const f = makeFixture("pii-id-unreadable-");
    f.writeFile("src/vanishing.ts", "export const OK = 1\n");
    execFileSync("git", ["add", "-A"], { cwd: f.dir, stdio: "pipe" });
    rmSync(join(f.dir, "src/vanishing.ts"));
    const r = spawnSync(process.execPath, [CHECK_REL], { cwd: f.dir, encoding: "utf-8" });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("could not be read");
  });

  it("fails closed when the allowlist is widened until it is vacuous", () => {
    // The whole rule is "everything except a few structurally-fake shapes".
    // An allowlist entry that admits an arbitrary body silently un-does it,
    // so the guard refuses to run with one.
    const f = makeFixture("pii-id-vacuous-");
    const src = execFileSync("cat", [CHECK_ABS], { encoding: "utf-8" });
    const widened = src.replace(/re: \/\^9900112233\$\//, "re: /^\\d{10}$/");
    expect(widened).not.toBe(src); // the mutation actually applied
    f.writeFile(CHECK_REL, widened);
    f.writeFile("src/fixture.ts", "export const OK = 1\n");
    const r = f.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("too broad");
  });

  it("fails closed on a widening that evades a two-body sample", () => {
    // The self-check used to sample two known-real bodies. `^8\d{9}$` matches
    // neither of those two, so it would have passed the sampled check — while
    // admitting two OTHER known-real ids. Testing every body closes that.
    const f = makeFixture("pii-id-sample-evade-");
    const src = execFileSync("cat", [CHECK_ABS], { encoding: "utf-8" });
    const widened = src.replace(/re: \/\^9900112233\$\//, "re: /^8\\d{9}$/");
    expect(widened).not.toBe(src); // the mutation actually applied
    f.writeFile(CHECK_REL, widened);
    f.writeFile("src/fixture.ts", "export const OK = 1\n");
    const r = f.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("too broad");
    expect(r.out).toContain('known-real "user"');
  });

  it("fails closed when a sanctioned shape carries a stateful g/y flag", () => {
    // `.test()` on a `g`- or `y`-flagged regex advances `lastIndex`, so the
    // SAME body alternates true/false across calls: `/^(\d)\1+$/g` tested four
    // times against one repeated-digit body returns true,false,true,false.
    // `isSanctionedIdBody` calls `.test()` once per id occurrence in the tree,
    // so every second legitimate repeated-digit id would be reported as an
    // offender and lint would fail depending on how many such ids happen to
    // precede it in the scan. The fixture below carries four sanctioned
    // repeated-digit ids: without the flag check the guard exits 1 reporting
    // two of them as "unsanctioned Telegram supergroup id" — a false positive
    // on ids the allowlist explicitly blesses. With the check it exits 1 at
    // config-validation time instead, naming the offending shape.
    const f = makeFixture("pii-id-stateful-");
    const src = execFileSync("cat", [CHECK_ABS], { encoding: "utf-8" });
    const mutated = src.replace(/re: \/\^\(\\d\)\\1\+\$\//, "re: /^(\\d)\\1+$/g");
    expect(mutated).not.toBe(src); // the mutation actually applied
    f.writeFile(CHECK_REL, mutated);
    f.writeFile(
      "src/fixture.ts",
      [
        "export const A = -1001111111111",
        "export const B = -1002222222222",
        "export const C = -1003333333333",
        "export const D = -1004444444444",
        "",
      ].join("\n"),
    );
    const r = f.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAILED CLOSED");
    expect(r.out).toContain("stateful flag (g)");
    expect(r.out).toContain("(\\d)\\1+");
    // ...and it must NOT have reached the scan and mislabelled sanctioned ids.
    expect(r.out).not.toContain("unsanctioned Telegram supergroup id");
  });

  it("fails closed on a sticky-flagged sanctioned shape too", () => {
    // `y` is stateful for the same reason `g` is — `.test()` advances
    // `lastIndex` — so it must be rejected on the same terms.
    const f = makeFixture("pii-id-sticky-");
    const src = execFileSync("cat", [CHECK_ABS], { encoding: "utf-8" });
    const mutated = src.replace(/re: \/\^\(\\d\)\\1\+\$\//, "re: /^(\\d)\\1+$/y");
    expect(mutated).not.toBe(src); // the mutation actually applied
    f.writeFile(CHECK_REL, mutated);
    f.writeFile("src/fixture.ts", "export const OK = 1\n");
    const r = f.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAILED CLOSED");
    expect(r.out).toContain("stateful flag (y)");
  });

  it("scans its own source — a contiguous id in the guard is caught", () => {
    // The guard used to skip its own path. That made it the one tracked file
    // where a contiguous real id could sit unflagged, and one did.
    const f = makeFixture("pii-id-self-", { withGuard: false });
    const src = execFileSync("cat", [CHECK_ABS], { encoding: "utf-8" });
    // Planted AFTER line 1: a shebang is only valid as the first line.
    const lines = src.split("\n");
    lines.splice(1, 0, `// planted in a comment: -100${BARE_ONLY_BODY}`);
    f.writeFile(CHECK_REL, lines.join("\n"));
    const r = f.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(CHECK_REL);
    expect(r.out).toContain("real Telegram id (supergroup)");
  });

  it("fails closed when git is unavailable", () => {
    const f = makeFixture("pii-id-nogit-");
    f.writeFile("src/fixture.ts", "export const OK = 1\n");
    f.run();
    const emptyBin = mkdtempSync(join(tmpdir(), "pii-id-nobin-"));
    scratchRoots.push(emptyBin);
    const r = spawnSync(process.execPath, [CHECK_REL], {
      cwd: f.dir,
      encoding: "utf-8",
      env: { ...process.env, PATH: emptyBin },
    });
    expect(r.status).toBe(1);
  });
});
