import { describe, it, expect } from "vitest";
import {
  loadStatusPins,
  persistStatusPins,
  pinnedMessageIsOurs,
  runStatusPinBootCleanup,
  type PersistedStatusPin,
  type StatusPinStoreFsSeam,
  type TrackedStatusPin,
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
 * Chat-scoped ownership guard (BUG 1). message_ids are per-chat small integers
 * and the gateway tracks many pins across chats/topics simultaneously — the
 * guard MUST match on messageId AND chatId, never messageId alone.
 */
describe("pinnedMessageIsOurs — chat-scoped guard", () => {
  const tracked: TrackedStatusPin[] = [
    { chatId: "-100AAA", messageId: 715 }, // chat A
    { chatId: "-100BBB", messageId: 42 }, // chat B, different id
  ];

  it("matches a genuine same-chat + same-id pin", () => {
    expect(pinnedMessageIsOurs(tracked, "-100AAA", 715)).toBe(true);
    expect(pinnedMessageIsOurs(tracked, "-100BBB", 42)).toBe(true);
  });

  it("does NOT match when the id collides but the chat differs (the bug)", () => {
    // Chat B receives a pinned_message update whose id (715) collides with
    // chat A's tracked status pin. A messageId-only guard would wrongly return
    // true and delete chat B's (possibly operator-manual) service message.
    expect(pinnedMessageIsOurs(tracked, "-100BBB", 715)).toBe(false);
    // Symmetric: chat A with chat B's id.
    expect(pinnedMessageIsOurs(tracked, "-100AAA", 42)).toBe(false);
  });

  it("does NOT match an untracked id in a tracked chat", () => {
    expect(pinnedMessageIsOurs(tracked, "-100AAA", 999)).toBe(false);
  });

  it("does NOT match against an empty tracked set", () => {
    expect(pinnedMessageIsOurs([], "-100AAA", 715)).toBe(false);
  });
});

/**
 * Boot-orphan cleanup — calls the REAL `runStatusPinBootCleanup` (extracted
 * pure over injected fs + unpin seams) so ordering / contract regressions are
 * caught here, not just structurally.
 */
describe("runStatusPinBootCleanup", () => {
  it("unpins every persisted entry and empties the store", async () => {
    const { fs } = memFs();
    const orphans: PersistedStatusPin[] = [
      pin({ pinKey: "fg:c:3", chatId: "-100123", messageId: 715 }),
      pin({ pinKey: "wk:agent-x", chatId: "-100999", messageId: 42 }),
    ];
    persistStatusPins(PATH, fs, orphans);

    const unpinned: Array<[string, number]> = [];
    const res = await runStatusPinBootCleanup({
      path: PATH,
      fs,
      unpin: async (chatId, messageId) => {
        unpinned.push([chatId, messageId]);
      },
      log: () => {},
    });

    expect(unpinned).toEqual([
      ["-100123", 715],
      ["-100999", 42],
    ]);
    expect(res).toEqual({ cleared: 2, total: 2 });
    // Store empty afterwards → no re-attempt next boot.
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });

  it("a failing unpin is non-fatal and the store is still emptied", async () => {
    const { fs } = memFs();
    persistStatusPins(PATH, fs, [
      pin({ pinKey: "fg:c:1", chatId: "-100123", messageId: 5 }),
      pin({ pinKey: "fg:c:2", chatId: "-100123", messageId: 6 }),
    ]);

    const res = await runStatusPinBootCleanup({
      path: PATH,
      fs,
      unpin: async (_c, messageId) => {
        if (messageId === 5) throw new Error("chat gone");
      },
      log: () => {},
    });

    // One failed, one succeeded — still non-fatal, store still emptied.
    expect(res).toEqual({ cleared: 1, total: 2 });
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });

  it("no-op on a fresh boot with no persisted pins (no unpin calls)", async () => {
    const { fs } = memFs();
    let calls = 0;
    const res = await runStatusPinBootCleanup({
      path: PATH,
      fs,
      unpin: async () => {
        calls++;
      },
      log: () => {},
    });
    expect(res).toEqual({ cleared: 0, total: 0 });
    expect(calls).toBe(0);
  });
});
