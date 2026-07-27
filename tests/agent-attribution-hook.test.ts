/**
 * Outcome tests for the commit-attribution hook.
 *
 * These drive REAL `git commit` in REAL throwaway repos with the REAL
 * `bin/git-agent-attribution-hook.sh` installed exactly the way
 * `docker/Dockerfile.agent` installs it (copied into a hooks dir as
 * `prepare-commit-msg`) and `profiles/_base/start.sh.hbs` activates it
 * (`core.hooksPath`). Every assertion reads the resulting commit back out of
 * `git log`, because "the commit carries the trailer" is the guarantee — not
 * "the shell function was called".
 *
 * NOTE ON /tmp: several of these need to EXECUTE a file from the temp dir, and
 * some dev containers mount /tmp `noexec`. Set an exec-capable `TMPDIR` when
 * running locally (see CLAUDE.md § "Local env noise vs real failures"); GitHub
 * runners are exec-capable by default.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const HOOK_SRC = join(repoRoot, "bin", "git-agent-attribution-hook.sh");

/** Temp roots created by this file, cleaned up at the end. */
const scratchRoots: string[] = [];

function makeScratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(dir);
  return dir;
}

/**
 * Install the hook the way the image does: a dedicated directory whose single
 * entry is named after the hook.
 */
function installHookDir(root: string): string {
  const hooksDir = join(root, "git-hooks");
  mkdirSync(hooksDir, { recursive: true });
  const dest = join(hooksDir, "prepare-commit-msg");
  copyFileSync(HOOK_SRC, dest);
  chmodSync(dest, 0o755);
  return hooksDir;
}

interface RepoOpts {
  /** Env the `git commit` runs under — the agent-container simulation. */
  env?: Record<string, string | undefined>;
  /** Skip `core.hooksPath`, i.e. simulate a container without the hook. */
  withoutHook?: boolean;
}

interface Repo {
  dir: string;
  commit: (message: string, extraArgs?: string[]) => void;
  amend: () => void;
  lastMessage: () => string;
  trailer: (token: string) => string;
}

function makeRepo(prefix: string, opts: RepoOpts = {}): Repo {
  const root = makeScratch(prefix);
  const dir = join(root, "repo");
  mkdirSync(dir, { recursive: true });

  const baseEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  baseEnv.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
  baseEnv.GIT_CONFIG_SYSTEM = "/dev/null";
  // The hook keys off SWITCHROOM_AGENT_NAME. These tests run INSIDE an agent
  // container, where those vars are set for real — delete them explicitly, or
  // the "a human's commit is untouched" cases would silently test nothing.
  delete baseEnv.SWITCHROOM_AGENT_NAME;
  delete baseEnv.SWITCHROOM_SESSION_MODEL;
  delete baseEnv.SWITCHROOM_AGENT_MODEL;
  delete baseEnv.SWITCHROOM_ATTRIBUTION_DISABLE;
  Object.assign(baseEnv, opts.env ?? {});

  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf-8",
      env: baseEnv as NodeJS.ProcessEnv,
    });

  run(["init", "--quiet", "-b", "main"]);
  run(["config", "user.email", "operator@example.test"]);
  run(["config", "user.name", "Operator"]);
  if (!opts.withoutHook) {
    // Global, exactly like start.sh — proving the hook needs no per-repo setup.
    run(["config", "--global", "core.hooksPath", installHookDir(root)]);
  }

  let n = 0;
  return {
    dir,
    commit(message, extraArgs = []) {
      n += 1;
      writeFileSync(join(dir, `f${n}.txt`), `${n}\n`);
      run(["add", "-A"]);
      run(["commit", "-m", message, ...extraArgs]);
    },
    amend() {
      run(["commit", "--amend", "--no-edit"]);
    },
    lastMessage() {
      return run(["log", "-1", "--format=%B"]);
    },
    trailer(token) {
      return run(["log", "-1", `--format=%(trailers:key=${token},valueonly)`]).trim();
    },
  };
}

const AGENT_ENV = {
  SWITCHROOM_AGENT_NAME: "klanker",
  SWITCHROOM_SESSION_MODEL: "claude-opus-5",
};

