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
  check: (env?: Record<string, string | undefined>) => { code: number; out: string };
  /**
   * As `check`, but keeps the two streams APART. A WARN the operator is meant
   * to act on has to reach them on the stream they actually read: `bun run lint`
   * and every `2>/dev/null` invocation show stdout only, so asserting on the
   * merged blob cannot tell a visible warning from an invisible one.
   */
  checkStreams: (
    env?: Record<string, string | undefined>,
  ) => { code: number; stdout: string; stderr: string };
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
  // `check()` injects `CHANGELOG_BASE: "main"` by default; deleting it here is
  // what lets a caller pass `CHANGELOG_BASE: undefined` to get it GENUINELY
  // unset (the `pull_request` shape, where the guard must fall through its
  // candidate cascade) rather than merely set to an empty string.
  delete env.CHANGELOG_BASE;

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

  const checkStreams = (extraEnv: Record<string, string | undefined> = {}) => {
    const merged: Record<string, string | undefined> = {
      ...env,
      CHANGELOG_BASE: "main",
      ...extraEnv,
    };
    // An explicit `undefined` DELETES the key rather than passing the string
    // "undefined" through to the child, so a test can pin the genuinely-unset
    // case and not just the set-to-garbage one.
    for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
    const r = spawnSync(process.execPath, [CHECK], {
      cwd: dir,
      encoding: "utf-8",
      env: merged as NodeJS.ProcessEnv,
    });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

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
    checkStreams,
    check(extraEnv = {}) {
      const r = checkStreams(extraEnv);
      return { code: r.code, out: `${r.stdout}${r.stderr}` };
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

  // NOTE: the unresolvable-queue-base case is NOT duplicated here. It lives in
  // "the queue-ref base is authoritative" below, which is its subject.

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

  it("still FLAGS a buried entry when a fence contains an unterminated `<!--`", () => {
    // The fail-OPEN twin of the case above, and the reason the two masks had to
    // become ONE stateful pass. Masking HTML comments FIRST let an unterminated
    // `<!--` *inside* a fence pair with any `-->` appearing later in prose; the
    // comment mask blanked the fence's own CLOSING ``` on the way, the fence ran
    // to EOF, every heading below it vanished, and the placement rule reported a
    // confident OK over a genuinely BURIED entry. Per CommonMark the `<!--` is
    // code and the fence closes normally. Non-vacuity: this test FAILS (exit 0,
    // no "ALREADY-RELEASED") against the two-pass `maskFencedCode(maskHtmlComments(x))`
    // shape and passes only with the interleaved pass.
    const TRAP = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "- **Earlier entry (#0):** the broken template we hit:",
      "",
      "```html",
      "<!-- unterminated on purpose",
      "```",
      "",
      "## v0.20.11 — a released section",
      "",
      "- **Something shipped (#1):** an --> arrow in prose.",
      "",
    ].join("\n");
    const f = makeFixture("changelog-fence-comment-", TRAP);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    f.writeFile(
      "CHANGELOG.md",
      `${TRAP}- **BURIED ENTRY (#2):** appended under the RELEASED heading.\n`,
    );
    f.commit("feat: ship code and bury the entry under a released heading");

    const r = f.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("ALREADY-RELEASED");
    expect(r.out).toContain("BURIED ENTRY (#2)");
    expect(r.out).toContain("## v0.20.11");
  });

  it("WARNs when a code fence is left open at end-of-file", () => {
    // CommonMark-correct — an unclosed fence runs to EOF — but it means every
    // `## ` heading below it is code, so the placement rule inspects nothing
    // down there. That must not read as a confident OK.
    const UNCLOSED = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "- **Earlier entry (#0):** pasting output and forgetting to close it:",
      "",
      "```",
      "oops, never closed",
      "",
      "## v0.20.11 — a released section",
      "",
      "- **Something shipped (#1):** prose.",
      "",
    ].join("\n");
    const f = makeFixture("changelog-unclosed-fence-", UNCLOSED);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    f.writeFile("CHANGELOG.md", `${UNCLOSED}- **Branch entry (#2):** staged.\n`);
    f.commit("feat: ship code with an unclosed fence in the changelog");

    const r = f.check();
    expect(r.out).toContain("code fence opened at line 7 that is never closed");
    expect(r.out).toContain("the placement rule cannot see anything past it");
  });
});

