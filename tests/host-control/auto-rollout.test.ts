/**
 * KEN-131 (stage 3 of KEN-128) — unattended auto-update rollout via
 * HostdServer.startAutoRollout. Outcome-asserting tests:
 *
 *   - happy path: the watcher-initiated roll runs the staggered canary
 *     rollout child, completes, releases the fleet-mutation lock, and
 *     alerts the operator through the first ADMIN agent's gateway relay;
 *   - canary failure HALTS: no further rollout, the failed pin is latched
 *     (no unattended retry loop), compose is rolled back to the prior pin,
 *     the canary is restarted back on it, and the operator gets an alert
 *     card naming the failure + the rollback outcome;
 *   - the fleet-mutation lock refuses a concurrent auto roll.
 *
 * Same private-method cast pattern as rollout-agent-validation.test.ts;
 * `runSwitchroom` is stubbed so no child process ever spawns.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loadConfigMock = vi.fn();
vi.mock("../../src/config/loader.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/config/loader.js")
  >("../../src/config/loader.js");
  return {
    ...actual,
    loadConfig: (...args: unknown[]) => loadConfigMock(...args),
  };
});

const { HostdServer, isAutoRolloutRequestId, AUTO_ROLLOUT_REQUEST_PREFIX } =
  await import("../../src/host-control/server.js");
import type { ServerOptions } from "../../src/host-control/server.js";
import { encodeRolloutResultLine } from "../../src/cli/rollout.js";
import type { RolloutTerminalNotice } from "../../src/host-control/rollout-relay.js";

type RunResult = { exit_code: number; stdout: string; stderr: string };

interface Harness {
  server: InstanceType<typeof HostdServer>;
  calls: string[][];
  posted: RolloutTerminalNotice[];
  startAutoRollout: (
    pin: string,
  ) => Promise<{ started: boolean; request_id?: string; reason?: string }>;
}

/**
 * Bare server with a stubbed `runSwitchroom`. `onRun` maps the spawned
 * argv to a fake result; every invocation is recorded in `calls`.
 */
function makeServer(
  onRun: (args: string[]) => RunResult,
  homeDir?: string,
): Harness {
  const posted: RolloutTerminalNotice[] = [];
  const dir = homeDir ?? mkdtempSync(join(tmpdir(), "auto-rollout-test-"));
  const server = new HostdServer({
    homeDir: dir,
    agentUids: {},
    config: {
      // First ADMIN agent is "overlord" — the expected alert relay target
      // for watcher-initiated rolls (which have no caller agent).
      agents: { "test-harness": {}, overlord: { admin: true }, clerk: {} },
    },
    auditLogPath: join(dir, "audit.log"),
    // High selfVersion so needsSelfBump never triggers in these tests.
    selfVersion: "v99.0.0",
    allowNonLinux: true,
    rolloutRelay: {
      postTerminal: (n) => {
        posted.push(n);
      },
    },
  } as unknown as ServerOptions);
  const calls: string[][] = [];
  const s = server as unknown as {
    missingApplyAssets: () => string[];
    runSwitchroom: (
      args: string[],
      env?: Record<string, string>,
      onLine?: (l: string) => void,
    ) => Promise<RunResult>;
    startAutoRollout: Harness["startAutoRollout"];
  };
  s.missingApplyAssets = () => [];
  s.runSwitchroom = async (args) => {
    calls.push(args);
    return onRun(args);
  };
  return {
    server,
    calls,
    posted,
    startAutoRollout: (pin) => s.startAutoRollout(pin),
  };
}

const PRIOR_PIN = "v1.0.0";

beforeEach(() => {
  loadConfigMock.mockReset();
  loadConfigMock.mockReturnValue({
    agents: { "test-harness": {}, overlord: { admin: true }, clerk: {} },
    release: { pin: PRIOR_PIN },
  });
});

async function waitForTerminal(h: Harness): Promise<void> {
  await vi.waitFor(() => {
    expect(h.posted.length).toBeGreaterThan(0);
  });
}

describe("startAutoRollout — happy path", () => {
  it("runs the canary rollout child, completes, releases the lock, and alerts via the admin agent", async () => {
    const h = makeServer((args) => {
      expect(args.slice(0, 3)).toEqual(["rollout", "--pin", "v1.0.1"]);
      return {
        exit_code: 0,
        stdout:
          encodeRolloutResultLine({
            ok: true,
            rolled: ["test-harness", "overlord", "clerk"],
            warnings: [],
          }) + "\n",
        stderr: "",
      };
    });
    const r = await h.startAutoRollout("v1.0.1");
    expect(r.started).toBe(true);
    expect(r.request_id).toMatch(new RegExp(`^${AUTO_ROLLOUT_REQUEST_PREFIX}`));
    expect(isAutoRolloutRequestId(r.request_id!)).toBe(true);
    await waitForTerminal(h);
    // Exactly ONE child spawned — the rollout itself; no recovery commands.
    expect(h.calls).toHaveLength(1);
    // Alert routed via the FIRST ADMIN agent (no caller agent exists).
    expect(h.posted[0]!.agentName).toBe("overlord");
    expect(h.posted[0]!.requestId).toBe(r.request_id);
    // Lock released: a follow-up auto roll to a newer pin starts cleanly.
    const again = await h.startAutoRollout("v1.0.2");
    expect(again.started).toBe(true);
  });
});