beforeAll(() => {
  // Fail loudly rather than silently green if the source file went missing.
  expect(existsSync(HOOK_SRC), `${HOOK_SRC} must exist`).toBe(true);
  return () => {
    for (const d of scratchRoots) rmSync(d, { recursive: true, force: true });
  };
});

describe("git-agent-attribution-hook — an agent's commit names its agent and model", () => {
  it("stamps both trailers on a plain `git commit -m` in an agent container", () => {
    const repo = makeRepo("attr-basic-", { env: AGENT_ENV });
    repo.commit("feat(x): do the thing");

    expect(repo.trailer("Switchroom-Agent")).toBe("klanker");
    expect(repo.trailer("Switchroom-Model")).toBe("claude-opus-5");
  });

  it("stamps them even with --no-verify (the reason this is prepare-commit-msg, not commit-msg)", () => {
    // `--no-verify` bypasses pre-commit and commit-msg. If this guarantee were
    // implemented as a commit-msg hook, this test would fail — and agents
    // reach for --no-verify routinely.
    const repo = makeRepo("attr-noverify-", { env: AGENT_ENV });
    repo.commit("chore: bypass hooks", ["--no-verify"]);

    expect(repo.trailer("Switchroom-Agent")).toBe("klanker");
    expect(repo.trailer("Switchroom-Model")).toBe("claude-opus-5");
  });

  it("preserves an existing Co-authored-by trailer instead of replacing it", () => {
    const repo = makeRepo("attr-coauthor-", { env: AGENT_ENV });
    repo.commit(
      "feat(y): keep provenance\n\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>",
    );

    const msg = repo.lastMessage();
    expect(msg).toContain("Co-authored-by: Claude Opus 5 <noreply@anthropic.com>");
    expect(repo.trailer("Switchroom-Agent")).toBe("klanker");
    expect(repo.trailer("Switchroom-Model")).toBe("claude-opus-5");
  });

  it("does not duplicate trailers across an --amend", () => {
    const repo = makeRepo("attr-amend-", { env: AGENT_ENV });
    repo.commit("feat(z): first pass");
    repo.amend();

    const msg = repo.lastMessage();
    expect(msg.match(/Switchroom-Agent:/g)?.length).toBe(1);
    expect(msg.match(/Switchroom-Model:/g)?.length).toBe(1);
  });

  it("falls back to SWITCHROOM_AGENT_MODEL when the session export is absent", () => {
    // The `docker exec` path: container env only, no start.sh export.
    const repo = makeRepo("attr-fallback-", {
      env: { SWITCHROOM_AGENT_NAME: "marko", SWITCHROOM_AGENT_MODEL: "claude-sonnet-5" },
    });
    repo.commit("fix: from a bare docker exec");

    expect(repo.trailer("Switchroom-Agent")).toBe("marko");
    expect(repo.trailer("Switchroom-Model")).toBe("claude-sonnet-5");
  });

  it("prefers the live session model over the static container default", () => {
    const repo = makeRepo("attr-precedence-", {
      env: {
        SWITCHROOM_AGENT_NAME: "marko",
        SWITCHROOM_AGENT_MODEL: "claude-sonnet-5",
        SWITCHROOM_SESSION_MODEL: "claude-opus-5",
      },
    });
    repo.commit("fix: after a /model switch");

    expect(repo.trailer("Switchroom-Model")).toBe("claude-opus-5");
  });

  it("writes `unknown` rather than an empty trailer when no model is resolvable", () => {
    const repo = makeRepo("attr-unknown-", { env: { SWITCHROOM_AGENT_NAME: "klanker" } });
    repo.commit("chore: model env missing");

    expect(repo.trailer("Switchroom-Agent")).toBe("klanker");
    expect(repo.trailer("Switchroom-Model")).toBe("unknown");
  });

  it("sanitizes a hostile agent name into a single safe trailer line", () => {
    const repo = makeRepo("attr-sanitize-", {
      env: { SWITCHROOM_AGENT_NAME: "kl anker\nSwitchroom-Model: forged", SWITCHROOM_SESSION_MODEL: "m" },
    });
    repo.commit("chore: hostile env");

    // The newline must not have created a second, forged trailer.
    expect(repo.trailer("Switchroom-Model")).toBe("m");
    expect(repo.trailer("Switchroom-Agent")).not.toContain("\n");
    expect(repo.trailer("Switchroom-Agent")).not.toContain(" ");
  });
});

