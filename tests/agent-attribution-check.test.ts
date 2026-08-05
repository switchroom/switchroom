/**
 * Outcome tests for `scripts/check-agent-attribution-trailers.mjs`.
 *
 * The guarantee under test is "CI goes red on an unattributed machine commit
 * and stays green on a human one", so every case here builds a REAL git repo
 * with REAL commits and runs the REAL script as a subprocess, asserting on its
 * exit code — not on the return value of an internal helper.
 *
 * The human-exemption cases are the load-bearing ones: a false positive here
 * blocks a human contributor from committing by hand, which is a worse
 * outcome than the missing attribution the guard exists to catch.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const CHECK = join(repoRoot, "scripts", "check-agent-attribution-trailers.mjs");

/**
 * The guard's rollout cutoff, read out of the guard's own source. Read rather
 * than imported: the guard is a `.mjs` lint script with no type declarations,
 * and `tsc --noEmit` (itself part of `npm run lint`) would reject the import.
 * Reading the literal also means a silent edit to the cutoff shows up here.
 */
const ENFORCEMENT_START = (() => {
  const src = readFileSync(CHECK, "utf-8");
  const m = /ENFORCEMENT_START = Date\.parse\('([^']+)'\)/.exec(src);
  if (!m) throw new Error("could not read ENFORCEMENT_START out of the guard source");
  return Date.parse(m[1]);
})();

const scratchRoots: string[] = [];

/** An instant safely inside the enforcement window. */
const ENFORCED_ISO = new Date(ENFORCEMENT_START + 86_400_000).toISOString();
/** An instant safely before it — the pre-rollout grace window. */
const PRE_ROLLOUT_ISO = new Date(ENFORCEMENT_START - 86_400_000).toISOString();

interface Fixture {
  dir: string;
  /** Commit on the working branch (the "PR"). */
  commit: (message: string, when?: string) => string;
  /** Run the real guard over `main..HEAD`; returns exit code + output. */
  check: (env?: Record<string, string>) => { code: number; out: string };
}

function makeFixture(prefix: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(root);
  const dir = join(root, "repo");
  mkdirSync(dir, { recursive: true });

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  // No hook here on purpose: this fixture writes commit messages verbatim so
  // it can produce the exact shapes the guard must judge, including the
  // "hook never ran" one.
  env.GIT_AUTHOR_NAME = "Operator";
  env.GIT_AUTHOR_EMAIL = "operator@example.test";
  env.GIT_COMMITTER_NAME = "Operator";
  env.GIT_COMMITTER_EMAIL = "operator@example.test";

  const git = (args: string[], extra: Record<string, string> = {}) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf-8",
      env: { ...env, ...extra } as NodeJS.ProcessEnv,
    });

  git(["init", "--quiet", "-b", "main"]);
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "chore: base"]);
  // A local `main` standing in for `origin/main`: the guard's candidate list
  // falls through to plain `main` when no remote is configured.
  git(["checkout", "-q", "-b", "work"]);

  let n = 0;
  return {
    dir,
    commit(message, when = ENFORCED_ISO) {
      n += 1;
      writeFileSync(join(dir, `f${n}.txt`), `${n}\n`);
      git(["add", "-A"]);
      git(["commit", "-q", "-m", message], {
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
      });
      return git(["rev-parse", "HEAD"]).trim();
    },
    check(extraEnv = {}) {
      const r = spawnSync(process.execPath, [CHECK], {
        cwd: dir,
        encoding: "utf-8",
        env: { ...env, AGENT_ATTRIBUTION_BASE: "main", ...extraEnv } as NodeJS.ProcessEnv,
      });
      return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
  };
}

const ATTRIBUTED = [
  "feat(x): attributed work",
  "",
  "Co-authored-by: Claude Opus 5 <noreply@anthropic.com>",
  "Switchroom-Agent: klanker",
  "Switchroom-Model: claude-opus-5",
].join("\n");

const UNATTRIBUTED = [
  "feat(x): the hook did not run",
  "",
  "Co-authored-by: Claude Opus 5 <noreply@anthropic.com>",
].join("\n");

beforeAll(() => () => {
  for (const d of scratchRoots) rmSync(d, { recursive: true, force: true });
});

