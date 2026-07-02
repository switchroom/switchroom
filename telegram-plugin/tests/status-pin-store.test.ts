import { describe, it, expect } from "vitest";
import {
  loadStatusPins,
  persistStatusPins,
  pinnedMessageIsOurs,
  reconcileAndPersistStatusPin,
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
    // v3 is an unknown FUTURE version (v1 + v2 are the supported set).
    const { fs: f1 } = memFs({ [PATH]: JSON.stringify({ v: 3, pins: [pin()] }) });
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

  it("unpins a PENDING record too (crash in the persist-after-pin window)", async () => {
    // Fix 1: a pin that landed in Telegram but whose confirming rewrite never
    // ran leaves a `pending` record. Boot cleanup must treat it like a confirmed
    // pin and unpin it — otherwise the orphan lingers forever.
    const { fs } = memFs();
    persistStatusPins(PATH, fs, [
      pin({ pinKey: "fg:c:9", chatId: "-100777", messageId: 314, pending: true }),
    ]);
    const unpinned: Array<[string, number]> = [];
    const res = await runStatusPinBootCleanup({
      path: PATH,
      fs,
      unpin: async (chatId, messageId) => {
        unpinned.push([chatId, messageId]);
      },
      log: () => {},
    });
    expect(unpinned).toEqual([["-100777", 314]]);
    expect(res).toEqual({ cleared: 1, total: 1 });
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });
});

/**
 * Envelope versioning — a v1 snapshot (no `pending` field) must still load
 * fail-open as a confirmed pin, and v2 must round-trip the `pending` flag.
 */
describe("status-pin-store — envelope version compat", () => {
  it("loads a legacy v1 snapshot (no pending field) as confirmed pins", () => {
    const { fs } = memFs({
      [PATH]: JSON.stringify({
        v: 1,
        pins: [{ pinKey: "fg:c:3", chatId: "-100123", messageId: 715 }],
      }),
    });
    const loaded = loadStatusPins(PATH, fs);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].pending).toBeUndefined();
    expect(loaded[0].messageId).toBe(715);
  });

  it("round-trips a v2 pending flag and writes v2 envelopes", () => {
    const { fs, files } = memFs();
    persistStatusPins(PATH, fs, [pin({ pending: true })]);
    expect(JSON.parse(files.get(PATH)!).v).toBe(2);
    expect(loadStatusPins(PATH, fs)[0].pending).toBe(true);
  });

  it("rejects an unknown future envelope version (fail-open [])", () => {
    const { fs } = memFs({ [PATH]: JSON.stringify({ v: 3, pins: [pin()] }) });
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });

  it("drops a row with a non-boolean pending field", () => {
    const { fs } = memFs({
      [PATH]: JSON.stringify({
        v: 2,
        pins: [
          pin({ messageId: 715 }),
          { pinKey: "k", chatId: "c", messageId: 1, pending: "yes" },
        ],
      }),
    });
    const loaded = loadStatusPins(PATH, fs);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].messageId).toBe(715);
  });
});

/**
 * reconcileAndPersistStatusPin — the persist-BEFORE-pin ordering that closes the
 * leak window (Fix 1). These exercise the REAL wrapper the gateway calls, with
 * an fs seam that can crash at a chosen write so we can prove the leak is
 * recovered (red→green against the pre-fix persist-after ordering).
 */