describe("startAutoRollout — canary failure halts (hardened no-operator path)", () => {
  function failingHarness(): Harness {
    return makeServer((args) => {
      if (args[0] === "rollout") {
        return {
          exit_code: 1,
          stdout:
            encodeRolloutResultLine({
              ok: false,
              rolled: [],
              failedStep: "restart-agent",
              failedAgent: "test-harness",
              got: null,
              warnings: [],
            }) + "\n",
          stderr: "",
        };
      }
      // Recovery commands (apply / agent restart) succeed.
      return { exit_code: 0, stdout: "", stderr: "" };
    });
  }

  it("rolls compose back to the prior pin, restarts the canary on it, and alerts", async () => {
    const h = failingHarness();
    const r = await h.startAutoRollout("v1.0.1");
    expect(r.started).toBe(true);
    await waitForTerminal(h);
    // Recovery: compose restore + canary restart back on the PRIOR pin.
    expect(h.calls).toContainEqual([
      "apply",
      "--pin",
      PRIOR_PIN,
      "--compose-only",
      "--non-interactive",
    ]);
    expect(h.calls).toContainEqual([
      "agent",
      "restart",
      "test-harness",
      "--wait",
      "--force",
      "--pin",
      PRIOR_PIN,
    ]);
    // Alert card: routed via the admin agent, naming failure + rollback.
    expect(h.posted[0]!.agentName).toBe("overlord");
    expect(h.posted[0]!.text).toMatch(/FAILED/);
    expect(h.posted[0]!.text).toMatch(/compose restored to v1\.0\.0/);
    expect(h.posted[0]!.text).toMatch(/test-harness restarted back on v1\.0\.0/);
  });

  it("latches the failed pin — the SAME version is never retried unattended, a NEWER one is", async () => {
    const h = failingHarness();
    await h.startAutoRollout("v1.0.1");
    await waitForTerminal(h);
    const retry = await h.startAutoRollout("v1.0.1");
    expect(retry.started).toBe(false);
    expect(retry.reason).toMatch(/FAILED/);
    // No second rollout child was spawned for the retry.
    expect(h.calls.filter((c) => c[0] === "rollout")).toHaveLength(1);
    // A newer release supersedes the latch.
    const newer = await h.startAutoRollout("v1.0.2");
    expect(newer.started).toBe(true);
  });

  it("does NOT auto-roll-back past a green canary (mixed fleet is alerted, not mass-reverted)", async () => {
    const h = makeServer((args) => {
      if (args[0] === "rollout") {
        return {
          exit_code: 1,
          stdout:
            encodeRolloutResultLine({
              ok: false,
              rolled: ["test-harness"],
              failedStep: "restart-agent",
              failedAgent: "clerk",
              got: "1.0.0",
              warnings: [],
            }) + "\n",
          stderr: "",
        };
      }
      return { exit_code: 0, stdout: "", stderr: "" };
    });
    await h.startAutoRollout("v1.0.1");
    await waitForTerminal(h);
    // Only the rollout child ran — no apply / restart recovery spawns.
    expect(h.calls).toHaveLength(1);
    expect(h.posted[0]!.text).toMatch(/No automatic rollback/);
  });
});

