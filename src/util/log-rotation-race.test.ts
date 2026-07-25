/**
 * log-rotation — the two interleavings the lock exists for (#3600
 * re-review, findings 1 and 4).
 *
 * `log-rotation-lock.test.ts` asserts the right OUTCOMES but never
 * reaches the mechanisms it credits: with the active file at 0 bytes the
 * top-level `overCap` guard returns before the lock is taken, and its
 * "interleaved" case is sequential and single-process. Real concurrency
 * in a test is either flaky or slow, so instead we drive the exact
 * interleaving deterministically: `node:fs` is mocked so a hook fires
 * INSIDE `withRotateLock`, at the precise syscall where the peer's action
 * must land. What the hook does is what a second process really does.
 *
 * Both tests fail against the pre-fix code:
 *  - drop the under-lock size re-check and the first one clobbers `.1`;
 *  - restore `unlink` + `open(wx)` as the stale reclaim and the second
 *    one enters the critical section while a peer holds the lock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as realFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Fires immediately before the named syscall inside log-rotation.ts. */
const hooks = vi.hoisted(() => ({
  beforeRename: undefined as ((from: string) => void) | undefined,
  beforeOpen: undefined as ((p: string, flags: string) => void) | undefined,
  beforeUnlink: undefined as ((p: string) => void) | undefined,
  beforeStat: undefined as ((p: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    renameSync: (from: realFs.PathLike, to: realFs.PathLike) => {
      hooks.beforeRename?.(String(from));
      return actual.renameSync(from, to);
    },
    unlinkSync: (p: realFs.PathLike) => {
      hooks.beforeUnlink?.(String(p));
      return actual.unlinkSync(p);
    },
    openSync: (p: realFs.PathLike, flags: string, mode?: number) => {
      hooks.beforeOpen?.(String(p), flags);
      return actual.openSync(p, flags, mode);
    },
    statSync: ((p: realFs.PathLike, o?: realFs.StatSyncOptions) => {
      hooks.beforeStat?.(String(p));
      return actual.statSync(p, o);
    }) as unknown as typeof realFs.statSync,
  };
});

const { maybeRotateLogFile, rotateLogFile } = await import("./log-rotation.js");

let dir: string;
let log: string;
let lock: string;

const HISTORY = "REAL HISTORY — must survive\n";
const CAP = 1024;

beforeEach(() => {
  dir = realFs.mkdtempSync(path.join(os.tmpdir(), "rotrace-"));
  log = path.join(dir, "events.jsonl");
  lock = `${log}.rotate.lock`;
  hooks.beforeRename = undefined;
  hooks.beforeOpen = undefined;
  hooks.beforeUnlink = undefined;
  hooks.beforeStat = undefined;
});

afterEach(() => {
  hooks.beforeRename = undefined;
  hooks.beforeOpen = undefined;
  hooks.beforeUnlink = undefined;
  hooks.beforeStat = undefined;
  realFs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Age our LIVE lock past the stale threshold (i.e. our rotation overran),
 * then run a second process end to end: it EEXISTs, judges the lock
 * stale, park-verify-claims it, rotates, and appends fresh rows
 * afterwards. This is the whole of H1 — it needs no third process.
 */
function peerReclaimsAndRotates(maxFiles: number, appended: string): void {
  const old = Date.now() / 1000 - 300;
  realFs.utimesSync(lock, old, old);
  maybeRotateLogFile(log, { maxBytes: CAP, maxFiles, tag: "peer", lock: true });
  realFs.appendFileSync(log, appended);
}

describe("the under-lock size re-check (finding 4)", () => {
  it("declines to rotate a file a peer rotated while we waited for the lock", () => {
    // Real shape: over cap at our first stat, EMPTY by the time we hold
    // the lock. Without the re-check we copy those zero bytes over `.1`
    // and shift a full generation of events off the end of the window.
    realFs.writeFileSync(log, "x".repeat(CAP * 4));
    realFs.writeFileSync(`${log}.1`, HISTORY);

    let peerRan = false;
    hooks.beforeOpen = (p, flags) => {
      // The instant we are about to take the lock, the peer finishes its
      // own rotation: `.1` becomes the peer's snapshot, active truncated.
      if (p !== lock || flags !== "wx" || peerRan) return;
      peerRan = true;
      realFs.writeFileSync(`${log}.1`, HISTORY);
      realFs.truncateSync(log, 0);
    };

    const rotated = maybeRotateLogFile(log, {
      maxBytes: CAP,
      maxFiles: 2,
      tag: "t",
      lock: true,
    });

    expect(peerRan).toBe(true); // the interleaving really happened
    expect(rotated).toBe(false);
    expect(realFs.readFileSync(`${log}.1`, "utf8")).toBe(HISTORY);
    expect(realFs.existsSync(`${log}.2`)).toBe(false); // no shift happened
  });
});

describe("stale-lock reclaim is mutually exclusive (finding 1)", () => {
  it("does NOT enter the critical section when a peer reclaimed first", () => {
    realFs.writeFileSync(log, "x".repeat(CAP * 4));
    realFs.writeFileSync(`${log}.1`, HISTORY);

    // A lock left by a killed rotator, well past the stale threshold.
    realFs.writeFileSync(lock, "");
    const old = Date.now() / 1000 - 300;
    realFs.utimesSync(lock, old, old);

    // Fire on whichever syscall the implementation uses to get the stale
    // lock out of the way — `rename` now, `unlink` in the pre-fix code —
    // so this test is version-agnostic and really does bite both.
    let peerLockIno = -1;
    const peerReclaims = (p: string) => {
      if (p !== lock || peerLockIno !== -1) return;
      // Between our staleness decision and that syscall, a peer completes
      // the same reclaim and is now HOLDING a fresh lock. Pre-fix, our
      // unlink removed exactly this file and our create then succeeded —
      // two rotators, which is the failure the lock exists to prevent.
      realFs.rmSync(lock, { force: true });
      realFs.closeSync(realFs.openSync(lock, "wx", 0o600));
      peerLockIno = realFs.statSync(lock).ino;
    };
    hooks.beforeRename = peerReclaims;
    hooks.beforeUnlink = peerReclaims;

    const rotated = maybeRotateLogFile(log, {
      maxBytes: CAP,
      maxFiles: 2,
      tag: "t",
      lock: true,
    });

    expect(peerLockIno).not.toBe(-1); // the interleaving really happened
    expect(rotated).toBe(false); // we did NOT run alongside the peer
    // The peer's lock is intact — same inode, still held.
    expect(realFs.existsSync(lock)).toBe(true);
    expect(realFs.statSync(lock).ino).toBe(peerLockIno);
    // And nothing rotated behind the peer's back.
    expect(realFs.readFileSync(`${log}.1`, "utf8")).toBe(HISTORY);
    expect(realFs.statSync(log).size).toBe(CAP * 4);
    // No parked debris left behind.
    expect(
      realFs.readdirSync(dir).filter((f) => f.includes(".stale.")),
    ).toEqual([]);
  });

  it("still reclaims a genuinely stale lock when no peer intervenes", () => {
    realFs.writeFileSync(log, "x".repeat(CAP * 4));
    realFs.writeFileSync(lock, "");
    const old = Date.now() / 1000 - 300;
    realFs.utimesSync(lock, old, old);

    const rotated = maybeRotateLogFile(log, {
      maxBytes: CAP,
      maxFiles: 2,
      tag: "t",
      lock: true,
    });

    expect(rotated).toBe(true);
    expect(realFs.statSync(`${log}.1`).size).toBe(CAP * 4);
    expect(realFs.statSync(log).size).toBe(0);
    expect(realFs.existsSync(lock)).toBe(false); // released
  });

  it("sweeps park files a crashed reclaim stranded (L2)", () => {
    // A crash between the reclaim's `rename` and its cleanup `unlink`
    // leaves `<lock>.stale.<pid>.<rand>` behind forever — nothing else
    // globs that name. A successful reclaim must collect the aged ones.
    realFs.writeFileSync(log, "x".repeat(CAP * 4));
    realFs.writeFileSync(lock, "");
    const old = Date.now() / 1000 - 300;
    realFs.utimesSync(lock, old, old);

    // Two leaked parks from earlier crashes, both past the threshold.
    const leaked = [`${lock}.stale.999.aaaaaaaa`, `${lock}.stale.998.bbbbbbbb`];
    for (const f of leaked) {
      realFs.writeFileSync(f, "");
      realFs.utimesSync(f, old, old);
    }
    // A park younger than the threshold — a peer may be mid-reclaim with
    // it, so it must survive.
    const fresh = `${lock}.stale.997.cccccccc`;
    realFs.writeFileSync(fresh, "");
    // Neighbours that do NOT carry the park prefix. Both are older than
    // the threshold, which is the whole point: the sweep's eligibility
    // test is age, so the ONLY thing keeping them alive is the prefix
    // guard. `<log>.1` is the previous generation and `webhook.sock` is
    // the gateway's socket — both really do sit in this directory.
    const neighbour = `${log}.1`;
    realFs.writeFileSync(neighbour, HISTORY);
    realFs.utimesSync(neighbour, old, old);
    const sock = path.join(dir, "webhook.sock");
    realFs.writeFileSync(sock, "");
    realFs.utimesSync(sock, old, old);

    expect(
      maybeRotateLogFile(log, {
        maxBytes: CAP,
        maxFiles: 3,
        tag: "t",
        lock: true,
      }),
    ).toBe(true);

    for (const f of leaked) expect(realFs.existsSync(f)).toBe(false);
    expect(realFs.existsSync(fresh)).toBe(true);
    expect(realFs.existsSync(sock)).toBe(true);
    // `<log>.1` was SHIFTED to `.2`, not destroyed. Asserting the bytes at
    // `.2` is what makes this bite: rotation recreates `.1` unconditionally
    // (log-rotation.ts, `copyFileSync(logPath, snapshotPath)`), so
    // `existsSync(<log>.1)` is true whether or not the sweep ate the
    // original (#3600 round-4, L2).
    expect(realFs.readFileSync(`${log}.2`, "utf8")).toBe(HISTORY);
    expect(realFs.statSync(`${log}.1`).size).toBe(CAP * 4);
    // And our own park did not survive either.
    expect(
      realFs.readdirSync(dir).filter((f) => f.includes(".stale.")),
    ).toEqual([path.basename(fresh)]);
  });

  it("a failing sweep never breaks the reclaim (L2)", () => {
    realFs.writeFileSync(log, "x".repeat(CAP * 4));
    realFs.writeFileSync(lock, "");
    const old = Date.now() / 1000 - 300;
    realFs.utimesSync(lock, old, old);

    const leaked = `${lock}.stale.999.aaaaaaaa`;
    realFs.writeFileSync(leaked, "");
    realFs.utimesSync(leaked, old, old);

    // The park vanishes under the sweep (a peer reaped it first): the
    // unlink throws ENOENT and must be swallowed, not escape the reclaim.
    hooks.beforeUnlink = (p) => {
      if (p === leaked) realFs.rmSync(leaked, { force: true });
    };

    expect(
      maybeRotateLogFile(log, {
        maxBytes: CAP,
        maxFiles: 2,
        tag: "t",
        lock: true,
      }),
    ).toBe(true);
    expect(realFs.statSync(`${log}.1`).size).toBe(CAP * 4);
    expect(realFs.statSync(log).size).toBe(0);
  });

  it("release does not delete a lock that is no longer ours", () => {
    // We overran the stale threshold and a peer reclaimed while we were
    // inside; the identity-guarded release must not unlink the peer's
    // lock on the way out (that would leave the log with NO lock).
    realFs.writeFileSync(log, "x".repeat(CAP * 4));
    realFs.writeFileSync(`${log}.1`, HISTORY);

    let peerIno = -1;
    hooks.beforeRename = (from) => {
      if (from !== `${log}.1` || peerIno !== -1) return;
      realFs.unlinkSync(lock);
      realFs.closeSync(realFs.openSync(lock, "wx", 0o600));
      peerIno = realFs.statSync(lock).ino;
    };

    // We now DECLINE as well as release safely (#3600 round-4, H1): once
    // the lock is the peer's, finishing the rotation is the clobber. The
    // release guard is what this test is about, and it still holds.
    expect(
      maybeRotateLogFile(log, {
        maxBytes: CAP,
        maxFiles: 2,
        tag: "t",
        lock: true,
      }),
    ).toBe(false);

    expect(peerIno).not.toBe(-1);
    expect(realFs.existsSync(lock)).toBe(true);
    expect(realFs.statSync(lock).ino).toBe(peerIno);
  });
});

/**
 * H1 (#3600 round-4). The reclaim cannot tell "stale because the holder
 * died" from "stale because the holder is slow": the lock mtime is
 * stamped once by `open(wx)` and never refreshed, so a LIVE holder that
 * overruns the threshold is reclaimable by a peer, at TWO writers. The
 * close is not to prevent that but to make the loser harmless — every
 * destructive syscall in `rotateLogFile` re-asserts the lock inode.
 *
 * Each test lands the peer at a different point in the victim's rotation
 * and asserts the OUTCOME: the reclaimer's snapshot, the shifted history,
 * and the rows the reclaimer's writers appended all survive.
 */
describe("a reclaimed holder does not clobber the reclaimer (H1)", () => {
  const BODY = "x".repeat(CAP * 4);
  const NEW = "ROWS WRITTEN AFTER THE PEER ROTATED\n".repeat(64);

  it("declines outright when the peer rotated before we touched anything", () => {
    realFs.writeFileSync(log, BODY);
    realFs.writeFileSync(`${log}.1`, HISTORY);

    // Fire on the UNDER-LOCK size re-check — we hold the lock, we have
    // destroyed nothing yet. The peer rotates and its writers append
    // enough to put us back over cap, so the re-check passes and the
    // inode guard is what has to stop us.
    let stats = 0;
    hooks.beforeStat = (p) => {
      if (p !== log) return;
      if (++stats !== 2) return;
      hooks.beforeStat = undefined;
      peerReclaimsAndRotates(2, NEW);
    };

    const rotated = maybeRotateLogFile(log, {
      maxBytes: CAP,
      maxFiles: 2,
      tag: "victim",
      lock: true,
    });

    expect(stats).toBeGreaterThanOrEqual(2); // the interleaving happened
    expect(rotated).toBe(false);
    expect(realFs.readFileSync(`${log}.1`, "utf8")).toBe(BODY); // peer's snapshot
    expect(realFs.readFileSync(`${log}.2`, "utf8")).toBe(HISTORY); // shifted, not dropped
    expect(realFs.readFileSync(log, "utf8")).toBe(NEW); // not re-truncated
  });

  it("does not shift the peer's fresh .1 off the end of the window", () => {
    // `.1` absent, `.2` present: our first destructive syscall is the
    // oldest-generation unlink, and the peer lands on it. By the time we
    // reach the shift loop, `.1` is the peer's brand-new snapshot.
    realFs.writeFileSync(log, BODY);
    realFs.writeFileSync(`${log}.2`, "OLDEST\n");

    let fired = false;
    hooks.beforeUnlink = (p) => {
      if (p !== `${log}.2` || fired) return;
      fired = true;
      hooks.beforeUnlink = undefined;
      peerReclaimsAndRotates(2, NEW);
    };

    const rotated = maybeRotateLogFile(log, {
      maxBytes: CAP,
      maxFiles: 2,
      tag: "victim",
      lock: true,
    });

    expect(fired).toBe(true);
    expect(rotated).toBe(false);
    expect(realFs.readFileSync(`${log}.1`, "utf8")).toBe(BODY); // still `.1`
    expect(realFs.readFileSync(log, "utf8")).toBe(NEW);
  });

  it("does not copy over the peer's .1", () => {
    // The peer lands inside our shift rename — i.e. in the documented
    // check→syscall gap, so that ONE rename proceeds unserialized and
    // moves the peer's `.1` to `.2`. The next checkpoint must catch it:
    // no zero-byte `.1` may be created over the peer's snapshot, and the
    // rows its writers appended must survive.
    realFs.writeFileSync(log, BODY);
    realFs.writeFileSync(`${log}.1`, HISTORY);

    let fired = false;
    hooks.beforeRename = (from) => {
      if (from !== `${log}.1` || fired) return;
      fired = true;
      hooks.beforeRename = undefined;
      peerReclaimsAndRotates(2, NEW);
    };

    const rotated = maybeRotateLogFile(log, {
      maxBytes: CAP,
      maxFiles: 2,
      tag: "victim",
      lock: true,
    });

    expect(fired).toBe(true);
    expect(rotated).toBe(false);
    expect(realFs.existsSync(`${log}.1`)).toBe(false); // no copy happened
    expect(realFs.readFileSync(`${log}.2`, "utf8")).toBe(BODY); // peer's snapshot
    expect(realFs.readFileSync(log, "utf8")).toBe(NEW);
  });

  it("does not truncate rows written after the peer's rotation", () => {
    // The peer lands on the snapshot fsync — after our copy, before our
    // truncate. Truncating now would destroy rows that belong to the
    // peer's already-completed cycle, not ours.
    realFs.writeFileSync(log, BODY);

    let fired = false;
    hooks.beforeOpen = (p, flags) => {
      if (p !== `${log}.1` || flags !== "r" || fired) return;
      fired = true;
      hooks.beforeOpen = undefined;
      peerReclaimsAndRotates(2, NEW);
    };

    const rotated = maybeRotateLogFile(log, {
      maxBytes: CAP,
      maxFiles: 2,
      tag: "victim",
      lock: true,
    });

    expect(fired).toBe(true);
    expect(rotated).toBe(false);
    expect(realFs.readFileSync(log, "utf8")).toBe(NEW); // rows intact
    expect(realFs.readFileSync(`${log}.1`, "utf8")).toBe(BODY);
  });

  it("a rotator that lost the lock touches nothing at all", () => {
    // Unit-level: the predicate is false from the first call, so every
    // generation and the active file must be byte-identical afterwards.
    realFs.writeFileSync(log, BODY);
    realFs.writeFileSync(`${log}.1`, HISTORY);
    realFs.writeFileSync(`${log}.2`, "OLDEST\n");

    expect(rotateLogFile(log, 2, "victim", () => false)).toBe(false);

    expect(realFs.readFileSync(log, "utf8")).toBe(BODY);
    expect(realFs.readFileSync(`${log}.1`, "utf8")).toBe(HISTORY);
    expect(realFs.readFileSync(`${log}.2`, "utf8")).toBe("OLDEST\n");
  });

  it("rotates normally when the lock is still ours", () => {
    // The guard must not be a blanket refusal: the ordinary path still
    // rotates, and an absent predicate (unlocked callers) is unaffected.
    realFs.writeFileSync(log, BODY);
    expect(rotateLogFile(log, 2, "t", () => true)).toBe(true);
    expect(realFs.readFileSync(`${log}.1`, "utf8")).toBe(BODY);
    expect(realFs.statSync(log).size).toBe(0);
  });
});
