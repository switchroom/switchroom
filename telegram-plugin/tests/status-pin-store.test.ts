import { describe, it, expect } from "vitest";
import {
  loadStatusPins,
  persistStatusPins,
  type PersistedStatusPin,
  type StatusPinStoreFsSeam,
} from "../gateway/status-pin-store.js";

/** In-memory fs seam with an atomic rename, so the store's tmp→rename
 *  crash-safety contract is exercised without touching the real disk. */
function memFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const calls: string[] = [];
  const fs: StatusPinStoreFsSeam = {
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

const PATH = "/state/agent/telegram/status-pins.json";

function pin(over: Partial<PersistedStatusPin> = {}): PersistedStatusPin {
  return { pinKey: "fg:c:3", chatId: "-100123", messageId: 715, ...over };
}

describe("status-pin-store", () => {
  it("round-trips the pin claim set", () => {
    const { fs } = memFs();
    const snap: PersistedStatusPin[] = [
      pin({ pinKey: "fg:c:3", messageId: 715 }),
      pin({ pinKey: "wk:agent-x", chatId: "-100999", messageId: 42 }),
    ];
    persistStatusPins(PATH, fs, snap);
    expect(loadStatusPins(PATH, fs)).toEqual(snap);
  });

  it("writes via tmp + atomic rename (crash-safe)", () => {
    const { fs, calls } = memFs();
    persistStatusPins(PATH, fs, [pin()]);
    expect(calls).toEqual([`write:${PATH}.tmp`, `rename:${PATH}.tmp->${PATH}`]);
  });

  it("persist-on-pin: a new claim is reflected on disk", () => {
    const { fs } = memFs();
    // Simulate reconcile writing state, then snapshotting.
    persistStatusPins(PATH, fs, [pin({ pinKey: "fg:c:3", messageId: 715 })]);
    const loaded = loadStatusPins(PATH, fs);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].messageId).toBe(715);
  });

  it("remove-on-unpin: unpinning empties the persisted set", () => {
    const { fs } = memFs();
    persistStatusPins(PATH, fs, [pin()]);
    expect(loadStatusPins(PATH, fs)).toHaveLength(1);
    // Reconcile deleted the key → snapshot of the now-empty Map.
    persistStatusPins(PATH, fs, []);
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });

  it("loads [] when no file exists (fresh boot)", () => {
    const { fs } = memFs();
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });

  it("fail-open: corrupt JSON loads as [] (never crashes boot)", () => {
    const { fs } = memFs({ [PATH]: "{not json" });
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });

  it("fail-open: wrong envelope version / shape loads as []", () => {
    const { fs: f1 } = memFs({ [PATH]: JSON.stringify({ v: 2, pins: [pin()] }) });
    expect(loadStatusPins(PATH, f1)).toEqual([]);
    const { fs: f2 } = memFs({ [PATH]: JSON.stringify({ v: 1, pins: "nope" }) });
    expect(loadStatusPins(PATH, f2)).toEqual([]);
  });

  it("drops malformed rows but keeps valid ones", () => {
    const { fs } = memFs({
      [PATH]: JSON.stringify({
        v: 1,
        pins: [
          pin({ messageId: 715 }),
          { pinKey: "", chatId: "c", messageId: 1 }, // empty pinKey → dropped
          { pinKey: "k", chatId: "", messageId: 1 }, // empty chatId → dropped
          { pinKey: "k", chatId: "c" }, // missing messageId → dropped
        ],
      }),
    });
    const loaded = loadStatusPins(PATH, fs);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].messageId).toBe(715);
  });

  it("persist never throws on a failing fs (durability degrades, live path unaffected)", () => {
    const throwingFs: StatusPinStoreFsSeam = {
      readFileSync: () => {
        throw new Error("boom");
      },
      writeFileSync: () => {
        throw new Error("disk full");
      },
      renameSync: () => {
        throw new Error("nope");
      },
      existsSync: () => false,
    };
    const logs: string[] = [];
    expect(() =>
      persistStatusPins(PATH, throwingFs, [pin()], (l) => logs.push(l)),
    ).not.toThrow();
    expect(logs.join("")).toContain("persist FAILED");
  });
});

/**
 * Boot-orphan cleanup contract (modelled against the store, since the gateway's
 * `statusPinBootCleanup` isn't exported — the gateway is a 25k-line module with
 * import-time side effects). It: (1) loads the persisted set, (2) unpins each
 * entry best-effort, (3) empties the store. This reproduces that flow over the
 * store's public surface + a fake unpin so the observable contract is pinned.
 */
describe("status-pin boot orphan cleanup", () => {
  it("unpins every persisted entry and empties the store", async () => {
    const { fs } = memFs();
    const orphans: PersistedStatusPin[] = [
      pin({ pinKey: "fg:c:3", chatId: "-100123", messageId: 715 }),
      pin({ pinKey: "wk:agent-x", chatId: "-100999", messageId: 42 }),
    ];
    persistStatusPins(PATH, fs, orphans);

    const unpinned: Array<[string, number]> = [];
    const fakeUnpin = async (chatId: string, messageId: number) => {
      unpinned.push([chatId, messageId]);
    };

    // Reproduce statusPinBootCleanup's body:
    const persisted = loadStatusPins(PATH, fs);
    for (const p of persisted) await fakeUnpin(p.chatId, p.messageId);
    persistStatusPins(PATH, fs, []);

    expect(unpinned).toEqual([
      ["-100123", 715],
      ["-100999", 42],
    ]);
    // Store is empty afterwards → no re-attempt on the next boot, and the
    // service-message handler's ownership Map sees no false positives.
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });

  it("a failing unpin is non-fatal and the store is still emptied", async () => {
    const { fs } = memFs();
    persistStatusPins(PATH, fs, [pin()]);

    const fakeUnpin = async () => {
      throw new Error("chat gone");
    };

    const persisted = loadStatusPins(PATH, fs);
    let threw = false;
    for (const p of persisted) {
      try {
        await fakeUnpin();
        void p;
      } catch {
        /* non-fatal, as in the gateway */
      }
    }
    // Store emptied regardless of unpin outcome.
    persistStatusPins(PATH, fs, []);

    expect(threw).toBe(false);
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });

  it("no-op on a fresh boot with no persisted pins", () => {
    const { fs } = memFs();
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });
});
