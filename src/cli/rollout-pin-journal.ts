/**
 * Durable pin journal — makes the rollout's `release.pin` write **provisional
 * until the roll is proven**.
 *
 * ## The bug this closes
 *
 * `planRollout` emits a `persist-pin` step (first on the host-shell path,
 * just-after-the-canary on the hostd path). Once that step ran, the durable
 * pin in `switchroom.yaml` IS the target version — permanently, even if the
 * roll then fails. `executeRollout` returns `ok:false` and nothing reverts it,
 * and hostd's `recoverFailedAutoRollout` explicitly declines to act on
 * past-canary failures ("Past-canary failures are NOT auto-rolled-back",
 * `src/host-control/server.ts`). From that moment every later `agent restart`,
 * crash-loop recreate, reconcile or `docker compose up -d` reads the broken
 * pin and converges the *remaining* agents onto a build that demonstrably
 * failed to boot: the fleet drifts toward broken instead of staying
 * mixed-but-working.
 *
 * ## The mechanism
 *
 * Persisting the pin is a two-phase commit:
 *
 *   1. **begin** — before rewriting `switchroom.yaml`, write a journal file
 *      next to it recording *which pin* is being written, *which pin it
 *      replaces*, the writing process's **pid**, and the time. Then write the
 *      new pin.
 *   2. **commit** — only when the whole roll returned `ok:true`, delete the
 *      journal. The pin is now durable.
 *   3. **rollback** — on any failure return, make a **targeted** edit that
 *      restores `release.pin` to `priorPin` (or deletes it when there was
 *      none), then clear the journal.
 *
 * ## Why targeted, not a snapshot restore
 *
 * An earlier draft stored the byte-exact prior config and restored it
 * wholesale. That is the mirror image of the bug it fixes: on the hostd path
 * the provisional write lands right after the canary and the remaining agents
 * take minutes, so a rollback commonly runs long after the write — and after a
 * crash, arbitrarily later. Any config edit made in that window (an operator
 * adding an agent, an approved `config_propose_edit`, a vault reference
 * change) would be silently reverted. The journal therefore carries only the
 * pin values, and the revert touches only `release.pin`.
 *
 * ## Why liveness + freshness
 *
 * A journal on disk means "a pin write is uncommitted", NOT "the writer is
 * dead". A hostd restart mid-roll (the host-shell path refreshes hostd as its
 * last step; a self-bump recreates it outright) would otherwise make boot
 * recovery revert the pin of a roll that is still running, or that already
 * succeeded. So recovery reverts only when the journal is **stale**:
 *
 *   - the recording pid is no longer alive (`isPidAlive`), **or**
 *   - the journal is older than {@link PIN_JOURNAL_MAX_AGE_MS}.
 *
 * This mirrors the sibling self-bump marker mechanism
 * (`parsePendingRolloutMarker` / `isMarkerFresh` in `host-control/self-bump.ts`),
 * deliberately: the same "did the thing that wrote this survive?" question,
 * answered the same way. The pid check alone is not enough — a recreated
 * hostd's pid can collide with the recorded one — so age is the backstop.
 *
 * The crash case is the reason this is a *file* and not an in-memory
 * try/finally: if the rollout process is SIGKILLed (or hostd is recreated
 * under it) between step 1 and step 2, the journal survives on disk. Any of
 * the three recovery sites then reverts it:
 *
 *   - hostd startup — covers "hostd died mid-roll";
 *   - hostd's rollout terminal handler — covers "the roll child died mid-roll
 *     while hostd survived" (no sentinel, so the outcome was never captured);
 *   - the start of the next `switchroom rollout` — covers the host-shell path.
 *
 * A committed roll leaves no journal, so recovery is a no-op in the happy
 * case. Recovery is idempotent and best-effort: it never throws into a caller.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import {
  getReleasePinFromConfig,
  setReleasePinInConfig,
  deleteReleasePinInConfig,
} from "./release-yaml.js";

/**
 * Age past which a journal is considered abandoned even if its pid still
 * resolves (pids are recycled, and a recreated hostd can land on the old one).
 *
 * 15 minutes, matching `SELF_BUMP_MARKER_MAX_AGE_MS` in
 * `host-control/self-bump.ts` — the same question about the same subsystem
 * should not have two different answers. A staggered fleet roll is minutes,
 * not tens of minutes; a journal older than this is not a roll in progress.
 */
export const PIN_JOURNAL_MAX_AGE_MS = 15 * 60 * 1000;

/** Journal schema. Records pin VALUES only — never a config snapshot. */
export interface RolloutPinJournal {
  v: 1;
  /** Absolute path of the config the pin was written into. */
  configPath: string;
  /** The pin that was provisionally written. */
  pin: string;
  /** The pin in effect before the write. Absent = the config was unpinned. */
  priorPin?: string;
  /** pid of the process that wrote the provisional pin (liveness probe). */
  pid: number;
  /** ISO timestamp of the begin (freshness backstop). */
  at: string;
}

/**
 * Journal path for a given config. Sits beside the config (same directory,
 * so the same mount/ownership rules apply) and is dot-prefixed so it is never
 * mistaken for a config variant by the `*.yaml` globs.
 */
