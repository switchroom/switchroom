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
 * These tests execute the REAL shell — both the precondition guard and the
 * loop — lifted out of the template, and assert OUTCOMES rather than log
 * lines. Specifically, and deliberately:
 *
 * - the stagger is asserted as a WAIT that actually happens (wall clock, and
 *   the argument handed to `sleep`), not as the `offset=Ns` it announces;
 * - the interval clamp is asserted as the duration the loop actually waits
 *   between ticks, with the announcement checked to MATCH it;
 * - the kill switch and the other preconditions are asserted by running the
 *   real guard and seeing whether a sidecar is supervised at all.
 *
 * Each of those three used to pass against a mutant with the mechanism
 * deleted: the announcement was still printed, so the suite stayed green
 * while the stagger, the switch and the cadence did nothing.
 *
 * Serialisation is NOT asserted here, because it is no longer this file's
 * job: `drain_pending.py` locks itself for every caller (SessionStart, this
 * sidecar, the operator's `docker exec`) and
 * `vendor/hindsight-memory/scripts/tests/test_drain_serialisation.py` pins
 * it. What IS asserted here is the corollary — that this loop does NOT hold
 * that lock, because a wrapper here would starve the drain it launches.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
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

/**
 * Lift the whole precondition guard — `if ... then <define+supervise> else
 * <explain> fi` — so the switch and the "why didn't it start" branch can be
 * EXECUTED rather than pattern-matched.
 */
function extractGuard(agentDir: string, agentName: string, logDir: string): string {
  const from = SRC.indexOf("  _hs_drain_script=");
  const to = SRC.indexOf("{{/if}}", from);
  expect(from, "the drain guard not found in start.sh.hbs").toBeGreaterThan(0);
  expect(to, "the {{#if hindsightEnabled}} guard is not closed").toBeGreaterThan(from);
  const block = SRC.slice(from, to)
    .split("\n")
    .map((l) => l.replace(/^ {2}/, ""))
    .join("\n")
    .replaceAll("{{agentDir}}", agentDir)
    .replaceAll("{{name}}", agentName)
    // The real log path is asserted separately (see the `_switchroom_supervise`
    // structure test); rebinding it keeps the test out of the host's /var/log.
    .replaceAll("/var/log/switchroom", logDir);
  expect(block, "an unbound handlebars token would make this test lie").not.toContain(
    "{{",
  );
  return block;
}

/**
 * Absolute paths for the few real binaries these tests need, resolved ONCE
 * off the ambient PATH. The guard tests below run the shell with a closed
 * PATH (see runGuard), so nothing may be looked up by name at that point —
 * not even `bash` itself.
 */
function whichOrThrow(name: string): string {
  const p = execFileSync("sh", ["-c", `command -v ${name}`], {
    encoding: "utf-8",
  }).trim();
  expect(p, `${name} must be on PATH to run these tests`).not.toBe("");
  return p;
}
const BASH = whichOrThrow("bash");
const MKDIR = whichOrThrow("mkdir");

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
  /** shell prologue injected after the loop is defined (e.g. a sleep stub) */
  prologue?: string;
  /** how long the loop is allowed to run, in seconds (fractions allowed) */
  runFor?: number;
}

interface Result {
  runs: number;
  stdout: string;
  argv: string[];
  /** every duration the loop handed to `sleep`, in order (RECORD_SLEEPS only) */
  sleeps: string[];
  /** per run: whether the stub drain could take the drain lock itself */
  lockTaken: boolean[];
}

