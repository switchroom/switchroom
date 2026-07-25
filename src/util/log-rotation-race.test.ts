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
  };
});

const { maybeRotateLogFile } = await import("./log-rotation.js");

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
});

afterEach(() => {
  hooks.beforeRename = undefined;
  hooks.beforeOpen = undefined;
  hooks.beforeUnlink = undefined;
  realFs.rmSync(dir, { recursive: true, force: true });
});

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
    // it, so it must survive; and an unrelated neighbour must too.
    const fresh = `${lock}.stale.997.cccccccc`;
    realFs.writeFileSync(fresh, "");
    const neighbour = `${log}.1`;
    realFs.writeFileSync(neighbour, HISTORY);

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
    expect(realFs.existsSync(neighbour)).toBe(true);
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

    expect(
      maybeRotateLogFile(log, {
        maxBytes: CAP,
        maxFiles: 2,
        tag: "t",
        lock: true,
      }),
    ).toBe(true);

    expect(peerIno).not.toBe(-1);
    expect(realFs.existsSync(lock)).toBe(true);
    expect(realFs.statSync(lock).ino).toBe(peerIno);
  });
});
