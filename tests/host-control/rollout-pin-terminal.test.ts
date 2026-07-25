/**
 * hostd's rollout TERMINAL handler vs. the durable pin journal.
 *
 * The terminal handler runs a pin-journal recovery pass on every roll that
 * finishes. Recovery REVERTS `release.pin` to the journal's `priorPin` — which
 * is right for a child that died mid-roll and catastrophic for a child that
 * SUCCEEDED and merely failed to unlink its journal afterwards (`commitPin`
 * returns that error rather than throwing, so the roll still reports ok:true
 * and exits 0).
 *
 * These assert the OUTCOME on a real config file: after the terminal, what does
 * `release.pin` say, and is the journal still there? A test that only checked
 * "recovery was called" would pass on the bug.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

const { HostdServer, resolveHostdConfigPath, HOSTD_FALLBACK_CONFIG_PATH } =
  await import("../../src/host-control/server.js");
import type { ServerOptions } from "../../src/host-control/server.js";
import { encodeRolloutResultLine } from "../../src/cli/rollout.js";
import { pinJournalPath } from "../../src/cli/rollout-pin-journal.js";
import { findConfigFile } from "../../src/config/loader.js";
import { getReleasePinFromConfig } from "../../src/cli/release-yaml.js";
import type { RolloutTerminalNotice } from "../../src/host-control/rollout-relay.js";

const PRIOR_PIN = "v1.0.0";
const TARGET = "v2.0.0";

/**
 * A pid that cannot be alive, so the journal reads as ABANDONED and the
 * stale gate does NOT protect us. That is the production shape at a terminal:
 * the child that wrote the journal has exited.
 */
const DEAD_PID = 0x3fffffff;

function config(pin: string): string {
  return `telegram:\n  bot_token: x\nrelease:\n  pin: ${pin}\nagents:\n  clerk:\n    extends: default\n`;
}

interface Harness {
  configPath: string;
  posted: RolloutTerminalNotice[];
  entry: Record<string, unknown>;
  pin: () => string | undefined;
  journalExists: () => boolean;
  spawnRollout: (args: string[]) => void;
}

/**
 * A server whose config is a tmpdir file and whose rollout child is stubbed to
 * return `stdout` verbatim — the sentinel line is what the terminal handler
 * parses, so that string IS the roll's outcome.
 */
function makeServer(child: { stdout: string; exit_code: number }): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pin-terminal-"));
  const configPath = join(dir, "switchroom.yaml");
  writeFileSync(configPath, config(TARGET), "utf8"); // the provisional write already landed
  const posted: RolloutTerminalNotice[] = [];
  const server = new HostdServer({
    homeDir: dir,
    configPath,
    agentUids: {},
    config: { agents: { "test-harness": {}, overlord: { admin: true } } },
    auditLogPath: join(dir, "audit.log"),
    selfVersion: "v99.0.0",
    allowNonLinux: true,
    rolloutRelay: {
      postTerminal: (n) => {
        posted.push(n);
      },
    },
  } as unknown as ServerOptions);
  const s = server as unknown as {
    runSwitchroom: (
      args: string[],
      env?: Record<string, string>,
      onLine?: (l: string) => void,
    ) => Promise<{ exit_code: number; stdout: string; stderr: string }>;
    spawnRollout: (args: string[], entry: Record<string, unknown>) => void;
  };
  s.runSwitchroom = async () => ({ ...child, stderr: "" });
  const entry: Record<string, unknown> = {
    request_id: "req-pin-terminal",
    verb: "rollout",
    caller: { kind: "agent", name: "overlord" },
    result: "started",
    started_at: Date.now(),
    pin: TARGET,
    prior_pin: PRIOR_PIN,
  };
  return {
    configPath,
    posted,
    entry,
    pin: () => getReleasePinFromConfig(readFileSync(configPath, "utf8")),
    journalExists: () => existsSync(pinJournalPath(configPath)),
    spawnRollout: (args) => s.spawnRollout(args, entry),
  };
}

/** Plant the journal a dead child left behind: pin written, never committed. */
function plantOrphanJournal(configPath: string): void {
  writeFileSync(
    pinJournalPath(configPath),
    JSON.stringify({
      v: 1,
      configPath,
      pin: TARGET,
      priorPin: PRIOR_PIN,
      pid: DEAD_PID,
      at: new Date().toISOString(),
    }),
    "utf8",
  );
}

beforeEach(() => {
  process.env.SWITCHROOM_PIN_JOURNAL_DIR = mkdtempSync(
    join(tmpdir(), "pin-terminal-state-"),
  );
  loadConfigMock.mockReset();
  loadConfigMock.mockReturnValue({
    agents: { "test-harness": {}, overlord: { admin: true } },
    release: { pin: PRIOR_PIN },
  });
});

afterEach(() => {
  delete process.env.SWITCHROOM_PIN_JOURNAL_DIR;
});

