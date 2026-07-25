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
 * ## Where the journal lives — and why NOT beside the config
 *
 * The journal MUST outlive the container that wrote it, because "hostd was
 * recreated mid-roll" is the primary case it exists for. It therefore lives in
 * the switchroom state directory (`<homedir()>/.switchroom`), which is a
 * **directory** bind mount on every path that runs a roll:
 *
 *   - host shell — `homedir()` is the operator's home, so this is literally
 *     `~/.switchroom`, the same directory `findConfigFile` searches;
 *   - inside hostd — `hostd.ts` pins `HOME: /host-home` in the compose it
 *     generates, and `/host-home/.switchroom` is bind-mounted from the
 *     operator's `~/.switchroom`. Durable by construction.
 *
 * An earlier draft put the journal beside the config (`dirname(configPath)`).
 * That is correct on the host shell and **silently wrong inside hostd**: the
 * config there is a SINGLE-FILE bind mount (`~/.switchroom/switchroom.yaml` →
 * `/state/config/switchroom.yaml`), so `/state/config` the *directory* is the
 * container's writable overlay. The journal landed at
 * `/state/config/.switchroom.yaml.rollout-pin-journal.json`, existed nowhere on
 * the host, and died with the container — making the hostd-boot recovery site
 * below dead code on exactly the path this module is aimed at. (The same
 * single-file mount is why `rollout.ts` carries an in-place-rewrite fallback
 * for EBUSY/EXDEV/EINVAL on the config.)
 *
 * Because both writers now share ONE directory, the filename is keyed by a
 * digest of the absolute config path the writer sees — `/state/config/…`
 * inside hostd, `~/.switchroom/…` on the host shell — so the two never share a
 * journal. That matters: a shared journal would let a failing roll revert to
 * the OTHER roll's `priorPin` and delete its journal, after which the other
 * roll commits a no-op and reports success while the durable pin names the
 * wrong version. {@link beginPinPersist} additionally refuses to open a second
 * journal for the same config while the first writer is demonstrably alive, so
 * two rolls against the same config path cannot interleave either.
 *
 * ## Why liveness + freshness
 *
 * A journal on disk means "a pin write is uncommitted", NOT "the writer is
 * dead". A hostd restart mid-roll (the host-shell path refreshes hostd as its
 * last step; a self-bump recreates it outright) would otherwise make boot
 * recovery revert the pin of a roll that is still running, or that already
 * succeeded. So recovery reverts only when the journal is **stale**:
 *
 *   - the recording process is gone ({@link isJournalWriterAlive}), **or**
 *   - the journal is older than {@link PIN_JOURNAL_MAX_AGE_MS}.
 *
 * `isJournalWriterAlive` is deliberately NOT a bare `kill(pid, 0)`. The pid is
 * recorded inside a container, PID namespaces restart at 1, so a recreated
 * hostd's process tree occupies the same low pid range — a bare probe answers
 * "alive" for an unrelated process essentially always, precisely in the
 * recreate case that triggers recovery. It therefore pairs the liveness probe
 * with the process's **start time** (`/proc/<pid>/stat` field 22 against
 * `/proc/stat:btime`), the same PID-reuse defence `vault/flock.ts` uses for the
 * vault writer lock: a process that started AFTER the journal was written is
 * not the journal's writer, whatever its pid says.
 *
 * The age check is the backstop *within* a recovery pass, for the residual
 * cases start time cannot resolve (non-Linux, unreadable /proc — both treated
 * conservatively as alive). It is NOT a periodic sweep: all three sites below
 * are one-shot, so "the journal will eventually age out" only means "the next
 * time one of these sites runs, age alone is enough". Nothing re-checks on a
 * timer, and this module does not claim otherwise.
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
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join, basename, resolve, dirname } from "node:path";
import {
  getReleasePinFromConfig,
  setReleasePinInConfig,
  deleteReleasePinInConfig,
} from "./release-yaml.js";
import { pidStartTimeMs } from "../vault/flock.js";

