/**
 * Outcome tests for `scripts/check-changelog-entry.mjs`.
 *
 * The guarantee under test is "CI goes red when a PR ships code without
 * staging a `## Unreleased` entry, and stays green for docs/chore/test PRs and
 * for a PR that DID stage one", so every case builds a REAL git repo with REAL
 * commits and runs the REAL script as a subprocess, asserting on its exit code
 * — not on the return value of an internal helper.
 *
 * Non-vacuity: the two red-outcome cases (`expect(r.code).toBe(1)`) are the
 * load-bearing ones — they fail if the guard's verdict is neutered to always-
 * pass. (The green/skip cases assert specific reason text, so they also flip
 * under a neuter, but it is the exit-1 assertions that pin the guarantee.) The
 * merge-base regression below is proven non-vacuous the hard way: it FAILS
 * against a tip-based `run()` and PASSES only once the merge-base fix lands.
 * The escape-hatch and docs-only cases guard against the worse failure mode —
 * blocking a legitimate PR.
 */
import { describe, expect, it, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const CHECK = join(repoRoot, "scripts", "check-changelog-entry.mjs");

const SEED_CHANGELOG = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "<!-- staging area; entries land here per-PR -->",
  "",
  "## v0.20.11 — a released section",
  "",
  "- **Something shipped (#1):** prose.",
  "",
].join("\n");

const scratchRoots: string[] = [];

interface Fixture {
  dir: string;
  /** Write a file at a repo-relative path (creates parent dirs). */
  writeFile: (rel: string, body: string) => void;
  /** Stage everything and commit on the current (work) branch. */
  commit: (message: string) => string;
  /**
   * Commit `files` onto `main` AFTER the branch has forked, then return to
   * `work`. Simulates main advancing past the branch's merge-base (e.g. a
   * release renaming `## Unreleased`).
   */
  advanceMain: (files: Record<string, string>, message: string) => string;
  /** Run the real guard over `main...HEAD`; returns exit code + output. */
  check: (env?: Record<string, string>) => { code: number; out: string };
}