/** Run the real loop in a sandbox and report what it did. */
function run(s: Scenario): Result {
  const home = mkdtempSync(join(root, "home-"));
  mkdirSync(join(home, ".hindsight"), { recursive: true });
  const runsDir = join(home, "runs");
  mkdirSync(runsDir);
  writeFileSync(join(home, "drain_pending.py"), "# stub\n");

  // Stand in for python3 on PATH: records every invocation and, critically,
  // whether IT could still take the drain lock — drain_pending.py takes that
  // lock for real, so a `flock` wrapper in the loop would starve it.
  const py = join(home, "python3");
  writeFileSync(
    py,
    `#!${BASH}
_lock="$HOME/.hindsight/drain-pending.lock"
if ( exec 9>"$_lock"; flock -n 9 ) 2>/dev/null; then _l=lock-free; else _l=lock-held; fi
printf '%s\\n' "$_l $*" > "$RUNS_DIR/$(date +%s%N)"
exit ${s.exitCode ?? 0}
`,
  );
  chmodSync(py, 0o755);

  // `set -m` puts the loop in its own process group so the teardown below can
  // kill the group. Without it, an un-stubbed `sleep` survives the loop as an
  // orphan, keeps the harness's stdout pipe open, and every real-time test
  // hangs until the runner's timeout instead of finishing in a second.
  const out = join(home, "out");
  const harness = join(home, "harness.sh");
  writeFileSync(
    harness,
    `#!/usr/bin/env bash
set -u
export PATH="${home}:$PATH"
${extractLoop(s.agentName ?? "klanker")}
${s.prologue ?? ""}
set -m
_switchroom_hindsight_drain_loop "${join(home, "drain_pending.py")}" > "${out}" 2>&1 &
_loop=$!
set +m
command sleep ${s.runFor ?? 1}
kill -9 -"$_loop" 2>/dev/null || kill -9 "$_loop" 2>/dev/null
exit 0
`,
  );
  chmodSync(harness, 0o755);

  execFileSync(BASH, [harness], {
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: home,
      RUNS_DIR: runsDir,
      SLEEPS_FILE: join(home, "sleeps"),
      SWITCHROOM_HINDSIGHT_DRAIN_INTERVAL_S: s.interval ?? "",
    },
    timeout: 30_000,
  });
  const stdout = existsSync(out) ? readFileSync(out, "utf-8") : "";
  const names = readdirSync(runsDir).sort();
  const recorded = names.map((n) => readFileSync(join(runsDir, n), "utf-8").trim());
  const sleepsPath = join(home, "sleeps");
  return {
    runs: names.length,
    stdout,
    argv: recorded.map((l) => l.replace(/^lock-(free|held) /, "")),
    lockTaken: recorded.map((l) => l.startsWith("lock-free ")),
    sleeps: existsSync(sleepsPath)
      ? readFileSync(sleepsPath, "utf-8").split("\n").filter(Boolean)
      : [],
  };
}

/** Collapse the loop's own waits so a 15-minute cadence is testable in ~1s. */
const FAST = "sleep() { command sleep 0.05; }";
/**
 * Record every duration the loop asks to wait for, then return immediately.
 * This is what makes the stagger and the clamp assertable as BEHAVIOUR: the
 * value handed to `sleep` is the mechanism, the `offset=`/`interval=` line is
 * only an announcement, and the two are independently mutable.
 */
const RECORD_SLEEPS = `sleep() { printf '%s\\n' "\${1:-}" >> "$SLEEPS_FILE"; command sleep 0.02; }`;

/**
 * An agent name chosen so the deterministic offset is exactly 1 second at the
 * default 900s interval (`printf '%s' snooze-98 | cksum` → 3006612601, and
 * 3006612601 % 900 == 1). That is what makes the stagger testable as a REAL
 * wall-clock wait instead of a printed number.
 */
