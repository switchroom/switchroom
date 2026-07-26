/**
 * The hindsight backlog drain sidecar (start.sh.hbs block 5).
 *
 * WHY: `pending-retains` had exactly one automatic consumer — the
 * SessionStart hook, once per session boot, under a ~9s latency budget
 * against work measured at 85-280s per entry. An agent that simply stays up
 * never drained. Measured on the fleet 2026-07-26: 8 of 11 agents had
 * drained nothing and the queue reached 1,060 files. A memory stuck in that
 * queue is a memory the agent cannot recall
 * (reference/jobs/remember-across-sessions.md).
 *
 * These tests execute the REAL shell function lifted out of the template
 * against real `flock`, and assert OUTCOMES: that a run cannot be
 * overlapped, that a failing run does not end the drain for the container's
 * life, and that the fleet does not wake in lockstep against a 4-slot LLM
 * lane.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const TEMPLATE = join(__dirname, "..", "profiles", "_base", "start.sh.hbs");
const SRC = readFileSync(TEMPLATE, "utf-8");

/**
 * Lift the pure-shell loop out of the template and bind the one handlebars
 * token in its body ({{name}}) to a caller-supplied agent name. Asserting
 * that {{name}} is the ONLY token keeps this harness representative of what
 * actually renders — a second token appearing would make these tests lie.
 */
function extractLoop(agentName: string): string {
  const lines = SRC.split("\n");
  const start = lines.findIndex((l) =>
    l.includes("_switchroom_hindsight_drain_loop() {"),
  );
  expect(
    start,
    "_switchroom_hindsight_drain_loop() not found in start.sh.hbs",
  ).toBeGreaterThanOrEqual(0);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === "    }") {
      end = i;
      break;
    }
  }
  expect(end, "closing brace of the drain loop not found").toBeGreaterThan(start);
  const fn = lines
    .slice(start, end + 1)
    .map((l) => l.replace(/^ {4}/, ""))
    .join("\n");
  expect(fn.match(/\{\{[^}]+\}\}/g) ?? []).toEqual(["{{name}}"]);
  return fn.replaceAll("{{name}}", agentName);
}

// Sandbox under the repo, NOT os.tmpdir(): these tests exec a stub `python3`
// off PATH, and /tmp is mounted `noexec` in the agent container (and on some
// CI images). A noexec sandbox silently falls through to the REAL python3,
// which makes the loop tests pass for the wrong reason. `.test-tmp/` is
// already gitignored.
let root: string;

