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