const ONE_SECOND_OFFSET_AGENT = "snooze-98";

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

  // The measured `timeout=900 conc=1 -> drained 5 of 5` result is real, but
  // the durable reading of it is that the CONTENT BOUND consumed the whole
  // deadline (#3693), not that the drain should wait three times as long.
  // `_backlog_timeout()` and `retain_content_limit()` are derived from ONE
  // number on purpose; pinning a literal here would silently unpick that and
  // size a max part against a deadline nothing else in the system knows about.
  it("does not pin a drain timeout — it stays derived from the retain client deadline", () => {
    const block = SRC.slice(
      SRC.indexOf("5) hindsight backlog drain"),
      SRC.indexOf("SWITCHROOM_DOCKER_TMUX_INNER=1"),
    );
    expect(block).not.toMatch(/HINDSIGHT_DRAIN_BACKLOG_TIMEOUT=/);
    expect(block).not.toMatch(/HINDSIGHT_RETAIN_CLIENT_DEADLINE_S=/);
  });

  // The stopgap the comment block above cites ran under an outer `flock` on
  // `drain.lock`, so the rows are one `git revert` away from being read as a
  // reason to put that wrapper back. The behavioural test below only goes red
  // for a wrapper on the SAME path `drain_pending.py` takes; a wrapper on the
  // historical `drain.lock` starves nothing and would slip through green while
  // silently re-narrowing serialisation to this one caller — the SessionStart
  // hook's in-process drain and a bare `docker exec` would walk past it again.
  // So pin the wrapper's ABSENCE textually. Comments are stripped first: the
  // block deliberately talks about `flock` at length.
  it("wraps the drain in no `flock` at all — the outer lock was deleted, not renamed", () => {
    const code = extractLoop("klanker")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    // Guards the negative below: if the invocation is ever renamed, this test
    // must fail loudly rather than pass against a loop it no longer covers.
    expect(code).toMatch(/python3 "\$_script" --backlog/);
    expect(
      code,
      "an outer `flock` wrapper is back in the drain loop; drain_pending.py owns serialisation for ALL callers",
    ).not.toMatch(/\bflock\b/);
  });

  it("the sidecar region is valid bash", () => {
    const block = extractGuard("/state/agent", "klanker", join(root, "logs"));
    const f = join(root, "syntax.sh");
    writeFileSync(f, `#!/usr/bin/env bash\n_switchroom_supervise() { :; }\n${block}\n`);
    expect(() => execFileSync("bash", ["-n", f])).not.toThrow();
  });

  it("only the docker runtime gets a sidecar, and that is written down", () => {
    // The block lives inside the `SWITCHROOM_RUNTIME = docker` branch that
    // ends at `exec tmux`, so a systemd-path agent silently keeps the
    // boot-only drain. Undocumented, that reads as a bug; documented, it is a
    // scope statement. (The fleet is entirely docker.)
    const runtimeGuard = SRC.indexOf(`[ "$SWITCHROOM_RUNTIME" = "docker" ]`);
    const block = SRC.indexOf("5) hindsight backlog drain");
    const execTmux = SRC.indexOf("exec tmux -L");
    expect(runtimeGuard).toBeGreaterThan(0);
    expect(block).toBeGreaterThan(runtimeGuard);
    expect(execTmux).toBeGreaterThan(block);
    expect(SRC.slice(block, execTmux)).toContain("DOCKER RUNTIME ONLY");
  });
});

/**
 * The precondition guard, EXECUTED. Previously nothing ran this: the kill
 * switch could be deleted outright and all ten tests stayed green, while the
 * Risk section leaned on it as the container-level off switch.
 */
