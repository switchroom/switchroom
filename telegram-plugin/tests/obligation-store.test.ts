import { describe, it, expect } from "vitest";
import {
  loadObligations,
  persistObligations,
  type ObligationStoreFsSeam,
} from "../gateway/obligation-store.js";
import type { Obligation } from "../gateway/obligation-ledger.js";

/** In-memory fs seam with an atomic rename, so the store's tmp→rename
 *  crash-safety contract is exercised without touching the real disk. */
function memFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const calls: string[] = [];
  const fs: ObligationStoreFsSeam = {
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`);
      return files.get(p)!;
    },
    writeFileSync: (p, d) => {
      calls.push(`write:${p}`);
      files.set(p, d);
    },
    renameSync: (a, b) => {
      calls.push(`rename:${a}->${b}`);
      if (!files.has(a)) throw new Error(`ENOENT ${a}`);
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    existsSync: (p) => files.has(p),
    fsyncFileSync: (p) => {
      calls.push(`fsyncFile:${p}`);
    },
    fsyncDirSync: (p) => {
      calls.push(`fsyncDir:${p}`);
    },
  };
  return { fs, files, calls };
}

const PATH = "/state/agent/telegram/obligations.json";

function ob(id: string, over: Partial<Obligation> = {}): Obligation {
  return {
    originTurnId: id,
    chatId: "-100123",
    threadId: 3,
    messageId: Number(id.split("#").pop() ?? 1),
    text: "do the thing",
    openedAt: 1000,
    representCount: 0,
    ...over,
  };
}

describe("obligation-store", () => {
  it("round-trips the open set, preserving representCount + escalateAttempts", () => {
    const { fs } = memFs();
    const snap: Obligation[] = [
      ob("c:3#715", { representCount: 2, escalateAttempts: 1 }),
      ob("c:5#900", { representCount: 0, openedAt: 2000 }),
    ];
    persistObligations(PATH, fs, snap);
    const loaded = loadObligations(PATH, fs);
    expect(loaded).toEqual(snap);
    expect(loaded[0].escalateAttempts).toBe(1);
    expect(loaded[0].representCount).toBe(2);
  });

  it("persists atomically: writes a sibling .tmp then renames over the path", () => {
    const { fs, calls, files } = memFs();
    persistObligations(PATH, fs, [ob("c:3#1")]);
    expect(calls).toEqual([
      `write:${PATH}.tmp`,
      `fsyncFile:${PATH}.tmp`,
      `rename:${PATH}.tmp->${PATH}`,
      "fsyncDir:/state/agent/telegram",
    ]);
    // The tmp is gone (renamed); only the real path remains.
    expect(files.has(PATH)).toBe(true);
    expect(files.has(`${PATH}.tmp`)).toBe(false);
  });

  it("returns [] for a missing file", () => {
    const { fs } = memFs();
    expect(loadObligations(PATH, fs)).toEqual([]);
  });

  it("returns [] for a torn / non-JSON file (crash mid-write tolerance)", () => {
    const { fs } = memFs({ [PATH]: '{"v":1,"obligations":[{"originTurnId":"c:3#7' });
    expect(loadObligations(PATH, fs)).toEqual([]);
  });

  it("returns [] for a wrong-version or wrong-shape envelope", () => {
    const a = memFs({ [PATH]: JSON.stringify({ v: 2, obligations: [ob("c:3#1")] }) });
    expect(loadObligations(PATH, a.fs)).toEqual([]);
    const b = memFs({ [PATH]: JSON.stringify({ v: 1, obligations: "nope" }) });
    expect(loadObligations(PATH, b.fs)).toEqual([]);
  });

  it("filters out malformed rows but keeps valid ones", () => {
    const raw = JSON.stringify({
      v: 1,
      obligations: [
        ob("c:3#715"),
        { originTurnId: "", chatId: "x" }, // empty id → dropped
        { nope: true }, // missing fields → dropped
        ob("c:5#900", { openedAt: 2000 }),
      ],
    });
    const { fs } = memFs({ [PATH]: raw });
    const loaded = loadObligations(PATH, fs);
    expect(loaded.map((o) => o.originTurnId)).toEqual(["c:3#715", "c:5#900"]);
  });

  it("round-trips lastRepresentedAt through parse → isObligationRow filter → hydrate", () => {
    // Regression: isObligationRow only checks required fields; optional fields
    // (lastRepresentedAt, lastTurnEndedAt, escalateAttempts) must survive the
    // filter without being stripped. A missing check would silently drop the field
    // and break the per-represent grace window across restarts.
    const { fs } = memFs();
    const snap: Obligation[] = [
      ob("c:3#715", { representCount: 1, lastRepresentedAt: 1_700_000_000_000, lastTurnEndedAt: 1_700_000_001_000 }),
    ];
    persistObligations(PATH, fs, snap);
    const loaded = loadObligations(PATH, fs);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.lastRepresentedAt).toBe(1_700_000_000_000);
    expect(loaded[0]!.lastTurnEndedAt).toBe(1_700_000_001_000);
    expect(loaded[0]!.representCount).toBe(1);
  });

  it("round-trips a valid capturedDelivery snapshot through persist → load (#3282)", () => {
    const { fs } = memFs();
    const capturedDelivery = {
      chunks: ["c0", "c1"],
      chunkStates: [
        { index: 0, messageIds: [10], confirmed: true },
        { index: 1, messageIds: [11, 12], confirmed: false },
      ],
    };
    persistObligations(PATH, fs, [ob("c:3#715", { capturedDelivery })]);
    const loaded = loadObligations(PATH, fs);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.capturedDelivery).toEqual(capturedDelivery);
  });

  it("STRIPS a malformed capturedDelivery (fail-open to fresh-generation represent) (#3282)", () => {
    // A partial write / forward-incompatible shape must not crash the resume: the
    // row survives (obligation preserved), the bad blob is dropped.
    const bad = {
      v: 1,
      obligations: [
        { ...ob("c:3#715"), capturedDelivery: { chunks: "not-an-array", chunkStates: [] } },
        { ...ob("c:3#716"), capturedDelivery: { chunks: ["c0"], chunkStates: [{ index: 0 }] } },
      ],
    };
    const { fs } = memFs({ [PATH]: JSON.stringify(bad) });
    const loaded = loadObligations(PATH, fs);
    expect(loaded.map((o) => o.originTurnId)).toEqual(["c:3#715", "c:3#716"]);
    expect(loaded[0]!.capturedDelivery).toBeUndefined();
    expect(loaded[1]!.capturedDelivery).toBeUndefined();
  });

  it("STRIPS an empty-chunks capturedDelivery (nothing to resume → fresh-gen, bounded) (#3282)", () => {
    const bad = {
      v: 1,
      obligations: [{ ...ob("c:3#715"), capturedDelivery: { chunks: [], chunkStates: [] } }],
    };
    const { fs } = memFs({ [PATH]: JSON.stringify(bad) });
    const loaded = loadObligations(PATH, fs);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.capturedDelivery).toBeUndefined();
  });

  it("never throws on a write failure — degrades to in-memory (logs)", () => {
    const logs: string[] = [];
    const fs: ObligationStoreFsSeam = {
      readFileSync: () => "",
      writeFileSync: () => {
        throw new Error("EROFS read-only fs");
      },
      renameSync: () => {},
      existsSync: () => false,
      fsyncFileSync: () => {},
      fsyncDirSync: () => {},
    };
    expect(() => persistObligations(PATH, fs, [ob("c:3#1")], (l) => logs.push(l))).not.toThrow();
    expect(logs.join("")).toContain("persist FAILED");
  });
});

describe("obligation-store — power-cut durability (fsync ordering)", () => {
  it("fsyncs the tmp file BEFORE the rename and the directory AFTER it", () => {
    const { fs, calls } = memFs();
    persistObligations(PATH, fs, [ob("c:3#1")]);
    // The exact sequence IS the guarantee: syncing the directory before the
    // rename, or renaming before the tmp file's data is on stable storage,
    // publishes a name that can point at bytes that were never written.
    expect(calls).toEqual([
      `write:${PATH}.tmp`,
      `fsyncFile:${PATH}.tmp`,
      `rename:${PATH}.tmp->${PATH}`,
      "fsyncDir:/state/agent/telegram",
    ]);
  });

  it("a failed tmp fsync aborts BEFORE the rename — the previous snapshot is left intact", () => {
    // Publishing an unsynced tmp over a good snapshot would be strictly worse
    // than not writing at all, so the rename must not happen.
    const prior = JSON.stringify({ v: 1, obligations: [ob("c:3#1")] });
    const { fs, files } = memFs({ [PATH]: prior });
    const logs: string[] = [];
    const failing: ObligationStoreFsSeam = {
      ...fs,
      fsyncFileSync: () => {
        throw new Error("EIO: i/o error, fsync");
      },
    };
    expect(() => persistObligations(PATH, failing, [ob("c:3#2")], (l) => logs.push(l))).not.toThrow();
    expect(logs.join("")).toContain("persist FAILED");
    expect(files.get(PATH)).toBe(prior);
    expect(loadObligations(PATH, fs)[0]!.originTurnId).toBe("c:3#1");
  });

  it("a failed DIRECTORY fsync keeps the written snapshot and is not reported as a failed persist", () => {
    // The rename already landed, so the snapshot is correct for a process
    // crash; only the power-cut upgrade is missing. Mislabelling it
    // "persist FAILED" would send an operator hunting a write that worked.
    const { fs, files } = memFs();
    const logs: string[] = [];
    const failing: ObligationStoreFsSeam = {
      ...fs,
      fsyncDirSync: () => {
        throw new Error("EIO: i/o error, fsync dir");
      },
    };
    expect(() => persistObligations(PATH, failing, [ob("c:3#1")], (l) => logs.push(l))).not.toThrow();
    expect(logs.join("")).toContain("directory fsync FAILED");
    expect(logs.join("")).not.toContain("persist FAILED");
    expect(files.has(PATH)).toBe(true);
    expect(loadObligations(PATH, fs)).toHaveLength(1);
  });
});
