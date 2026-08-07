/**
 * Outcome tests for `scripts/gen-changelog-entry.mjs` — the author-side
 * complement to `check-changelog-entry.mjs`.
 *
 * The guarantee under test is "given a shippable PR with no staged
 * `## Unreleased` entry, the helper derives one from the PR title / newest
 * conventional commit and writes it under the header — idempotently, and never
 * when an escape hatch is set". Every case builds a REAL git repo with REAL
 * commits and runs the REAL script as a subprocess, then reads the written
 * CHANGELOG.md back and asserts on its content — not on a helper's return value.
 *
 * Non-vacuity: the write cases assert the exact derived bullet text (type/scope
 * parsing + `(#n)` suffix) landed under `## Unreleased`; they fail if derivation
 * is wrong or a no-op. The idempotency case runs the script TWICE and asserts
 * the second run adds nothing (a naive append would double it). The escape-hatch
 * cases assert the file is byte-unchanged — they fail if a hatch stops opting
 * out of generation.
 */
import { describe, expect, it, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const GEN = join(repoRoot, "scripts", "gen-changelog-entry.mjs");

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
  /** Run the real generator over `main...HEAD`; returns exit code + output. */
  gen: (extraArgs?: string[], extraEnv?: Record<string, string>) => { code: number; out: string };
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
    readChangelog() {
      return readFileSync(join(dir, "CHANGELOG.md"), "utf-8");
    },
    gen(extraArgs = [], extraEnv = {}) {
      const r = spawnSync(process.execPath, [GEN, "--base", "main", ...extraArgs], {
        cwd: dir,
        encoding: "utf-8",
        env: { ...env, ...extraEnv } as NodeJS.ProcessEnv,
      });
      return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
  };
}

