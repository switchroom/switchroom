/**
 * Outcome tests for `scripts/agent-pr-label.mjs`.
 *
 * "A PR opened by an agent actually gets the label" cannot be asserted against
 * real GitHub from a unit suite, so these run the REAL script as a subprocess
 * against a stub `gh` on `PATH` that records every call and replays canned API
 * responses. The assertions are on the API calls the script actually makes —
 * `POST /repos/:r/labels`, `POST /repos/:r/issues/:n/labels`,
 * `DELETE .../labels/:name` — which is the observable behaviour GitHub sees.
 * Everything except GitHub itself is real.
 *
 * NOTE ON /tmp: the stub `gh` must be EXECUTABLE from the temp dir, and some
 * dev containers mount /tmp `noexec`. Set an exec-capable `TMPDIR` locally
 * (CLAUDE.md § "Local env noise vs real failures").
 */
import { describe, expect, it, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
const SCRIPT = join(repoRoot, "scripts", "agent-pr-label.mjs");

const scratchRoots: string[] = [];

interface StubOpts {
  /** Commit messages the fake PR's commits carry. */
  commitMessages: string[];
  /** Labels already on the PR. */
  currentLabels?: string[];
  /** Label names that already exist in the repo. */
  existingLabels?: string[];
  /** Substring of an argv that should make the stub exit non-zero. */
  failOn?: string;
}

interface StubResult {
  code: number;
  out: string;
  /** Every `gh` argv the script invoked, in order, space-joined. */
  calls: string[];
}

/**
 * Build a stub `gh` and run the real labeller against it.
 */
function runLabeller(opts: StubOpts): StubResult {
  const root = mkdtempSync(join(tmpdir(), "agent-label-"));
  scratchRoots.push(root);
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const callLog = join(root, "calls.log");

  const fixtures = {
    commits: opts.commitMessages.map((m) => ({ commit: { message: m } })),
    labels: (opts.currentLabels ?? []).map((name) => ({ name })),
    existing: opts.existingLabels ?? [],
    failOn: opts.failOn ?? null,
  };
  writeFileSync(join(root, "fixtures.json"), JSON.stringify(fixtures));

  // A node-based stub so the fixture logic stays readable. `gh api --paginate
  // --slurp` returns an array of PAGES, which is the shape the script must
  // flatten — the stub reproduces that faithfully rather than the easier
  // single-array shape.
  writeFileSync(
    join(binDir, "gh"),
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const f = JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "fixtures.json"))}, 'utf-8'))
fs.appendFileSync(${JSON.stringify(callLog)}, args.join(' ') + '\\n')
if (f.failOn && args.join(' ').includes(f.failOn)) {
  process.stderr.write('stub gh: forced failure\\n')
  process.exit(1)
}
const joined = args.join(' ')
if (joined.includes('/commits')) { process.stdout.write(JSON.stringify([f.commits])); process.exit(0) }
if (joined.includes('--method')) { process.stdout.write('{}'); process.exit(0) }
if (/issues\\/\\d+\\/labels/.test(joined)) { process.stdout.write(JSON.stringify([f.labels])); process.exit(0) }
const m = /repos\\/[^/]+\\/[^/]+\\/labels\\/(.+)$/.exec(joined)
if (m) {
  const name = decodeURIComponent(m[1])
  if (f.existing.includes(name)) { process.stdout.write('{}'); process.exit(0) }
  process.stderr.write('gh: Not Found (HTTP 404)\\n')
  process.exit(1)
}
process.stdout.write('[]')
`,
  );
  chmodSync(join(binDir, "gh"), 0o755);

  const r = spawnSync(process.execPath, [SCRIPT, "--repo", "switchroom/switchroom", "--pr", "4242"], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } as NodeJS.ProcessEnv,
  });

  const calls = existsSync(callLog)
    ? readFileSync(callLog, "utf-8").split("\n").filter(Boolean)
    : [];
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, calls };
}

const AGENT_COMMIT = [
  "feat(x): do the thing",
  "",
  "Co-authored-by: Claude Opus 5 <noreply@anthropic.com>",
  "Switchroom-Agent: klanker",
  "Switchroom-Model: claude-opus-5",
].join("\n");

beforeAll(() => () => {
  for (const d of scratchRoots) rmSync(d, { recursive: true, force: true });
});

describe("agent-pr-label — a PR whose commits name an agent gets that agent's label", () => {
  it("creates the label on demand and applies it", () => {
    const r = runLabeller({ commitMessages: [AGENT_COMMIT] });

    expect(r.code).toBe(0);
    // Created, because the repo did not already have it...
    expect(r.calls.some((c) => c.includes("--method POST") && c.includes("/labels") && c.includes("name=agent:klanker"))).toBe(true);
    // ...and applied to the PR.
    expect(r.calls.some((c) => c.includes("issues/4242/labels") && c.includes("labels[]=agent:klanker"))).toBe(true);
  });

  it("does not re-create a label that already exists", () => {
    const r = runLabeller({
      commitMessages: [AGENT_COMMIT],
      existingLabels: ["agent:klanker"],
    });

    expect(r.code).toBe(0);
    expect(r.calls.some((c) => c.includes("--method POST") && c.includes("switchroom/labels"))).toBe(false);
    expect(r.calls.some((c) => c.includes("labels[]=agent:klanker"))).toBe(true);
  });

  it("is a no-op when the label is already on the PR", () => {
    const r = runLabeller({
      commitMessages: [AGENT_COMMIT],
      currentLabels: ["agent:klanker", "enhancement"],
      existingLabels: ["agent:klanker"],
    });

    expect(r.code).toBe(0);
    expect(r.calls.some((c) => c.includes("--method POST") && c.includes("labels[]="))).toBe(false);
    expect(r.calls.some((c) => c.includes("--method DELETE"))).toBe(false);
  });

  it("labels every agent when a PR carries work from more than one", () => {
    const second = AGENT_COMMIT.replace("klanker", "marko");
    const r = runLabeller({ commitMessages: [AGENT_COMMIT, second] });

    expect(r.code).toBe(0);
    expect(r.calls.some((c) => c.includes("labels[]=agent:klanker"))).toBe(true);
    expect(r.calls.some((c) => c.includes("labels[]=agent:marko"))).toBe(true);
  });

  it("removes a stale agent label whose commits are gone, and touches nothing else", () => {
    const r = runLabeller({
      commitMessages: [AGENT_COMMIT],
      currentLabels: ["agent:someoneelse", "enhancement", "epic"],
      existingLabels: ["agent:klanker", "agent:someoneelse"],
    });

    expect(r.code).toBe(0);
    expect(r.calls.some((c) => c.includes("--method DELETE") && c.includes("agent%3Asomeoneelse"))).toBe(true);
    // Non-agent labels are never in scope.
    expect(r.calls.some((c) => c.includes("--method DELETE") && c.includes("enhancement"))).toBe(false);
    expect(r.calls.some((c) => c.includes("--method DELETE") && c.includes("epic"))).toBe(false);
  });
});

describe("agent-pr-label — a human PR gets no agent label", () => {
  it("applies nothing when no commit carries a Switchroom-Agent trailer", () => {
    const r = runLabeller({
      commitMessages: ["docs: fix a typo", "fix: tighten the parser\n\nCloses #1"],
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("human PR, nothing to label");
    expect(r.calls.some((c) => c.includes("--method"))).toBe(false);
  });

  it("ignores a malformed trailer value rather than creating a junk label", () => {
    const r = runLabeller({
      commitMessages: ["feat: x\n\nSwitchroom-Agent: not a slug!\nSwitchroom-Model: m"],
    });

    expect(r.code).toBe(0);
    expect(r.calls.some((c) => c.includes("--method"))).toBe(false);
  });
});

describe("agent-pr-label — a labelling failure is loud, never a silent unlabelled PR", () => {
  it("exits non-zero when label creation is refused (permissions / rate limit)", () => {
    const r = runLabeller({ commitMessages: [AGENT_COMMIT], failOn: "--method POST" });

    expect(r.code).toBe(1);
    expect(r.out).toContain("agent-pr-label: FAILED");
    expect(r.out).toContain("silently ends up without its agent label");
  });

  it("exits non-zero when the commits cannot be read at all", () => {
    const r = runLabeller({ commitMessages: [AGENT_COMMIT], failOn: "/commits" });

    expect(r.code).toBe(1);
    expect(r.out).toContain("listing PR commits");
  });
});

describe("agent-pr-label — label scheme", () => {
  it("uses one shared colour and a descriptive, self-explaining description", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    // A single family colour, not a per-agent hash: fifteen near-identical
    // hues carry no meaning and cannot be told apart at a glance.
    expect(src).toContain("export const AGENT_LABEL_COLOR = '5319e7'");
    expect(src).toContain('Opened by switchroom agent "${agent}" (auto-applied from commit trailers)');
  });

  it("uses the `agent:` prefix Ken filters on", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    expect(src).toContain("export const AGENT_LABEL_PREFIX = 'agent:'");
  });
});
