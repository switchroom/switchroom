/**
 * Outcome tests for `scripts/gen-changelog-entry.mjs` — the author-side
 * complement to `check-changelog-entry.mjs`.
 *
 * The guarantee under test is "given a shippable PR with no staged changelog
 * note, the helper derives one from the PR title / newest conventional commit
 * and writes it as a NEW `changelog.d/` fragment file — idempotently, never
 * touching CHANGELOG.md, and never when an escape hatch is set". Every case
 * builds a REAL git repo with REAL commits and runs the REAL script as a
 * subprocess, then reads the written fragment back and asserts on its path and
 * content — not on a helper's return value.
 *
 * CHANGELOG.md must stay byte-identical on EVERY path, including the write
 * path: the fragment model exists precisely so two in-flight PRs never edit
 * the same file, and a generator that still wrote CHANGELOG.md would silently
 * reintroduce the merge-conflict class (#4678→#4679, #4679→#4712, #4678→#4712
 * were three queue ejections in one day).
 *
 * Non-vacuity: the write cases assert the exact derived fragment NAME
 * (`<pr>-<slug>.<type>.md`) and bullet text; they fail if derivation is wrong
 * or a no-op. The agreement case feeds the generator's output to the REAL
 * check script and asserts it passes — writer and checker must agree on what
 * counts as a staged note (and its red baseline proves the pass comes from the
 * fragment, not from the fixture). The idempotency cases run the script TWICE
 * and assert exactly one fragment exists after both. The escape-hatch cases
 * assert nothing was written at all.
 */
