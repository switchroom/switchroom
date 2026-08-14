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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  /**
   * Run git inside the fixture under its HERMETIC env (pinned identity, no
   * ambient `~/.gitconfig`). Throws on non-zero. Every git call a test makes
   * MUST go through this or `gitTry`: a bare `execFileSync("git", ...)`
   * inherits the ambient environment, and a CI runner has no `user.name` /
   * `user.email`, so any commit-creating command there dies with exit 128.
   */
  git: (args: string[]) => string;
  /** As `git`, but non-throwing — returns the exit status and both streams. */
  gitTry: (args: string[]) => { status: number; stdout: string; stderr: string };
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

  const gitTry = (args: string[]) => {
    const r = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf-8",
      env: env as NodeJS.ProcessEnv,
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

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
    git,
    gitTry,
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

/**
 * The post-release merge trap, end to end.
 *
 * A PR stages its entry under `## Unreleased`. A release is cut before it
 * merges, renaming that header to `## v0.21.0`. Merging main into the branch is
 * TEXTUALLY CLEAN — the entry lands inside the shipped section, exit 0, zero
 * conflicts — and nothing used to notice: the PR-side run measures growth
 * against the PR's own merge-base (which predates the release, so the entry
 * still reads as "under Unreleased" there), and the merge queue SKIPped the
 * script outright.
 *
 * Non-vacuity: `trapFixture` asserts the merge is CLEAN and that the entry
 * really did land under the released heading BEFORE the guard runs, so a
 * fixture that stopped reproducing the corruption fails loudly instead of
 * quietly making the red case unreachable.
 */
describe("check-changelog-entry — an entry that lands in an already-released section", () => {
  /**
   * The fork state. Shaped like the real file: `## Unreleased` already holds a
   * staged entry, and the branch appends BELOW it — i.e. anchored on the next
   * `##` heading. That anchoring is what makes the merge clean and the landing
   * silent, and it is exactly how #4680's entry ended up at CHANGELOG.md:813.
   */
  const FORK = [
    "# Changelog",
    "",
    "## Unreleased",
    "",
    "<!-- staging area; entries land here per-PR -->",
    "",
    "- **Existing staged entry (#0):** already waiting for the next cut.",
    "",
    "## v0.20.11 — a released section",
    "",
    "- **Something shipped (#1):** prose.",
    "",
  ].join("\n");

  /** The branch: appends its entry at the end of Unreleased. */
  const BRANCH = FORK.replace(
    "- **Existing staged entry (#0):** already waiting for the next cut.\n",
    "- **Existing staged entry (#0):** already waiting for the next cut.\n" +
      "- **Branch entry (#2):** staged under Unreleased, before the release.\n",
  );

  /**
   * Main, after the release cut: `## Unreleased` is RENAMED to `## v0.21.0`
   * (carrying entry #0 with it) and a fresh empty Unreleased is seeded above.
   * The branch never saw this, and its own edit is far enough down the file
   * that git merges the two without a murmur.
   */
  const AFTER_RELEASE = [
    "# Changelog",
    "",
    "## Unreleased",
    "",
    "<!-- staging area; entries land here per-PR -->",
    "",
    "## v0.21.0 — the cut that happened while the PR sat open",
    "",
    "- **Existing staged entry (#0):** already waiting for the next cut.",
    "",
    "## v0.20.11 — a released section",
    "",
    "- **Something shipped (#1):** prose.",
    "",
  ].join("\n");

  /**
   * Build the corrupt-but-clean merge: branch stages an entry, main cuts a
   * release, branch merges main. Leaves the fixture on the merge commit.
   */
  function trapFixture(prefix: string): Fixture {
    const f = makeFixture(prefix, FORK);

    // The branch ships code and stages its entry under `## Unreleased`.
    f.writeFile("src/feature.ts", "export const feature = 9;\n");
    f.writeFile("CHANGELOG.md", BRANCH);
    f.commit("feat: ship code with its entry staged under Unreleased");

    // Main advances: the release renames the header the entry lives under.
    f.advanceMain({ "CHANGELOG.md": AFTER_RELEASE }, "chore: release v0.21.0");

    // The merge that silently corrupts. It MUST be clean — that is the defect.
    // Runs under the fixture's pinned identity: this call CREATES a merge
    // commit, so on an identity-less CI runner a bare git here exits 128.
    const merge = f.gitTry(["merge", "--no-edit", "main"]);
    expect(merge.status, `the trap requires a CLEAN merge; got:\n${merge.stderr}`).toBe(0);

    // And the entry MUST now sit under the released heading, not Unreleased.
    const merged = f.git(["show", "HEAD:CHANGELOG.md"]).split("\n");
    const entryLine = merged.findIndex((l) => l.includes("Branch entry (#2)"));
    const releasedLine = merged.findIndex((l) => l.startsWith("## v0.21.0"));
    expect(entryLine, "fixture no longer reproduces: entry missing").toBeGreaterThan(-1);
    expect(
      entryLine,
      "fixture no longer reproduces: entry did not land under the released heading",
    ).toBeGreaterThan(releasedLine);

    return f;
  }

  it("RED on the merge queue: the merged result is caught, naming the section and the fix", () => {
    const f = trapFixture("changelog-trap-mg-");

    // The queue ref: base is github.event.merge_group.base_sha, surfaced as
    // $CHANGELOG_BASE by ci-lint.yml. This is the ONLY moment the corruption is
    // observable, so this assertion is the whole point of the fix.
    const r = f.check({ GITHUB_EVENT_NAME: "merge_group", CHANGELOG_BASE: "main" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("landed in an ALREADY-RELEASED section");
    // Names the actual problem and the actual fix — not the misleading
    // "adds no new entry under ## Unreleased" symptom the old guard reported.
    expect(r.out).toContain("`## v0.21.0`");
    expect(r.out).toContain("Branch entry (#2)");
    expect(r.out).toContain("MOVE your entry back under");
    expect(r.out).not.toContain("adds no new entry");
  });

  it("RED on the PR event too, once the branch has merged main in", () => {
    const f = trapFixture("changelog-trap-pr-");
    const r = f.check({ CHANGELOG_BASE: "main" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("landed in an ALREADY-RELEASED section");
  });

  it("is escapable with a [changelog placement ok] commit token, for a deliberate old-section edit", () => {
    const f = trapFixture("changelog-trap-escape-");
    f.writeFile("src/other.ts", "export const other = 1;\n");
    f.commit("chore: amend the shipped note\n\n[changelog placement ok]");

    const r = f.check({ GITHUB_EVENT_NAME: "merge_group", CHANGELOG_BASE: "main" });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("ALREADY-RELEASED");
  });

  it("does NOT fire on the release PR, which adds the released heading in the same range", () => {
    // The release PR renames `## Unreleased` to `## v0.21.0`, so every line
    // beneath that heading reads as "added" to the diff. Exempting a section
    // whose OWN heading was added in the range is what keeps this green.
    const f = makeFixture("changelog-release-pr-", FORK);
    f.writeFile(
      "CHANGELOG.md",
      FORK.replace(
        "<!-- staging area; entries land here per-PR -->\n",
        "<!-- staging area; entries land here per-PR -->\n\n## v0.21.0 — the cut\n",
      ),
    );
    f.commit("chore: release v0.21.0");

    const r = f.check();
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("ALREADY-RELEASED");
  });
});

describe("check-changelog-entry — non-vacuity", () => {
  it("WARNs instead of a bare OK when the range is empty (the uncommitted-merge trap)", () => {
    // `npm run lint` over an UNCOMMITTED merge sees an empty main...HEAD range
    // and used to print a cheerful OK — which cost real reviewer time on
    // exactly the corruption above. It must say it checked nothing.
    const f = makeFixture("changelog-empty-range-");
    f.git(["checkout", "-q", "main"]);
    f.writeFile("src/uncommitted.ts", "export const x = 1;\n"); // dirty worktree

    const r = f.check({ CHANGELOG_BASE: "main" });
    expect(r.out).toContain("EMPTY range");
    expect(r.out).toContain("this run checked nothing");
    expect(r.out).toContain("COMMIT it first");
  });

  it("FAILs when merge_group sets a base ref that does not resolve", () => {
    // A workflow that stops surfacing merge_group.base_sha correctly must break
    // loudly. Skipping here would silently restore the original blind spot.
    //
    // NOTE: no `branch -m main detached-away` here on purpose. Renaming `main`
    // away made EVERY candidate unresolvable, so this test used to pass via the
    // generic no-base path and never exercised the stated guarantee at all —
    // it stayed green against a build where the cascade silently rescued the
    // queue ref with `origin/main`.
    const f = makeFixture("changelog-mg-badbase-");
    f.writeFile("src/feature.ts", "export const feature = 2;\n");
    f.commit("feat: ship on a queue ref");

    const r = f.check({
      GITHUB_EVENT_NAME: "merge_group",
      CHANGELOG_BASE: "does-not-exist-ref",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("merge_group base ref is unresolvable");
  });

  it("ci-lint.yml surfaces merge_group.base_sha as $CHANGELOG_BASE", () => {
    // Without this env line the queue-side placement check has no base and the
    // merged result goes uninspected again. Pin it in the workflow itself.
    const wf = readFileSync(join(repoRoot, ".github", "workflows", "ci-lint.yml"), "utf-8");
    expect(wf).toMatch(/CHANGELOG_BASE:.*github\.event\.merge_group\.base_sha/);
  });
});

describe("check-changelog-entry — a fenced code block is not a section boundary", () => {
  // The repo's own changelog style pastes CI/grep output verbatim, so a fenced
  // block whose CONTENT starts with `## ` is routine (CHANGELOG.md already
  // carries 30+ fence markers). If the parser treats that as a real heading it
  // invents a phantom RELEASED section, and every entry appended after it —
  // i.e. every entry written the documented way, at the end of `## Unreleased`
  // — reads as landing under a released heading. That is a sticky, repo-wide
  // false FAIL: once one such fenced block lands, every subsequent PR reds.
  const FENCED = [
    "# Changelog",
    "",
    "## Unreleased",
    "",
    "<!-- staging area; entries land here per-PR -->",
    "",
    "- **Earlier entry (#0):** quoting a CI transcript verbatim:",
    "",
    "```",
    "## v9.9.9 — sample output",
    "- not a real heading, just pasted stdout",
    "```",
    "",
    "## v0.20.11 — a released section",
    "",
    "- **Something shipped (#1):** prose.",
    "",
  ].join("\n");

  it("does NOT flag an entry appended after a fenced block that contains a `## ` line", () => {
    const f = makeFixture("changelog-fence-", FENCED);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    f.writeFile(
      "CHANGELOG.md",
      FENCED.replace(
        "```\n\n## v0.20.11",
        "```\n\n- **Branch entry (#2):** appended at the end of Unreleased.\n\n## v0.20.11",
      ),
    );
    f.commit("feat: ship code and stage an entry below a fenced block");

    const r = f.check();
    expect(r.out).not.toContain("ALREADY-RELEASED");
    expect(r.out).not.toContain("v9.9.9");
    expect(r.code).toBe(0);
  });

  it("counts an entry below a fenced block as real Unreleased growth", () => {
    // `extractUnreleasedEntries` shares the blindness: it TRUNCATES the section
    // at the fenced `## ` line, so an entry appended after the fence is invisible
    // to RULE 1 and a genuinely-staged PR fails for want of an entry.
    const f = makeFixture("changelog-fence-growth-", FENCED);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    f.writeFile(
      "CHANGELOG.md",
      FENCED.replace(
        "```\n\n## v0.20.11",
        "```\n\n- **Branch entry (#2):** appended at the end of Unreleased.\n\n## v0.20.11",
      ),
    );
    f.commit("feat: ship code and stage an entry below a fenced block");

    const r = f.check();
    expect(r.out).toContain("## Unreleased grew");
  });
});

describe("check-changelog-entry — the queue-ref base is authoritative", () => {
  it("FAILs when merge_group's $CHANGELOG_BASE does not resolve, even though `main` does", () => {
    // The guarantee ci-lint.yml claims. The fallback cascade (origin/main, main)
    // must NOT rescue a queue ref: on a real fetch-depth: 0 checkout `origin/main`
    // ALWAYS resolves, so a cascade here means a broken workflow silently checks
    // the wrong range and reports OK. Note there is no `branch -m` here — `main`
    // is present and resolvable, which is the whole point.
    const f = makeFixture("changelog-mg-badbase-fallback-");
    f.writeFile("src/feature.ts", "export const feature = 2;\n");
    f.commit("feat: ship on a queue ref");

    const r = f.check({
      GITHUB_EVENT_NAME: "merge_group",
      CHANGELOG_BASE: "does-not-exist-ref",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("merge_group base ref is unresolvable");
  });

  it("FAILs when merge_group runs with no $CHANGELOG_BASE at all", () => {
    // Deleting the `CHANGELOG_BASE:` line from ci-lint.yml leaves the variable
    // UNSET, not set-to-garbage. That must break loudly too — otherwise the
    // cascade quietly falls through to `main` and the queue check certifies a
    // range that is not the merged result.
    const f = makeFixture("changelog-mg-nobase-");
    f.writeFile("src/feature.ts", "export const feature = 2;\n");
    f.commit("feat: ship on a queue ref");

    const r = f.check({ GITHUB_EVENT_NAME: "merge_group", CHANGELOG_BASE: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("merge_group ran with no base ref");
  });
});

describe("check-changelog-entry — diff parsing and section newness", () => {
  it("does not lose added lines after one whose CONTENT starts with `+++`", () => {
    // In a `-U0` hunk body, `+++foo` is an ADDED LINE whose text begins with
    // `+`, not the `+++ b/<path>` file header. Treating it as a header without
    // advancing the new-file cursor mis-attributes every later added line in the
    // hunk one line too low — which can drop a real entry out of the placement
    // check entirely (or land a line number on a heading, exempting it).
    const SEED = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "## v0.20.11 — a released section",
      "",
      "- **Something shipped (#1):** prose.",
      "",
    ].join("\n");
    const f = makeFixture("changelog-plusplus-", SEED);
    f.writeFile(
      "CHANGELOG.md",
      SEED.replace(
        "- **Something shipped (#1):** prose.\n",
        "- **Something shipped (#1):** prose.\n" +
          "- **Buried A (#2):** first.\n" +
          "+++ pasted diff header, still a changelog line\n" +
          "- **Buried C (#4):** third.\n",
      ),
    );
    f.commit("docs: append three lines under the released section");

    const r = f.check();
    expect(r.code).toBe(1);
    // All three added lines sit under the released heading; all three must be
    // reported. The `+++` desync drops the LAST one.
    expect(r.out).toContain("Buried A (#2)");
    expect(r.out).toContain("Buried C (#4)");
  });

  it("still catches a buried entry when the released heading itself was edited", () => {
    // The exemption exists for the release PR, which RENAMES `## Unreleased` to
    // `## vX.Y.Z`. Keying it on "the heading LINE changed" instead of "the
    // section is new" means a one-character typo fix on an old heading blanket-
    // exempts that whole section — and any entry buried in it goes unreported.
    const SEED = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "## v0.20.11 — a relesed section",
      "",
      "- **Something shipped (#1):** prose.",
      "",
    ].join("\n");
    const f = makeFixture("changelog-heading-typo-", SEED);
    f.writeFile(
      "CHANGELOG.md",
      SEED.replace("a relesed section", "a released section").replace(
        "- **Something shipped (#1):** prose.\n",
        "- **Something shipped (#1):** prose.\n- **Buried entry (#2):** should be caught.\n",
      ),
    );
    f.commit("docs: fix a typo in an old heading and (wrongly) add an entry under it");

    const r = f.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("Buried entry (#2)");
  });

  it("names the missing-`## Unreleased` case in the FAIL message", () => {
    // With no `## Unreleased` section at all, EVERY added line is necessarily
    // under a released heading, and the generic "you staged it under Unreleased
    // and a release was cut" story is simply wrong. Say the real thing.
    const SEED = [
      "# Changelog",
      "",
      "## v0.20.11 — a released section",
      "",
      "- **Something shipped (#1):** prose.",
      "",
    ].join("\n");
    const f = makeFixture("changelog-no-unreleased-", SEED);
    f.writeFile(
      "CHANGELOG.md",
      SEED.replace(
        "- **Something shipped (#1):** prose.\n",
        "- **Something shipped (#1):** prose.\n- **New entry (#2):** nowhere to put it.\n",
      ),
    );
    f.commit("docs: add an entry to a changelog with no Unreleased section");

    const r = f.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("has NO `## Unreleased` section");
  });
});

describe("check-changelog-entry — skips that must never gate", () => {
  it("does not blanket-skip a merge_group event; it runs the placement check", () => {
    // RULE 1 (an entry must exist) still stands down on a queue ref: the
    // `no-changelog` label and the PR body are unreadable there, so enforcing it
    // would red a legitimately-escaped PR and eject the train. RULE 2
    // (placement) reads only the diff, so it runs — and this must not regress
    // back into an unconditional skip.
    const f = makeFixture("changelog-skip-mg-");
    f.writeFile("src/feature.ts", "export const feature = 2;\n");
    f.commit("feat: ship without changelog on the queue ref");

    const r = f.check({ GITHUB_EVENT_NAME: "merge_group" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("no entry added under a released section");
    expect(r.out).not.toContain("SKIP — merge_group");
  });

  it("skips (passes) when no base ref is resolvable", () => {
    const f = makeFixture("changelog-skip-nobase-");
    f.writeFile("src/feature.ts", "export const feature = 2;\n");
    f.commit("feat: ship without changelog, no base");
    // Rename the local `main` away so NONE of the guard's fallback candidates
    // (origin/main, main) resolve — the shallow-clone / detached-checkout shape.
    f.git(["branch", "-m", "main", "detached-away"]);

    const r = f.check({ CHANGELOG_BASE: "does-not-exist-ref" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("SKIP — no base ref");
  });
});