describe("check-changelog-entry — a `<!--` in prose does not blind the parser", () => {
  // The fail-OPEN the single stateful pass introduced, and the reason the
  // multi-line comment opener is line-start-ANCHORED. Per CommonMark only an
  // HTML block type 2 opener — `<!--` at the start of its line, indented at most
  // 3 spaces — can span lines; a `<!--` anywhere else is inline raw HTML, which
  // cannot. An unanchored scanner reads a changelog entry that merely QUOTES
  // `<!--` as opening a comment that runs to EOF, blanks every released `## `
  // heading below it, and then reports a confident OK over a buried entry.
  //
  // This is not hypothetical for this file: measured on the real CHANGELOG.md,
  // one prose line quoting `<!--` at the end of `## Unreleased` took the parse
  // from 429 sections to 421, and the 8 that vanished were `## v0.21.10`,
  // `## v0.21.9`, `## v0.21.8` and neighbours — exactly the sections a
  // post-release merge buries an entry in.

  /**
   * The trap: an entry buried under a RELEASED heading. `prose` is spliced into
   * `## Unreleased` ABOVE the released heading — the only difference between the
   * control and the attack.
   */
  function buriedEntryFixture(prefix: string, prose: string[]): Fixture {
    const BASE = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "<!-- staging area; entries land here per-PR -->",
      "",
      "- **Earlier entry (#0):** already staged.",
      ...prose,
      "",
      "## v0.20.11 — a released section",
      "",
      "- **Something shipped (#1):** prose.",
      "",
    ].join("\n");
    const f = makeFixture(prefix, BASE);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    f.writeFile("CHANGELOG.md", `${BASE}- **BURIED ENTRY (#2):** appended under the RELEASED heading.\n`);
    f.commit("feat: ship code and bury the entry under a released heading");
    return f;
  }

  const MERGE_GROUP = { GITHUB_EVENT_NAME: "merge_group", CHANGELOG_BASE: "main" };

  // NON-VACUITY, structural: the control and the attack are the SAME fixture but
  // for one prose line, and they are asserted to differ in BOTH exit code and
  // message. The pair cannot pass by every case agreeing on one answer — a guard
  // that always FAILs reds the control's twin below, and one that always passes
  // reds the control here.
  it("control: the buried entry FAILs when no `<!--` appears in prose", () => {
    const r = buriedEntryFixture("changelog-prose-control-", []).check(MERGE_GROUP);
    expect(r.code).toBe(1);
    expect(r.out).toContain("ALREADY-RELEASED");
    expect(r.out).toContain("BURIED ENTRY (#2)");
  });

  it("attack: one prose line quoting `<!--` must NOT turn that FAIL into an OK", () => {
    // Mutation-proven: against the unanchored scanner this run is exit 0 with
    // "OK — no entry added under a released section", because every heading
    // below the prose line — including `## v0.20.11` — has been masked away.
    const r = buriedEntryFixture("changelog-prose-attack-", [
      "- guard: a bare `<!--` in prose is now literal text",
    ]).check(MERGE_GROUP);
    expect(r.code).toBe(1);
    expect(r.out).toContain("ALREADY-RELEASED");
    expect(r.out).toContain("BURIED ENTRY (#2)");
    expect(r.out).toContain("## v0.20.11");
  });

  it("a `<!--` indented 4+ spaces does not open a multi-line comment either", () => {
    // 4 spaces is past CommonMark's 3-space limit for an HTML block opener (it is
    // an indented code block), so this must stay literal too. Sits at the
    // boundary the anchoring rule actually implements, not just far from it.
    const r = buriedEntryFixture("changelog-prose-indent4-", ["", "    <!--"]).check(MERGE_GROUP);
    expect(r.code).toBe(1);
    expect(r.out).toContain("ALREADY-RELEASED");
    expect(r.out).toContain("## v0.20.11");
  });

  it("a 4-space `<!--` at the END of the file opens nothing — no unclosed WARN", () => {
    // The observable half of the ≤3-space anchor. The test above puts the
    // 4-space opener above a column-0 heading, and container scoping now ends a
    // block at that dedent regardless — so that fixture alone no longer
    // distinguishes `start <= 3` from `start <= 4`, and the boundary would go
    // unpinned.
    //
    // Here the indented code block TRAILS the file, so nothing dedents before
    // EOF and the only witness is the state machine's own end state: relax the
    // anchor by one column and this `<!--` opens a comment that never closes,
    // firing the unclosed-comment WARN on a file that contains no open comment
    // at all. Correct behaviour is a silent OK.
    const TRAILING_INDENTED_CODE = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "<!-- staging area; entries land here per-PR -->",
      "",
      "- **Earlier entry (#0):** already staged.",
      "",
      "## v0.20.11 — a released section",
      "",
      "- **Something shipped (#1):** prose.",
      "",
      "The raw markdown of a staging block, as an indented code block:",
      "",
      "    <!--",
      "    ## v0.0.1 — a heading inside indented code",
      "",
    ].join("\n");
    const f = makeFixture("changelog-indent4-eof-", TRAILING_INDENTED_CODE);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    f.writeFile(
      "CHANGELOG.md",
      TRAILING_INDENTED_CODE.replace(
        "- **Earlier entry (#0):** already staged.\n",
        "- **Earlier entry (#0):** already staged.\n- **Branch entry (#2):** staged.\n",
      ),
    );
    f.commit("feat: ship code and stage an entry, with indented code trailing the file");

    const r = f.checkStreams();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("## Unreleased grew");
    expect(`${r.stdout}${r.stderr}`).not.toContain("never closed");
  });

  it("still masks a GENUINE line-start multi-line comment, `## ` lines and all", () => {
    // The other side of the anchoring rule, and the real use this must not break:
    // a comment that DOES start its own line spans lines exactly as before, so a
    // `## ` inside it is commentary and not a section boundary. An entry appended
    // after it is still plain Unreleased growth, not a burial.
    const COMMENTED = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "<!--",
      "## v9.9.9 — a heading inside a real comment, not a section",
      "reviewer note: keep this block until the next cut",
      "-->",
      "",
      "- **Earlier entry (#0):** already staged.",
      "",
      "## v0.20.11 — a released section",
      "",
      "- **Something shipped (#1):** prose.",
      "",
    ].join("\n");
    const f = makeFixture("changelog-real-comment-", COMMENTED);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    f.writeFile(
      "CHANGELOG.md",
      COMMENTED.replace(
        "- **Earlier entry (#0):** already staged.\n",
        "- **Earlier entry (#0):** already staged.\n- **Branch entry (#2):** appended under Unreleased.\n",
      ),
    );
    f.commit("feat: ship code and stage an entry below a real HTML comment");

    const r = f.check();
    expect(r.code).toBe(0);
    expect(r.out).toContain("## Unreleased grew");
    expect(r.out).not.toContain("ALREADY-RELEASED");
    expect(r.out).not.toContain("v9.9.9");
  });

  it("WARNs on STDOUT when an HTML comment is left open at end-of-file", () => {
    // Belt to the anchoring rule's braces. Anchoring makes the fail-open shape
    // unreachable from prose, but a guard whose entire value proposition is
    // "does not fail open" has to be LOUD when its own state machine ends in an
    // unexpected state — the same duty, and the same wording, as the unclosed
    // fence WARN it sits beside.
    //
    // Asserted on stdout ALONE on purpose: `bun run lint` and every `2>/dev/null`
    // invocation show stdout only, so a WARN written to stderr would be invisible
    // to the operator it is addressed to. The merged blob cannot tell them apart.
    // The unclosed comment is in the BASE and trails the file, so the run itself
    // PASSES — which is the case that matters. A WARN only earns its keep when
    // the verdict is OK; on a FAIL the operator is already reading the output.
    const UNCLOSED = [
      "# Changelog", //                                                   1
      "", //                                                              2
      "## Unreleased", //                                                 3
      "", //                                                              4
      "<!-- staging area; entries land here per-PR -->", //                5
      "", //                                                              6
      "- **Earlier entry (#0):** already staged.", //                     7
      "", //                                                              8
      "## v0.20.11 — a released section", //                              9
      "", //                                                             10
      "- **Something shipped (#1):** prose.", //                         11
      "", //                                                             12
      "<!-- reviewer note: drop this before the cut", //                  13  ← never closed
      "", //                                                             14
    ].join("\n");
    const f = makeFixture("changelog-unclosed-comment-", UNCLOSED);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    // The branch's ONLY changelog edit is an entry under `## Unreleased`, which
    // pushes the unclosed opener from line 13 to line 14.
    f.writeFile(
      "CHANGELOG.md",
      UNCLOSED.replace(
        "- **Earlier entry (#0):** already staged.\n",
        "- **Earlier entry (#0):** already staged.\n- **Branch entry (#2):** staged.\n",
      ),
    );
    f.commit("feat: ship code with an unclosed HTML comment in the changelog");

    const r = f.checkStreams();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("HTML comment opened at line 14 that is never closed");
    expect(r.stdout).toContain("every `## ` heading past it is invisible to");
    expect(r.stdout).toContain("Close the comment with `-->`");
  });
});

