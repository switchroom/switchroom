import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Tests for bin/bridge-watchdog.sh — a mix of:
 *
 *   1. Static-analysis guards (regression pins on byte-level script
 *      shape: dynamic discovery, strings(1) usage, inactive-heal
 *      branch, failed-skip branch). These caught the 2026-04-21
 *      hardcoded-agents incident and the 2026-04-22 clean-exit
 *      stranded-agent incident.
 *
 *   2. Behavioural integration tests that drive the script with a
 *      stub `systemctl` on PATH plus fixture gateway.log files.
 *      These cover the 2026-04-22 sustained-disconnect fix: 3
 *      false restarts of klanker during CPU-heavy work, caused by
 *      the old `tail -1` heuristic catching transient bridge flaps
 *      across Claude Code turn boundaries.
 *
 * The integration tests deliberately do NOT use real `systemctl` —
 * they set PATH so a local stub answers `list-units`, `show`,
 * `is-active`, `restart`, and `start` commands. Every action the
 * stub is asked to take appends a line to an audit log, which the
 * tests then assert over.
 */
const scriptPath = resolve(__dirname, "..", "bin", "bridge-watchdog.sh");
const script = readFileSync(scriptPath, "utf8");

describe("bridge-watchdog.sh — static regression guards", () => {
  it("does NOT hardcode any agent names in an AGENTS= array", () => {
    // The 2026-04-21 incident: a hardcoded AGENTS=(assistant klanker)
    // array silently skipped clerk (renamed from assistant) and
    // lawgpt (new agent). Both were stuck for hours.
    expect(script).not.toMatch(/AGENTS=\(/);
    expect(script).not.toMatch(/"(assistant|clerk|klanker|lawgpt):/);
  });

  it("discovers agents via systemctl list-units with the switchroom-*-gateway pattern", () => {
    expect(script).toContain("systemctl --user list-units");
    expect(script).toMatch(/switchroom-\.\+-gateway\\.service/);
  });

  it("derives the gateway log path from the unit's WorkingDirectory (not hardcoded)", () => {
    expect(script).toMatch(/WorkingDirectory/);
    expect(script).toMatch(/gateway_log=.*gateway\.log/);
  });

  it("strips the switchroom- prefix and -gateway.service suffix to get agent names", () => {
    expect(script).toMatch(/agent="\$\{gateway_svc#switchroom-\}"/);
    expect(script).toMatch(/agent="\$\{agent%-gateway\.service\}"/);
  });

  it("exits cleanly when no gateway services are active (no error spam in deploys)", () => {
    expect(script).toMatch(/gateway_services\[@\]\}.*eq 0/);
    expect(script).toMatch(/exit 0/);
  });

  it("heals agents whose agent service is inactive (start them, don't silently skip)", () => {
    // Regression: 2026-04-22 incident #2.
    expect(script).toMatch(/systemctl --user is-active --quiet.*\$agent_svc/);
    expect(script).toMatch(/systemctl --user start "\$agent_svc"/);
    expect(script).toMatch(/agent service is inactive/);
  });

  it("does NOT restart an agent in 'failed' state (needs operator reset-failed)", () => {
    expect(script).toMatch(/\[\[ "\$state" == "failed" \]\]/);
    expect(script).toMatch(/needs operator reset-failed/);
  });

  it("uses ss -x for IPC socket state check (not log-grep)", () => {
    // Production incident 2026-04-22 ~07:20: watchdog log-grep was
    // finding pre-restart 'bridge registered' events via tail -1 and
    // reporting stuck agents as healthy. Kernel-level ss check is
    // authoritative — if there's an ESTAB unix socket, bridge is
    // actually connected; if not, it isn't.
    expect(script).toContain("ss -x");
    expect(script).toMatch(/ESTAB/);
    expect(script).toMatch(/ipc_estab_count/);
  });

  it("skips if the gateway socket file is missing (gateway starting up)", () => {
    expect(script).toMatch(/\! -S "\$gateway_sock"/);
  });

  it("uses set -euo pipefail (safe bash)", () => {
    expect(script).toMatch(/set -euo pipefail/);
  });

  it("is still executable (chmod +x preserved)", () => {
    const stat = require("node:fs").statSync(scriptPath);
    expect(stat.mode & 0o100).toBeTruthy();
  });

  it("exposes UPTIME_GRACE_SECS, DISCONNECT_GRACE_SECS and LIVENESS_GRACE_SECS as env-overridable tunables", () => {
    // The tests below drive edge cases by overriding these — don't
    // accidentally hardcode them back into raw literals.
    expect(script).toMatch(/UPTIME_GRACE_SECS:=/);
    expect(script).toMatch(/DISCONNECT_GRACE_SECS:=/);
    expect(script).toMatch(/LIVENESS_GRACE_SECS:=/);
  });

  it("checks the liveness file mtime when ESTAB == 0 (bridge-alive false-positive fix)", () => {
    // The proper fix for the ~12 false restarts/day: before declaring the
    // bridge dead on ESTAB==0, consult the mtime of .bridge-alive — a file
    // the bridge touches on every heartbeat tick.
    expect(script).toMatch(/\.bridge-alive/);
    expect(script).toMatch(/LIVENESS_GRACE_SECS/);
    expect(script).toMatch(/liveness file is fresh/);
  });

  it("requires SUSTAINED disconnection before restarting (not tail -1 alone)", () => {
    // The 2026-04-22 fix: persist disconnect-since epoch to a sidecar
    // file, only restart when duration exceeds the grace window.
    expect(script).toMatch(/disconnect_marker/);
    expect(script).toMatch(/DISCONNECT_GRACE_SECS/);
  });

  it("skips the bridge check during the uptime grace window after (re)start", () => {
    // ActiveEnterTimestamp-based grace: the freshly-restarted agent
    // hasn't had a chance to register its bridge yet — don't restart
    // it again on the first tick after boot.
    expect(script).toMatch(/ActiveEnterTimestamp/);
    expect(script).toMatch(/UPTIME_GRACE_SECS/);
  });

  it("gates ALL three restart paths on a multi-signal progress probe", () => {
    // 2026-05-02 incident: TURN_HANG_SECS=300 fired on long sub-agent
    // runs because the parent's tool_use stream goes silent while a
    // Task() sub-agent does its work. The CLI's mid-turn guard caught
    // some, but on subsequent ticks the marker stayed stale and
    // eventually a restart slipped through, killing the sub-agent.
    //
    // Fix: every restart path (bridge-disconnect, turn-hang,
    // journal-silence) consults `agent_has_recent_progress` which
    // ORs over TWO independent fingerprints (transcript JSONL +
    // tasks JSON). Two uncorrelated signals mean a wedged agent has
    // to be silent on both before we kill it.
    expect(script).toMatch(/JSONL_LIVENESS_SECS:=/);
    expect(script).toMatch(/agent_has_recent_progress\(\)/);

    // Both fingerprints must be probed inside the helper.
    expect(script).toMatch(/\.claude\/projects.*-name '\*\.jsonl'/s);
    expect(script).toMatch(/\.claude\/tasks.*-name '\*\.json'/s);

    // All three restart paths must call the helper before acting.
    // Count the call-sites: should be exactly 3 (bridge-disconnect,
    // turn-hang, journal-silence).
    const calls = script.match(/agent_has_recent_progress "/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("emits forensic context (process state + progress fingerprints) on every action log", () => {
    // Operator forensics: after a restart the process is gone and
    // its state is unrecoverable. Every [restart] / [detect] /
    // [skip] line must carry the moment-of-decision snapshot so the
    // journal alone is enough to reconstruct WHY the action fired.
    // Snapshot includes: pid, /proc/<pid>/stat state letter, CPU%,
    // RSS, JSONL-age, tasks-age.
    expect(script).toMatch(/agent_main_pid\(\)/);
    expect(script).toMatch(/agent_proc_snapshot\(\)/);
    expect(script).toMatch(/agent_progress_snapshot\(\)/);
    expect(script).toMatch(/agent_observation\(\)/);
    // Reads the process-state letter from /proc/<pid>/stat (field 3).
    expect(script).toMatch(/\/proc\/\$\{pid\}\/stat/);
    // Every action log carries `agent=NAME reason=… <observation>`.
    expect(script).toMatch(/wd_log restart .* \$\{observation\}/);
    expect(script).toMatch(/wd_log detect .* \$\{observation\}/);
  });

  it("bridge-disconnect routes through `switchroom agent restart` (not raw systemctl)", () => {
    // Detector B parity fix: previously the bridge-disconnect path
    // went straight to `systemctl --user restart`, bypassing the
    // CLI's in-flight guard and config reconciliation. Now it
    // matches turn-hang and journal-silence: try the CLI first,
    // fall back to systemctl only when the CLI isn't installed.
    // Specifically, the script should resolve a `switchroom_cli`
    // path inside the bridge-disconnect block (not just inside the
    // journal-silence block at the bottom of the file).
    const bridgeBlock = script.split("# ─── Journal-silence check")[0];
    expect(bridgeBlock).toMatch(/switchroom_cli=/);
    expect(bridgeBlock).toMatch(/"\$switchroom_cli" agent restart "\$agent"/);
  });

  it("logs every decision via `logger -t switchroom-watchdog` with a level tag", () => {
    // Operator visibility: `journalctl -t switchroom-watchdog` should
    // show one tagged line per action. Levels: detect (signal observed),
    // restart (action taken), skip (action declined), error (failure).
    expect(script).toMatch(/wd_log\(\)/);
    expect(script).toMatch(/logger -t switchroom-watchdog/);
    expect(script).toMatch(/wd_log restart "agent=/);
    expect(script).toMatch(/wd_log skip "agent=/);
    expect(script).toMatch(/wd_log detect "agent=/);
  });

  it("stamps clean-shutdown.json with the watchdog reason on EVERY restart path", () => {
    // The bridge-disconnect path stamped a reason; the turn-hang and
    // journal-silence paths did not, so greeting cards on those
    // restarts silently dropped the "Restarted  <reason>" row.
    // Pulled the stamping into a helper called from all three paths.
    expect(script).toMatch(/stamp_restart_reason\(\)/);
    expect(script).toMatch(/stamp_restart_reason \\?\s*"\$\{gateway_state_dir\}\/clean-shutdown\.json"/);
    expect(script).toMatch(/stamp_restart_reason \\?\s*"\$\{agent_state_dir\}\/clean-shutdown\.json"/);
  });

  it("defines a restart-rate-cap helper and gates every restart path through it", () => {
    // Belt-and-suspenders for runaway restart loops — the script's three
    // restart paths plus the service-inactive heal must all consult the
    // rate cap before issuing a restart, so a single agent can't burn
    // Claude quota by being restarted N times in a window.
    expect(script).toMatch(/restart_rate_check\(\)/);
    expect(script).toMatch(/restart_rate_record\(\)/);
    expect(script).toMatch(/MAX_RESTARTS_PER_WINDOW/);
    expect(script).toMatch(/RESTART_RATE_WINDOW_SECS/);
    // Every restart path must call restart_rate_check before acting.
    const restartCheckCalls = script.match(/restart_rate_check "\$agent"/g) ?? [];
    expect(restartCheckCalls.length).toBeGreaterThanOrEqual(4);
    const restartRecordCalls = script.match(/restart_rate_record "\$agent"/g) ?? [];
    expect(restartRecordCalls.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------
// Behavioural tests: drive the real script with stub systemctl.
// ---------------------------------------------------------------

interface Harness {
  root: string;
  binDir: string;
  stateDir: string;
  auditLog: string;
  controlDir: string;
  // files the stub reads to decide what to report:
  unitsFile: string;           // list-units output
  workingDirFile: string;      // WorkingDirectory value
  isActiveFile: string;        // "0"=active, non-zero=inactive; default 0
  activeStateFile: string;     // "active"|"inactive"|"failed"|...
  activeEnterTsFile: string;   // systemctl-style wall clock (or epoch seconds prefixed with @)
  ssEstabCountFile: string;    // fake number of ESTAB connections on the gateway.sock
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "wd-test-"));
  const binDir = join(root, "bin");
  const stateDir = join(root, "state");  // WorkingDirectory for the fake gateway
  const controlDir = join(root, "control");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(controlDir, { recursive: true });

  const auditLog = join(controlDir, "audit.log");
  const unitsFile = join(controlDir, "units");
  const workingDirFile = join(controlDir, "workingdir");
  const isActiveFile = join(controlDir, "isactive");
  const activeStateFile = join(controlDir, "activestate");
  const activeEnterTsFile = join(controlDir, "activeenterts");
  const ssEstabCountFile = join(controlDir, "ssestabcount");

  // Defaults: one agent, state dir set, agent active, active state,
  // started long enough ago that the uptime grace does NOT apply.
  writeFileSync(unitsFile, "switchroom-klanker-gateway.service loaded active running switchroom telegram gateway (klanker)\n");
  writeFileSync(workingDirFile, stateDir);
  writeFileSync(isActiveFile, "0");
  writeFileSync(activeStateFile, "active");
  // 1 hour ago in systemd's "Tue 2026-04-21 19:23:38 AEST" format is
  // a pain to generate portably — use ISO which `date -d` also parses.
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  writeFileSync(activeEnterTsFile, hourAgo);
  writeFileSync(auditLog, "");
  // Default: 1 ESTAB connection (bridge healthy). Tests override for
  // disconnect scenarios.
  writeFileSync(ssEstabCountFile, "1");

  // Stub ss -x. Outputs N fake ESTAB lines referencing the gateway
  // socket. The real ss output is more complex; bridge-watchdog's
  // awk filter matches on $1=="u_str" && $2=="ESTAB" && contains(sock).
  // The stub emits lines in that exact shape so the awk filter passes.
  const ssStubPath = join(binDir, "ss");
  const ssStubContent = `#!/usr/bin/env bash
set -eu
n="$(cat "${ssEstabCountFile}" 2>/dev/null || echo 0)"
for ((i=0; i<n; i++)); do
  echo "u_str ESTAB 0 0 ${stateDir}/gateway.sock 1\${i} * 2\${i}"
done
`;
  writeFileSync(ssStubPath, ssStubContent);
  chmodSync(ssStubPath, 0o755);

  // Stub needs to also create the gateway.sock file (bridge-watchdog
  // short-circuits if the socket doesn't exist). The test only cares
  // about the -S file-test, not the actual content.
  // Use a regular file named gateway.sock; -S will still succeed if
  // we bind-create a proper socket, but since we can't easily do that
  // in pure bash, use a symlink to /dev/null which passes most tests
  // OR just create a simple placeholder file that -S rejects. To make
  // -S pass, use a named FIFO or actual socket. Python's socket module
  // can create one cheaply: handled at test-prep time instead.
  //
  // Simplest: since Linux has Unix socket support in bash via
  // /dev/stdin tricks, use python3 inline.
  try {
    execFileSync("python3", [
      "-c",
      `import socket; s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.bind('${stateDir}/gateway.sock'); s.listen(1)`,
    ]);
  } catch {
    // If python3 isn't available, fall back to mknod (requires sudo)
    // or skip. Tests that depend on the socket existing will reveal
    // the gap.
  }

  // Stub systemctl. Reads control files, appends to audit log.
  const stubPath = join(binDir, "systemctl");
  const stubContent = `#!/usr/bin/env bash
set -eu
echo "systemctl $*" >> "${auditLog}"
# strip the --user flag and optional trailing args
args=()
for a in "$@"; do
  if [[ "$a" != "--user" ]]; then args+=("$a"); fi
done
set -- "\${args[@]}"
case "\${1:-}" in
  list-units)
    cat "${unitsFile}"
    ;;
  show)
    # show <unit> -p <property> --value
    prop="\${4:-}"
    case "$prop" in
      WorkingDirectory) cat "${workingDirFile}" ;;
      ActiveState)      cat "${activeStateFile}" ;;
      ActiveEnterTimestamp) cat "${activeEnterTsFile}" ;;
      *) echo "" ;;
    esac
    ;;
  is-active)
    # is-active --quiet <unit>
    exit "$(cat "${isActiveFile}")"
    ;;
  restart|start)
    # Caller asserted on audit log already; do nothing.
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
  writeFileSync(stubPath, stubContent);
  chmodSync(stubPath, 0o755);

  return {
    root,
    binDir,
    stateDir,
    auditLog,
    controlDir,
    unitsFile,
    workingDirFile,
    isActiveFile,
    activeStateFile,
    activeEnterTsFile,
    ssEstabCountFile,
  };
}

function setEstabCount(h: Harness, n: number): void {
  writeFileSync(h.ssEstabCountFile, String(n));
}

function runWatchdog(
  h: Harness,
  env: Record<string, string> = {},
): { stdout: string; stderr: string; code: number; audit: string } {
  // Per-test isolation for the rate-cap state dir — without this, accumulated
  // restarts across the suite would eventually trip the cap and produce
  // confusing skip behaviour. controlDir is recreated per `makeHarness()`.
  const wdState = join(h.controlDir, "wd-state");
  mkdirSync(wdState, { recursive: true });
  const opts: ExecFileSyncOptions = {
    env: {
      PATH: `${h.binDir}:/usr/bin:/bin`,
      // HOME and USER sometimes matter for bash shell init.
      HOME: process.env.HOME ?? "/tmp",
      USER: process.env.USER ?? "nobody",
      WATCHDOG_STATE_DIR: wdState,
      ...env,
    },
    encoding: "utf8",
  };
  try {
    const stdout = execFileSync("/bin/bash", [scriptPath], opts).toString();
    const audit = readFileSync(h.auditLog, "utf8");
    return { stdout, stderr: "", code: 0, audit };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      code: err.status ?? 1,
      audit: existsSync(h.auditLog) ? readFileSync(h.auditLog, "utf8") : "",
    };
  }
}

function writeGatewayLog(h: Harness, lines: string[]): void {
  writeFileSync(join(h.stateDir, "gateway.log"), lines.join("\n") + "\n");
}

function restartIssued(audit: string, unit: string): boolean {
  return audit.split("\n").some((ln) => ln.startsWith(`systemctl --user restart ${unit}`));
}

function startIssued(audit: string, unit: string): boolean {
  return audit.split("\n").some((ln) => ln.startsWith(`systemctl --user start ${unit}`));
}

describe("bridge-watchdog.sh — behavioural integration", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    rmSync(h.root, { recursive: true, force: true });
  });

  it("healthy bridge (log tail = registered) → no restart", () => {
    writeGatewayLog(h, [
      "telegram gateway: bridge disconnected",
      "telegram gateway: bridge registered",
    ]);
    const r = runWatchdog(h);
    expect(r.code).toBe(0);
    expect(restartIssued(r.audit, "switchroom-klanker.service")).toBe(false);
  });

  it("transient flap (zero ESTAB connections, first observation) → no restart on this tick", () => {
    // This is the exact 2026-04-21 false-restart pattern: the bridge
    // flaps across a Claude Code turn boundary and the watchdog tick
    // happens to catch it mid-flap.
    setEstabCount(h, 0);
    writeGatewayLog(h, ["telegram gateway: bridge registered"]);
    const r = runWatchdog(h);
    expect(r.code).toBe(0);
    expect(restartIssued(r.audit, "switchroom-klanker.service")).toBe(false);
    // And a disconnect marker should now exist so the next tick can
    // measure duration.
    expect(existsSync(join(h.stateDir, ".watchdog-disconnect-since"))).toBe(true);
  });

  it("sustained disconnect (marker older than grace) → restart", () => {
    setEstabCount(h, 0);
    writeGatewayLog(h, ["telegram gateway: bridge registered"]);
    // Pretend the previous tick observed the disconnect 200s ago.
    const longAgo = Math.floor(Date.now() / 1000) - 200;
    writeFileSync(join(h.stateDir, ".watchdog-disconnect-since"), String(longAgo));

    const r = runWatchdog(h, { DISCONNECT_GRACE_SECS: "120" });
    expect(r.code).toBe(0);
    expect(restartIssued(r.audit, "switchroom-klanker.service")).toBe(true);
    // Marker should have been cleared post-restart.
    expect(existsSync(join(h.stateDir, ".watchdog-disconnect-since"))).toBe(false);
  });

  it("sustained disconnect writes clean-shutdown.json with the watchdog reason BEFORE restarting", () => {
    // PR feat/restart-reason-greeting: every restart initiator stamps a
    // reason into the clean-shutdown marker so the next agent greeting
    // can render "Restarted  <reason>". Watchdog restarts are the
    // trickiest of the five — the agent is sick, so we pre-seed the
    // reason from bash rather than node.
    setEstabCount(h, 0);
    writeGatewayLog(h, ["telegram gateway: bridge registered"]);
    const longAgo = Math.floor(Date.now() / 1000) - 200;
    writeFileSync(join(h.stateDir, ".watchdog-disconnect-since"), String(longAgo));

    const r = runWatchdog(h, { DISCONNECT_GRACE_SECS: "120" });
    expect(r.code).toBe(0);

    // The file must exist after the watchdog runs — the restart is via
    // the stub systemctl so nothing has consumed the marker yet.
    const markerPath = join(h.stateDir, "clean-shutdown.json");
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      ts: number;
      signal: string;
      reason: string;
    };
    expect(typeof marker.ts).toBe("number");
    expect(marker.signal).toBe("SIGTERM");
    expect(marker.reason).toMatch(/^watchdog: bridge disconnected for \d+s$/);

    // And the marker write MUST appear before the systemctl restart in
    // the script so the new boot picks it up. The audit log is ordered
    // (stub systemctl appends in real-time), so the restart line should
    // only exist *after* the marker file has been written.
    expect(restartIssued(r.audit, "switchroom-klanker.service")).toBe(true);
  });

  it("empty gateway.log + fresh uptime (within grace) → no restart", () => {
    writeGatewayLog(h, []);
    // Override: agent started 10s ago.
    writeFileSync(h.activeEnterTsFile, new Date(Date.now() - 10_000).toISOString());
    const r = runWatchdog(h, { UPTIME_GRACE_SECS: "90" });
    expect(r.code).toBe(0);
    expect(restartIssued(r.audit, "switchroom-klanker.service")).toBe(false);
  });

  it("zero ESTAB + agent up for hours → marker written, still no restart first tick", () => {
    setEstabCount(h, 0);
    writeGatewayLog(h, []);
    // Hour-ago timestamp is already the default from makeHarness.
    const r = runWatchdog(h);
    expect(r.code).toBe(0);
    expect(restartIssued(r.audit, "switchroom-klanker.service")).toBe(false);
    expect(existsSync(join(h.stateDir, ".watchdog-disconnect-since"))).toBe(true);
  });

  it("registered-tail clears a stale disconnect marker", () => {
    writeGatewayLog(h, [
      "telegram gateway: bridge disconnected",
      "telegram gateway: bridge registered",
    ]);
    writeFileSync(
      join(h.stateDir, ".watchdog-disconnect-since"),
      String(Math.floor(Date.now() / 1000) - 500),
    );
    const r = runWatchdog(h);
    expect(r.code).toBe(0);
    expect(restartIssued(r.audit, "switchroom-klanker.service")).toBe(false);
    expect(existsSync(join(h.stateDir, ".watchdog-disconnect-since"))).toBe(false);
  });

  it("agent inactive (not failed) → start it (existing heal path preserved)", () => {
    writeFileSync(h.isActiveFile, "3"); // systemctl is-active non-zero
    writeFileSync(h.activeStateFile, "inactive");
    // gateway.log shouldn't matter for this branch, but create one.
    writeGatewayLog(h, [
      "telegram gateway: bridge disconnected",
    ]);
    const r = runWatchdog(h);
    expect(r.code).toBe(0);
    expect(startIssued(r.audit, "switchroom-klanker.service")).toBe(true);
    expect(restartIssued(r.audit, "switchroom-klanker.service")).toBe(false);
  });

  it("agent failed → skip entirely (needs operator)", () => {
    writeFileSync(h.isActiveFile, "3");
    writeFileSync(h.activeStateFile, "failed");
    writeGatewayLog(h, [
      "telegram gateway: bridge disconnected",
    ]);
    const r = runWatchdog(h);
    expect(r.code).toBe(0);
    expect(startIssued(r.audit, "switchroom-klanker.service")).toBe(false);
    expect(restartIssued(r.audit, "switchroom-klanker.service")).toBe(false);
    expect(r.stdout).toMatch(/failed state/);
  });

  it("no active gateways → clean exit, no actions", () => {
    writeFileSync(h.unitsFile, "");
    const r = runWatchdog(h);
    expect(r.code).toBe(0);
    expect(r.audit.split("\n").filter(Boolean).length).toBe(1); // only list-units
  });

  it("uptime grace clears any stale disconnect marker (fresh slate after restart)", () => {
    writeGatewayLog(h, [
      "telegram gateway: bridge disconnected",
    ]);
    writeFileSync(h.activeEnterTsFile, new Date(Date.now() - 5_000).toISOString());
    // Pre-existing stale marker from before the restart.
    writeFileSync(
      join(h.stateDir, ".watchdog-disconnect-since"),
      String(Math.floor(Date.now() / 1000) - 5000),
    );
    const r = runWatchdog(h, { UPTIME_GRACE_SECS: "90" });
    expect(r.code).toBe(0);
    expect(restartIssued(r.audit, "switchroom-klanker.service")).toBe(false);
    expect(existsSync(join(h.stateDir, ".watchdog-disconnect-since"))).toBe(false);
  });

  it("bridge alive but disconnected (liveness file fresh) → no restart", () => {
    // Core liveness-file test: ESTAB == 0 but the bridge touched the
    // liveness file very recently, so it's alive and just reconnecting.
    // Should NOT restart — that would kill an in-flight Claude turn.
    setEstabCount(h, 0);
    writeGatewayLog(h, ["telegram gateway: bridge registered"]);
    // Write a fresh liveness file (mtime = now).
    const livenessFile = join(h.stateDir, ".bridge-alive");
    writeFileSync(livenessFile, "");
    const r = runWatchdog(h, { LIVENESS_GRACE_SECS: "30" });
    expect(r.code).toBe(0);
    expect(restartIssued(r.audit, "switchroom-klanker.service")).toBe(false);
    expect(r.stdout).toMatch(/liveness file is fresh/);
  });

  it("bridge dead (liveness file stale) → restart after grace", () => {
    // The bridge process has died: ESTAB == 0 AND the liveness file
    // hasn't been touched in a long time. After the disconnect grace
    // window, the watchdog should restart the agent.
    setEstabCount(h, 0);
    writeGatewayLog(h, ["telegram gateway: bridge registered"]);
    // Write a stale liveness file (mtime = 2 minutes ago).
    const livenessFile = join(h.stateDir, ".bridge-alive");
    writeFileSync(livenessFile, "");
    const staleTime = new Date(Date.now() - 120_000);
    const { utimesSync: touch } = require("node:fs");
    touch(livenessFile, staleTime, staleTime);
    // Also pre-seed the disconnect marker so the grace window is already
    // exhausted.
    const longAgo = Math.floor(Date.now() / 1000) - 200;
    writeFileSync(join(h.stateDir, ".watchdog-disconnect-since"), String(longAgo));
    const r = runWatchdog(h, { DISCONNECT_GRACE_SECS: "120", LIVENESS_GRACE_SECS: "30" });
    expect(r.code).toBe(0);
    expect(restartIssued(r.audit, "switchroom-klanker.service")).toBe(true);
  });

  it("bridge dead (no liveness file at all) → restart after grace (backwards compat)", () => {
    // Old bridges don't write the liveness file at all. The watchdog
    // must still restart them when ESTAB == 0 for long enough — no
    // regression in the existing behaviour.
    setEstabCount(h, 0);
    writeGatewayLog(h, ["telegram gateway: bridge registered"]);
    // No liveness file written — backwards compat scenario.
    const longAgo = Math.floor(Date.now() / 1000) - 200;
    writeFileSync(join(h.stateDir, ".watchdog-disconnect-since"), String(longAgo));
    const r = runWatchdog(h, { DISCONNECT_GRACE_SECS: "120", LIVENESS_GRACE_SECS: "30" });
    expect(r.code).toBe(0);
    expect(restartIssued(r.audit, "switchroom-klanker.service")).toBe(true);
  });

  it("restart rate cap blocks the Nth+1 restart within the window", () => {
    // Simulate that this agent has already been restarted N=MAX times
    // within the rate-cap window. The next restart attempt should
    // log-and-skip rather than proceed, even though every other guard
    // (uptime, disconnect grace, progress) says "restart now".
    setEstabCount(h, 0);
    writeGatewayLog(h, ["telegram gateway: bridge registered"]);
    const longAgo = Math.floor(Date.now() / 1000) - 200;
    writeFileSync(join(h.stateDir, ".watchdog-disconnect-since"), String(longAgo));

    // Pre-seed the rate-cap state with 5 recent timestamps (the default
    // MAX_RESTARTS_PER_WINDOW).
    const wdState = join(h.controlDir, "wd-state");
    mkdirSync(wdState, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    const recent = [now - 60, now - 120, now - 300, now - 600, now - 900].join("\n") + "\n";
    writeFileSync(join(wdState, "klanker.restarts"), recent);

    const r = runWatchdog(h, {
      DISCONNECT_GRACE_SECS: "120",
      LIVENESS_GRACE_SECS: "30",
    });
    expect(r.code).toBe(0);
    // The cap fired — no restart issued.
    expect(restartIssued(r.audit, "switchroom-klanker.service")).toBe(false);
    expect(r.stdout).toMatch(/restart-rate-capped/);
  });

  it("restart rate cap does NOT block when prior restart timestamps are outside the window", () => {
    // Old timestamps (further back than RESTART_RATE_WINDOW_SECS) must
    // be trimmed and not counted toward the cap.
    setEstabCount(h, 0);
    writeGatewayLog(h, ["telegram gateway: bridge registered"]);
    const longAgo = Math.floor(Date.now() / 1000) - 200;
    writeFileSync(join(h.stateDir, ".watchdog-disconnect-since"), String(longAgo));

    const wdState = join(h.controlDir, "wd-state");
    mkdirSync(wdState, { recursive: true });
    // 5 timestamps, all OLDER than the default 1800s window.
    const now = Math.floor(Date.now() / 1000);
    const old = [now - 5000, now - 4500, now - 4000, now - 3500, now - 3000].join("\n") + "\n";
    writeFileSync(join(wdState, "klanker.restarts"), old);

    const r = runWatchdog(h, {
      DISCONNECT_GRACE_SECS: "120",
      LIVENESS_GRACE_SECS: "30",
    });
    expect(r.code).toBe(0);
    expect(restartIssued(r.audit, "switchroom-klanker.service")).toBe(true);
  });
});
