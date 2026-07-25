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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

/**
 * How long before "now" this roll's child was spawned, in the fixture.
 *
 * Load-bearing, not decoration. The terminal attributes a journal by comparing
 * its `at` against `entry.started_at`, and the production shape is
 * `started_at < at < now`: no child can write a journal AFTER the terminal
 * that reads it has run. If the fixture stamped `started_at` at `Date.now()`,
 * {@link afterStart} would have to put `at` in the FUTURE — on the far side of
 * BOTH candidate discriminators — and the delete-path test could no longer
 * tell `entry.started_at` from `Date.now()` at the
 * `clearProvenRolloutPinJournal` call site: swap the argument there and the
 * suite would stay green with the regression fully live. Backdating the roll
 * puts `afterStart` strictly between the two, which is the only positioning
 * that discriminates.
 */
const ROLL_STARTED_AGO_MS = 60_000;

/** Where {@link afterStart} sits in that window: after the start, before now. */
const JOURNAL_WRITTEN_AGO_MS = 30_000;

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
  /** Run hostd's real boot path (registered for teardown). */
  start: () => Promise<void>;
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
  started.push(server);
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
    // Backdated on purpose — see ROLL_STARTED_AGO_MS. The terminal adjudicates
    // within milliseconds of this call, so a `Date.now()` stamp here would
    // collapse the `started_at` / `now` window that attribution is tested on.
    started_at: Date.now() - ROLL_STARTED_AGO_MS,
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
    start: () => server.start(),
  };
}

/** Every server built in this file, stopped in afterEach. */
const started: Array<{ stop(): Promise<void> }> = [];

/**
 * Plant the journal a dead child left behind: pin written, never committed.
 *
 * `at` is an EXPLICIT parameter because it is the attribution discriminator
 * the terminal uses. A journal written BETWEEN this roll's start and now is
 * this roll's own child's — its `commitPin` failed to unlink it, so the
 * terminal may clear it. (Both bounds matter: the child cannot have written it
 * before the child existed, and it cannot have written it after the terminal
 * reading it ran.) A journal written BEFORE the start is a PREDECESSOR's
 * orphan: this roll's child
 * journalled nothing (production `persistPin` no-ops when the config already
 * names the target), and clearing it destroys the only record that
 * `release.pin` names a build this roll never proved for the agents it did not
 * touch.
 */
function plantOrphanJournal(configPath: string, at: Date): void {
  writeFileSync(
    pinJournalPath(configPath),
    JSON.stringify({
      v: 1,
      configPath,
      pin: TARGET,
      priorPin: PRIOR_PIN,
      pid: DEAD_PID,
      at: at.toISOString(),
    }),
    "utf8",
  );
}

/**
 * A journal timestamp that unambiguously belongs to THIS roll's child: strictly
 * after `started_at` AND strictly before now, which is the only window a real
 * child could have written in. See {@link ROLL_STARTED_AGO_MS} for why landing
 * inside the window (rather than past its far edge) is what makes the
 * delete-path test discriminate.
 */
function afterStart(h: Harness): Date {
  const at = new Date(
    (h.entry.started_at as number) + (ROLL_STARTED_AGO_MS - JOURNAL_WRITTEN_AGO_MS),
  );
  // Guard the fixture itself: the production shape is started_at < at < now.
  expect(at.getTime()).toBeGreaterThan(h.entry.started_at as number);
  expect(at.getTime()).toBeLessThan(Date.now());
  return at;
}

