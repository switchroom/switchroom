/**
 * Outcome tests for `src/util/state-owner.ts`.
 *
 * The bug being guarded: a root-running gateway (root-tier agents run their
 * container, and therefore their gateway, as uid 0) writes state files into a
 * directory owned by the agent's uid, leaving them `root:root`. A later
 * non-root reader then EACCESes on state it owns the directory of — the same
 * silent failure that dropped an agent's crons for weeks in #4371.
 *
 * So the assertions here are about the OWNER of a file on disk after a write,
 * not about which code path ran.
 *
 * ## Why the ownership assertions are root-gated
 *
 * Only uid 0 can `chown(2)` a file to an arbitrary uid, so the outcome this
 * module exists to produce cannot be produced — or observed — by an
 * unprivileged process. `describe.runIf(isRoot)` runs those cases wherever
 * the suite runs as root (agent containers, the docker e2e images) and skips
 * them on an unprivileged runner. The NON-root behaviour — that this change
 * is inert off the root path — is asserted unconditionally in the block
 * below it, which is the half an unprivileged runner can actually prove.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  appendFileSync,
  chownSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _resetStateOwnerCacheForTests,
  adoptSqliteOwnership,
  adoptStateOwnership,
  appendStateFileSync,
  atomicWriteStateFileSync,
  mkdirStateSync,
  reconcileStateDirOwnership,
  reconcileStateDirOwnershipLogged,
  resolveStateOwner,
  writeStateFileSync,
} from "../src/util/state-owner.js";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** Two synthetic uids that exist nowhere — chown(2) does not require them to. */
const AGENT_UID = 61234;
const AGENT_GID = 61234;
const OTHER_UID = 61235;

let root: string;