describe("reconcileAndPersistStatusPin — persist-before-pin ordering", () => {
  it("writes a PENDING record BEFORE the pin API call", async () => {
    const { fs } = memFs();
    const order: string[] = [];
    // Record what's on disk at the moment the pin API is invoked.
    let onDiskAtPin: PersistedStatusPin[] = [];
    const next = await reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey: "fg:c:3",
      chatId: "-100123",
      op: { kind: "pin", messageId: 715 },
      snapshotOthers: () => [],
      applyPin: async () => {
        order.push("pin-api");
        onDiskAtPin = loadStatusPins(PATH, fs);
        return { messageId: 715 };
      },
      log: () => {},
    });
    // At the moment the pin API ran, a pending record was already on disk.
    expect(onDiskAtPin).toEqual([
      { pinKey: "fg:c:3", chatId: "-100123", messageId: 715, pending: true },
    ]);
    // After success it's confirmed (pending cleared).
    expect(next).toEqual({ messageId: 715 });
    expect(loadStatusPins(PATH, fs)).toEqual([
      { pinKey: "fg:c:3", chatId: "-100123", messageId: 715 },
    ]);
  });

  it("RED→GREEN: a crash between pin-lands and confirm leaves a recoverable pending record", async () => {
    // Simulate SIGKILL: the pin API lands in Telegram, then the process dies
    // before the confirming rewrite. We model the crash by throwing out of
    // applyPin AFTER it 'pinned' — the pending record must survive on disk.
    const { fs } = memFs();
    let pinnedInTelegram: number | null = null;
    await expect(
      reconcileAndPersistStatusPin({
        path: PATH,
        fs,
        pinKey: "fg:c:3",
        chatId: "-100123",
        op: { kind: "pin", messageId: 715 },
        snapshotOthers: () => [],
        applyPin: async () => {
          pinnedInTelegram = 715; // the pin landed in Telegram
          throw new Error("SIGKILL — process died before confirm rewrite");
        },
        log: () => {},
      }),
    ).rejects.toThrow("SIGKILL");

    // The pin is live in Telegram...
    expect(pinnedInTelegram).toBe(715);
    // ...AND a pending record survived on disk (this is what the pre-fix
    // persist-AFTER-pin ordering FAILED to do — the store would have been empty
    // and boot cleanup blind to the orphan).
    const persisted = loadStatusPins(PATH, fs);
    expect(persisted).toEqual([
      { pinKey: "fg:c:3", chatId: "-100123", messageId: 715, pending: true },
    ]);

    // Next boot: cleanup unpins the orphan using the pending record.
    const unpinned: Array<[string, number]> = [];
    await runStatusPinBootCleanup({
      path: PATH,
      fs,
      unpin: async (c, m) => {
        unpinned.push([c, m]);
      },
      log: () => {},
    });
    expect(unpinned).toEqual([["-100123", 715]]);
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });

  it("clears the pending record when the pin API fails (no phantom claim)", async () => {
    const { fs } = memFs();
    const next = await reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey: "fg:c:3",
      chatId: "-100123",
      op: { kind: "pin", messageId: 715 },
      snapshotOthers: () => [],
      // reconcilePin returns null (prevState) when the pin API throws.
      applyPin: async () => null,
      log: () => {},
    });
    expect(next).toBeNull();
    // Pending record dropped — nothing to leak, nothing was pinned.
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });

  it("preserves OTHER live claims while flipping one key pending→confirmed", async () => {
    const { fs } = memFs();
    const other: PersistedStatusPin = {
      pinKey: "wk:agent-x",
      chatId: "-100999",
      messageId: 42,
    };
    await reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey: "fg:c:3",
      chatId: "-100123",
      op: { kind: "pin", messageId: 715 },
      snapshotOthers: () => [other],
      applyPin: async () => ({ messageId: 715 }),
      log: () => {},
    });
    const loaded = loadStatusPins(PATH, fs);
    expect(loaded).toContainEqual(other);
    expect(loaded).toContainEqual({
      pinKey: "fg:c:3",
      chatId: "-100123",
      messageId: 715,
    });
  });

  it("clear op: unpins then drops the record (post-pin ordering is safe)", async () => {
    const { fs } = memFs();
    persistStatusPins(PATH, fs, [pin({ pinKey: "fg:c:3", messageId: 715 })]);
    const next = await reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey: "fg:c:3",
      chatId: "-100123",
      op: { kind: "clear" },
      snapshotOthers: () => [],
      applyPin: async () => null,
      log: () => {},
    });
    expect(next).toBeNull();
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });
});
