import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GUARDED_STATE_DIR_VARS,
  GUARD_TMP_ROOT,
  installAgentStateDirGuard,
  reapStaleGuardDirs,
} from "./vitest-setup/agent-state-dir-guard-core.mjs";

/**
 * The runtime alarm for the vitest half of the state-dir hermeticity guard
 * (`scripts/check-agent-state-dir-hermeticity.mjs` is the static half).
 *
 * The guard exists because the gateway's turn-record writer hard-coded
 * `/state/agent/turns.jsonl`, which inside an agent container is a LIVE agent's
 * bind-mounted state dir — a characterization test appended 356 synthetic rows
 * into production turn records that the fleet-health sensor then scored as real
 * drift.
 */
describe("agent-state-dir guard — this vitest process is isolated", () => {
  it("guards every env var a gateway/runtime module WRITES agent state into", () => {
    // Spelled out literally, not derived from the export: the per-var tests
    // below iterate GUARDED_STATE_DIR_VARS, so deleting an entry would shrink
    // the loop and stay green. `SWITCHROOM_RUNTIME_STATE_DIR` is the second
    // writer family (telegram-plugin/runtime-metrics.ts `runtime-metrics.jsonl`,
    // analytics-posthog.ts's analytics-id fallback); dropping it re-opens the
    // same class one file at a time.
    expect([...GUARDED_STATE_DIR_VARS].sort()).toEqual([
      "SWITCHROOM_AGENT_STATE_DIR",
      "SWITCHROOM_RUNTIME_STATE_DIR",
    ]);
  });

  // The setup file (vitest.config.ts `setupFiles`) ran before this module was
  // imported. If it is unwired, these vars are unset and every writer defaults
  // to /state/agent.
  for (const k of GUARDED_STATE_DIR_VARS) {
    it(`${k} is set to a tmp dir, never a live agent state dir`, () => {
      const v = process.env[k];
      expect(v, `${k} unset — the setupFiles guard did not run`).toBeTruthy();
      expect(v).not.toBe("/state/agent");
      expect(v?.startsWith(tmpdir())).toBe(true);
      expect(existsSync(v as string)).toBe(true);
    });
  }
});

describe("installAgentStateDirGuard", () => {
  it("redirects every guarded var to one created dir", () => {
    const root = mkdtempSync(join(tmpdir(), "sr-guard-unit-"));
    const env: Record<string, string | undefined> = {};
    const dir = installAgentStateDirGuard(env, root);
    expect(dir).not.toBeNull();
    expect(existsSync(dir as string)).toBe(true);
    for (const k of GUARDED_STATE_DIR_VARS) expect(env[k]).toBe(dir);
  });

  it("never overrides a state dir the test process chose itself", () => {
    const root = mkdtempSync(join(tmpdir(), "sr-guard-unit-"));
    const env: Record<string, string | undefined> = {};
    for (const k of GUARDED_STATE_DIR_VARS) env[k] = "/chosen/by/the/test";
    expect(installAgentStateDirGuard(env, root)).toBeNull();
    for (const k of GUARDED_STATE_DIR_VARS) expect(env[k]).toBe("/chosen/by/the/test");
  });

  it("fills only the vars that are missing", () => {
    const root = mkdtempSync(join(tmpdir(), "sr-guard-unit-"));
    const [first, ...rest] = GUARDED_STATE_DIR_VARS;
    const env: Record<string, string | undefined> = { [first]: "/chosen" };
    const dir = installAgentStateDirGuard(env, root);
    expect(env[first]).toBe("/chosen");
    for (const k of rest) expect(env[k]).toBe(dir);
  });

  it("reaps dead-process dirs on install, so tmp litter cannot accumulate", () => {
    // Regression: the guard used to mkdtemp per worker with no cleanup, so
    // every `vitest run` left N empty dirs in /tmp forever.
    const root = mkdtempSync(join(tmpdir(), "sr-guard-unit-"));
    const dead = join(root, "999001");
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, "turns.jsonl"), "{}\n");

    installAgentStateDirGuard({}, root);
    expect(existsSync(dead)).toBe(false);
  });

  it("is keyed by UID, so two users sharing /tmp cannot lock each other out", () => {
    // A single shared root is created 0700 by whoever runs first; every other
    // user's run then dies with EACCES *inside the guard* — the hermeticity
    // guard turning into a cross-user denial of service. This host runs several
    // agents plus root sessions against the same checkout.
    expect(GUARD_TMP_ROOT).toBe(join(tmpdir(), `switchroom-test-agent-state-${process.getuid?.()}`));
  });

  it("falls back to a random dir instead of throwing when the root is unusable", () => {
    // Deterministic "unusable root" for ANY uid (including root): a regular
    // file where the directory should be — mkdir gives ENOTDIR/EEXIST.
    const parent = mkdtempSync(join(tmpdir(), "sr-guard-unit-"));
    const root = join(parent, "root-is-a-file");
    writeFileSync(root, "not a directory\n");
    const env: Record<string, string | undefined> = {};
    let dir: string | null = null;
    expect(() => {
      dir = installAgentStateDirGuard(env, root);
    }).not.toThrow();
    expect(dir).not.toBeNull();
    expect(existsSync(dir as unknown as string)).toBe(true);
    expect(dir as unknown as string).toContain("switchroom-test-agent-state-fallback-");
    for (const k of GUARDED_STATE_DIR_VARS) expect(env[k]).toBe(dir);
    rmSync(dir as unknown as string, { recursive: true, force: true });
  });
});

describe("reapStaleGuardDirs", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "sr-guard-unit-"));
    for (const n of ["100", "200", "not-a-pid"]) mkdirSync(join(root, n));
    mkdirSync(join(root, String(process.pid)), { recursive: true });
    return root;
  };

  it("removes only the dirs whose PID is gone", () => {
    const root = setup();
    const reaped = reapStaleGuardDirs(root, (pid) => pid === 200);
    expect(reaped).toEqual(["100"]);
    expect(existsSync(join(root, "100"))).toBe(false);
    expect(existsSync(join(root, "200"))).toBe(true);
  });

  it("never touches this process's own dir, or a non-PID name", () => {
    const root = setup();
    reapStaleGuardDirs(root, () => false);
    expect(existsSync(join(root, String(process.pid)))).toBe(true);
    expect(existsSync(join(root, "not-a-pid"))).toBe(true);
  });

  it("is a no-op when the root does not exist", () => {
    expect(reapStaleGuardDirs(join(tmpdir(), "sr-guard-absent-root-xyz"), () => false)).toEqual([]);
  });
});