export function pinJournalPath(configPath: string): string {
  return join(dirname(configPath), `.${basename(configPath)}.rollout-pin-journal.json`);
}

/** True when an uncommitted provisional pin write is on disk. */
export function hasPinJournal(configPath: string): boolean {
  return existsSync(pinJournalPath(configPath));
}

/**
 * Is `pid` a live process? `kill(pid, 0)` throws ESRCH when it is not, and
 * EPERM when it exists but is owned by another user — EPERM therefore means
 * ALIVE. Treats an unknown error as alive: refusing to revert is the safe
 * default (a stale pin is recoverable by hand; a wrongly-reverted pin on a
 * live roll actively fights the roll).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Is this journal still plausibly owned by a running roll? Mirrors
 * `isMarkerFresh` (host-control/self-bump.ts). An unparseable timestamp is
 * treated as NOT fresh — a journal we cannot date is a journal we cannot
 * trust to be in-flight.
 */
export function isJournalFresh(journal: RolloutPinJournal, nowMs: number): boolean {
  const created = Date.parse(journal.at);
  if (!Number.isFinite(created)) return false;
  return nowMs - created < PIN_JOURNAL_MAX_AGE_MS;
}

/**
 * Read + validate the journal.
 *
 * Returns null when absent. A journal that EXISTS but is unreadable or
 * malformed is a **loud** condition, not a silent no-op: it means a pin write
 * may be uncommitted with no way to tell what to revert to, which an operator
 * must know about. The `warn` sink is invoked in that case (and defaults to
 * stderr) before null is returned.
 */
export function readPinJournal(
  configPath: string,
  warn: (msg: string) => void = (m) => process.stderr.write(m),
): RolloutPinJournal | null {
  const p = pinJournalPath(configPath);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    if (existsSync(p)) {
      warn(
        `⚠️  rollout pin journal: ${p} exists but could not be read ` +
          `(${(e as Error).message}). A provisional \`release.pin\` may be ` +
          `uncommitted — verify it host-side before the next reconcile.\n`,
      );
    }
    return null;
  }
  const bad = (why: string): null => {
    warn(
      `⚠️  rollout pin journal: ${p} is unusable (${why}). A rollout may have ` +
        `left an unproven \`release.pin\` in ${configPath} that CANNOT be ` +
        `auto-reverted — check it host-side, then delete the journal file.\n`,
    );
    return null;
  };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return bad(`not valid JSON: ${(e as Error).message}`);
  }
  if (typeof obj !== "object" || obj === null) return bad("not a JSON object");
  const o = obj as Record<string, unknown>;
  if (o.v !== 1) return bad(`unknown schema version ${JSON.stringify(o.v)}`);
  if (typeof o.configPath !== "string") return bad("missing configPath");
  if (typeof o.pin !== "string") return bad("missing pin");
  if (typeof o.pid !== "number") return bad("missing pid");
  if (typeof o.at !== "string") return bad("missing timestamp");
  return {
    v: 1,
    configPath: o.configPath,
    pin: o.pin,
    ...(typeof o.priorPin === "string" ? { priorPin: o.priorPin } : {}),
    pid: o.pid,
    at: o.at,
  };
}

/**
 * Phase 1 — record the pin being provisionally written, and what it replaces.
 *
 * Written atomically (tmp + rename) so a crash mid-write can never leave a
 * truncated journal that recovery would have to guess about.
 *
 * Throws only if the config is unreadable or the journal cannot be written —
 * in which case the caller must NOT proceed with the pin write either, since
 * an unjournalled pin write is exactly the defect this module prevents.
 */
export function beginPinPersist(configPath: string, pin: string): RolloutPinJournal {
  const priorPin = getReleasePinFromConfig(readFileSync(configPath, "utf8"));
  const journal: RolloutPinJournal = {
    v: 1,
    configPath,
    pin,
    ...(priorPin ? { priorPin } : {}),
    pid: process.pid,
    at: new Date().toISOString(),
  };
  const p = pinJournalPath(configPath);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(journal), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, p);
  return journal;
}

/**
 * Phase 2 — the roll succeeded; the pin is durable.
 *
 * Returns an error message when the journal could NOT be removed and still
 * exists. That is not cosmetic: a journal that survives a successful commit is
 * exactly the input that makes the next boot revert a *proven* pin, so the
 * caller must surface it. A journal that is simply already gone is a success
 * (commit is idempotent).
 */
export function commitPinPersist(configPath: string): string | null {
  const p = pinJournalPath(configPath);
  try {
    unlinkSync(p);
    return null;
  } catch (e) {
    if (!existsSync(p)) return null; // already gone — idempotent success
    return (
      `rollout pin journal: FAILED to clear ${p} after a SUCCESSFUL roll ` +
      `(${(e as Error).message}). Delete it host-side — while it exists, ` +
      `recovery may revert a proven \`release.pin\`.`
    );
  }
}