describe("rollout terminal — a PROVEN pin is never reverted", () => {
  it("deletes (does not act on) a journal that outlived a SUCCESSFUL roll", async () => {
    // The production sequence: canary green, every agent rolled, the child's
    // own `commitPinPersist` FAILED to unlink the journal (EIO / read-only
    // state dir / a directory at the journal path — a state this repo's own
    // suite constructs). `commitPin` RETURNS that as a warning rather than
    // throwing, so the roll is ok:true and exits 0 with the journal still on
    // disk. The child is now dead, so the stale gate offers no protection.
    const h = makeServer({
      exit_code: 0,
      stdout:
        encodeRolloutResultLine({
          ok: true,
          rolled: ["test-harness", "overlord"],
          warnings: ["rollout pin journal: FAILED to clear …"],
        }) + "\n",
    });
    plantOrphanJournal(h.configPath);

    h.spawnRollout(["rollout", "--pin", TARGET]);
    await vi.waitFor(() => expect(h.posted.length).toBeGreaterThan(0));

    // THE outcome: the pin the roll PROVED survives. Reverting it here would
    // tell the operator the roll succeeded while the durable pin named the
    // prior version, and every later reconcile would drag the fleet back.
    expect(h.pin()).toBe(TARGET);
    // …and the debris is gone, so hostd's next BOOT recovery — which has no
    // sentinel to consult and only the stale gate — can't revert it later.
    expect(h.journalExists()).toBe(false);
    expect(h.entry.result).toBe("completed");
    expect(String(h.entry.stderr_tail ?? "")).toMatch(/outlived a SUCCESSFUL roll/);
  });

  it("still REVERTS when the roll structurally failed", async () => {
    // The case the terminal recovery exists for, unchanged.
    const h = makeServer({
      exit_code: 1,
      stdout:
        encodeRolloutResultLine({
          ok: false,
          rolled: ["test-harness"],
          failedStep: "restart-agent",
          failedAgent: "overlord",
          warnings: [],
        }) + "\n",
    });
    plantOrphanJournal(h.configPath);

    h.spawnRollout(["rollout", "--pin", TARGET]);
    await vi.waitFor(() => expect(h.posted.length).toBeGreaterThan(0));

    expect(h.pin()).toBe(PRIOR_PIN);
    expect(h.journalExists()).toBe(false);
  });

  it("REVERTS when the child died with NO sentinel, even on exit 0", async () => {
    // `entry.result` is inferred from the exit code when no sentinel was
    // emitted, so it reads "completed" here — which is exactly why the gate is
    // keyed on the SENTINEL, not on `entry.result`. Nothing proved this roll,
    // so the uncommitted pin must not stand.
    const h = makeServer({ exit_code: 0, stdout: "no sentinel here\n" });
    plantOrphanJournal(h.configPath);

    h.spawnRollout(["rollout", "--pin", TARGET]);
    await vi.waitFor(() => expect(h.posted.length).toBeGreaterThan(0));

    expect(h.entry.result).toBe("completed");
    expect(h.pin()).toBe(PRIOR_PIN);
    expect(h.journalExists()).toBe(false);
  });

  it("is a silent no-op on a successful roll that left NO journal", async () => {
    // The normal case: the child committed its own pin. Nothing to clear, and
    // nothing added to the operator-facing tail.
    const h = makeServer({
      exit_code: 0,
      stdout:
        encodeRolloutResultLine({
          ok: true,
          rolled: ["test-harness", "overlord"],
          warnings: [],
        }) + "\n",
    });

    h.spawnRollout(["rollout", "--pin", TARGET]);
    await vi.waitFor(() => expect(h.posted.length).toBeGreaterThan(0));

    expect(h.pin()).toBe(TARGET);
    expect(h.journalExists()).toBe(false);
    expect(String(h.entry.stderr_tail ?? "")).not.toMatch(/rollout pin journal/);
  });
});

describe("resolveHostdConfigPath — hostd and its rollout child must agree", () => {
  const saved = process.env.SWITCHROOM_CONFIG;
  afterEach(() => {
    if (saved === undefined) delete process.env.SWITCHROOM_CONFIG;
    else process.env.SWITCHROOM_CONFIG = saved;
  });

  it("computes the SAME journal path the rollout child does", () => {
    // Not a cosmetic agreement. The journal FILENAME is a digest of the
    // absolute config path, so a daemon that resolves a different string than
    // its child looks for a journal that does not exist — at boot and at every
    // rollout terminal — and silently recovers nothing. The old `dirname()`
    // scheme degraded to "same directory, wrong name"; digest keying degrades
    // to invisible.
    //
    // The child resolves via `getConfigPath` → `findConfigFile()` →
    // `$SWITCHROOM_CONFIG`. A hardcoded `/state/config/switchroom.yaml` on the
    // daemon side agrees with that only by coincidence of today's deployment.
    const dir = mkdtempSync(join(tmpdir(), "hostd-configpath-"));
    const cfg = join(dir, "switchroom.yaml");
    writeFileSync(cfg, config(PRIOR_PIN), "utf8");
    process.env.SWITCHROOM_CONFIG = cfg;

    expect(resolveHostdConfigPath()).toBe(findConfigFile());
    expect(pinJournalPath(resolveHostdConfigPath())).toBe(pinJournalPath(findConfigFile()));
    expect(resolveHostdConfigPath()).not.toBe(HOSTD_FALLBACK_CONFIG_PATH);
  });

  it("prefers an explicit configPath over the environment", () => {
    process.env.SWITCHROOM_CONFIG = "/somewhere/else/switchroom.yaml";
    expect(resolveHostdConfigPath("/explicit/switchroom.yaml")).toBe(
      "/explicit/switchroom.yaml",
    );
  });

  it("falls back to the container path only when nothing else resolves", () => {
    // `findConfigFile()` THROWS when it finds nothing, and a throw out of a
    // boot path or a rollout `.finally()` would be worse than a
    // wrong-but-conventional guess — so the literal survives as the LAST arm,
    // never the first.
    delete process.env.SWITCHROOM_CONFIG;
    let expected: string;
    try {
      expected = findConfigFile();
    } catch {
      expected = HOSTD_FALLBACK_CONFIG_PATH;
    }
    expect(resolveHostdConfigPath()).toBe(expected);
  });
});