describe("check-changelog-entry — `<!-->` and `<!--->` are COMPLETE comments", () => {
  // Round 4 of the same fail-open class, and the one the round-3 WARN backstop
  // could not catch. CommonMark 0.30+ (matching the HTML spec) says an HTML
  // comment is `<!-->`, `<!--->`, or `<!--` + text + `-->` — i.e. the closing
  // `-->` may reuse the opener's own dashes — and HTML block type 2 ends on any
  // line CONTAINING `-->`, which `<!-->` does. Verified against the reference
  // implementation in `tests/fixtures/commonmark-mask-cases.mjs`.
  //
  // Scanning for the closer from `start + 4` cannot see either form, so the
  // masker called a CLOSED comment unterminated; at column 0 it passed the
  // anchoring check, set `open: true`, and blanked on to the next `-->` in the
  // FILE. Measured on the real CHANGELOG.md at this PR's head, one such prose
  // line at the end of `## Unreleased` took the parse from 429 sections to 421
  // — the eight that vanished were `## v0.21.10` down to `## v0.21.3`, exactly
  // the sections a post-release merge buries an entry in — and
  // `unclosedCommentLine` stayed NULL, so the unclosed-comment WARN added in
  // 54c96b6c never fired. Silent OK, exit 0, on a genuinely buried entry.

  /**
   * As `buriedEntryFixture` above, plus a `trailer` appended AFTER the released
   * section. The trailer is what makes this the SILENT variant: with an ordinary
   * `<!-- ... -->` block later in the file (the real CHANGELOG.md has these), the
   * runaway mask terminates there instead of at EOF, so not even the
   * unclosed-comment WARN fires.
   */
  function fixture(prefix: string, prose: string[], trailer: string[] = []): Fixture {
    const BASE = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "<!-- staging area; entries land here per-PR -->",
      "",
      "- **Earlier entry (#0):** already staged.",
      ...prose,
      "",
      "## v0.20.11 — a released section",
      "",
      "- **Something shipped (#1):** prose.",
      "",
      ...trailer,
    ].join("\n");
    const f = makeFixture(prefix, BASE);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    f.writeFile(
      "CHANGELOG.md",
      BASE.replace(
        "- **Something shipped (#1):** prose.\n",
        "- **Something shipped (#1):** prose.\n- **BURIED ENTRY (#2):** appended under the RELEASED heading.\n",
      ),
    );
    f.commit("feat: ship code and bury the entry under a released heading");
    return f;
  }

  const MERGE_GROUP = { GITHUB_EVENT_NAME: "merge_group", CHANGELOG_BASE: "main" };
  // An ordinary later comment block, as the real CHANGELOG.md carries around
  // lines 1310 and 1419. Its `-->` is what silences the WARN.
  const LATER_COMMENT = ["<!-- reviewer note: keep until the next cut -->", ""];

  it("control: the buried entry FAILs with no `<!--`-ish line in prose", () => {
    // The twin of every case below, same fixture but for one prose line. A guard
    // that always FAILs cannot pass the whole file (the green cases red), and one
    // that always passes reds here.
    const r = fixture("changelog-overlap-control-", [], LATER_COMMENT).check(MERGE_GROUP);
    expect(r.code).toBe(1);
    expect(r.out).toContain("ALREADY-RELEASED");
    expect(r.out).toContain("BURIED ENTRY (#2)");
  });

  for (const form of ["<!-->", "<!--->"]) {
    it(`SILENT variant: a line-start \`${form}\` must NOT turn that FAIL into an OK`, () => {
      // Against `s.indexOf('-->', start + 4)` this run is exit 0 with
      // "OK — no entry added under a released section" and NO warning at all:
      // `## v0.20.11` was masked away, and the mask ended at the later comment's
      // `-->`, so `unclosedCommentLine` is null and the WARN never fires.
      const r = fixture(`changelog-overlap-silent-${form.length}-`, [form], LATER_COMMENT);
      const s = r.checkStreams(MERGE_GROUP);
      expect(s.code).toBe(1);
      expect(`${s.stdout}${s.stderr}`).toContain("ALREADY-RELEASED");
      expect(`${s.stdout}${s.stderr}`).toContain("BURIED ENTRY (#2)");
      expect(`${s.stdout}${s.stderr}`).toContain("## v0.20.11");
      // And it is a CLOSED comment, so it must not be reported as an open one.
      expect(`${s.stdout}${s.stderr}`).not.toContain("HTML comment opened at line");
    });

    it(`LOUD variant: \`${form}\` with no later \`-->\` in the file also FAILs`, () => {
      // The same defect with the WARN backstop reachable. It used to WARN and
      // still exit 0 — a warning is not a gate, so this had to become a FAIL.
      const s = fixture(`changelog-overlap-loud-${form.length}-`, [form]).checkStreams(MERGE_GROUP);
      expect(s.code).toBe(1);
      expect(`${s.stdout}${s.stderr}`).toContain("ALREADY-RELEASED");
      expect(`${s.stdout}${s.stderr}`).toContain("BURIED ENTRY (#2)");
      expect(`${s.stdout}${s.stderr}`).not.toContain("HTML comment opened at line");
    });
  }

  it("a `-->` TAIL cannot reopen a multi-line comment, even at its own offset 0", () => {
    // Pins `maskCommentsInLine(line.slice(idx + 3), false)`: the text after a
    // closing `-->` is mid-line BY CONSTRUCTION, so no `<!--` in it is
    // line-start-anchored. Flip that `false` to `true` and the ` <!--` below
    // looks anchored (offset 1, only spaces before it), the mask runs to the
    // next `-->` in the file, `## v0.20.11` disappears and this exits 0 — the
    // fail-open the `allowMultiline` parameter exists to prevent. Per CommonMark
    // the whole line is the HTML block's END-CONDITION line, i.e. raw HTML, so
    // nothing in it opens anything either way.
    const s = fixture(
      "changelog-overlap-tail-",
      ["", "<!--", "reviewer note", "--> <!-- and a bare opener in the tail"],
      LATER_COMMENT,
    ).checkStreams(MERGE_GROUP);
    expect(s.code).toBe(1);
    expect(`${s.stdout}${s.stderr}`).toContain("ALREADY-RELEASED");
    expect(`${s.stdout}${s.stderr}`).toContain("## v0.20.11");
  });
});