/** Outcome of a rollback attempt, for operator-facing notes. */
export interface PinRollbackOutcome {
  /** True when a journal existed and `release.pin` was reverted. */
  reverted: boolean;
  /** The provisional pin that was rolled back (when reverted). */
  pin?: string;
  /** The pin restored — absent means the pin was deleted (was unpinned). */
  priorPin?: string;
  /** Set when the journal was left alone because its writer looks alive. */
  skippedLive?: boolean;
  /** Set when a journal existed but the revert failed. */
  error?: string;
}

/**
 * Phase 3 — revert the provisional pin with a targeted `release.pin` edit,
 * then clear the journal.
 *
 * Never throws: a failed revert is reported in the outcome so the caller can
 * surface it to the operator. Callable at any time — a no-op (and cheap) when
 * no journal exists, which is what makes it safe to run unconditionally.
 *
 * `opts.requireStale` is what recovery sites pass: it declines to revert while
 * the recording process is still alive AND the journal is young, so a hostd
 * restart mid-roll cannot revert a roll that is still running (or has already
 * succeeded but not yet committed). The rollout's OWN failure path leaves it
 * false — that caller *is* the writer and knows the roll is over.
 *
 * `writeConfig` is injectable so the production caller can route through the
 * hardened atomic/ownership-preserving writer while tests stay hermetic.
 */
export function rollbackPinPersist(
  configPath: string,
  opts: {
    requireStale?: boolean;
    writeConfig?: (path: string, text: string, mode: number) => void;
    warn?: (msg: string) => void;
    now?: number;
  } = {},
): PinRollbackOutcome {
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m));
  const journal = readPinJournal(configPath, warn);
  if (!journal) return { reverted: false };

  // A journal written for a DIFFERENT config is not ours to act on. (Same
  // directory, different file — e.g. a config path that moved between runs.)
  if (journal.configPath !== configPath) {
    warn(
      `⚠️  rollout pin journal: journal records configPath=${journal.configPath} ` +
        `but recovery is running against ${configPath}. Refusing to revert.\n`,
    );
    return { reverted: false, pin: journal.pin, error: "configPath mismatch" };
  }

  if (opts.requireStale) {
    const now = opts.now ?? Date.now();
    if (isPidAlive(journal.pid) && isJournalFresh(journal, now)) {
      return { reverted: false, pin: journal.pin, skippedLive: true };
    }
  }

  try {
    const current = readFileSync(configPath, "utf8");
    const next = journal.priorPin
      ? setReleasePinInConfig(current, journal.priorPin)
      : deleteReleasePinInConfig(current);
    let mode = 0o600;
    try {
      mode = statSync(configPath).mode & 0o777;
    } catch {
      /* config missing/unreadable — fall back to owner-only */
    }
    if (opts.writeConfig) {
      opts.writeConfig(configPath, next, mode);
    } else {
      writeFileSync(configPath, next, { encoding: "utf8", mode });
    }
  } catch (e) {
    return {
      reverted: false,
      pin: journal.pin,
      ...(journal.priorPin ? { priorPin: journal.priorPin } : {}),
      error: (e as Error).message,
    };
  }
  const commitErr = commitPinPersist(configPath);
  if (commitErr) warn(`⚠️  ${commitErr}\n`);
  return {
    reverted: true,
    pin: journal.pin,
    ...(journal.priorPin ? { priorPin: journal.priorPin } : {}),
  };
}

/**
 * Crash recovery entry point. Reverts an uncommitted provisional pin left by
 * a rollout that died between the pin write and the roll's terminal, and
 * returns a human-readable note (null when there was nothing to do).
 *
 * Always stale-gated — every caller of this is a recovery site that may be
 * running *concurrently* with a live roll.
 *
 * Best-effort by contract — callers wire this into startup paths where a
 * throw would be worse than a stale pin, so it swallows everything.
 */
export function recoverPinJournal(
  configPath: string,
  opts: {
    writeConfig?: (path: string, text: string, mode: number) => void;
    warn?: (msg: string) => void;
    now?: number;
  } = {},
): string | null {
  let outcome: PinRollbackOutcome;
  try {
    outcome = rollbackPinPersist(configPath, { ...opts, requireStale: true });
  } catch (e) {
    return `rollout pin journal: recovery threw (${(e as Error).message}) — verify \`release.pin\` in ${configPath} host-side.`;
  }
  if (outcome.skippedLive) {
    return (
      `rollout pin journal: left release.pin=${outcome.pin} alone — the roll ` +
      `that wrote it still looks live (its process is running and the journal ` +
      `is under ${PIN_JOURNAL_MAX_AGE_MS / 60000}min old).`
    );
  }
  if (outcome.reverted) {
    return (
      `rollout pin journal: reverted an UNCOMMITTED release.pin=${outcome.pin} ` +
      `left by a rollout that did not complete` +
      (outcome.priorPin ? ` (restored ${outcome.priorPin})` : " (pin removed)") +
      `. The fleet keeps the prior pin so reconciles cannot converge onto an ` +
      `unproven build.`
    );
  }
  if (outcome.error) {
    return (
      `rollout pin journal: FAILED to revert an uncommitted release.pin=` +
      `${outcome.pin} (${outcome.error}). Check \`release.pin\` in ` +
      `${configPath} host-side before the next reconcile.`
    );
  }
  return null;
}