/**
 * Age past which a journal is considered abandoned even if
 * {@link isJournalWriterAlive} could not rule its writer out (a `/proc` we
 * cannot read, a non-Linux host, an undateable journal — all treated
 * conservatively as alive).
 *
 * This bounds how long a recovery pass will defer to an unresolvable writer.
 * It is NOT a promise that an abandoned pin self-heals on a timer: every
 * recovery site is one-shot (see the module header), so the age check only
 * takes effect the next time one of them runs.
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
  /**
   * pid of the process that wrote the provisional pin. Only meaningful when
   * paired with {@link RolloutPinJournal.at} — see {@link isJournalWriterAlive}.
   */
  pid: number;
  /**
   * ISO timestamp of the begin. Doubles as the freshness backstop AND the
   * reference point for the start-time / PID-reuse check.
   */
  at: string;
}

/** Name of the switchroom state directory, under the operator's home. */
const STATE_DIR_NAME = ".switchroom";

/**
 * Directory the journal is written into: the switchroom state dir.
 *
 * This is the DURABLE, bind-mounted directory on every path that runs a roll.
 * See the module header for why it must NOT be `dirname(configPath)` in
 * general: inside hostd the config is a single-file bind mount, so its parent
 * directory is container-ephemeral and a journal written there cannot survive
 * the recreate it exists to recover from.
 *
 * Precedence:
 *
 *   1. `SWITCHROOM_PIN_JOURNAL_DIR` — a test seam, and an operator escape
 *      hatch for a host whose state dir is elsewhere.
 *   2. the config's own directory when it IS a `.switchroom` dir. This is the
 *      host-shell case (`~/.switchroom/switchroom.yaml`), and taking it from
 *      the config rather than `homedir()` removes the one ambiguity here:
 *      `switchroom rollout` is documented "run with sudo", and whether sudo
 *      leaves `HOME` as the operator's or resets it to `/root` is sudoers
 *      policy. It never matches inside hostd, whose config dir is
 *      `/state/config`.
 *   3. `<homedir()>/.switchroom` — the hostd case, where `hostd.ts` pins
 *      `HOME: /host-home` in the compose it generates and
 *      `/host-home/.switchroom` is bind-mounted from the operator's
 *      `~/.switchroom`. Durable by construction.
 */
export function pinJournalDir(configPath?: string): string {
  const override = process.env.SWITCHROOM_PIN_JOURNAL_DIR;
  if (override && override.trim().length > 0) return override.trim();
  if (configPath) {
    const dir = dirname(resolve(configPath));
    if (basename(dir) === STATE_DIR_NAME) return dir;
  }
  return join(homedir(), STATE_DIR_NAME);
}

/**
 * Journal path for a given config: `<state dir>/.rollout-pin-journal.<key>.json`.
 *
 * Dot-prefixed so it is never mistaken for a config variant by the state dir's
 * `*.yaml` globs, and keyed by a digest of the ABSOLUTE config path rather than
 * co-located with it. The key is what keeps the hostd writer
 * (`/state/config/switchroom.yaml`) and a host-shell writer
 * (`~/.switchroom/switchroom.yaml`) on separate journals now that they share
 * one directory — see the module header for the concurrent-roll damage a
 * shared journal would cause. The config's basename is kept in the name purely
 * so an operator listing the directory can tell what a journal belongs to.
 */