/** A journal timestamp that unambiguously predates this roll. */
function beforeStart(h: Harness): Date {
  return new Date((h.entry.started_at as number) - 60_000);
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

afterEach(async () => {
  delete process.env.SWITCHROOM_PIN_JOURNAL_DIR;
  // Only servers that actually bound sockets need stopping; stop() is a no-op
  // otherwise. Draining here keeps a boot test from leaking listeners.
  while (started.length) await started.pop()!.stop().catch(() => undefined);
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
    plantOrphanJournal(h.configPath, afterStart(h));

    h.spawnRollout(["rollout", "--pin", TARGET]);
    await vi.waitFor(() => expect(h.posted.length).toBeGreaterThan(0));

    // THE outcome: the pin the roll PROVED survives. Reverting it here would
    // tell the operator the roll succeeded while the durable pin named the
    // prior version, and every later reconcile would drag the fleet back.
    expect(h.pin()).toBe(TARGET);
    // …and the debris is gone, so hostd's next BOOT recovery — which has no
    // sentinel to consult and only the stale gate — can't revert it later.
    // Deleting is correct HERE, and only here, because the journal is
    // attributable to this roll: `afterStart` puts its `at` INSIDE the roll's
    // own window — after `started_at`, before the terminal that is reading it
    // — which is the production shape (this roll's own child wrote it and then
    // failed to unlink it). That positioning is what makes this assertion
    // discriminating rather than decorative: `at` is on the near side of both
    // `started_at` and `now`, so passing `Date.now()` instead of
    // `entry.started_at` at the call site flips this journal to LEFT IN PLACE
    // and fails the expectation below. The sibling test pins the opposite
    // verdict for a journal that predates the roll.
    expect(h.journalExists()).toBe(false);
    expect(h.entry.result).toBe("completed");
    expect(String(h.entry.stderr_tail ?? "")).toMatch(/outlived a SUCCESSFUL roll/);
  });

  it("LEAVES a predecessor's orphan journal alone on a successful roll", async () => {
    // The undiscriminated delete: `hasPinJournal` → `commitPinPersist` with no
    // check that the journal belongs to this roll. A journal is NOT proof this
    // roll wrote one — the child journals only when it actually writes the pin
    // and no-ops when the config already names the target, which is precisely
    // the state a repeat/subset roll of an already-pinned version is in.
    //
    // hostd always passes `--pin` and may pass `--agents`, so this is the
    // subset roll: three of twelve agents proved, and the orphan journal is
    // the only record that `release.pin` names a build still unproven for the
    // other nine. Deleting it makes that permanently undetectable — the exact
    // damage the guard exists to prevent, arrived at from the other side.
    const h = makeServer({
      exit_code: 0,
      stdout:
        encodeRolloutResultLine({
          ok: true,
          rolled: ["test-harness"],
          warnings: [],
        }) + "\n",
    });
    plantOrphanJournal(h.configPath, beforeStart(h));

    h.spawnRollout(["rollout", "--pin", TARGET, "--agents", "test-harness"]);
    await vi.waitFor(() => expect(h.posted.length).toBeGreaterThan(0));

    // Never reverted — this roll succeeded, so the pin stands…
    expect(h.pin()).toBe(TARGET);
    // …but the evidence survives, and the operator is TOLD, through the same
    // structured surface the clear-path uses.
    expect(h.journalExists()).toBe(true);
    expect(h.entry.result).toBe("completed");
    expect(String(h.entry.stderr_tail ?? "")).toMatch(/LEFT IN PLACE/);
    expect(String(h.entry.stderr_tail ?? "")).not.toMatch(/outlived a SUCCESSFUL roll/);
  });

  it("LEAVES an UNREADABLE journal alone on a successful roll", async () => {
    // Attribution needs a parseable `at`. A journal that is corrupt (or whose
    // timestamp is garbage) cannot be attributed to this roll either, and the
    // safe verdict for "cannot attribute" must be LEAVE — deleting would turn
    // a loud, recoverable corruption into silence.
    const h = makeServer({
      exit_code: 0,
      stdout:
        encodeRolloutResultLine({ ok: true, rolled: ["test-harness"], warnings: [] }) +
        "\n",
    });
    writeFileSync(pinJournalPath(h.configPath), "{ not json", "utf8");

    h.spawnRollout(["rollout", "--pin", TARGET]);
    await vi.waitFor(() => expect(h.posted.length).toBeGreaterThan(0));

    expect(h.pin()).toBe(TARGET);
    expect(h.journalExists()).toBe(true);
    expect(String(h.entry.stderr_tail ?? "")).toMatch(/LEFT IN PLACE/);
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
    plantOrphanJournal(h.configPath, afterStart(h));

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
    plantOrphanJournal(h.configPath, afterStart(h));

    h.spawnRollout(["rollout", "--pin", TARGET]);
    await vi.waitFor(() => expect(h.posted.length).toBeGreaterThan(0));

    expect(h.entry.result).toBe("completed");
    expect(h.pin()).toBe(PRIOR_PIN);
    expect(h.journalExists()).toBe(false);
  });

  it("recovers a stale journal at BOOT — the call site, not just the helper", async () => {
    // `recoverPinJournal` itself is well covered in
    // `src/cli/rollout-pin-journal.test.ts`, but nothing exercised hostd's
    // BOOT call site: delete `this.recoverRolloutPinJournal("boot")` from
    // `start()` and the whole scoped suite stayed green. That call is the
    // crash net's only trigger after a SIGKILL/OOM/recreate killed the child
    // between the provisional pin write and its commit — with it gone, the
    // unproven pin stands and every later reconcile converges the fleet onto
    // a build that never booted.
    const h = makeServer({ exit_code: 0, stdout: "" });
    // Aged well past PIN_JOURNAL_MAX_AGE_MS and owned by a dead pid, so the
    // stale gate (which correctly protects a LIVE roll) opens.
    plantOrphanJournal(h.configPath, new Date(Date.now() - 60 * 60 * 1000));
    expect(h.pin()).toBe(TARGET);

    await h.start();

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
  const savedHome = process.env.HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.SWITCHROOM_CONFIG;
    else process.env.SWITCHROOM_CONFIG = saved;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  /**
   * The PRODUCTION wiring, not the helper.
   *
   * `main.ts` constructs `HostdServer` with **no** `configPath`, so every
   * recovery site inside the daemon reaches the resolver through the private
   * `hostdConfigPath()`. Testing the exported helper alone leaves that wire
   * unpinned: restore the pre-fix body
   * `return this.opts.configPath ?? "/state/config/switchroom.yaml";` and a
   * helper-only suite stays green with the defect fully back.
   */
  function serverConfigPath(configPath?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "hostd-wiring-"));
    const server = new HostdServer({
      homeDir: dir,
      ...(configPath ? { configPath } : {}),
      agentUids: {},
      config: { agents: { "test-harness": {} } },
      auditLogPath: join(dir, "audit.log"),
      selfVersion: "v99.0.0",
      allowNonLinux: true,
    } as unknown as ServerOptions);
    return (
      server as unknown as { hostdConfigPath(): string }
    ).hostdConfigPath();
  }

  it("routes a HostdServer with NO configPath through the resolver", () => {
    // Constructed the way production constructs it (`src/cli/main.ts` — no
    // `configPath`), which is the only shape where arms 2+ are reachable. The
    // whole rest of this suite passes an explicit path, so without this the
    // hardcoded container literal is restorable with a green suite.
    const dir = mkdtempSync(join(tmpdir(), "hostd-configpath-env-"));
    const cfg = join(dir, "switchroom.yaml");
    writeFileSync(cfg, config(PRIOR_PIN), "utf8");
    process.env.SWITCHROOM_CONFIG = cfg;

    expect(serverConfigPath()).toBe(cfg);
    expect(serverConfigPath()).toBe(findConfigFile());
    expect(serverConfigPath()).not.toBe(HOSTD_FALLBACK_CONFIG_PATH);
    // …and an explicit path still wins, so the arm order survives too.
    expect(serverConfigPath("/explicit/switchroom.yaml")).toBe(
      "/explicit/switchroom.yaml",
    );
  });

  it("DELEGATES to findConfigFile rather than reading $SWITCHROOM_CONFIG itself", () => {
    // The divergence a re-derived env arm reintroduces. `findConfigFile` takes
    // `$SWITCHROOM_CONFIG` only `if (existsSync(envPath))` and otherwise falls
    // through to cwd / `~/.switchroom`. An arm that returns `resolve(env)`
    // unconditionally — one arm ahead of `findConfigFile`, which is what this
    // function used to do — hands back a dangling path while the child
    // resolves a real file. The two hash to different journal names and the
    // recovery goes silently blind, which is the exact failure mode the
    // docstring's "MUST agree, string-for-string" claim asserts cannot happen.
    const home = mkdtempSync(join(tmpdir(), "hostd-configpath-home-"));
    mkdirSync(join(home, ".switchroom"));
    const real = join(home, ".switchroom", "switchroom.yaml");
    writeFileSync(real, config(PRIOR_PIN), "utf8");
    process.env.HOME = home;
    const dangling = join(
      mkdtempSync(join(tmpdir(), "hostd-configpath-gone-")),
      "nope",
      "switchroom.yaml",
    );
    expect(existsSync(dangling)).toBe(false);
    process.env.SWITCHROOM_CONFIG = dangling;
    // Guard the fixture: nothing in cwd may shadow the home config, or this
    // would pass for the wrong reason.
    expect(existsSync(join(process.cwd(), "switchroom.yaml"))).toBe(false);

    expect(findConfigFile()).toBe(real);
    expect(serverConfigPath()).toBe(real);
    expect(serverConfigPath()).not.toBe(dangling);
    expect(pinJournalPath(serverConfigPath())).toBe(pinJournalPath(findConfigFile()));
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
