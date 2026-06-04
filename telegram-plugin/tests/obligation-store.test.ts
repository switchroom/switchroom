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
    expect(calls).toEqual([`write:${PATH}.tmp`, `rename:${PATH}.tmp->${PATH}`]);
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

  it("never throws on a write failure — degrades to in-memory (logs)", () => {
    const logs: string[] = [];
    const fs: ObligationStoreFsSeam = {
      readFileSync: () => "",
      writeFileSync: () => {
        throw new Error("EROFS read-only fs");
      },
      renameSync: () => {},
      existsSync: () => false,
    };
    expect(() => persistObligations(PATH, fs, [ob("c:3#1")], (l) => logs.push(l))).not.toThrow();
    expect(logs.join("")).toContain("persist FAILED");
  });
});