function makeFixture(prefix: string, initialChangelog: string = SEED_CHANGELOG): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(root);
  const dir = join(root, "repo");
  mkdirSync(dir, { recursive: true });

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_AUTHOR_NAME = "Operator";
  env.GIT_AUTHOR_EMAIL = "operator@example.test";
  env.GIT_COMMITTER_NAME = "Operator";
  env.GIT_COMMITTER_EMAIL = "operator@example.test";
  // Hermetic against the ambient CI event: the suite runs on `merge_group` too
  // (ci-tests-core.yml), where the guard SKIPs — which would silently turn the
  // red-case fixture into a skip. Each test that cares sets the event itself.
  delete env.GITHUB_EVENT_NAME;
  delete env.GITHUB_BASE_REF;
  delete env.CHANGELOG_PR_BODY;
  delete env.CHANGELOG_PR_LABELS;

  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf-8", env: env as NodeJS.ProcessEnv });

  const writeFile = (rel: string, body: string) => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };

  git(["init", "--quiet", "-b", "main"]);
  writeFile("CHANGELOG.md", initialChangelog);
  writeFile("src/base.ts", "export const base = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "chore: base"]);
  // A local `main` standing in for `origin/main`: the guard's candidate cascade
  // falls through to plain `main` when no remote is configured.
  git(["checkout", "-q", "-b", "work"]);

  return {
    dir,
    writeFile,
    commit(message) {
      git(["add", "-A"]);
      git(["commit", "-q", "-m", message]);
      return git(["rev-parse", "HEAD"]).trim();
    },
    advanceMain(files, message) {
      git(["checkout", "-q", "main"]);
      for (const [rel, body] of Object.entries(files)) writeFile(rel, body);
      git(["add", "-A"]);
      git(["commit", "-q", "-m", message]);
      const sha = git(["rev-parse", "main"]).trim();
      git(["checkout", "-q", "work"]);
      return sha;
    },
    check(extraEnv = {}) {
      const r = spawnSync(process.execPath, [CHECK], {
        cwd: dir,
        encoding: "utf-8",
        env: { ...env, CHANGELOG_BASE: "main", ...extraEnv } as NodeJS.ProcessEnv,
      });
      return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
  };
}

/** Append a real entry line under `## Unreleased`. */
function changelogWithEntry(entry: string): string {
  return SEED_CHANGELOG.replace(
    "<!-- staging area; entries land here per-PR -->\n",
    `<!-- staging area; entries land here per-PR -->\n\n- **${entry}**\n`,
  );
}

afterAll(() => {
  for (const d of scratchRoots) rmSync(d, { recursive: true, force: true });
});

describe("check-changelog-entry — red when shippable code ships no Unreleased entry", () => {
  it("fails a src/** change that does not grow ## Unreleased", () => {
    const f = makeFixture("changelog-red-");
    f.writeFile("src/feature.ts", "export const feature = 2;\n");
    f.commit("feat: add a feature but forget the changelog");

    const r = f.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("check-changelog-entry: FAIL");
    expect(r.out).toContain("src/feature.ts");
  });

  it("fails a change under skills/** with no changelog entry", () => {
    const f = makeFixture("changelog-red-skills-");
    f.writeFile("skills/foo/SKILL.md", "# foo\n");
    // NOTE: SKILL.md is `.md` → exempt. Add a non-md shippable file too so the
    // PR is genuinely shippable and the md exemption is exercised in the mix.
    f.writeFile("bin/foo.sh", "#!/bin/sh\necho hi\n");
    f.commit("feat: new bin helper");

    const r = f.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("bin/foo.sh");
    // The exempt markdown file must NOT be listed as a shippable offender.
    expect(r.out).not.toContain("skills/foo/SKILL.md");
  });
});

describe("check-changelog-entry — green when the entry is staged or the change is exempt", () => {
  it("passes a src/** change that grows ## Unreleased", () => {
    const f = makeFixture("changelog-green-entry-");
    f.writeFile("src/feature.ts", "export const feature = 2;\n");
    f.writeFile("CHANGELOG.md", changelogWithEntry("Add a feature (#2): with a note."));
    f.commit("feat: add a feature and stage the changelog");

    const r = f.check();
    expect(r.code).toBe(0);
    expect(r.out).toContain("## Unreleased grew");
  });

  it("passes a docs-only change (no shippable paths)", () => {
    const f = makeFixture("changelog-green-docs-");
    f.writeFile("docs/guide.md", "# guide\n");
    f.writeFile("README.md", "# readme\n");
    f.commit("docs: update the guide");

    const r = f.check();
    expect(r.code).toBe(0);
    expect(r.out).toContain("no shippable code changed");
  });

  it("passes a test-only change even under a shippable root", () => {
    const f = makeFixture("changelog-green-test-");
    f.writeFile("telegram-plugin/tests/thing.test.ts", "// a test\n");
    f.commit("test: cover the thing");

    const r = f.check();
    expect(r.code).toBe(0);
    expect(r.out).toContain("no shippable code changed");
  });

  it("passes a shippable change with a [skip changelog] commit token on its own line", () => {
    const f = makeFixture("changelog-green-token-");
    f.writeFile("src/chore.ts", "export const chore = 3;\n");
    // Token alone on a body line — the sanctioned, deliberate form.
    f.commit("chore: rename a variable\n\n[skip changelog]");

    const r = f.check();
    expect(r.code).toBe(0);
    expect(r.out).toContain("escape hatch");
  });

  it("does NOT self-trip: a body that merely mentions the token inline still fails", () => {
    const f = makeFixture("changelog-selftrip-");
    f.writeFile("src/feature.ts", "export const feature = 4;\n");
    f.commit("feat: ship a feature");

    // Prose that documents the escape hatch inline must NOT disable the gate.
    const r = f.check({
      CHANGELOG_PR_BODY: "This PR adds support for a `[skip changelog]` token.",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("check-changelog-entry: FAIL");
  });

  it("passes a shippable change with the no-changelog label", () => {
    const f = makeFixture("changelog-green-label-");
    f.writeFile("src/chore.ts", "export const chore = 3;\n");
    f.commit("chore: tidy up");

    const r = f.check({ CHANGELOG_PR_LABELS: "agent:klanker no-changelog" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("escape hatch");
  });

  it("passes a shippable change with a [skip changelog] PR-body token on its own line", () => {
    const f = makeFixture("changelog-green-body-");
    f.writeFile("src/chore.ts", "export const chore = 3;\n");
    f.commit("chore: tidy up");

    const r = f.check({ CHANGELOG_PR_BODY: "Pure refactor.\n[skip changelog]\n" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("escape hatch");
  });
});

describe("check-changelog-entry — growth is measured against the merge-base, not main's tip", () => {
  // Fork point: `## Unreleased` already carries an entry from earlier in the
  // cycle. The branch inherits it and never adds a NEW one.
  const FORK_CHANGELOG = [
    "# Changelog",
    "",
    "## Unreleased",
    "",
    "<!-- staging -->",
    "",
    "- **Old entry (#1):** shipped earlier this cycle.",
    "",
    "## v0.20.0 — prior",
    "",
    "- prior stuff.",
    "",
  ].join("\n");

  // Main then cuts a release: `## Unreleased` is renamed to `## v0.21.0` (its
  // entry moves with it) and a fresh EMPTY `## Unreleased` is re-seeded.
  const RELEASED_CHANGELOG = [
    "# Changelog",
    "",
    "## Unreleased",
    "",
    "<!-- staging -->",
    "",
    "## v0.21.0 — the release",
    "",
    "- **Old entry (#1):** shipped earlier this cycle.",
    "",
    "## v0.20.0 — prior",
    "",
    "- prior stuff.",
    "",
  ].join("\n");

  it("fails when main advanced past the fork (release emptied Unreleased) and the branch adds shippable code but no NEW entry", () => {
    const f = makeFixture("changelog-mergebase-", FORK_CHANGELOG);
    // Main advances AFTER the fork: the release rename empties Unreleased on main.
    f.advanceMain({ "CHANGELOG.md": RELEASED_CHANGELOG }, "chore: release v0.21.0");
    // The (un-rebased) branch ships code and does NOT touch CHANGELOG — it still
    // carries the old Unreleased entry from the fork point.
    f.writeFile("src/feature.ts", "export const feature = 9;\n");
    f.commit("feat: ship without staging a NEW entry");

    // Tip-based `run()` compares the branch's stale Unreleased against main's
    // now-empty one and sees false growth → exit 0 (the bug). Merge-base-based
    // `run()` compares against the fork point (identical Unreleased) → exit 1.
    const r = f.check({ CHANGELOG_BASE: "main" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("check-changelog-entry: FAIL");
    expect(r.out).toContain("src/feature.ts");
  });

  it("passes when the branch adds a genuinely new entry on top of the released main", () => {
    const f = makeFixture("changelog-mergebase-ok-", FORK_CHANGELOG);
    f.advanceMain({ "CHANGELOG.md": RELEASED_CHANGELOG }, "chore: release v0.21.0");
    // This time the branch DOES stage a new entry under its Unreleased.
    f.writeFile("src/feature.ts", "export const feature = 9;\n");
    f.writeFile(
      "CHANGELOG.md",
      FORK_CHANGELOG.replace(
        "- **Old entry (#1):** shipped earlier this cycle.\n",
        "- **Old entry (#1):** shipped earlier this cycle.\n- **Brand new entry (#2):** this branch's work.\n",
      ),
    );
    f.commit("feat: ship and stage a new entry");

    const r = f.check({ CHANGELOG_BASE: "main" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("## Unreleased grew");
  });
});

describe("check-changelog-entry — skips that must never gate", () => {
  it("skips (passes) on a merge_group event", () => {
    const f = makeFixture("changelog-skip-mg-");
    f.writeFile("src/feature.ts", "export const feature = 2;\n");
    f.commit("feat: ship without changelog on the queue ref");

    const r = f.check({ GITHUB_EVENT_NAME: "merge_group" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("SKIP — merge_group");
  });

  it("skips (passes) when no base ref is resolvable", () => {
    const f = makeFixture("changelog-skip-nobase-");
    f.writeFile("src/feature.ts", "export const feature = 2;\n");
    f.commit("feat: ship without changelog, no base");
    // Rename the local `main` away so NONE of the guard's fallback candidates
    // (origin/main, main) resolve — the shallow-clone / detached-checkout shape.
    execFileSync("git", ["branch", "-m", "main", "detached-away"], {
      cwd: f.dir,
      encoding: "utf-8",
    });

    const r = f.check({ CHANGELOG_BASE: "does-not-exist-ref" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("SKIP — no base ref");
  });
});