import { describe, expect, it, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const GEN = join(repoRoot, "scripts", "gen-changelog-entry.mjs");
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
  writeFile: (rel: string, body: string) => void;
  commit: (message: string) => string;
  readChangelog: () => string;
  /** Fragment file names under changelog.d/ (empty when the dir is absent). */
  listFragments: () => string[];
  readFragment: (name: string) => string;
  /**
   * Run git inside the fixture under its HERMETIC env (pinned identity, no
   * ambient `~/.gitconfig`). Every git call a test makes MUST go through this:
   * a bare `execFileSync("git", ...)` inherits the ambient environment, and a
   * CI runner has no `user.name` / `user.email`.
   */
  git: (args: string[]) => string;
  /** Run the real generator over `main...HEAD`; returns exit code + output. */
  gen: (extraArgs?: string[], extraEnv?: Record<string, string>) => { code: number; out: string };
  /** Run the real GUARD over `main...HEAD` — the writer/checker agreement probe. */
  check: () => { code: number; out: string };
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
  delete env.GITHUB_EVENT_NAME;
  delete env.GITHUB_BASE_REF;
  delete env.CHANGELOG_PR_BODY;
  delete env.CHANGELOG_PR_LABELS;
  delete env.CHANGELOG_PR_TITLE;
  delete env.CHANGELOG_PR_NUMBER;
  delete env.CHANGELOG_BASE;
  // The temp repo has no remote, so `resolvePrNumber`'s `gh pr view` fallback
  // errors out to null — the tests pin the number via --pr only. No PATH games
  // needed (git must stay resolvable).

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
  git(["checkout", "-q", "-b", "work"]);

  return {
    dir,
    writeFile,
    commit(message) {
      git(["add", "-A"]);
      git(["commit", "-q", "-m", message]);
      return git(["rev-parse", "HEAD"]).trim();
    },
    git,
    readChangelog() {
      return readFileSync(join(dir, "CHANGELOG.md"), "utf-8");
    },
    listFragments() {
      const fragDir = join(dir, "changelog.d");
      return existsSync(fragDir) ? readdirSync(fragDir).sort() : [];
    },
    readFragment(name: string) {
      return readFileSync(join(dir, "changelog.d", name), "utf-8");
    },
    gen(extraArgs = [], extraEnv = {}) {
      const r = spawnSync(process.execPath, [GEN, "--base", "main", ...extraArgs], {
        cwd: dir,
        encoding: "utf-8",
        env: { ...env, ...extraEnv } as NodeJS.ProcessEnv,
      });
      return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
    check() {
      const r = spawnSync(process.execPath, [CHECK], {
        cwd: dir,
        encoding: "utf-8",
        env: { ...env, CHANGELOG_BASE: "main" } as NodeJS.ProcessEnv,
      });
      return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
  };
}

afterAll(() => {
  for (const d of scratchRoots) rmSync(d, { recursive: true, force: true });
});

describe("gen-changelog-entry — derives a fragment from the conventional-commit title", () => {
  it("writes <pr>-<slug>.<type>.md with a scoped bullet and the #PR suffix", () => {
    const f = makeFixture("gen-feat-");
    f.writeFile("src/memory.ts", "export const m = 2;\n");
    f.commit("fix(memory): stop double-counting recalls");

    const before = f.readChangelog();
    const r = f.gen(["--pr", "4500"]);
    expect(r.code).toBe(0);
    expect(f.listFragments()).toEqual(["4500-stop-double-counting-recalls.fix.md"]);
    expect(f.readFragment("4500-stop-double-counting-recalls.fix.md")).toBe(
      "- **memory: stop double-counting recalls (#4500)**\n",
    );
    // The fragment model's core property: CHANGELOG.md is never touched.
    expect(f.readChangelog()).toBe(before);
  });

  it("prefers an explicit --title over the commit subject", () => {
    const f = makeFixture("gen-title-");
    f.writeFile("src/feature.ts", "export const x = 1;\n");
    f.commit("wip: messy local subject");

    const r = f.gen(["--pr", "7", "--title", "feat(cli): add a shiny verb"]);
    expect(r.code).toBe(0);
    expect(f.listFragments()).toEqual(["7-add-a-shiny-verb.feat.md"]);
    expect(f.readFragment("7-add-a-shiny-verb.feat.md")).toBe("- **cli: add a shiny verb (#7)**\n");
  });

  it("falls back to `.other.md` and a plain bullet for a non-conventional title", () => {
    const f = makeFixture("gen-plain-");
    f.writeFile("src/thing.ts", "export const t = 1;\n");
    f.commit("just did some stuff");

    const r = f.gen(); // no --pr
    expect(r.code).toBe(0);
    expect(f.listFragments()).toEqual(["just-did-some-stuff.other.md"]);
    const body = f.readFragment("just-did-some-stuff.other.md");
    expect(body).toBe("- **just did some stuff**\n");
    expect(body).not.toContain("(#");
  });

  it("marks a breaking change", () => {
    const f = makeFixture("gen-breaking-");
    f.writeFile("src/api.ts", "export const a = 1;\n");
    f.commit("feat(config)!: drop the legacy overlay");

    const r = f.gen(["--pr", "99"]);
    expect(r.code).toBe(0);
    expect(f.readFragment("99-drop-the-legacy-overlay.feat.md")).toBe(
      "- **BREAKING** **config: drop the legacy overlay (#99)**\n",
    );
  });
});

describe("gen-changelog-entry — the writer and the checker agree on what is staged", () => {
  it("the guard passes a shippable PR whose only note is the generated fragment", () => {
    // Agreement asserted through the REAL check script, not either script's
    // internals: the property is that gen's output satisfies check's rule.
    const f = makeFixture("gen-agree-");
    f.writeFile("src/feature.ts", "export const x = 1;\n");
    f.commit("feat(cli): add a verb");

    // Red baseline: without the fragment the guard fails this PR, so the
    // green below is attributable to the fragment and nothing else.
    expect(f.check().code).toBe(1);

    const r = f.gen(["--pr", "42"]);
    expect(r.code).toBe(0);
    f.commit("chore: stage changelog fragment");

    const after = f.check();
    expect(after.code).toBe(0);
    expect(after.out).toContain("changelog fragment staged");
  });
});

describe("gen-changelog-entry — idempotency", () => {
  it("running twice (with a commit in between) leaves exactly one fragment", () => {
    const f = makeFixture("gen-idem-");
    f.writeFile("src/feature.ts", "export const x = 1;\n");
    f.commit("feat(cli): add a verb");

    const first = f.gen(["--pr", "42"]);
    expect(first.code).toBe(0);
    expect(f.listFragments()).toHaveLength(1);
    f.commit("chore: stage changelog fragment");

    const second = f.gen(["--pr", "42"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("no change");
    expect(f.listFragments()).toHaveLength(1);
  });

  it("running twice WITHOUT committing in between still writes only one fragment", () => {
    const f = makeFixture("gen-idem-nocommit-");
    f.writeFile("src/feature.ts", "export const x = 1;\n");
    f.commit("feat(cli): add a verb");

    const first = f.gen(["--pr", "42"]);
    expect(first.code).toBe(0);
    // No commit here — the fragment is an UNTRACKED file the second run must see.
    const second = f.gen(["--pr", "42"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("no change");
    expect(f.listFragments()).toHaveLength(1);
  });

  it("does not write when the author already staged an entry under ## Unreleased", () => {
    // The legacy path still counts as staged: a hand-written Unreleased entry
    // must not gain a duplicate fragment.
    const f = makeFixture("gen-respect-");
    f.writeFile("src/feature.ts", "export const x = 1;\n");
    f.writeFile(
      "CHANGELOG.md",
      SEED_CHANGELOG.replace(
        "<!-- staging area; entries land here per-PR -->\n",
        "<!-- staging area; entries land here per-PR -->\n\n- **Author wrote this (#3)**\n",
      ),
    );
    f.commit("feat(cli): add a verb and hand-write the note");

    const r = f.gen(["--pr", "3"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already has a new entry");
    expect(f.listFragments()).toEqual([]);
  });
});

describe("gen-changelog-entry — escape hatches opt out of generation", () => {
  it("writes nothing when the no-changelog label is present", () => {
    const f = makeFixture("gen-label-");
    f.writeFile("src/chore.ts", "export const c = 1;\n");
    f.commit("feat(cli): a change");

    const before = f.readChangelog();
    const r = f.gen(["--pr", "5"], { CHANGELOG_PR_LABELS: "agent:klanker no-changelog" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("escape hatch");
    expect(f.listFragments()).toEqual([]);
    expect(f.readChangelog()).toBe(before);
  });

  it("writes nothing when a [skip changelog] token is on its own line in a commit", () => {
    const f = makeFixture("gen-token-");
    f.writeFile("src/chore.ts", "export const c = 1;\n");
    f.commit("chore: rename a var\n\n[skip changelog]");

    const r = f.gen(["--pr", "5"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("escape hatch");
    expect(f.listFragments()).toEqual([]);
  });

  it("does NOT self-trip: a body that merely mentions the token still generates", () => {
    const f = makeFixture("gen-selftrip-");
    f.writeFile("src/feature.ts", "export const x = 1;\n");
    f.commit("feat(cli): document the hatch");

    const r = f.gen(["--pr", "6"], {
      CHANGELOG_PR_BODY: "This PR adds support for a `[skip changelog]` token.",
    });
    expect(r.code).toBe(0);
    expect(f.listFragments()).toEqual(["6-document-the-hatch.feat.md"]);
  });
});

describe("gen-changelog-entry — no-ops that must never write", () => {
  it("writes nothing for a docs-only change (no shippable paths)", () => {
    const f = makeFixture("gen-docs-");
    f.writeFile("docs/guide.md", "# guide\n");
    f.commit("docs: update the guide");

    const r = f.gen(["--pr", "8"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no shippable code changed");
    expect(f.listFragments()).toEqual([]);
  });

  it("skips on a merge_group event", () => {
    const f = makeFixture("gen-mg-");
    f.writeFile("src/feature.ts", "export const x = 1;\n");
    f.commit("feat(cli): add a verb");

    const r = f.gen(["--pr", "9"], { GITHUB_EVENT_NAME: "merge_group" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("merge_group");
    expect(f.listFragments()).toEqual([]);
  });

  it("skips cleanly when no base ref resolves", () => {
    // `resolveRange` is shared with check-changelog-entry.mjs and reports
    // failure as an `{error}` OBJECT, not null — a truthiness test here would
    // sail past the guard and then diff against `undefined..HEAD`, so pin the
    // skip. Rename `main` away so no candidate in the cascade resolves.
    const f = makeFixture("gen-nobase-");
    f.writeFile("src/feature.ts", "export const x = 1;\n");
    f.commit("feat(cli): add a verb");
    f.git(["branch", "-m", "main", "detached-away"]);

    const r = f.gen(["--pr", "11"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no base ref to diff against");
    expect(f.listFragments()).toEqual([]);
  });

  it("--dry-run prints the fragment path + entry but writes nothing", () => {
    const f = makeFixture("gen-dry-");
    f.writeFile("src/feature.ts", "export const x = 1;\n");
    f.commit("feat(cli): add a verb");

    const r = f.gen(["--pr", "10", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DRY RUN");
    expect(r.out).toContain("changelog.d/10-add-a-verb.feat.md");
    expect(r.out).toContain("(#10)");
    expect(f.listFragments()).toEqual([]);
  });
});
