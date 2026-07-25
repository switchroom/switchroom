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
 * The file has grown past those two interleavings (H1 in round 4, the fd
 * premise in round 5, the four check→syscall gaps in round 6). Describe 1
 * is still the original single test; describe 2 has kept its original
 * first test and accumulated four more (the reclaim/sweep/release cases).
 * The two originals still fail against the pre-fix code:
 *  - drop the under-lock size re-check and "declines to rotate a file a
 *    peer rotated while we waited for the lock" clobbers `.1`;
 *  - restore `unlink` + `open(wx)` as the stale reclaim and "does NOT
 *    enter the critical section when a peer reclaimed first" enters the
 *    critical section while a peer holds the lock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as realFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Fires immediately before the named syscall inside log-rotation.ts.
 * `afterOpen` fires just after, because it needs the resulting fd — that
 * is how the M3 test learns which fd is the lock's. `afterStat` fires just
 * after, which is the only way to land a peer INSIDE a check→syscall gap
 * rather than before the check (round-6, H2).
 */
const hooks = vi.hoisted(() => ({
  beforeRename: undefined as ((from: string) => void) | undefined,
  beforeOpen: undefined as ((p: string, flags: string) => void) | undefined,
  afterOpen: undefined as
    | ((p: string, flags: string, fd: number) => void)
    | undefined,
  beforeUnlink: undefined as ((p: string) => void) | undefined,
  beforeStat: undefined as ((p: string) => void) | undefined,
  afterStat: undefined as ((p: string) => void) | undefined,
  beforeCopy: undefined as ((from: string, to: string) => void) | undefined,
  beforeTruncate: undefined as ((p: string) => void) | undefined,
  beforeClose: undefined as ((fd: number) => void) | undefined,
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
      const fd = actual.openSync(p, flags, mode);
      hooks.afterOpen?.(String(p), flags, fd);
      return fd;
    },
    copyFileSync: (from: realFs.PathLike, to: realFs.PathLike) => {
      hooks.beforeCopy?.(String(from), String(to));
      return actual.copyFileSync(from, to);
    },
    truncateSync: (p: realFs.PathLike, len?: number) => {
      hooks.beforeTruncate?.(String(p));
      return actual.truncateSync(p, len);
    },
    closeSync: (fd: number) => {
      hooks.beforeClose?.(fd);
      return actual.closeSync(fd);
    },
    statSync: ((p: realFs.PathLike, o?: realFs.StatSyncOptions) => {
      hooks.beforeStat?.(String(p));
      const s = actual.statSync(p, o);
      hooks.afterStat?.(String(p));
      return s;
    }) as unknown as typeof realFs.statSync,
  };
});

const { maybeRotateLogFile, rotateLogFile } = await import("./log-rotation.js");

let dir: string;
let log: string;
let lock: string;

const HISTORY = "REAL HISTORY — must survive\n";
const CAP = 1024;

function clearHooks(): void {
  hooks.beforeRename = undefined;
  hooks.beforeOpen = undefined;
  hooks.afterOpen = undefined;
  hooks.beforeUnlink = undefined;
  hooks.beforeStat = undefined;
  hooks.afterStat = undefined;
  hooks.beforeCopy = undefined;
  hooks.beforeTruncate = undefined;
  hooks.beforeClose = undefined;
}

beforeEach(() => {
  dir = realFs.mkdtempSync(path.join(os.tmpdir(), "rotrace-"));
  log = path.join(dir, "events.jsonl");
  lock = `${log}.rotate.lock`;
  clearHooks();
});