describe("check-agent-attribution-trailers — red on an unattributed machine commit", () => {
  it("fails when a Claude co-authored commit carries no Switchroom trailers", () => {
    const f = makeFixture("attrchk-red-");
    f.commit(UNATTRIBUTED);

    const r = f.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("check-agent-attribution-trailers: FAIL");
    expect(r.out).toContain("missing `Switchroom-Agent:` trailer");
    expect(r.out).toContain("missing `Switchroom-Model:` trailer");
  });

  it("fails on a HALF-written pair — agent named, model missing", () => {
    // This is the case a `Co-authored-by`-only rule would miss if the model
    // trailer were dropped but Co-authored-by also went absent.
    const f = makeFixture("attrchk-half-");
    f.commit("feat: half a pair\n\nSwitchroom-Agent: klanker");

    const r = f.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("missing `Switchroom-Model:` trailer");
  });

  it("fails on a malformed agent slug rather than accepting any string", () => {
    const f = makeFixture("attrchk-shape-");
    f.commit(
      "feat: bad slug\n\nSwitchroom-Agent: not a slug!\nSwitchroom-Model: claude-opus-5",
    );

    const r = f.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("is not a valid agent slug");
  });

  it("names the offending commit and tells the operator how to fix it", () => {
    const f = makeFixture("attrchk-message-");
    const sha = f.commit(UNATTRIBUTED);

    const r = f.check();
    expect(r.out).toContain(sha.slice(0, 12));
    expect(r.out).toContain("core.hooksPath");
    expect(r.out).toContain("git rebase -i --exec");
  });
});

describe("check-agent-attribution-trailers — green on everything it must not block", () => {
  it("passes an attributed machine commit", () => {
    const f = makeFixture("attrchk-green-");
    f.commit(ATTRIBUTED);

    const r = f.check();
    expect(r.code).toBe(0);
    expect(r.out).toContain("check-agent-attribution-trailers: OK");
  });

  it("passes a hand-written human commit with no machine markers at all", () => {
    // The load-bearing exemption: a human committing from a laptop has no
    // `Co-authored-by: Claude` trailer, so the guard never inspects them.
    const f = makeFixture("attrchk-human-");
    f.commit("docs: fix a typo");
    f.commit("fix: tighten the parser\n\nCloses #123");
    f.commit("chore: bump dep\n\nCo-authored-by: A Human <human@example.test>");

    const r = f.check();
    expect(r.code).toBe(0);
  });

  it("passes an unattributed machine commit made before ENFORCEMENT_START", () => {
    // The rollout grace window: the hook only reaches a container after the
    // agent image is rebuilt and the agent restarted.
    const f = makeFixture("attrchk-grace-");
    f.commit(UNATTRIBUTED, PRE_ROLLOUT_ISO);

    const r = f.check();
    expect(r.code).toBe(0);
    // ...and SAYS so. A bare "0 machine-authored" would read as "nothing here
    // to check", which is the false comfort this guard exists to remove — a
    // reader must be able to tell "clean" apart from "exempted".
    expect(r.out).toMatch(/exempt \(committed before ENFORCEMENT_START/);
  });

  it("SKIPs rather than failing when there is no base ref to diff against", () => {
    // A shallow clone, or a checkout with no `main` / `origin/main`. Blocking
    // a developer because their clone has no base would be a false positive,
    // and CI checks out with fetch-depth: 0 precisely so this path is not
    // taken there.
    const root = mkdtempSync(join(tmpdir(), "attrchk-nobase-"));
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
    delete env.GITHUB_BASE_REF;
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf-8", env: env as NodeJS.ProcessEnv });
    // Branch is `detached-work`, so neither `main` nor `origin/main` exists.
    git(["init", "--quiet", "-b", "detached-work"]);
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", UNATTRIBUTED]);

    const r = spawnSync(process.execPath, [CHECK], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...env, AGENT_ATTRIBUTION_BASE: "refs/heads/does-not-exist" } as NodeJS.ProcessEnv,
    });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("SKIP");
  });

  it("honours the allowlist for a genuinely exempt commit", () => {
    const f = makeFixture("attrchk-allow-");
    const sha = f.commit(UNATTRIBUTED);
    // The guard reads the allowlist relative to its cwd, which is the fixture
    // repo — mirroring how it reads the repo's own allowlist in CI.
    mkdirSync(join(f.dir, "scripts"), { recursive: true });
    writeFileSync(
      join(f.dir, "scripts", "check-agent-attribution-trailers-allowlist.txt"),
      `# upstream patch replayed verbatim\n${sha}\n`,
    );

    const r = f.check();
    expect(r.code).toBe(0);
  });
});