beforeAll(() => {
  const base = join(__dirname, "..", ".test-tmp");
  mkdirSync(base, { recursive: true });
  root = mkdtempSync(join(base, "hs-drain-sidecar-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Scenario {
  agentName?: string;
  interval?: string;
  /** exit status of the stub drain */
  exitCode?: number;
  /** hold the drain lock for the whole run, as a concurrent sweep would */
  holdLock?: boolean;
  /** shell prologue injected after the loop is defined (e.g. a sleep stub) */
  prologue?: string;
  /** how long the loop is allowed to run, in seconds */
  runFor?: number;
}

/** Run the real loop in a sandbox and report what it did. */
function run(s: Scenario): { runs: number; stdout: string; argv: string[] } {
  const home = mkdtempSync(join(root, "home-"));
  mkdirSync(join(home, ".hindsight"), { recursive: true });
  const runsDir = join(home, "runs");
  mkdirSync(runsDir);
  writeFileSync(join(home, "drain_pending.py"), "# stub\n");

  // Stand in for python3 on PATH: records every invocation, then exits.
  const py = join(home, "python3");
  writeFileSync(
    py,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "$RUNS_DIR/$(date +%s%N)"\nexit ${s.exitCode ?? 0}\n`,
  );
  chmodSync(py, 0o755);

  const lockHold = s.holdLock
    ? `exec 9>"$HOME/.hindsight/drain.lock"\nflock -n 9 || { echo "harness could not take the lock"; exit 99; }\n`
    : "";

  const harness = join(home, "harness.sh");
  writeFileSync(
    harness,
    `#!/usr/bin/env bash
set -u
export PATH="${home}:$PATH"
${extractLoop(s.agentName ?? "klanker")}
${s.prologue ?? ""}
${lockHold}
_switchroom_hindsight_drain_loop "${join(home, "drain_pending.py")}" &
_loop=$!
command sleep ${s.runFor ?? 1}
kill -9 $_loop 2>/dev/null
exit 0
`,
  );
  chmodSync(harness, 0o755);

  const stdout = execFileSync("bash", [harness], {
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: home,
      RUNS_DIR: runsDir,
      SWITCHROOM_HINDSIGHT_DRAIN_INTERVAL_S: s.interval ?? "",
    },
    timeout: 20_000,
  });
  const names = readdirSync(runsDir);
  return {
    runs: names.length,
    stdout,
    argv: names.map((n) => readFileSync(join(runsDir, n), "utf-8").trim()),
  };
}

/** Collapse the loop's own waits so a 15-minute cadence is testable in ~1s. */
const FAST = "sleep() { command sleep 0.05; }";
/** Stop the loop at its very first wait — enough to read the announced config. */
const HALT_AT_FIRST_SLEEP = "sleep() { exit 0; }";

describe("hindsight drain sidecar — structure", () => {
  it("the whole block sits inside {{#if hindsightEnabled}}, so a memory-less agent's start.sh is unchanged", () => {
    const lines = SRC.split("\n");
    const marker = lines.findIndex((l) => l.includes("5) hindsight backlog drain"));
    expect(marker, "block 5 not found").toBeGreaterThan(0);
    let open = -1;
    for (let i = marker; i >= 0; i--) {
      if (lines[i].includes("{{#if")) {
        open = i;
        break;
      }
    }
    expect(lines[open]).toBe("{{#if hindsightEnabled}}");
    let close = -1;
    for (let i = marker; i < lines.length; i++) {
      if (lines[i] === "{{/if}}") {
        close = i;
        break;
      }
    }
    expect(close, "guard not closed").toBeGreaterThan(marker);
    const outside = lines.slice(0, open).concat(lines.slice(close + 1)).join("\n");
    expect(outside).not.toContain("hindsight-drain");
    expect(outside).not.toContain("_switchroom_hindsight_drain_loop");
    expect(outside).not.toContain("drain_pending.py");
  });

  it("is supervised WITHOUT --oneshot-ok, so a crash self-heals and a clean exit still restarts", () => {
    const line = SRC.split("\n").find((l) =>
      l.includes("_switchroom_supervise hindsight-drain"),
    );
    expect(line, "the drain is not supervised").toBeTruthy();
    expect(line!).toContain("/var/log/switchroom/hindsight-drain.log");
    expect(line!).not.toContain("--oneshot-ok");
  });

  it("does not raise drain concurrency — the 4-slot LLM lane is shared and near-saturated", () => {
    const block = SRC.slice(
      SRC.indexOf("5) hindsight backlog drain"),
      SRC.indexOf("SWITCHROOM_DOCKER_TMUX_INNER=1"),
    );
    expect(block).not.toMatch(/HINDSIGHT_DRAIN_CONCURRENCY=/);
  });

  it("the sidecar region is valid bash", () => {
    const from = SRC.indexOf("  _hs_drain_script=");
    const to = SRC.indexOf("{{/if}}", from);
    expect(from).toBeGreaterThan(0);
    const block = SRC.slice(from, to)
      .replaceAll("{{agentDir}}", "/state/agent")
      .replaceAll("{{name}}", "klanker");
    expect(block).not.toContain("{{");
    const f = join(root, "syntax.sh");
    writeFileSync(f, `#!/usr/bin/env bash\n_switchroom_supervise() { :; }\n${block}\n`);
    expect(() => execFileSync("bash", ["-n", f])).not.toThrow();
  });
});

describe("hindsight drain sidecar — behaviour", () => {
  it("drains again and again — a single boot-time pass is what left 8 of 11 agents at zero", () => {
    const { runs } = run({ prologue: FAST, runFor: 1 });
    expect(runs, "the loop must keep ticking").toBeGreaterThan(2);
  });

  it("invokes the drain in --backlog mode, not the 4-second in-hook mode", () => {
    // Without --backlog the script runs the SessionStart drain: a ~4s total
    // budget against ~168s per entry, i.e. the do-nothing path this sidecar
    // exists to replace.
    const { argv } = run({ prologue: FAST, runFor: 1 });
    expect(argv.length).toBeGreaterThan(0);
    for (const line of argv) {
      expect(line).toMatch(/drain_pending\.py --backlog$/);
    }
  });

  it("CANNOT overlap a drain that is already running — the tick skips instead of stacking", () => {
    // Same outcome as a long run overshooting the interval: the lock is
    // held, so no second drain may start. Without `flock -n` in the loop
    // this window would see a dozen concurrent drains.
    const { runs } = run({ prologue: FAST, holdLock: true, runFor: 1 });
    expect(runs, "no drain may start while the lock is held").toBe(0);
  });

  it("keeps draining after a non-zero exit — `dead` entries are an outcome, not a reason to stop", () => {
    // drain_pending exits 1 when it promoted entries to `.dead`. Treating
    // that as fatal would silently end the drain for the container's life.
    const { runs } = run({ prologue: FAST, exitCode: 1, runFor: 1 });
    expect(runs).toBeGreaterThan(2);
  });

  it("staggers the fleet with a deterministic per-agent offset", () => {
    const offsets = new Map<string, number>();
    for (const name of ["klanker", "reggie", "marko", "overlord", "fable"]) {
      const first = run({
        agentName: name,
        interval: "900",
        prologue: HALT_AT_FIRST_SLEEP,
        runFor: 1,
      });
      const m = first.stdout.match(/offset=(\d+)s/);
      expect(m, `no offset announced for ${name}: ${first.stdout}`).not.toBeNull();
      const again = run({
        agentName: name,
        interval: "900",
        prologue: HALT_AT_FIRST_SLEEP,
        runFor: 1,
      });
      expect(
        again.stdout.match(/offset=(\d+)s/)![1],
        "the same agent must get the same offset on every boot",
      ).toBe(m![1]);
      offsets.set(name, Number(m![1]));
      expect(Number(m![1])).toBeLessThan(900);
    }
    expect(
      new Set(offsets.values()).size,
      `offsets collapsed, the fleet would stampede: ${JSON.stringify([...offsets])}`,
    ).toBeGreaterThan(3);
  });

  it("clamps a bogus or too-eager interval instead of hammering the lane", () => {
    const cases: Array<[string, number]> = [
      ["", 900],
      ["abc", 900],
      ["0", 60],
      ["5", 60],
      ["1200", 1200],
    ];
    for (const [given, want] of cases) {
      const { stdout } = run({
        interval: given,
        prologue: HALT_AT_FIRST_SLEEP,
        runFor: 1,
      });
      expect(stdout, `interval ${JSON.stringify(given)}`).toContain(`interval=${want}s`);
    }
  });
}, 60_000);