beforeEach(() => {
  _resetStateOwnerCacheForTests();
  root = mkdtempSync(join(tmpdir(), "state-owner-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.runIf(isRoot)("state-owner: root writer into an agent-owned dir", () => {
  /** A state dir owned by the agent uid, as the scaffold creates it. */
  function agentOwnedDir(name = "telegram"): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chownSync(dir, AGENT_UID, AGENT_GID);
    return dir;
  }

  it("writeStateFileSync leaves the file owned by the directory owner, not root", () => {
    const dir = agentOwnedDir();
    const path = join(dir, "turn-active.json");

    writeStateFileSync(path, '{"turnKey":"t1"}\n', { mode: 0o600 });

    const st = statSync(path);
    expect(st.uid).toBe(AGENT_UID);
    expect(st.gid).toBe(AGENT_GID);
    expect(readFileSync(path, "utf-8")).toBe('{"turnKey":"t1"}\n');
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("plain writeFileSync in the same place leaves it root-owned (the bug being fixed)", () => {
    const dir = agentOwnedDir();
    const path = join(dir, "control.json");

    writeFileSync(path, "x", { mode: 0o600 });

    // This is the pre-fix behaviour, pinned so the test above cannot pass
    // vacuously (e.g. if the kernel were inheriting ownership from the dir).
    expect(statSync(path).uid).toBe(0);
  });

  it("atomicWriteStateFileSync lands the tmp+rename file under the directory owner", () => {
    const dir = agentOwnedDir();
    const path = join(dir, "status-pins.json");

    atomicWriteStateFileSync(path, JSON.stringify([{ pinKey: "a" }]), 0o600);

    const st = statSync(path);
    expect(st.uid).toBe(AGENT_UID);
    expect(st.gid).toBe(AGENT_GID);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual([{ pinKey: "a" }]);
    // No tempfile left behind.
    expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
  });

  it("appendStateFileSync adopts on the creating append", () => {
    const dir = agentOwnedDir();
    const path = join(dir, "inbound-spool.jsonl");

    appendStateFileSync(path, '{"a":1}\n');
    appendStateFileSync(path, '{"a":2}\n');

    expect(statSync(path).uid).toBe(AGENT_UID);
    expect(readFileSync(path, "utf-8")).toBe('{"a":1}\n{"a":2}\n');
  });

  it("mkdirStateSync adopts every directory it creates and leaves existing ones alone", () => {
    const dir = agentOwnedDir();
    // A pre-existing subdir with a deliberately different owner must survive.
    const preexisting = join(dir, "voice-cache");
    mkdirSync(preexisting);
    chownSync(preexisting, OTHER_UID, OTHER_UID);

    mkdirStateSync(join(dir, "buzz", "journal"), { recursive: true, mode: 0o700 });
    mkdirStateSync(preexisting, { recursive: true });

    expect(statSync(join(dir, "buzz")).uid).toBe(AGENT_UID);
    expect(statSync(join(dir, "buzz", "journal")).uid).toBe(AGENT_UID);
    expect(statSync(preexisting).uid).toBe(OTHER_UID);
  });

  it("adoptSqliteOwnership re-owns the db and both lazily-created sidecars", () => {
    const dir = agentOwnedDir();
    const db = join(dir, "history.db");
    // Stand in for SQLite: files created in C, invisible to any node:fs seam.
    writeFileSync(db, "SQLite format 3\0");
    writeFileSync(`${db}-wal`, "wal");
    // `-shm` deliberately absent — the common case between checkpoints.

    adoptSqliteOwnership(db);

    expect(statSync(db).uid).toBe(AGENT_UID);
    expect(statSync(`${db}-wal`).uid).toBe(AGENT_UID);
    expect(existsSync(`${db}-shm`)).toBe(false); // not conjured into existence
  });

  it("does nothing when the state dir is itself root-owned", () => {
    const dir = join(root, "root-owned");
    mkdirSync(dir);
    const path = join(dir, "beacon.json");

    writeStateFileSync(path, "{}");

    expect(statSync(path).uid).toBe(0);
    expect(resolveStateOwner(dir)).toBeNull();
  });

  describe("reconcile sweep", () => {
    it("adopts root-owned leftovers, including nested ones", () => {
      const dir = agentOwnedDir();
      writeFileSync(join(dir, "gateway-beacon.json"), "{}");
      mkdirSync(join(dir, "approved"));
      writeFileSync(join(dir, "approved", "12345"), "");

      const result = reconcileStateDirOwnership(dir);

      expect(statSync(join(dir, "gateway-beacon.json")).uid).toBe(AGENT_UID);
      expect(statSync(join(dir, "approved")).uid).toBe(AGENT_UID);
      expect(statSync(join(dir, "approved", "12345")).uid).toBe(AGENT_UID);
      expect(result.adopted).toBe(3);
      expect(result.truncated).toBe(false);
    });

    it("never chowns through a symlink that escapes the agent dir", () => {
      const dir = agentOwnedDir();
      // The real hazard: a live state dir contains links such as
      // `home/.switchroom -> /home/<operator>/.switchroom`. Following one
      // would hand the operator's home to the agent uid.
      const outsideDir = join(root, "operator-home");
      mkdirSync(outsideDir);
      const outsideFile = join(outsideDir, "secret.env");
      writeFileSync(outsideFile, "x");
      chownSync(outsideDir, OTHER_UID, OTHER_UID);
      chownSync(outsideFile, OTHER_UID, OTHER_UID);

      symlinkSync(outsideDir, join(dir, "escape-dir"));
      symlinkSync(outsideFile, join(dir, "escape-file"));

      const result = reconcileStateDirOwnership(dir);

      // The link targets are untouched — neither descended into nor chowned.
      expect(statSync(outsideDir).uid).toBe(OTHER_UID);
      expect(statSync(outsideFile).uid).toBe(OTHER_UID);
      // …and the links themselves were not re-owned either.
      expect(lstatSync(join(dir, "escape-file")).uid).toBe(0);
      expect(result.symlinksSkipped).toBe(2);
      expect(result.adopted).toBe(0);
    });

    it("refuses to chown a hardlinked file (the non-symlink escape)", () => {
      const dir = agentOwnedDir();
      const outside = join(root, "outside-target");
      writeFileSync(outside, "x");
      chownSync(outside, OTHER_UID, OTHER_UID);
      linkSync(outside, join(dir, "hardlinked"));

      const result = reconcileStateDirOwnership(dir);

      expect(statSync(outside).uid).toBe(OTHER_UID);
      expect(result.adopted).toBe(0);
    });

    it("stops at maxEntries instead of walking an unbounded tree", () => {
      const dir = agentOwnedDir();
      for (let i = 0; i < 12; i++) writeFileSync(join(dir, `f${i}`), "");

      const result = reconcileStateDirOwnership(dir, { maxEntries: 5 });

      expect(result.scanned).toBe(5);
      expect(result.truncated).toBe(true);
    });

    it("stops at maxDepth instead of recursing without bound", () => {
      const dir = agentOwnedDir();
      mkdirSync(join(dir, "a", "b", "c"), { recursive: true });
      writeFileSync(join(dir, "a", "b", "c", "deep"), "");

      const result = reconcileStateDirOwnership(dir, { maxDepth: 2 });

      expect(result.truncated).toBe(true);
      // `a` (depth 1) and `b` (depth 2) adopted; `c` and below not reached.
      expect(statSync(join(dir, "a")).uid).toBe(AGENT_UID);
      expect(statSync(join(dir, "a", "b")).uid).toBe(AGENT_UID);
      expect(statSync(join(dir, "a", "b", "c")).uid).toBe(0);
    });

    // The gateway wires the sweep through the *Logged wrapper, so the operator-
    // visible outcome is the line it emits — not the result object.
    it("the logged wrapper adopts and reports exactly one line", () => {
      const dir = agentOwnedDir();
      writeFileSync(join(dir, "gateway-beacon.json"), "{}");
      const lines: string[] = [];

      reconcileStateDirOwnershipLogged(dir, "boot", {
        prefix: "telegram gateway",
        write: line => lines.push(line),
      });

      expect(statSync(join(dir, "gateway-beacon.json")).uid).toBe(AGENT_UID);
      expect(lines).toEqual([
        "telegram gateway: state-owner reconcile (boot) scanned=1 adopted=1" +
          " symlinksSkipped=0 truncated=false\n",
      ]);
    });

    it("the logged wrapper stays silent on a pass that adopted nothing", () => {
      // A 6-hourly tick over an already-clean tree must not add a log line —
      // the sweep is silent unless it actually changed something.
      const dir = agentOwnedDir();
      const path = join(dir, "clean.json");
      writeFileSync(path, "{}");
      chownSync(path, AGENT_UID, AGENT_GID);
      const lines: string[] = [];

      reconcileStateDirOwnershipLogged(dir, "periodic", {
        prefix: "telegram gateway",
        write: line => lines.push(line),
      });

      expect(lines).toEqual([]);
    });
  });

  it("writeStateFileSync through a symlinked target still writes, but does not chown it", () => {
    const dir = agentOwnedDir();
    const outside = join(root, "outside.json");
    writeFileSync(outside, "old");
    chownSync(outside, OTHER_UID, OTHER_UID);
    const link = join(dir, "linked.json");
    symlinkSync(outside, link);

    writeStateFileSync(link, "new");

    // Availability preserved: a dropped state write can drop an approval.
    expect(readFileSync(outside, "utf-8")).toBe("new");
    // Security preserved: root never chowned an inode it reached via a link.
    expect(statSync(outside).uid).toBe(OTHER_UID);
  });
});

describe("state-owner: non-root is inert", () => {
  it("resolveStateOwner returns null without touching the filesystem", () => {
    if (isRoot) {
      // Under root the fast path can't be exercised; the root block above
      // pins the root behaviour instead.
      expect(resolveStateOwner(root)).toBeNull();
      return;
    }
    // A path that does not exist: a filesystem-touching implementation would
    // have to stat it, and `null` here is returned before any such call.
    expect(resolveStateOwner(join(root, "does", "not", "exist"))).toBeNull();
    expect(resolveStateOwner(root)).toBeNull();
  });

  it.skipIf(isRoot)("write helpers are byte- and mode-identical to the plain fs calls", () => {
    const viaHelper = join(root, "helper.json");
    const viaPlain = join(root, "plain.json");

    writeStateFileSync(viaHelper, '{"a":1}', { mode: 0o600 });
    writeFileSync(viaPlain, '{"a":1}', { mode: 0o600 });

    expect(readFileSync(viaHelper, "utf-8")).toBe(readFileSync(viaPlain, "utf-8"));
    expect(statSync(viaHelper).mode).toBe(statSync(viaPlain).mode);
    expect(statSync(viaHelper).uid).toBe(statSync(viaPlain).uid);

    const appHelper = join(root, "a-helper.jsonl");
    const appPlain = join(root, "a-plain.jsonl");
    appendStateFileSync(appHelper, "x\n");
    appendStateFileSync(appHelper, "y\n");
    appendFileSync(appPlain, "x\n");
    appendFileSync(appPlain, "y\n");
    expect(readFileSync(appHelper, "utf-8")).toBe(readFileSync(appPlain, "utf-8"));

    atomicWriteStateFileSync(join(root, "atomic.json"), "{}", 0o600);
    expect(readFileSync(join(root, "atomic.json"), "utf-8")).toBe("{}");

    mkdirStateSync(join(root, "x", "y"), { recursive: true, mode: 0o700 });
    expect(statSync(join(root, "x", "y")).isDirectory()).toBe(true);
  });

  it.skipIf(isRoot)("reconcile does no work and reports nothing", () => {
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "f"), "");

    expect(reconcileStateDirOwnership(root)).toEqual({
      scanned: 0,
      adopted: 0,
      symlinksSkipped: 0,
      truncated: false,
    });
  });

  it("the logged wrapper never throws on a missing state dir", () => {
    // It runs on the gateway's BOOT path: a throw here would take the gateway
    // down before it can serve, which is strictly worse than an unswept tree.
    const lines: string[] = [];
    expect(() =>
      reconcileStateDirOwnershipLogged(join(root, "gone"), "boot", {
        write: line => lines.push(line),
      }),
    ).not.toThrow();
    expect(lines).toEqual([]);
  });

  it("adopt helpers never throw on a missing file", () => {
    expect(() => adoptStateOwnership(join(root, "nope"))).not.toThrow();
    expect(() => adoptSqliteOwnership(join(root, "nope.db"))).not.toThrow();
  });
});