afterEach(() => {
  clearHooks();
  realFs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Age our LIVE lock past the stale threshold (i.e. our rotation overran),
 * then run a second process end to end: it EEXISTs, judges the lock
 * stale, park-verify-claims it, rotates, and appends fresh rows
 * afterwards. This is the whole of H1 — it needs no third process.
 *
 * `appended === ""` is the QUIET peer: it rotates and then writes nothing
 * for the moment we are looking at. That is the ordinary state of a
 * low-traffic log (the webhook event log goes minutes between events), and
 * it is a strictly worse victim for us than a busy peer — the active file
 * it leaves behind is zero bytes, so anything of ours that copies it
 * copies nothing (round-6, H1). Passing rows here is the EASY case; tests
 * that only pass rows mask the worst outcome.
 */
function peerReclaimsAndRotates(maxFiles: number, appended: string): void {
  const old = Date.now() / 1000 - 300;
  realFs.utimesSync(lock, old, old);
  maybeRotateLogFile(log, { maxBytes: CAP, maxFiles, tag: "peer", lock: true });
  if (appended) realFs.appendFileSync(log, appended);
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
 * and asserts the OUTCOME. What survives is NOT uniform, and these tests
 * pin the difference (#3600 round-5, M1; extended round-6). Read as a
 * table, the peer lands either before our first destructive syscall or in
 * one of the FOUR check→syscall gaps, and the four are not equivalent:
 *
 *   - before our first destructive syscall — nothing of ours ran, so the
 *     reclaimer's `.1`, the shifted history at `.2` and the rows its
 *     writers appended all survive ("declines outright…").
 *   - the unlink gap — the peer's freshly shifted history at `.2` is
 *     deleted ("…but the unlink gap destroys its shifted history").
 *   - the shift gap — `.1` ABSENT, `.2` the peer's snapshot: our
 *     unserialized `rename` moved its fresh `.1` to `.2` over the history
 *     that was there ("does not copy over the peer's .1").
 *   - the copy gap — worst of the four, and how bad depends on the PEER:
 *     with a busy peer, `.1` is a duplicate of the live file and the
 *     prior generation is gone ("loses a generation…"); with a QUIET peer
 *     we copy its freshly-truncated zero bytes and the log loses
 *     everything it has ("loses EVERY byte…", round-6 H1).
 *   - the truncate gap — the only one that destroys LIVE rows and the
 *     only one with no next checkpoint. Caught by a data-based gate for
 *     every landing before its stat ("declines the truncate when the peer
 *     rotated after our lock check"); the surviving window after that
 *     stat destroys the peer's rows and returns `true` ("destroys the
 *     peer's rows…", round-6 H2).
 *
 * So what these tests pin is much narrower than "all survive", and
 * narrower than round 5's "at worst one generation". They are asserted
 * rather than described so the residual in `log-rotation.ts` cannot drift
 * away from the behaviour — which is what rounds 3, 4, 5 and 6 each
 * caught it doing.
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

  it("does not shift the peer's fresh .1 off the end — but the unlink gap destroys its shifted history", () => {
    // The peer lands in the check→`unlinkSync` gap, our FIRST destructive
    // syscall. Two things to pin, and the second one is why this test's
    // fixture changed in round 6:
    //
    //   - the shift loop that runs after must NOT move the peer's fresh
    //     `.1` off the end of the window (the next checkpoint stops us);
    //   - the unlink itself already went through unserialized, and it is
    //     NOT harmless. Until round 6 this test seeded `.2` and NO `.1`,
    //     so the peer's own rotation had already removed `.2` by the time
    //     our unlink ran: it failed ENOENT and the test passed on an
    //     error path, asserting nothing about the gap. Seeding `.1` too
    //     means the peer's shift puts real history at `.2`, and our
    //     unguarded unlink deletes it — which is what actually happens.
    realFs.writeFileSync(log, BODY);
    realFs.writeFileSync(`${log}.1`, HISTORY);
    realFs.writeFileSync(`${log}.2`, "OLDEST\n");

    let fired = false;
    let doomed = "";
    hooks.beforeUnlink = (p) => {
      if (p !== `${log}.2` || fired) return;
      fired = true;
      hooks.beforeUnlink = undefined;
      peerReclaimsAndRotates(2, NEW);
      // What sits at `.2` at the instant our unlink executes. The peer's
      // rotation shifted HISTORY there; we are about to delete it.
      doomed = realFs.readFileSync(`${log}.2`, "utf8");
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
    // The damage. Our unlink had a LIVE target — the peer's freshly
    // shifted history — and removed it. `.2` is gone, not merely absent
    // because nothing was ever there.
    expect(doomed).toBe(HISTORY);
    expect(realFs.existsSync(`${log}.2`)).toBe(false);
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

  it("loses a generation when the reclaim lands in the copy gap (residual)", () => {
    // The documented worst case (#3600 round-5, M2), asserted so the
    // residual cannot quietly become untrue. The peer lands between the
    // pre-copy `held()` check and `copyFileSync` itself, so that ONE
    // syscall proceeds unserialized: by then `.1` is the peer's fresh
    // snapshot, and we overwrite it with a copy of the LIVE file.
    realFs.writeFileSync(log, BODY);
    realFs.writeFileSync(`${log}.1`, HISTORY);

    let fired = false;
    hooks.beforeCopy = (from) => {
      if (from !== log || fired) return;
      fired = true;
      hooks.beforeCopy = undefined;
      peerReclaimsAndRotates(2, NEW);
    };

    const rotated = maybeRotateLogFile(log, {
      maxBytes: CAP,
      maxFiles: 2,
      tag: "victim",
      lock: true,
    });

    expect(fired).toBe(true);
    // The NEXT checkpoint still stops us — the active file is not
    // truncated, so the rows written after the peer's rotation survive.
    expect(rotated).toBe(false);
    expect(realFs.readFileSync(log, "utf8")).toBe(NEW);
    // But the damage is real and this is what it looks like: `.1` is now
    // a useless duplicate of the live file, and BOTH the peer's snapshot
    // (which was at `.1`) and the shifted HISTORY (which our own earlier
    // rename had put at `.2`, and the peer's rotation then dropped) are
    // gone. One unguarded syscall costs a full generation.
    expect(realFs.readFileSync(`${log}.1`, "utf8")).toBe(NEW);
    expect(realFs.existsSync(`${log}.2`)).toBe(false);
  });

  it("loses EVERY byte when the reclaim lands in the copy gap and the peer is quiet", () => {
    // Same gap as the test above, one variable changed: the peer does not
    // append after rotating. That is the ordinary state of a low-traffic
    // log, and it is the real worst case (#3600 round-6, H1) — the test
    // above masks it, because the rows its peer appends are what make the
    // unguarded `copyFileSync` copy anything at all.
    //
    // With a quiet peer the active file it leaves is ZERO bytes, so our
    // one unserialized copy writes zero bytes over the peer's fresh `.1`,
    // and the peer's own rotation already dropped the `.2` our earlier
    // shift had put there. `.1` empty, `.2` gone, active empty: every byte
    // of this log's history and of its live rows is gone. That is the
    // outcome `RotateOptions.lock` calls strictly worse than the ordinary
    // copy/truncate race window, produced WITH the lock held.
    realFs.writeFileSync(log, BODY);
    realFs.writeFileSync(`${log}.1`, HISTORY);

    let fired = false;
    hooks.beforeCopy = (from) => {
      if (from !== log || fired) return;
      fired = true;
      hooks.beforeCopy = undefined;
      peerReclaimsAndRotates(2, "");
    };

    const rotated = maybeRotateLogFile(log, {
      maxBytes: CAP,
      maxFiles: 2,
      tag: "victim",
      lock: true,
    });

    expect(fired).toBe(true);
    expect(rotated).toBe(false); // the next checkpoint does stop us
    expect(realFs.statSync(`${log}.1`).size).toBe(0); // zero-byte snapshot
    expect(realFs.existsSync(`${log}.2`)).toBe(false); // prior generation gone
    expect(realFs.statSync(log).size).toBe(0); // and nothing live to recover
  });

  it("declines the truncate when the peer rotated after our lock check (H2 gate)", () => {
    // The peer lands in the check→`truncateSync` gap: AFTER `held()`'s
    // stat of the lockfile, so the lock guard cannot see it. This is the
    // one gap with no next checkpoint — the truncate is the last one — and
    // the only gap that destroys LIVE rows rather than history depth.
    //
    // The data-based gate is what catches it: the active file is now
    // SHORTER than the snapshot we just wrote to `.1`, which only happens
    // when someone else truncated it under us. Remove that gate from
    // `rotateLogFile` and this test fails with `rotated === true` and an
    // empty active file — the peer's rows destroyed (#3600 round-6, H2).
    realFs.writeFileSync(log, BODY);
    realFs.writeFileSync(`${log}.1`, HISTORY);

    let copied = false;
    let fired = false;
    hooks.beforeCopy = () => {
      copied = true;
    };
    hooks.afterStat = (p) => {
      // The first stat of the lockfile after our copy IS `held()`'s check
      // for the truncate; firing after it lands us inside the gap.
      if (p !== lock || !copied || fired) return;
      fired = true;
      hooks.afterStat = undefined;
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
    expect(realFs.readFileSync(log, "utf8")).toBe(NEW); // rows survive
  });

  it("destroys the peer's rows when the reclaim lands in the truncate gap (residual, returns true)", () => {
    // The residual the gate above cannot close: the gate is itself a stat
    // followed by a separate `truncateSync`, and the peer lands between
    // those two. Nothing catches this — there is no later checkpoint.
    //
    // Asserted rather than described, INCLUDING the return value: we
    // report `rotated === true` while having destroyed rows that belong
    // to the peer's completed cycle. `true` is deliberate — a rotation
    // did happen, and `false` in this module means "nothing happened and
    // the active file is exactly as it was", which would be a worse lie.
    // The honest channel is the stderr line asserted below; both live
    // callers discard the boolean (#3600 round-6, H2).
    realFs.writeFileSync(log, BODY);
    realFs.writeFileSync(`${log}.1`, HISTORY);

    const errs: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        errs.push(String(chunk));
        return true;
      });

    let fired = false;
    hooks.beforeTruncate = (p) => {
      if (p !== log || fired) return;
      fired = true;
      hooks.beforeTruncate = undefined;
      peerReclaimsAndRotates(2, NEW);
    };

    let rotated: boolean;
    try {
      rotated = maybeRotateLogFile(log, {
        maxBytes: CAP,
        maxFiles: 2,
        tag: "victim",
        lock: true,
      });
    } finally {
      spy.mockRestore();
    }

    expect(fired).toBe(true);
    expect(rotated).toBe(true); // and it is not a rotation the caller can trust
    expect(realFs.statSync(log).size).toBe(0); // the peer's rows are gone
    expect(errs.join("")).toContain("rows another rotator wrote");
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

/**
 * M3 (#3600 round-5). Everything above rests on inode identity:
 * `stillHeld()` and the release guard both compare `statSync(lock).ino`
 * against the number captured by `fstat` at `open(wx)`. That comparison
 * only means "the same lock" because the lock `fd` stays OPEN for the
 * whole critical section — an open fd is a reference, and a filesystem
 * only recycles an inode number once nothing references it.
 *
 * This is not testable by outcome here. Measured over 200
 * park→unlink→recreate cycles (the exact shape of a peer's reclaim):
 *
 *     fd closed  ext4  200/200 collisions      fd closed  tmpfs  0/200
 *     fd open    ext4    0/200 collisions      fd open    tmpfs  0/200
 *
 * The suite's files live under `os.tmpdir()` — tmpfs, which never reuses
 * — so a race test cannot see an early close, while the real logs live
 * under `~/.switchroom/**` on ext4, which always does. Re-running the
 * whole race suite with `TMPDIR` on ext4 passes either way, which is
 * exactly why this test has to assert the mechanism instead: none of the
 * outcome tests lands a peer's reclaim in a window where an inode number
 * has been freed, so there is nothing for a reused number to collide
 * with even on the reusing filesystem.
 *
 * Round 5 wrote that list of sites and left the release unlink OFF it,
 * and the release unlink was the one site that violated the premise —
 * `closeSync` ran first, so the guard compared a freed number. Driven
 * directly on ext4 (round-6 H3, peer reclaiming inside the
 * close→stat window) that guard matched a peer's brand-new LIVE lock and
 * deleted it. The list below therefore covers the release unlink too, and
 * a carve-out is the thing to be suspicious of if this ever fails.
 *
 * So assert the MECHANISM, on any filesystem: the fd must still be open
 * at every inode-guarded destructive syscall, the release unlink
 * included. Close it before `fn()`, or move the close back ahead of the
 * release guard, and this fails.
 */
describe("inode identity's premise: the lock fd stays open (M3)", () => {
  it("holds the lock fd open through every destructive syscall", () => {
    const BODY = "x".repeat(CAP * 4);
    realFs.writeFileSync(log, BODY);
    realFs.writeFileSync(`${log}.1`, HISTORY);
    realFs.writeFileSync(`${log}.2`, "OLDEST\n");

    let lockFd = -1;
    let lockFdClosed = false;
    const seen: string[] = [];
    const note = (what: string) =>
      seen.push(`${what} [${lockFdClosed ? "FD CLOSED" : "fd open"}]`);
    const gen = (p: string) => `<log>${p.slice(log.length)}`;

    hooks.afterOpen = (p, flags, fd) => {
      if (p === lock && flags === "wx" && lockFd === -1) lockFd = fd;
    };
    hooks.beforeClose = (fd) => {
      if (lockFd !== -1 && fd === lockFd) lockFdClosed = true;
    };
    // The four log-data mutations AND the lockfile's own unlink at
    // release. That last one is not decoration: the release guard is an
    // inode comparison exactly like `stillHeld()`, so it needs the fd open
    // for the same reason, and until round 6 it did not have it — the
    // close ran first and the guard compared a number nothing was holding.
    // On ext4 a peer's park→unlink→`open(wx)` in that window got our
    // number back and we deleted its LIVE lock. Excluding this site from
    // the list is what let that survive round 5 (#3600 round-6, H3), so it
    // is included now and the ordering fix is what makes it pass.
    const isGeneration = (p: string) => /^\.\d+$/.test(p.slice(log.length));
    hooks.beforeUnlink = (p) => {
      if (isGeneration(p)) note(`unlink ${gen(p)}`);
      else if (p === lock) note("unlink <lock>");
    };
    hooks.beforeRename = (from) => {
      if (isGeneration(from)) note(`rename ${gen(from)}`);
    };
    hooks.beforeCopy = (from, to) => {
      if (from === log) note(`copy <log> → ${gen(to)}`);
    };
    hooks.beforeTruncate = (p) => {
      if (p === log) note("truncate <log>");
    };

    expect(
      maybeRotateLogFile(log, {
        maxBytes: CAP,
        maxFiles: 2,
        tag: "t",
        lock: true,
      }),
    ).toBe(true);

    expect(lockFd).not.toBe(-1); // we really did identify the lock fd
    expect(seen).toEqual([
      "unlink <log>.2 [fd open]",
      "rename <log>.1 [fd open]",
      "copy <log> → <log>.1 [fd open]",
      "truncate <log> [fd open]",
      "unlink <lock> [fd open]",
    ]);
    // And it IS closed by the end — otherwise the tags above would be
    // vacuously "fd open" and this test would prove nothing.
    expect(lockFdClosed).toBe(true);
  });
});