export function pinJournalPath(configPath: string): string {
  const abs = resolve(configPath);
  const key = createHash("sha256").update(abs).digest("hex").slice(0, 12);
  return join(pinJournalDir(abs), `.rollout-pin-journal.${basename(abs)}.${key}.json`);
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
 * Slop for the start-time comparison. The journal's `at` is stamped after the
 * writer process started (it reads the config first), so a genuine writer's
 * start time is always <= `at`. 100ms absorbs the 1-tick (10ms at USER_HZ=100)
 * granularity of `/proc/<pid>/stat` start times — same tolerance
 * `vault/flock.ts` uses for the identical check.
 */
const START_TIME_SLOP_MS = 100;

/**
 * Is the process that WROTE this journal still running?
 *
 * A bare `kill(pid, 0)` is not an answer here. The pid is recorded inside a
 * container; PID namespaces start at 1, so recorded pids are small (tens) and
 * after a container recreate the new process tree occupies the same low range.
 * `isPidAlive(37)` then hits an unrelated live process and recovery declines —
 * systematically, in exactly the recreate case recovery exists for.
 *
 * So the pid probe is paired with a start-time discriminator: if the process
 * currently at `journal.pid` started AFTER the journal was written, the pid was
 * reused (or belongs to a different container's tree) and the writer is gone.
 * This is `vault/flock.ts`'s `pidIsOriginalHolder` defence, reusing the same
 * `pidStartTimeMs` implementation rather than a second copy of the /proc parse.
 *
 * Conservative on unknown, in both directions: an unreadable `/proc` or an
 * undateable journal returns true (treat as alive). Refusing to revert leaves a
 * stale pin an operator can fix by hand; reverting a LIVE roll's pin actively
 * fights the roll. {@link isJournalFresh} is the backstop for those cases.
 *
 * `startTimeMs` is injectable so tests can assert the recreate case without
 * needing a real recycled pid.
 */
export function isJournalWriterAlive(
  journal: RolloutPinJournal,
  startTimeMs: (pid: number) => number | null = pidStartTimeMs,
): boolean {
  if (!isPidAlive(journal.pid)) return false;
  const started = startTimeMs(journal.pid);
  if (started === null) return true; // cannot tell — conservative
  const writtenAt = Date.parse(journal.at);
  if (!Number.isFinite(writtenAt)) return true; // cannot tell — conservative
  return started <= writtenAt + START_TIME_SLOP_MS;
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
 * **Exclusive.** If a journal for this config already exists and its writer is
 * demonstrably alive, this THROWS rather than overwriting it. Two rolls sharing
 * one journal is not a benign race: the loser's revert restores the winner's
 * `priorPin` and deletes the journal, after which the winner commits a no-op
 * and reports `ok:true` while the durable pin names the wrong version — worse
 * than having no journal at all. A journal whose writer is gone (or which has
 * aged out) is overwritten with a warning; blocking every future roll on a
 * crashed predecessor's file would be its own outage.
 *
 * Throws only if the config is unreadable, a live roll holds the journal, or
 * the journal cannot be written — in each case the caller must NOT proceed
 * with the pin write, since an unjournalled pin write is exactly the defect
 * this module prevents.
 */
export function beginPinPersist(
  configPath: string,
  pin: string,
  opts: { warn?: (msg: string) => void; now?: number } = {},
): RolloutPinJournal {
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m));
  const p = pinJournalPath(configPath);

  const existing = readPinJournal(configPath, warn);
  if (existing) {
    const now = opts.now ?? Date.now();
    if (isJournalWriterAlive(existing) && isJournalFresh(existing, now)) {
      throw new Error(
        `rollout pin journal: ${p} is held by a LIVE roll (pid ${existing.pid}, ` +
          `provisional pin ${existing.pin}, started ${existing.at}). Refusing to ` +
          `start a second provisional pin write against ${configPath} — two ` +
          `concurrent rolls sharing one journal can leave the durable ` +
          `\`release.pin\` naming the wrong version. Wait for that roll to ` +
          `finish, or delete the journal host-side if you know it is dead.`,
      );
    }
    warn(
      `⚠️  rollout pin journal: overwriting an ABANDONED journal at ${p} ` +
        `(pid ${existing.pid} recorded ${existing.at}, provisional pin ` +
        `${existing.pin}). Its roll never committed or reverted; \`release.pin\` ` +
        `in ${configPath} may still name that unproven build — verify it.\n`,
    );
  }

  const priorPin = getReleasePinFromConfig(readFileSync(configPath, "utf8"));
  const journal: RolloutPinJournal = {
    v: 1,
    configPath,
    pin,
    ...(priorPin ? { priorPin } : {}),
    pid: process.pid,
    at: new Date().toISOString(),
  };
  // The state dir exists on every real host (it holds switchroom.yaml), but a
  // journal write must never be the thing that fails a roll on a fresh box.
  mkdirSync(dirname(p), { recursive: true });
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
    startTimeMs?: (pid: number) => number | null;
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
    if (
      isJournalWriterAlive(journal, opts.startTimeMs ?? pidStartTimeMs) &&
      isJournalFresh(journal, now)
    ) {
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
    startTimeMs?: (pid: number) => number | null;
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
      `that wrote it still looks live (its pid is running, its process start ` +
      `time predates the journal, and the journal is under ` +
      `${PIN_JOURNAL_MAX_AGE_MS / 60000}min old).`
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
