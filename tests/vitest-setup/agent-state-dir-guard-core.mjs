/**
 * agent-state-dir-guard-core — the runner-agnostic body of the guard.
 *
 * Split out of `agent-state-dir-guard.mjs` for the same reason as
 * `auth-net-guard-core.mjs`: ONE implementation, loaded by every runner (a
 * vitest `setupFiles` entry AND a `bun test` `preload` entry) and read by the
 * lint gate (`scripts/check-agent-state-dir-hermeticity.mjs`). Two copies would
 * eventually disagree about what "isolated" means, which is how a defect class
 * regrows one runner at a time.
 *
 * See `agent-state-dir-guard.mjs` for the defect class this closes.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every env var that names a directory a gateway/runtime module WRITES agent
 * state into. Each one must be redirected, or a test that reaches that writer
 * lands in a live agent's bind-mounted state dir:
 *
 *   SWITCHROOM_AGENT_STATE_DIR   turns.jsonl (gateway `emitTurnRecord`),
 *                                context-occupancy snapshot, blocked-approval
 *                                fallback record
 *   SWITCHROOM_RUNTIME_STATE_DIR runtime-metrics.jsonl
 *                                (telegram-plugin/runtime-metrics.ts) and the
 *                                analytics-id fallback
 *                                (telegram-plugin/analytics-posthog.ts)
 *
 * Deliberately NOT listed: `SWITCHROOM_AGENT_SCHEDULER_LOCK` / `_JSONL`. Those
 * name READ-only probe inputs (`telegram-plugin/gateway/boot-probes.ts` only
 * calls `fs.exists`/read on them, and every probe test injects `opts.lockPath`
 * plus a fake fs), so they cannot pollute agent state; redirecting them would
 * change what the existing probe suites observe for no hermeticity gain.
 */
export const GUARDED_STATE_DIR_VARS = [
  "SWITCHROOM_AGENT_STATE_DIR",
  "SWITCHROOM_RUNTIME_STATE_DIR",
];

/**
 * ONE tmp root for every guard dir, with a per-PID child inside it.
 *
 * Not `mkdtemp`. This guard loads once per test PROCESS, and vitest's
 * `pool: "forks"` starts a fresh worker per file batch, so a random-suffix dir
 * per load leaves N empty dirs per `vitest run` that nothing ever removes —
 * a hermeticity guard that trades a state leak for a tmp leak. A per-PID name
 * under a single root is instead self-reaping: `reapStaleGuardDirs` deletes
 * every child whose PID is no longer alive at the start of each run, so litter
 * is bounded by the number of CURRENTLY RUNNING test processes rather than
 * growing forever. (Cleanup on process exit is registered too, but neither
 * runner reliably fires JS exit hooks in a killed worker — the reaper is the
 * mechanism that actually holds.)
 *
 * The root is keyed by UID. `/tmp` is shared: this host runs several agents
 * plus root-owned sessions against the same checkout, and a plain
 * `switchroom-test-agent-state` created by the first user is 0700 — every
 * OTHER user's test run then dies with EACCES inside the guard, i.e. the
 * hermeticity guard becomes a cross-user denial of service. One root per uid
 * removes the collision instead of relying on permissive modes.
 */
export const GUARD_TMP_ROOT = join(
  tmpdir(),
  `switchroom-test-agent-state-${process.getuid?.() ?? "u"}`,
);

/** Does a PID belong to a live process? `EPERM` means it exists but is owned
 *  by someone else — alive, and not ours to delete. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Delete guard dirs left by test processes that have since exited. Returns the
 * names removed. Best-effort: a dir owned by another user simply stays.
 *
 * Non-numeric children are left alone — this owns only what it created.
 */
export function reapStaleGuardDirs(root = GUARD_TMP_ROOT, isAlive = pidAlive) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return []; // root absent ⇒ nothing to reap
  }
  const reaped = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid || isAlive(pid)) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      reaped.push(name);
    } catch {
      /* best-effort */
    }
  }
  return reaped;
}

/**
 * Point every guarded state-dir var at a per-process tmpdir unless the test
 * process already chose one (an explicit override is always respected).
 *
 * Returns the directory in use, or null when every var was already set (so
 * nothing was created).
 */
export function installAgentStateDirGuard(env = process.env, root = GUARD_TMP_ROOT) {
  const missing = GUARDED_STATE_DIR_VARS.filter((k) => !env[k]);
  if (missing.length === 0) return null;

  reapStaleGuardDirs(root);

  let dir = join(root, String(process.pid));
  try {
    // Start clean: a recycled PID must not inherit a previous run's files.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  } catch {
    // The per-uid root is unusable (odd perms, tmpfs quirk, a file in the way).
    // Fall back to a random dir rather than throwing: a guard that aborts the
    // whole test run is worse than one that leaves a stray tmp dir. If THIS
    // throws too, tmpdir() is unusable and the run cannot be hermetic — let it
    // propagate rather than silently leave the writers pointed at /state/agent.
    dir = mkdtempSync(join(tmpdir(), "switchroom-test-agent-state-fallback-"));
  }
  for (const k of missing) env[k] = dir;

  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort — never fail a test run over tmp cleanup */
    }
  });
  return dir;
}