describe("startAutoRollout — latch durability across hostd restarts (KEN-131)", () => {
  // hostd restarts are ROUTINE on the auto-update path (the self-bump
  // recreates hostd's own container on essentially every roll; crash-loops
  // and host reboots also clear process memory). These tests construct a
  // SECOND HostdServer over the same home dir — the "restarted daemon" —
  // and assert the failed-pin latch still refuses an unattended retry.
  // With an in-memory-only latch each of these would retry the broken
  // pin, bouncing the canary forever with no operator in the loop.

  function failingRun(args: string[]): RunResult {
    if (args[0] === "rollout") {
      return {
        exit_code: 1,
        stdout:
          encodeRolloutResultLine({
            ok: false,
            rolled: [],
            failedStep: "restart-agent",
            failedAgent: "test-harness",
            got: null,
            warnings: [],
          }) + "\n",
        stderr: "",
      };
    }
    return { exit_code: 0, stdout: "", stderr: "" };
  }

  it("a FAILED pin is refused by a fresh daemon (restart does not clear the latch)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-rollout-restart-"));
    const h1 = makeServer(failingRun, dir);
    await h1.startAutoRollout("v1.0.1");
    await waitForTerminal(h1);
    // "Restart": brand-new server instance, same home dir, empty memory.
    const h2 = makeServer(failingRun, dir);
    const retry = await h2.startAutoRollout("v1.0.1");
    expect(retry.started).toBe(false);
    expect(retry.reason).toMatch(/FAILED/);
    expect(h2.calls.filter((c) => c[0] === "rollout")).toHaveLength(0);
    // A NEWER release still supersedes the durable latch after restart.
    const newer = await h2.startAutoRollout("v1.0.2");
    expect(newer.started).toBe(true);
  });

  it("a roll interrupted WITHOUT a terminal row (hostd killed mid-roll) is not retried after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-rollout-crash-"));
    // Roll child never resolves — simulates hostd dying mid-canary (no
    // terminal handler ever runs, only the launch-time latch exists).
    const h1 = makeServer(failingRun, dir);
    (h1.server as unknown as { runSwitchroom: () => Promise<RunResult> }).runSwitchroom =
      () => new Promise<RunResult>(() => {});
    const first = await h1.startAutoRollout("v1.0.1");
    expect(first.started).toBe(true);
    const h2 = makeServer(failingRun, dir);
    const retry = await h2.startAutoRollout("v1.0.1");
    expect(retry.started).toBe(false);
    expect(retry.reason).toMatch(/did not complete/);
    expect(h2.calls).toHaveLength(0);
  });

  it("a GREEN roll clears the durable latch (next daemon can roll again)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-rollout-green-"));
    const green = (args: string[]): RunResult => ({
      exit_code: 0,
      stdout:
        args[0] === "rollout"
          ? encodeRolloutResultLine({
              ok: true,
              rolled: ["test-harness", "overlord", "clerk"],
              warnings: [],
            }) + "\n"
          : "",
      stderr: "",
    });
    const h1 = makeServer(green, dir);
    await h1.startAutoRollout("v1.0.1");
    await waitForTerminal(h1);
    const h2 = makeServer(green, dir);
    // Same pin again from a fresh daemon: no latch left behind, so the
    // roll STARTS (the version-compare quiesce lives upstream in checkFn).
    const again = await h2.startAutoRollout("v1.0.1");
    expect(again.started).toBe(true);
  });
});

// A watcher-initiated roll has no caller agent, so the failure alert can only
// reach the operator through a privileged agent's gateway relay. If that
// lookup returns null the alert is DROPPED — an unattended rollback with no
// human notified. Two ways that used to happen: a fleet whose sole privileged
// agent is declared `root: true` (the newer tier) rather than `admin: true`,
// and yaml key order deciding the target non-deterministically.
describe("privileged-agent alert target resolution", () => {
  function target(agents: Record<string, unknown>): string | null {
    const dir = mkdtempSync(join(tmpdir(), "auto-rollout-admin-"));
    const server = new HostdServer({
      homeDir: dir,
      agentUids: {},
      config: { agents },
      auditLogPath: join(dir, "audit.log"),
      selfVersion: "v99.0.0",
      allowNonLinux: true,
    } as unknown as ServerOptions);
    return (
      server as unknown as { firstAdminAgentName: () => string | null }
    ).firstAdminAgentName();
  }

  it("resolves an admin agent", () => {
    expect(target({ plain: {}, overlord: { admin: true } })).toBe("overlord");
  });

  it("also accepts a root-tier agent (alert is not dropped on a root-only fleet)", () => {
    expect(target({ plain: {}, boss: { root: true } })).toBe("boss");
  });

  it("is deterministic — name order, not yaml key order", () => {
    expect(target({ zeta: { admin: true }, alpha: { admin: true } })).toBe("alpha");
    expect(target({ alpha: { admin: true }, zeta: { admin: true } })).toBe("alpha");
  });

  it("returns null when no agent is privileged", () => {
    expect(target({ a: {}, b: { admin: false } })).toBeNull();
    expect(target({})).toBeNull();
  });
});

describe("startAutoRollout — fleet-mutation lock", () => {
  it("refuses while a roll is already in flight", async () => {
    let release!: (r: RunResult) => void;
    const pending = new Promise<RunResult>((res) => {
      release = res;
    });
    const posted: RolloutTerminalNotice[] = [];
    const dir = mkdtempSync(join(tmpdir(), "auto-rollout-lock-"));
    const server = new HostdServer({
      homeDir: dir,
      agentUids: {},
      config: { agents: { overlord: { admin: true } } },
      auditLogPath: join(dir, "audit.log"),
      selfVersion: "v99.0.0",
      allowNonLinux: true,
      rolloutRelay: { postTerminal: (n: RolloutTerminalNotice) => posted.push(n) },
    } as unknown as ServerOptions);
    const s = server as unknown as {
      missingApplyAssets: () => string[];
      runSwitchroom: () => Promise<RunResult>;
      startAutoRollout: Harness["startAutoRollout"];
    };
    s.missingApplyAssets = () => [];
    s.runSwitchroom = () => pending;
    const first = await s.startAutoRollout("v1.0.1");
    expect(first.started).toBe(true);
    const second = await s.startAutoRollout("v1.0.2");
    expect(second.started).toBe(false);
    expect(second.reason).toMatch(/fleet-mutation lock/);
    release({
      exit_code: 0,
      stdout: encodeRolloutResultLine({ ok: true, rolled: [], warnings: [] }) + "\n",
      stderr: "",
    });
    await vi.waitFor(() => {
      expect(posted.length).toBeGreaterThan(0);
    });
  });
});