describe("check-changelog-entry — a fence or comment under a list item is scoped to that item", () => {
  // Round 5 of the same fail-open class. Both multi-line openers are recognised
  // at up to 3 spaces of indent ANYWHERE in the document, with no notion of the
  // block CONTAINER they sit in. CommonMark scopes a fence or HTML block opened
  // inside a list item TO that list item: a column-0 line ends the list, ends
  // the block, and is a real heading. A container-blind masker keeps the block
  // open at document level and blanks straight through it.
  //
  // It is the container, not the indent — remove the bullet and the two agree,
  // because a doc-level `  ```yaml` left unclosed runs to EOF in CommonMark too
  // (pinned as a fail-CLOSED row in the differential battery).
  //
  // This shape is the file's own house style: the real CHANGELOG.md already
  // ships an entry whose example block is indented under its bullet. Measured on
  // it at this PR's previous head, one such prose block took the parse from 429
  // sections to 179 — 250 of 429 released headings erased — and because a
  // column-0 fence further down eventually closed the runaway fence,
  // `unclosedFenceLine` stayed NULL and the round-3/4 WARN backstop never fired.
  // Silent OK, exit 0, on a genuinely buried entry.

  /** As the `<!-->` block's fixture: prose spliced into Unreleased, buried entry at the end. */
  function fixture(prefix: string, prose: string[], trailer: string[] = []): Fixture {
    const BASE = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "<!-- staging area; entries land here per-PR -->",
      "",
      "- **Earlier entry (#0):** already staged.",
      ...prose,
      "",
      "## v0.20.11 — a released section",
      "",
      "- **Something shipped (#1):** prose.",
      "",
      ...trailer,
    ].join("\n");
    const f = makeFixture(prefix, BASE);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    f.writeFile(
      "CHANGELOG.md",
      BASE.replace(
        "- **Something shipped (#1):** prose.\n",
        "- **Something shipped (#1):** prose.\n- **BURIED ENTRY (#2):** appended under the RELEASED heading.\n",
      ),
    );
    f.commit("feat: ship code and bury the entry under a released heading");
    return f;
  }

  const MERGE_GROUP = { GITHUB_EVENT_NAME: "merge_group", CHANGELOG_BASE: "main" };
  // A column-0 fence further down the file, as the real CHANGELOG.md carries 30+
  // of. It is what CLOSES a runaway container fence, so not even the
  // unclosed-fence WARN fires — the silent half of this fail-open.
  const LATER_FENCE = ["```console", "$ pasted transcript", "```", ""];
  // Same job for the comment variant.
  const LATER_COMMENT = ["<!-- reviewer note: keep until the next cut -->", ""];

  // NON-VACUITY, structural: control and attacks are the SAME fixture but for
  // the prose block, and are asserted to differ in exit code and message.
  it("control: the buried entry FAILs with no container block in prose", () => {
    const s = fixture("changelog-container-control-", [], LATER_FENCE).checkStreams(MERGE_GROUP);
    expect(s.code).toBe(1);
    expect(`${s.stdout}${s.stderr}`).toContain("ALREADY-RELEASED");
    expect(`${s.stdout}${s.stderr}`).toContain("BURIED ENTRY (#2)");
  });

  it("attack: a fence indented under a bullet must NOT mask the released heading below", () => {
    // Mutation-proven: widen the fence opener back to `/^ {0,3}(...)/` without
    // the container rule and this run is exit 0, "OK — no entry added under a
    // released section", with NO WARN, because `## v0.20.11` and the buried
    // entry are both inside a fence the guard thinks is still open.
    const s = fixture(
      "changelog-container-fence-",
      ["- an entry whose example block is indented under the bullet:", "", "  ```yaml", "  key: value"],
      LATER_FENCE,
    ).checkStreams(MERGE_GROUP);
    expect(s.code).toBe(1);
    expect(`${s.stdout}${s.stderr}`).toContain("ALREADY-RELEASED");
    expect(`${s.stdout}${s.stderr}`).toContain("BURIED ENTRY (#2)");
    expect(`${s.stdout}${s.stderr}`).toContain("## v0.20.11");
  });

  it("attack: a comment indented under a bullet must NOT mask the released heading below", () => {
    // The same container rule for HTML block type 2. Without it the `  <!--`
    // runs to the trailer's `-->`, taking `## v0.20.11` with it, and
    // `unclosedCommentLine` stays null so the WARN backstop is silent too.
    const s = fixture(
      "changelog-container-comment-",
      ["- an entry with a note tucked under it:", "  <!--"],
      LATER_COMMENT,
    ).checkStreams(MERGE_GROUP);
    expect(s.code).toBe(1);
    expect(`${s.stdout}${s.stderr}`).toContain("ALREADY-RELEASED");
    expect(`${s.stdout}${s.stderr}`).toContain("BURIED ENTRY (#2)");
    expect(`${s.stdout}${s.stderr}`).toContain("## v0.20.11");
  });

  it("does NOT over-correct: a column-0 `<!--` closed by a later `-->` is still comment body", () => {
    // The other direction, and the one this fix must not break. A line-start
    // comment at column 0 is CommonMark-correct comment body all the way to its
    // `-->`, so a `## ` inside it is commentary, not a section — and an entry
    // appended after it is ordinary Unreleased growth, silently OK. Anchor the
    // container rule at the wrong place (e.g. end a comment at ANY column-0
    // line) and this reds with a phantom `## v9.9.9` section.
    const COMMENTED = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "<!--",
      "## v9.9.9 — a heading inside a real comment, not a section",
      "reviewer note: keep this block until the next cut",
      "-->",
      "",
      "- **Earlier entry (#0):** already staged.",
      "",
      "## v0.20.11 — a released section",
      "",
      "- **Something shipped (#1):** prose.",
      "",
    ].join("\n");
    const f = makeFixture("changelog-container-nofix-", COMMENTED);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    f.writeFile(
      "CHANGELOG.md",
      COMMENTED.replace(
        "- **Earlier entry (#0):** already staged.\n",
        "- **Earlier entry (#0):** already staged.\n- **Branch entry (#2):** appended under Unreleased.\n",
      ),
    );
    f.commit("feat: ship code and stage an entry below a real HTML comment");

    const s = f.checkStreams();
    expect(s.code).toBe(0);
    expect(`${s.stdout}${s.stderr}`).toContain("## Unreleased grew");
    expect(`${s.stdout}${s.stderr}`).not.toContain("ALREADY-RELEASED");
    expect(`${s.stdout}${s.stderr}`).not.toContain("WARN");
    expect(`${s.stdout}${s.stderr}`).not.toContain("v9.9.9");
  });

  it("a BLANK line does not end a container block — fence content stays code", () => {
    // The container rule keys on a DEDENT, and a blank line is not one: a blank
    // line is fence content, and does not end an HTML block type 2 either. Drop
    // the `line.trim() !== ''` guard and a blank line (indent 0) dedents every
    // indented block, so the rest of this pasted transcript stops being masked
    // — and RULE 1 then counts a line of console output as a staged entry,
    // reporting "## Unreleased grew" for a PR that staged nothing. Fail-OPEN on
    // the growth rule, so it is pinned by outcome here: with the guard intact
    // this shippable PR correctly reds for having no entry.
    const BASE = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "<!-- staging area; entries land here per-PR -->",
      "",
      "- **Earlier entry (#0):** with a pasted transcript:",
      "",
      "  ```console",
      "  $ switchroom doctor",
      "  ok",
      "",
      "  $ switchroom status",
      "  ```",
      "",
      "## v0.20.11 — a released section",
      "",
      "- **Something shipped (#1):** prose.",
      "",
    ].join("\n");
    const f = makeFixture("changelog-container-blankline-", BASE);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    f.writeFile(
      "CHANGELOG.md",
      BASE.replace("  $ switchroom status\n", "  $ switchroom status\n  running\n"),
    );
    f.commit("feat: ship code and only extend a pasted transcript");

    const r = f.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("check-changelog-entry: FAIL");
    expect(r.out).toContain("src/feature.ts");
    expect(r.out).not.toContain("## Unreleased grew");
  });

  it("a dedented closer is CLOSING punctuation, not a staged entry", () => {
    // The closer is checked BEFORE the dedent rule on purpose: CommonMark lets a
    // closing fence be indented LESS than its opener, so a column-0 ``` under an
    // indented opener is that fence's own closer. Check the dedent first and the
    // line stops being fence punctuation — it survives masking as literal text,
    // and RULE 1 counts one line of ``` as a staged changelog entry. This PR
    // stages no entry at all, so the only correct verdict is a red.
    const BASE = [
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
    const f = makeFixture("changelog-container-closer-", BASE);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    f.writeFile(
      "CHANGELOG.md",
      BASE.replace(
        "<!-- staging area; entries land here per-PR -->\n",
        "<!-- staging area; entries land here per-PR -->\n\n  ```yaml\n  key: value\n```\n",
      ),
    );
    f.commit("feat: ship code and paste a config block, staging no entry");

    const r = f.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("check-changelog-entry: FAIL");
    expect(r.out).not.toContain("## Unreleased grew");
  });

  it("does NOT over-correct: a fence under a bullet that CLOSES still hides its `## ` line", () => {
    // The house style, written correctly: the closer sits at the opener's own
    // indent, so the block never dedents and the container rule never fires. A
    // `## ` inside it must stay code — read it as a heading and every later PR
    // appending to `## Unreleased` reds against a phantom released section.
    const BASE = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "<!-- staging area; entries land here per-PR -->",
      "",
      "- **Earlier entry (#0):** shows the release rename:",
      "",
      "  ```console",
      "  ## v9.9.9 — pasted release heading, not a section",
      "  ```",
      "",
      "## v0.20.11 — a released section",
      "",
      "- **Something shipped (#1):** prose.",
      "",
    ].join("\n");
    const f = makeFixture("changelog-container-closed-fence-", BASE);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    f.writeFile(
      "CHANGELOG.md",
      BASE.replace(
        "  ```\n",
        "  ```\n\n- **Branch entry (#2):** appended under Unreleased, below the block.\n",
      ),
    );
    f.commit("feat: ship code and stage an entry below an indented fenced block");

    const s = f.checkStreams();
    expect(s.code).toBe(0);
    expect(`${s.stdout}${s.stderr}`).toContain("## Unreleased grew");
    expect(`${s.stdout}${s.stderr}`).not.toContain("ALREADY-RELEASED");
    expect(`${s.stdout}${s.stderr}`).not.toContain("WARN");

    // …and the block's own lines are NOT entries. A `## ` heading indented
    // inside a fence is invisible to the column-0 `parseSections` either way, so
    // the observable claim is the entry count: decline to open the indented
    // fence and this pasted release heading becomes a staged changelog entry,
    // turning a PR that staged nothing into an OK.
    const BLOCK = [
      "  ```console",
      "  ## v9.9.9 — pasted release heading, not a section",
      "  ```",
      "",
    ].join("\n");
    const BASE_NO_BLOCK = BASE.replace(`${BLOCK}\n`, "");
    expect(BASE_NO_BLOCK).not.toContain("```");
    const g = makeFixture("changelog-container-closed-fence-only-", BASE_NO_BLOCK);
    g.writeFile("src/feature.ts", "export const feature = 3;\n");
    g.writeFile("CHANGELOG.md", BASE);
    g.commit("feat: ship code and only paste a transcript into Unreleased");

    const only = g.check();
    expect(only.code).toBe(1);
    expect(only.out).not.toContain("## Unreleased grew");
  });
});