describe("git-agent-attribution-hook — a human's commit is untouched", () => {
  it("adds nothing when SWITCHROOM_AGENT_NAME is absent (a laptop)", () => {
    const repo = makeRepo("attr-human-", {});
    repo.commit("docs: hand-written from a laptop");

    const msg = repo.lastMessage();
    expect(msg).not.toContain("Switchroom-Agent");
    expect(msg).not.toContain("Switchroom-Model");
    expect(msg.trim()).toBe("docs: hand-written from a laptop");
  });

  it("honours the SWITCHROOM_ATTRIBUTION_DISABLE escape hatch", () => {
    const repo = makeRepo("attr-optout-", {
      env: { ...AGENT_ENV, SWITCHROOM_ATTRIBUTION_DISABLE: "1" },
    });
    repo.commit("chore: replay an upstream patch verbatim");

    expect(repo.lastMessage()).not.toContain("Switchroom-Agent");
  });
});

describe("git-agent-attribution-hook — it does not displace a repo's own hook", () => {
  it("runs the repo-local prepare-commit-msg first and keeps its edit", () => {
    const repo = makeRepo("attr-chain-", { env: AGENT_ENV });
    const localHook = join(repo.dir, ".git", "hooks", "prepare-commit-msg");
    mkdirSync(join(repo.dir, ".git", "hooks"), { recursive: true });
    writeFileSync(
      localHook,
      '#!/bin/sh\nprintf "\\nRepo-Local-Hook: ran\\n" >> "$1"\n',
    );
    chmodSync(localHook, 0o755);

    repo.commit("feat: with a repo hook installed");

    const msg = repo.lastMessage();
    // The repo's own hook still ran...
    expect(msg).toContain("Repo-Local-Hook: ran");
    // ...and ours still got the last word.
    expect(repo.trailer("Switchroom-Agent")).toBe("klanker");
  });

  it("aborts the commit when the repo-local hook fails", () => {
    const repo = makeRepo("attr-chain-fail-", { env: AGENT_ENV });
    mkdirSync(join(repo.dir, ".git", "hooks"), { recursive: true });
    const localHook = join(repo.dir, ".git", "hooks", "prepare-commit-msg");
    writeFileSync(localHook, "#!/bin/sh\nexit 3\n");
    chmodSync(localHook, 0o755);

    expect(() => repo.commit("feat: repo hook says no")).toThrow();
  });
});

describe("wiring — the hook is actually installed and activated", () => {
  it("Dockerfile.agent materialises it as prepare-commit-msg in a hooks dir", () => {
    const dockerfile = readFileSync(join(repoRoot, "docker", "Dockerfile.agent"), "utf-8");
    expect(dockerfile).toContain("/opt/switchroom/git-hooks/prepare-commit-msg");
    expect(dockerfile).toContain("git-agent-attribution-hook.sh");
  });

  it("start.sh sets core.hooksPath globally at every boot", () => {
    const startSh = readFileSync(join(repoRoot, "profiles", "_base", "start.sh.hbs"), "utf-8");
    expect(startSh).toContain("git config --global core.hooksPath /opt/switchroom/git-hooks");
  });

  it("start.sh exports the launched model for the trailer", () => {
    const startSh = readFileSync(join(repoRoot, "profiles", "_base", "start.sh.hbs"), "utf-8");
    expect(startSh).toContain('export SWITCHROOM_SESSION_MODEL="$_EFFECTIVE_MODEL"');
  });

  it("the cron session exports its own (different) model", () => {
    const cronSh = readFileSync(
      join(repoRoot, "profiles", "_base", "cron-session.sh.hbs"),
      "utf-8",
    );
    expect(cronSh).toContain("export SWITCHROOM_SESSION_MODEL={{{cronModelQ}}}");
  });

  it("compose writes the static model fallback into the container env", () => {
    const compose = readFileSync(join(repoRoot, "src", "agents", "compose.ts"), "utf-8");
    expect(compose).toContain("SWITCHROOM_AGENT_MODEL: a.model");
  });
});