describe("hindsight drain sidecar — preconditions", () => {
  interface GuardResult {
    supervised: string[];
    stdout: string;
    log: string;
  }

  function runGuard(env: Record<string, string>, opts?: { noScript?: boolean; noPython?: boolean }): GuardResult {
    const home = mkdtempSync(join(root, "guard-"));
    const agentDir = join(home, "agent");
    const logDir = join(home, "log");
    const scriptDir = join(agentDir, ".claude", "plugins", "hindsight-memory", "scripts");
    if (!opts?.noScript) {
      mkdirSync(scriptDir, { recursive: true });
      writeFileSync(join(scriptDir, "drain_pending.py"), "# stub\n");
    }
    // A CLOSED PATH: the only interpreter on it is the one this test puts
    // there, so "python3 is absent" is a real condition rather than a lie the
    // ambient /usr/bin quietly contradicts. `mkdir` is the one external the
    // guard actually runs (creating the log dir).
    const binDir = join(home, "bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(MKDIR, join(binDir, "mkdir"));
    if (!opts?.noPython) {
      writeFileSync(join(binDir, "python3"), "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(join(binDir, "python3"), 0o755);
    }
    const supervised = join(home, "supervised");
    const harness = join(home, "guard.sh");
    writeFileSync(
      harness,
      `#!/usr/bin/env bash
# \`set -u\` on purpose: start.sh does not use it today, but a BARE
# \$SWITCHROOM_HINDSIGHT_DRAIN is one \`set -u\` away from aborting boot for
# every hindsight agent. The defaulted form must survive it.
set -u
# A CLOSED PATH — see runGuard: the ambient /usr/bin always has a python3.
export PATH="${binDir}"
_switchroom_supervise() { printf '%s\\n' "$*" >> "${supervised}"; }
${extractGuard(agentDir, "klanker", logDir)}
wait
`,
    );
    chmodSync(harness, 0o755);
    const stdout = execFileSync(BASH, [harness], {
      encoding: "utf-8",
      env: { ...process.env, HOME: home, PATH: binDir, ...env },
      timeout: 20_000,
    });
    const logFile = join(logDir, "hindsight-drain.log");
    return {
      supervised: existsSync(supervised)
        ? readFileSync(supervised, "utf-8").split("\n").filter(Boolean)
        : [],
      stdout,
      log: existsSync(logFile) ? readFileSync(logFile, "utf-8") : "",
    };
  }

  it("starts the sidecar when nothing objects, with SWITCHROOM_HINDSIGHT_DRAIN unset", () => {
    const r = runGuard({});
    expect(r.supervised.length, "the drain must be supervised by default").toBe(1);
    expect(r.supervised[0]).toContain("hindsight-drain");
    expect(r.supervised[0]).toContain("_switchroom_hindsight_drain_loop");
  });

  it("SWITCHROOM_HINDSIGHT_DRAIN=0 actually stops it — the Risk section's off switch", () => {
    // Deleting the kill-switch condition left every other test green. This is
    // the only thing that fails.
    const r = runGuard({ SWITCHROOM_HINDSIGHT_DRAIN: "0" });
    expect(r.supervised, "the kill switch did not kill anything").toEqual([]);
    expect(r.log).toContain("NOT STARTED");
    expect(r.log).toContain("SWITCHROOM_HINDSIGHT_DRAIN=0");
  });

  it("any other value leaves it running — the switch is =0, not truthiness", () => {
    expect(runGuard({ SWITCHROOM_HINDSIGHT_DRAIN: "1" }).supervised.length).toBe(1);
    expect(runGuard({ SWITCHROOM_HINDSIGHT_DRAIN: "" }).supervised.length).toBe(1);
  });

  it("says WHY it did not start, in the logfile, when the script is missing", () => {
    // Silence was the bug: no line, no logfile, so "is the drain running?"
    // was unanswerable and looked identical to "running, nothing to do".
    const r = runGuard({}, { noScript: true });
    expect(r.supervised).toEqual([]);
    expect(r.log).toContain("NOT STARTED");
    expect(r.log).toContain("no drain script at");
    expect(r.stdout).toContain("NOT STARTED");
  });

  it("says WHY it did not start when python3 is absent", () => {
    const r = runGuard({}, { noPython: true });
    expect(r.supervised).toEqual([]);
    expect(r.log).toContain("python3 is not on PATH");
  });

  it("names exactly one reason, and it is the true one", () => {
    // A branch that reported "python3 missing" for a disabled switch would be
    // worse than silence.
    const r = runGuard({ SWITCHROOM_HINDSIGHT_DRAIN: "0" }, { noPython: true });
    expect(r.log).toContain("SWITCHROOM_HINDSIGHT_DRAIN=0");
    expect(r.log).not.toContain("python3 is not on PATH");
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

  it("leaves the drain lock free for drain_pending.py, which takes it itself", () => {
    // Serialisation moved INTO the script so every caller is covered (the
    // SessionStart hook and the operator's `docker exec` never had a lock).
    // The corollary is load-bearing: a `flock` wrapper HERE would hold the
    // lock the script then asks for, and the drain would skip every tick,
    // silently, for the container's life. The stub records whether it could
    // still take the lock at the moment the loop invoked it.
    const { runs, lockTaken } = run({ prologue: FAST, runFor: 1 });
    expect(runs).toBeGreaterThan(2);
    expect(
      lockTaken.every(Boolean),
      "the loop is holding the drain lock; drain_pending.py would skip every run",
    ).toBe(true);
  });

  it("keeps draining after a non-zero exit — `dead` entries are an outcome, not a reason to stop", () => {
    // drain_pending exits 1 when it promoted entries to `.dead`. Treating
    // that as fatal would silently end the drain for the container's life.
    const { runs } = run({ prologue: FAST, exitCode: 1, runFor: 1 });
    expect(runs).toBeGreaterThan(2);
  });

  it("WAITS out the per-agent offset before the first drain — the stagger is a delay, not a log line", async () => {
    // The offset exists so 11 agents do not wake together against 4 shared
    // LLM lanes. Deleting `sleep "$_offset"` while keeping the computation
    // and the echo left the suite fully green, because the old test read the
    // announcement out of stdout. This one uses real time: the agent name is
    // picked so the offset is exactly 1s (see ONE_SECOND_OFFSET_AGENT), the
    // interval is the 900s default, so a drain inside the first second can
    // only mean the wait was skipped.
    const early = run({
      agentName: ONE_SECOND_OFFSET_AGENT,
      interval: "900",
      runFor: 0.6,
    });
    expect(early.stdout).toContain("offset=1s");
    expect(
      early.runs,
      "a drain fired before the offset elapsed — the fleet would stampede",
    ).toBe(0);

    const later = run({
      agentName: ONE_SECOND_OFFSET_AGENT,
      interval: "900",
      runFor: 2.5,
    });
    expect(later.runs, "the drain never ran after the offset").toBe(1);
  });

  it("the offset it WAITS for is deterministic per agent and spreads the fleet", () => {
    // Same mechanism, asserted on the value actually handed to `sleep` rather
    // than the value printed — those are independently mutable, and only the
    // first one staggers anything.
    const offsets = new Map<string, number>();
    for (const name of ["klanker", "reggie", "marko", "overlord", "fable"]) {
      const first = run({
        agentName: name,
        interval: "900",
        prologue: RECORD_SLEEPS,
        runFor: 0.5,
      });
      expect(first.sleeps.length, `${name}: the loop never slept`).toBeGreaterThan(0);
      const offset = Number(first.sleeps[0]);
      expect(
        Number.isFinite(offset),
        `${name}: first wait was not a number: ${first.sleeps[0]}`,
      ).toBe(true);
      expect(offset, `${name}: offset must be inside the interval`).toBeLessThan(900);

      const again = run({
        agentName: name,
        interval: "900",
        prologue: RECORD_SLEEPS,
        runFor: 0.5,
      });
      expect(
        Number(again.sleeps[0]),
        "the same agent must wait the same offset on every boot",
      ).toBe(offset);

      // The announcement must describe the wait that actually happens.
      expect(first.stdout).toContain(`offset=${offset}s`);
      offsets.set(name, offset);
    }
    expect(
      new Set(offsets.values()).size,
      `offsets collapsed, the fleet would stampede: ${JSON.stringify([...offsets])}`,
    ).toBeGreaterThan(3);
  });

  it("waits the CLAMPED interval between ticks, and announces the same number", () => {
    // The clamp used to be checked only as `interval=Ns` on stdout: replacing
    // `sleep "$_interval"` with a hardcoded `sleep 900` kept all ten tests
    // green. Here the assertion is on every wait the loop actually performs
    // after the initial offset.
    const cases: Array<[string, number]> = [
      ["", 900],
      ["abc", 900],
      ["0", 60],
      ["5", 60],
      ["1200", 1200],
    ];
    for (const [given, want] of cases) {
      const r = run({ interval: given, prologue: RECORD_SLEEPS, runFor: 0.5 });
      expect(r.stdout, `interval ${JSON.stringify(given)}`).toContain(
        `interval=${want}s`,
      );
      const betweenTicks = r.sleeps.slice(1);
      expect(
        betweenTicks.length,
        `interval ${JSON.stringify(given)}: the loop never reached its cooldown`,
      ).toBeGreaterThan(0);
      for (const s of betweenTicks) {
        expect(
          Number(s),
          `interval ${JSON.stringify(given)}: waited ${s}s between ticks, announced ${want}s`,
        ).toBe(want);
      }
    }
  });

  it("calls the interval a cooldown, because the loop is sequential", () => {
    // Honesty fix: the loop is `drain; sleep $interval`, so the true period is
    // a drain's duration (up to the 3600s backlog budget) PLUS the interval.
    // Announcing 900s as if it were the period overstated the cadence by up
    // to 5x on a backlogged agent.
    const { stdout } = run({ prologue: RECORD_SLEEPS, runFor: 0.3 });
    expect(stdout).toContain("cooldown between runs, not a fixed period");
  });
}, 90_000);