describe("check-changelog-entry — a `## ` heading is recognised at column 0 only", () => {
  // `parseSections` and `extractUnreleasedEntries` must agree on what a heading
  // is, and both anchor at column 0 rather than honouring CommonMark's ≤3-space
  // tolerance. Both directions of that choice are pinned here.

  it("an indented `## Unreleased` inside a released section does not un-release it", () => {
    // The fail-OPEN that indent tolerance in `parseSections` would open: a list
    // line reading `   ## Unreleased` *inside* `## v0.20.11` would start a new,
    // NON-released section, and every entry added below it — the rest of the
    // file — would stop being placement-checked. Loosen the regex to
    // `/^ {0,3}##\s/` and this run flips to exit 0.
    const BASE = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "- **Earlier entry (#0):** already staged.",
      "",
      "## v0.20.11 — a released section",
      "",
      "- **Something shipped (#1):** prose. To restore the staging area, add",
      "   ## Unreleased",
      "  back above the newest release.",
      "",
    ].join("\n");
    const f = makeFixture("changelog-indent-heading-", BASE);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    f.writeFile("CHANGELOG.md", `${BASE}- **BURIED ENTRY (#2):** below the indented line.\n`);
    f.commit("feat: ship code and bury the entry under a released heading");

    const r = f.check({ GITHUB_EVENT_NAME: "merge_group", CHANGELOG_BASE: "main" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("ALREADY-RELEASED");
    expect(r.out).toContain("BURIED ENTRY (#2)");
    expect(r.out).toContain("## v0.20.11");
  });

  it("an indented `## ` inside Unreleased does not TRUNCATE the section", () => {
    // The third column-0 site, and the only one that had no outcome test: the
    // section-END scan in `extractUnreleasedEntries`. Loosen it to `/^\s*##\s/`
    // and the indented prose line below ends `## Unreleased` early, so the entry
    // beneath it stops counting as growth and this shippable PR reds with
    // "adds no new entry under `## Unreleased`" — fail-CLOSED, but a false FAIL
    // on a PR that did exactly what the guard asked. Column 0 keeps the section
    // END and the section START agreeing on what a heading is.
    const BASE = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "- **Earlier entry (#0):** to cut a release, rename the header:",
      "  ## v0.20.12 — the next cut",
      "",
      "## v0.20.11 — a released section",
      "",
      "- **Something shipped (#1):** prose.",
      "",
    ].join("\n");
    const f = makeFixture("changelog-indent-heading-truncate-", BASE);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    f.writeFile(
      "CHANGELOG.md",
      BASE.replace(
        "  ## v0.20.12 — the next cut\n",
        "  ## v0.20.12 — the next cut\n- **Branch entry (#2):** staged below the indented line.\n",
      ),
    );
    f.commit("feat: ship code and stage an entry below an indented pseudo-heading");

    const r = f.check();
    expect(r.code).toBe(0);
    expect(r.out).toContain("## Unreleased grew");
    expect(r.out).not.toContain("check-changelog-entry: FAIL");
  });

  it("a 4-space-indented `## Unreleased` is not a staging section for RULE 1 either", () => {
    // The consistency half. 4 spaces is an indented CODE block to CommonMark and
    // invisible to `parseSections`, so RULE 1 must not credit growth under it —
    // which the old `.trim()`-based finder did, passing this shippable PR (exit
    // 0, "## Unreleased grew") while RULE 2 saw a file with no staging section.
    const BASE = [
      "# Changelog",
      "",
      "    ## Unreleased",
      "",
      "## v0.20.11 — a released section",
      "",
      "- **Something shipped (#1):** prose.",
      "",
    ].join("\n");
    const f = makeFixture("changelog-indent4-unreleased-", BASE);
    f.writeFile("src/feature.ts", "export const feature = 3;\n");
    f.writeFile(
      "CHANGELOG.md",
      BASE.replace("    ## Unreleased\n", "    ## Unreleased\n\n    - **Branch entry (#2):** staged in a code block.\n"),
    );
    f.commit("feat: ship code and stage an entry under an indented pseudo-header");

    const r = f.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("check-changelog-entry: FAIL");
    expect(r.out).toContain("src/feature.ts");
    expect(r.out).not.toContain("## Unreleased grew");
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

    // Both shapes: the variable absent from the environment entirely, and the
    // GitHub-Actions shape where `${{ github.event.merge_group.base_sha }}`
    // interpolates to the empty string off a queue ref.
    for (const CHANGELOG_BASE of [undefined, ""]) {
      const r = f.check({ GITHUB_EVENT_NAME: "merge_group", CHANGELOG_BASE });
      expect(r.code).toBe(1);
      expect(r.out).toContain("merge_group ran with no base ref");
    }
  });

  it("does NOT apply the authoritative-base rule off the queue: $CHANGELOG_BASE unset still enforces", () => {
    // The mirror of the two above, and the one that would break a legitimate PR
    // rather than let a bad one through. On `pull_request` the guard has no
    // authoritative base to be handed, so it MUST fall through its candidate
    // cascade (origin/main → main) and keep enforcing. If the merge_group
    // strictness ever leaks into this path — `if (!env.CHANGELOG_BASE) return
    // {error:'missing-base'}` hoisted out of the `authoritativeBase` branch, or
    // the `'main'` tail dropped from the candidate list — this run degrades into
    // a vacuous SKIP and RULE 1 stops gating anything at all.
    //
    // `CHANGELOG_BASE: undefined` here is genuinely unset, not empty-string:
    // `makeFixture` deletes it from the inherited env and `check()` drops
    // undefined-valued keys, so nothing reaches the child.
    const f = makeFixture("changelog-cascade-unset-base-");
    f.writeFile("src/feature.ts", "export const feature = 2;\n");
    f.commit("feat: ship a feature but forget the changelog");

    const r = f.check({ CHANGELOG_BASE: undefined });
    expect(r.code).toBe(1);
    expect(r.out).toContain("check-changelog-entry: FAIL");
    expect(r.out).toContain("src/feature.ts");
    // Proof the cascade actually RESOLVED a base rather than passing vacuously:
    // the only ways out without one are a SKIP (exit 0) or the merge_group
    // missing-base FAIL, and this is neither.
    expect(r.out).not.toContain("SKIP");
    expect(r.out).not.toContain("no base ref");
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