describe("check-agent-attribution-trailers — robust to GitHub squash reparagraphing", () => {
  // GitHub's squash-merge collects `Co-authored-by:` trailers and re-emits
  // them as a separate final paragraph, split by a blank line from the
  // `Switchroom-*` trailers the source commit carried. See #4381's squash
  // bb793cb. Reading only the final paragraph misses the attribution.
  const SQUASH_LAYOUT = [
    "feat(x): work that got squashed",
    "",
    "Closes #4379",
    "",
    "Switchroom-Agent: klanker",
    "Switchroom-Model: claude-opus-4-8",
    "",
    "Co-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
  ].join("\n");

  it("PASSES the GitHub-squash layout — Switchroom-* one paragraph above the Claude co-author", () => {
    const f = makeFixture("attrchk-squash-pass-");
    f.commit(SQUASH_LAYOUT);

    const r = f.check();
    expect(r.code).toBe(0);
    expect(r.out).toContain("check-agent-attribution-trailers: OK");
  });

  it("STILL FAILS a genuinely unattributed squash — Claude co-author, no Switchroom-* anywhere", () => {
    // Nothing to fold: the fix only surfaces attribution that genuinely
    // exists in an adjacent trailer-only paragraph. A bypassed hook that left
    // only the Claude co-author still reds, exactly as before.
    const f = makeFixture("attrchk-squash-fail-");
    f.commit(
      [
        "feat(x): the hook did not run, then got squashed",
        "",
        "Closes #4379",
        "",
        "Co-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
      ].join("\n"),
    );

    const r = f.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("missing `Switchroom-Agent:` trailer");
    expect(r.out).toContain("missing `Switchroom-Model:` trailer");
  });

  it("PASSES a human squash — non-Claude co-author, no Switchroom-* — is never machine-authored", () => {
    const f = makeFixture("attrchk-squash-human-");
    f.commit(
      [
        "fix: human work that got squashed",
        "",
        "Closes #4379",
        "",
        "Co-authored-by: Some Human <human@example.test>",
      ].join("\n"),
    );

    const r = f.check();
    expect(r.code).toBe(0);
  });

  it("FAILS when a prose separator isolates the Switchroom-* trailers from the Claude co-author", () => {
    // A `---------` (or any prose line) between the two trailer paragraphs is
    // NOT what GitHub's squash normaliser produces — it comes from a PR body
    // bleeding into the trailers. Folding deliberately stops at prose, so the
    // Switchroom-* block is isolated and the commit reads as machine-authored
    // (Claude co-author in the final block) but unattributed. This preserves
    // the original "a stray prose line means the hook block was disrupted"
    // detection. Decision recorded in the PR body.
    const f = makeFixture("attrchk-squash-prose-");
    f.commit(
      [
        "feat(x): prose separator between trailer paragraphs",
        "",
        "Switchroom-Agent: klanker",
        "Switchroom-Model: claude-opus-4-8",
        "",
        "---------",
        "",
        "Co-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
      ].join("\n"),
    );

    const r = f.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("missing `Switchroom-Agent:` trailer");
    expect(r.out).toContain("missing `Switchroom-Model:` trailer");
  });

  it("folds across MORE than two consecutive trailer-only paragraphs", () => {
    // Defensive: the run of trailer-only paragraphs is treated as one block
    // however many deep, stopping only at the subject prose.
    const f = makeFixture("attrchk-squash-multi-");
    f.commit(
      [
        "feat(x): deeply reparagraphed",
        "",
        "Switchroom-Agent: klanker",
        "",
        "Switchroom-Model: claude-opus-4-8",
        "",
        "Co-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
      ].join("\n"),
    );

    const r = f.check();
    expect(r.code).toBe(0);
  });
});

describe("check-agent-attribution-trailers — wiring", () => {
  it("is part of `npm run lint`", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
    expect(pkg.scripts.lint).toContain("check-agent-attribution-trailers.mjs");
    expect(pkg.scripts["lint:agent-attribution-trailers"]).toBe(
      "node scripts/check-agent-attribution-trailers.mjs",
    );
  });

  it("runs in CI with full history, or it would silently skip", () => {
    const lintWf = readFileSync(join(repoRoot, ".github", "workflows", "ci-lint.yml"), "utf-8");
    expect(lintWf).toContain("fetch-depth: 0");

    const attrWf = readFileSync(
      join(repoRoot, ".github", "workflows", "agent-attribution.yml"),
      "utf-8",
    );
    expect(attrWf).toContain("fetch-depth: 0");
    expect(attrWf).toContain("node scripts/check-agent-attribution-trailers.mjs");
    expect(attrWf).toContain("node scripts/agent-pr-label.mjs");
    // The merge queue requires every REQUIRED context to report on the queue
    // ref; this workflow is not required, and adding it there could only
    // stall the queue. See .github/MERGE-QUEUE.md.
    expect(/^\s{2}merge_group:/m.test(attrWf)).toBe(false);
  });
});