/** Return only the lines under `## Unreleased`, up to the next `## ` header. */
function unreleasedBlock(changelog: string): string {
  const lines = changelog.split("\n");
  let i = lines.findIndex((l) => /^##\s+unreleased\b/i.test(l.trim()));
  if (i === -1) return "";
  const out: string[] = [];
  for (i += 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

afterAll(() => {
  for (const d of scratchRoots) rmSync(d, { recursive: true, force: true });
});

describe("gen-changelog-entry — derives an entry from the conventional-commit title", () => {
  it("parses type+scope and writes a scoped bullet under a category with the #PR suffix", () => {
    const f = makeFixture("gen-feat-");
    f.writeFile("src/memory.ts", "export const m = 2;\n");
    f.commit("fix(memory): stop double-counting recalls");

    const r = f.gen(["--pr", "4500"]);
    expect(r.code).toBe(0);
    const block = unreleasedBlock(f.readChangelog());
    // fix → "Bug fixes" category; scope shown inline; #PR suffix present.
    expect(block).toContain("### Bug fixes");
    expect(block).toContain("- **memory: stop double-counting recalls (#4500)**");
  });

  it("prefers an explicit --title over the commit subject", () => {
    const f = makeFixture("gen-title-");
    f.writeFile("src/feature.ts", "export const x = 1;\n");
    f.commit("wip: messy local subject");

    const r = f.gen(["--pr", "7", "--title", "feat(cli): add a shiny verb"]);
    expect(r.code).toBe(0);
    const block = unreleasedBlock(f.readChangelog());
    expect(block).toContain("### Features");
    expect(block).toContain("- **cli: add a shiny verb (#7)**");
  });

  it("falls back to a plain bullet (no category, no suffix) for a non-conventional title", () => {
    const f = makeFixture("gen-plain-");
    f.writeFile("src/thing.ts", "export const t = 1;\n");
    f.commit("just did some stuff");

    const r = f.gen(); // no --pr
    expect(r.code).toBe(0);
    const block = unreleasedBlock(f.readChangelog());
    expect(block).toContain("- **just did some stuff**");
    expect(block).not.toContain("(#");
    expect(block).not.toContain("###");
  });

  it("marks a breaking change", () => {
    const f = makeFixture("gen-breaking-");
    f.writeFile("src/api.ts", "export const a = 1;\n");
    f.commit("feat(config)!: drop the legacy overlay");

    const r = f.gen(["--pr", "99"]);
    expect(r.code).toBe(0);
    expect(unreleasedBlock(f.readChangelog())).toContain(
      "- **BREAKING** **config: drop the legacy overlay (#99)**",
    );
  });
});

describe("gen-changelog-entry — idempotency", () => {
  it("running twice does not double-add the entry", () => {
    const f = makeFixture("gen-idem-");
    f.writeFile("src/feature.ts", "export const x = 1;\n");
    f.commit("feat(cli): add a verb");

    const first = f.gen(["--pr", "42"]);
    expect(first.code).toBe(0);
    const afterFirst = f.readChangelog();
    // Commit the generated entry so the SECOND run sees Unreleased has grown.
    f.commit("chore: stage changelog");

    const second = f.gen(["--pr", "42"]);
    expect(second.code).toBe(0);
    const afterSecond = f.readChangelog();

    const count = (s: string) => s.split("add a verb").length - 1;
    expect(count(afterFirst)).toBe(1);
    expect(count(afterSecond)).toBe(1);
    expect(second.out).toContain("no change");
  });

  it("running twice WITHOUT committing in between still does not double-add", () => {
    const f = makeFixture("gen-idem-nocommit-");
    f.writeFile("src/feature.ts", "export const x = 1;\n");
    f.commit("feat(cli): add a verb");

    const first = f.gen(["--pr", "42"]);
    expect(first.code).toBe(0);
    // No commit here — the generated entry is still an uncommitted work-tree edit.
    const second = f.gen(["--pr", "42"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("no change");

    const count = f.readChangelog().split("add a verb").length - 1;
    expect(count).toBe(1);
  });

  it("does not add when the author already staged an entry (respects hand-written)", () => {
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

    const before = f.readChangelog();
    const r = f.gen(["--pr", "3"]);
    expect(r.code).toBe(0);
    expect(f.readChangelog()).toBe(before);
    expect(r.out).toContain("already has a new entry");
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
    expect(f.readChangelog()).toBe(before);
    expect(r.out).toContain("escape hatch");
  });

  it("writes nothing when a [skip changelog] token is on its own line in a commit", () => {
    const f = makeFixture("gen-token-");
    f.writeFile("src/chore.ts", "export const c = 1;\n");
    f.commit("chore: rename a var\n\n[skip changelog]");

    const before = f.readChangelog();
    const r = f.gen(["--pr", "5"]);
    expect(r.code).toBe(0);
    expect(f.readChangelog()).toBe(before);
    expect(r.out).toContain("escape hatch");
  });

  it("does NOT self-trip: a body that merely mentions the token still generates", () => {
    const f = makeFixture("gen-selftrip-");
    f.writeFile("src/feature.ts", "export const x = 1;\n");
    f.commit("feat(cli): document the hatch");

    const r = f.gen(["--pr", "6"], {
      CHANGELOG_PR_BODY: "This PR adds support for a `[skip changelog]` token.",
    });
    expect(r.code).toBe(0);
    expect(unreleasedBlock(f.readChangelog())).toContain("(#6)");
  });
});

describe("gen-changelog-entry — no-ops that must never write", () => {
  it("writes nothing for a docs-only change (no shippable paths)", () => {
    const f = makeFixture("gen-docs-");
    f.writeFile("docs/guide.md", "# guide\n");
    f.commit("docs: update the guide");

    const before = f.readChangelog();
    const r = f.gen(["--pr", "8"]);
    expect(r.code).toBe(0);
    expect(f.readChangelog()).toBe(before);
    expect(r.out).toContain("no shippable code changed");
  });

  it("skips on a merge_group event", () => {
    const f = makeFixture("gen-mg-");
    f.writeFile("src/feature.ts", "export const x = 1;\n");
    f.commit("feat(cli): add a verb");

    const before = f.readChangelog();
    const r = f.gen(["--pr", "9"], { GITHUB_EVENT_NAME: "merge_group" });
    expect(r.code).toBe(0);
    expect(f.readChangelog()).toBe(before);
    expect(r.out).toContain("merge_group");
  });

  it("--dry-run prints the entry but writes nothing", () => {
    const f = makeFixture("gen-dry-");
    f.writeFile("src/feature.ts", "export const x = 1;\n");
    f.commit("feat(cli): add a verb");

    const before = f.readChangelog();
    const r = f.gen(["--pr", "10", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(f.readChangelog()).toBe(before);
    expect(r.out).toContain("DRY RUN");
    expect(r.out).toContain("(#10)");
  });
});
