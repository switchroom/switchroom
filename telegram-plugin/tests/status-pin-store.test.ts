import { describe, it, expect } from "vitest";
import {
  BOOT_UNPIN_MAX_ATTEMPTS,
  loadStatusPins,
  mutateStatusPinRow,
  persistStatusPins,
  pinnedMessageIsOurs,
  reconcileAndPersistStatusPin,
  runStatusPinBootCleanup,
  withPinReconcileLock,
  type PersistedStatusPin,
  type StatusPinStoreFsSeam,
  type TrackedStatusPin,
} from "../gateway/status-pin-store.js";
import { decidePinAction, type PinState, type DesiredPin } from "../status-pin.js";
import { executePinLeg, type PinBotApi } from "../status-pin-driver.js";
import {
  runStatusPinReconcile,
  type StatusPinClaim,
} from "../gateway/status-pin-retarget.js";
import { makeFloodWaitActiveError } from "../retry-api-call.js";

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

/**
 * Strip the #3810 claim-age stamp from persisted rows.
 *
 * Every confirmed/pending row now carries `pinnedAt` (the durable claim age the
 * mid-session store-orphan reaper needs). Row assertions that are about pin
 * IDENTITY — which key, which chat, which message, pending or not — stay about
 * identity by normalising the age away. The age has its own dedicated teeth in
 * the `claim age` describe below; it is not silently untested.
 */
function idOnly(rows: PersistedStatusPin[]): Omit<PersistedStatusPin, "pinnedAt">[] {
  return rows.map(({ pinnedAt: _age, ...rest }) => rest);
}

/** The `prev` snapshot a reconcile reads from the single claim registry (#3809),
 *  exactly as gateway.ts's `reconcileStatusPinInner` does. */
function prevOf(claims: Map<string, StatusPinClaim>, pinKey: string): PinState | null {
  const c = claims.get(pinKey);
  return c == null ? null : { messageId: c.messageId };
}

describe("status-pin-store", () => {
  it("round-trips the pin claim set", () => {
    const { fs } = memFs();
    const snap: PersistedStatusPin[] = [
      pin({ pinKey: "fg:c:3", messageId: 715 }),
      pin({ pinKey: "wk:agent-x", chatId: "-100999", messageId: 42 }),
    ];
    persistStatusPins(PATH, fs, snap);
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual(snap);
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
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([]);
  });

  it("loads [] when no file exists (fresh boot)", () => {
    const { fs } = memFs();
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([]);
  });

  it("fail-open: corrupt JSON loads as [] (never crashes boot)", () => {
    const { fs } = memFs({ [PATH]: "{not json" });
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([]);
  });

  it("fail-open: a shape that is not an envelope at all loads as []", () => {
    const { fs: f1 } = memFs({ [PATH]: JSON.stringify({ v: 1, pins: "nope" }) });
    expect(loadStatusPins(PATH, f1)).toEqual([]);
    const { fs: f2 } = memFs({ [PATH]: JSON.stringify({ pins: [pin()] }) });
    expect(loadStatusPins(PATH, f2)).toEqual([]);
    const { fs: f3 } = memFs({ [PATH]: JSON.stringify({ v: "4", pins: [pin()] }) });
    expect(loadStatusPins(PATH, f3)).toEqual([]);
    const { fs: f4 } = memFs({ [PATH]: JSON.stringify({ v: 0, pins: [pin()] }) });
    expect(loadStatusPins(PATH, f4)).toEqual([]);
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
    expect(res).toEqual({ cleared: 2, retained: 0, kept: 0, total: 2 });
    // Store empty afterwards → no re-attempt next boot.
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([]);
  });

  it("retry-safe (#3001): a failing unpin is non-fatal, RETAINS the row with an attempt counter, and drops only the succeeded one", async () => {
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

    // One failed, one succeeded — the failure is retained for a next-boot
    // retry instead of forfeiting the orphan (the pre-#3001 behaviour).
    expect(res).toEqual({ cleared: 1, retained: 1, kept: 0, total: 2 });
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([
      { pinKey: "fg:c:1", chatId: "-100123", messageId: 5, attempts: 1 },
    ]);
  });

  it("retry-safe (#3001): a row is forfeited once its attempts reach BOOT_UNPIN_MAX_ATTEMPTS", async () => {
    const { fs } = memFs();
    persistStatusPins(PATH, fs, [
      pin({
        pinKey: "fg:c:1",
        chatId: "-100123",
        messageId: 5,
        attempts: BOOT_UNPIN_MAX_ATTEMPTS - 1,
      }),
    ]);
    const res = await runStatusPinBootCleanup({
      path: PATH,
      fs,
      unpin: async () => {
        throw new Error("chat gone forever");
      },
      log: () => {},
    });
    // Final attempt failed too — forfeited, not retained: a permanently-
    // undeliverable unpin must not re-fail on every future boot.
    expect(res).toEqual({ cleared: 0, retained: 0, kept: 0, total: 1 });
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([]);
  });

  it("tool pins (#3001): an UNEXPIRED `tool:` row survives the boot untouched; an EXPIRED one is unpinned and dropped", async () => {
    const { fs } = memFs();
    const now = 1_750_000_000_000;
    persistStatusPins(PATH, fs, [
      pin({ pinKey: "tool:-100123:70", chatId: "-100123", messageId: 70, expiresAt: now + 1 }),
      pin({ pinKey: "tool:-100123:71", chatId: "-100123", messageId: 71, expiresAt: now }),
      pin({ pinKey: "wk:agent-x", chatId: "-100123", messageId: 72 }),
    ]);
    const unpinned: number[] = [];
    const res = await runStatusPinBootCleanup({
      path: PATH,
      fs,
      unpin: async (_c, messageId) => {
        unpinned.push(messageId);
      },
      now,
      log: () => {},
    });
    // The expired tool pin and the work-scoped wk: pin are unpinned; the
    // unexpired tool pin is kept for a future boot (restart ≠ reset for a
    // deliberate agent pin with no "work finished" event).
    expect(unpinned).toEqual([71, 72]);
    expect(res).toEqual({ cleared: 2, retained: 0, kept: 1, total: 3 });
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([
      { pinKey: "tool:-100123:70", chatId: "-100123", messageId: 70, expiresAt: now + 1 },
    ]);
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
    expect(res).toEqual({ cleared: 0, retained: 0, kept: 0, total: 0 });
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
    expect(res).toEqual({ cleared: 1, retained: 0, kept: 0, total: 1 });
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([]);
  });
});

/**
 * Concurrency race (multiple writers of status-pins.json). The store has two
 * concurrent writers: `reconcileAndPersistStatusPin` (fg:/wk: rows) and
 * `mutateStatusPinRow` (the banner:owner row). The race: a `pending` row is
 * written to disk BEFORE the applyPin network call; if a SECOND writer runs
 * DURING that await window and rebuilds the file, it can drop the in-flight
 * pending/confirmed row. The per-path lock + read-modify-write must close it —
 * BOTH rows survive.
 */
describe("status-pin-store — concurrent-writer race", () => {
  it("a banner persist DURING the applyPin await window does NOT drop the status pin's pending row", async () => {
    const { fs } = memFs();

    // applyPin is a promise we control: it resolves only when we let it, so we
    // can fire a concurrent writer squarely inside the await window.
    let releaseApplyPin!: () => void;
    const applyPinGate = new Promise<void>((r) => {
      releaseApplyPin = r;
    });
    // Snapshot what's on disk at the moment the pin API is invoked (proves the
    // pending row was written before the network call).
    let onDiskAtPin: PersistedStatusPin[] = [];

    const reconcile = reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey: "fg:c:3",
      chatId: "-100123",
      op: { kind: "pin", messageId: 715 },
      applyPin: async () => {
        onDiskAtPin = loadStatusPins(PATH, fs);
        await applyPinGate; // in-flight: hold the pin open
        return { messageId: 715 };
      },
      log: () => {},
    });

    // Let the reconcile reach its applyPin await (pending row now on disk).
    await Promise.resolve();
    await Promise.resolve();
    expect(idOnly(onDiskAtPin)).toEqual([
      { pinKey: "fg:c:3", chatId: "-100123", messageId: 715, pending: true },
    ]);

    // Fire the banner persist DURING the await window. Under the per-path lock
    // it must serialise AFTER the reconcile completes — its read-modify-write
    // then sees the confirmed fg: row and preserves it.
    const bannerPersist = mutateStatusPinRow(
      PATH,
      fs,
      "banner:owner",
      { pinKey: "banner:owner", chatId: "-100999", messageId: 42 },
      () => {},
    );

    // Now release the pin so the reconcile confirms.
    releaseApplyPin();
    await reconcile;
    await bannerPersist;

    // BOTH rows survive: the status pin was NOT dropped by the concurrent
    // banner write (the pre-fix bug), and the banner row is present.
    const loaded = loadStatusPins(PATH, fs);
    expect(idOnly(loaded)).toContainEqual({
      pinKey: "fg:c:3",
      chatId: "-100123",
      messageId: 715,
    });
    expect(idOnly(loaded)).toContainEqual({
      pinKey: "banner:owner",
      chatId: "-100999",
      messageId: 42,
    });
    expect(loaded).toHaveLength(2);
  });

  it("two concurrent key reconciles both survive (no lost pending row)", async () => {
    const { fs } = memFs();

    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });

    const reconcileA = reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey: "fg:c:3",
      chatId: "-100123",
      op: { kind: "pin", messageId: 715 },
      applyPin: async () => {
        await gateA;
        return { messageId: 715 };
      },
      log: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    // Second key's reconcile fires while A's pin is in-flight. Serialised by the
    // lock, it runs after A confirms — its read-modify-write preserves A's row.
    const reconcileB = reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey: "wk:agent-x",
      chatId: "-100999",
      op: { kind: "pin", messageId: 42 },
      applyPin: async () => ({ messageId: 42 }),
      log: () => {},
    });

    releaseA();
    await reconcileA;
    await reconcileB;

    const loaded = loadStatusPins(PATH, fs);
    expect(idOnly(loaded)).toContainEqual({
      pinKey: "fg:c:3",
      chatId: "-100123",
      messageId: 715,
    });
    expect(idOnly(loaded)).toContainEqual({
      pinKey: "wk:agent-x",
      chatId: "-100999",
      messageId: 42,
    });
    expect(loaded).toHaveLength(2);
  });

  // This is the case the LOCK (not just per-key RMW) is required for: two
  // overlapping ops on the SAME pinKey. Different-key writers survive with or
  // without serialisation (RMW alone preserves them), so the two tests above
  // pass even against a no-op lock. Here a `clear` races a `pin` on one key:
  // without the lock the clear runs inside the pin's await window, removes the
  // pending row, and the pin's later confirm RESURRECTS a pin that was meant to
  // be cleared. With the FIFO lock the clear waits until the pin fully confirms,
  // then removes it — final state is correctly empty. Asserting absence is what
  // distinguishes the real lock from a no-op one.
  it("a clear racing a pin on the SAME key does not resurrect the cleared pin", async () => {
    const { fs } = memFs();

    let releasePin!: () => void;
    const pinGate = new Promise<void>((r) => {
      releasePin = r;
    });

    // Pin op acquires the lock first and holds it across its applyPin await.
    const pin = reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey: "fg:c:3",
      chatId: "-100123",
      op: { kind: "pin", messageId: 715 },
      applyPin: async () => {
        await pinGate;
        return { messageId: 715 };
      },
      log: () => {},
    });
    // Reach the applyPin await — pending row now on disk, lock held.
    await Promise.resolve();
    await Promise.resolve();

    // Clear the SAME key while the pin is in-flight. FIFO-serialised behind the
    // pin, it must run only AFTER the pin confirms, leaving the key removed.
    const clear = reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey: "fg:c:3",
      chatId: "-100123",
      op: { kind: "clear" },
      applyPin: async () => null,
      log: () => {},
    });

    releasePin();
    await pin;
    await clear;

    // The later-submitted clear wins: the key is gone, NOT resurrected by the
    // pin's confirm write (which would happen under a no-op lock).
    const loaded = loadStatusPins(PATH, fs);
    expect(loaded.find((r) => r.pinKey === "fg:c:3")).toBeUndefined();
    expect(loaded).toHaveLength(0);
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

  it("round-trips a v2 pending flag and writes v4 envelopes", () => {
    const { fs, files } = memFs();
    persistStatusPins(PATH, fs, [pin({ pending: true })]);
    expect(JSON.parse(files.get(PATH)!).v).toBe(4);
    expect(loadStatusPins(PATH, fs)[0].pending).toBe(true);
  });

  it("v4 persists the forum topic a pin lives in, so a later sweep can aim at it", () => {
    // Telegram's pin stack is chat-wide and `unpinChatMessage` takes no
    // message_thread_id, so `unpinAllForumTopicMessages(chat, thread)` is the
    // only topic-scoped drain a bot has — and it needs this field. Without it a
    // boot after a crash knows a forum chat has orphans but not where.
    const { fs, files } = memFs();
    persistStatusPins(PATH, fs, [pin({ threadId: 77 })]);
    expect(JSON.parse(files.get(PATH)!).v).toBe(4);
    expect(loadStatusPins(PATH, fs)[0].threadId).toBe(77);
  });

  it("D4: a forum-topic foreground pin threads its topic THROUGH the orchestrator into the persisted row", async () => {
    // The narrative-lane fix passes `thread` as reconcileStatusPin's 4th arg;
    // this locks the plumbing beneath it — runStatusPinReconcile → the durable
    // row — so a forum-topic foreground card orphaned by a crash keeps a
    // threadId the sweep can aim `unpinAllForumTopicMessages` at. Before the
    // fix the producer dropped `thread`, landing a threadId-less row here.
    const { fs } = memFs();
    const claims = new Map<string, StatusPinClaim>();
    await runStatusPinReconcile({
      pinKey: "fg:-100123:9",
      chatId: "-100123",
      threadId: 9,
      prev: null,
      desired: { pinned: true, messageId: 715 },
      persist: { path: PATH, fs },
      runPin: async (action) =>
        action.kind === "pin" ? { messageId: action.messageId } : null,
      claims,
    });

    // The durable row AND the in-memory claim both carry the topic.
    expect(loadStatusPins(PATH, fs)[0]?.threadId).toBe(9);
    expect(claims.get("fg:-100123:9")?.threadId).toBe(9);
  });

  it("drops a row with a non-numeric threadId", () => {
    const { fs } = memFs({
      [PATH]: JSON.stringify({
        v: 4,
        pins: [pin({ messageId: 715 }), { pinKey: "k", chatId: "c", messageId: 1, threadId: "5" }],
      }),
    });
    expect(loadStatusPins(PATH, fs)).toHaveLength(1);
  });

  it("#3810: a v3 row round-trips its pinnedAt claim age; a v1/v2 row loads without one", () => {
    const { fs } = memFs({
      [PATH]: JSON.stringify({
        v: 3,
        pins: [
          { pinKey: "wk:group:g1", chatId: "-100123", messageId: 715, pinnedAt: 1234 },
          { pinKey: "wk:group:g2", chatId: "-100123", messageId: 716 },
        ],
      }),
    });
    const loaded = loadStatusPins(PATH, fs);
    expect(loaded[0].pinnedAt).toBe(1234);
    expect(loaded[1].pinnedAt).toBeUndefined();
  });

  it("drops a row with a non-numeric pinnedAt", () => {
    const { fs } = memFs({
      [PATH]: JSON.stringify({
        v: 3,
        pins: [
          pin({ messageId: 715 }),
          { pinKey: "k", chatId: "c", messageId: 1, pinnedAt: "soon" },
        ],
      }),
    });
    expect(loadStatusPins(PATH, fs)).toHaveLength(1);
  });

  /**
   * #3957 — a DOWNGRADE must degrade, not discard.
   *
   * The pre-#3953 reader has already shipped, so the v3→v4 case can never be
   * retroactively fixed; this pins the forward-looking half so the NEXT bump
   * behaves. A build that does not know the envelope version still reads every
   * row it can structurally validate — because for THIS file "discard" is not
   * "do nothing", it is "forget which messages we pinned", which turns every
   * pin the newer build took into a permanent orphan.
   */
  it("reads an unknown FUTURE envelope version, keeping every row it can validate", () => {
    const { fs } = memFs({
      [PATH]: JSON.stringify({
        v: 99,
        pins: [
          // A future row: known fields valid, plus a field this build has never
          // heard of. Kept — unknown fields are additive by the bump rule.
          { ...pin({ messageId: 715 }), someFutureField: "v99" },
          { pinKey: "k", chatId: "c", messageId: "not-a-number" }, // still dropped
        ],
      }),
    });
    const loaded = loadStatusPins(PATH, fs);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].messageId).toBe(715);
  });

  it("a rolled-back build still UNPINS the orphans a newer build recorded (#3957)", async () => {
    // The outcome that matters: not "the rows parse" but "the boot cleanup can
    // still reach them". Against the fail-open reader this unpins nothing.
    const { fs } = memFs({
      [PATH]: JSON.stringify({
        v: 99,
        pins: [
          { pinKey: "fg:c:3", chatId: "-100123", messageId: 715, unknownV99: 1 },
          { pinKey: "wk:agent-x", chatId: "-100999", messageId: 42 },
        ],
      }),
    });

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
    expect(res.cleared).toBe(2);
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([]);
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
      applyPin: async () => {
        order.push("pin-api");
        onDiskAtPin = loadStatusPins(PATH, fs);
        return { messageId: 715 };
      },
      log: () => {},
    });
    // At the moment the pin API ran, a pending record was already on disk.
    expect(idOnly(onDiskAtPin)).toEqual([
      { pinKey: "fg:c:3", chatId: "-100123", messageId: 715, pending: true },
    ]);
    // After success it's confirmed (pending cleared).
    expect(next).toEqual({ messageId: 715 });
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([
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
    expect(idOnly(persisted)).toEqual([
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
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([]);
  });

  it("clears the pending record when the pin API fails (no phantom claim)", async () => {
    const { fs } = memFs();
    const next = await reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey: "fg:c:3",
      chatId: "-100123",
      op: { kind: "pin", messageId: 715 },
      // executePinLeg returns null (prevState) when the pin API throws.
      applyPin: async () => null,
      log: () => {},
    });
    expect(next).toBeNull();
    // Pending record dropped — nothing to leak, nothing was pinned.
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([]);
  });

  it("preserves OTHER live claims while flipping one key pending→confirmed", async () => {
    const { fs } = memFs();
    const other: PersistedStatusPin = {
      pinKey: "wk:agent-x",
      chatId: "-100999",
      messageId: 42,
    };
    // Others now come from the on-disk file (read-modify-write), not a caller
    // snapshot — seed the other key's row on disk first.
    persistStatusPins(PATH, fs, [other]);
    await reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey: "fg:c:3",
      chatId: "-100123",
      op: { kind: "pin", messageId: 715 },
      applyPin: async () => ({ messageId: 715 }),
      log: () => {},
    });
    const loaded = loadStatusPins(PATH, fs);
    expect(idOnly(loaded)).toContainEqual(other);
    expect(idOnly(loaded)).toContainEqual({
      pinKey: "fg:c:3",
      chatId: "-100123",
      messageId: 715,
    });
  });

  it("uses on-disk OTHER rows (not a memory snapshot) — an on-disk key is preserved", async () => {
    // The banner (or another key's) row can exist ON DISK without the reconcile
    // caller knowing about it. Read-modify-write must carry it through.
    const { fs } = memFs();
    persistStatusPins(PATH, fs, [
      { pinKey: "banner:owner", chatId: "-100999", messageId: 42 },
    ]);
    await reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey: "fg:c:3",
      chatId: "-100123",
      op: { kind: "pin", messageId: 715 },
      applyPin: async () => ({ messageId: 715 }),
      log: () => {},
    });
    const loaded = loadStatusPins(PATH, fs);
    expect(idOnly(loaded)).toContainEqual({
      pinKey: "banner:owner",
      chatId: "-100999",
      messageId: 42,
    });
    expect(idOnly(loaded)).toContainEqual({
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
      applyPin: async () => null,
      log: () => {},
    });
    expect(next).toBeNull();
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([]);
  });

  // F1 (invisible-worker-cards review): a `clear` op is emitted for BOTH a real
  // unpin AND a `noop: already pinned`. For a noop, executePinLeg issues NO
  // Telegram call and returns the LIVE claim (non-null). The pre-fix clear
  // branch dropped the row unconditionally, so the worker feed's per-edit
  // syncPin (every steady-state edit maps to a noop-clear) erased the durable
  // row for a still-live pin — a crash after that left a stuck pinned card boot
  // cleanup could never see. The row MUST be preserved when applyPin returns a
  // live claim.
  it("clear op with a LIVE claim (noop-already-pinned) PRESERVES the durable row", async () => {
    const { fs, calls } = memFs();
    persistStatusPins(PATH, fs, [pin({ pinKey: "wk:group:g1", messageId: 715 })]);
    const before = calls.length;
    // applyPin returns the live claim unchanged (what executePinLeg does on noop).
    const next = await reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey: "wk:group:g1",
      chatId: "-100123",
      op: { kind: "clear" },
      applyPin: async () => ({ messageId: 715 }),
      log: () => {},
    });
    expect(next).toEqual({ messageId: 715 });
    // Row survives (rewritten confirmed, no `pending`).
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([
      { pinKey: "wk:group:g1", chatId: "-100123", messageId: 715 },
    ]);
    // Sanity: at least one disk write happened (the confirm rewrite) — the fix
    // does not skip persistence, it changes the CONTENT from delete to upsert.
    expect(calls.length).toBeGreaterThan(before);
  });

  it("repeated steady-state noop-clears keep the row present across many edits", async () => {
    const { fs } = memFs();
    persistStatusPins(PATH, fs, [pin({ pinKey: "wk:group:g1", messageId: 715 })]);
    for (let i = 0; i < 5; i++) {
      await reconcileAndPersistStatusPin({
        path: PATH,
        fs,
        pinKey: "wk:group:g1",
        chatId: "-100123",
        op: { kind: "clear" },
        applyPin: async () => ({ messageId: 715 }),
        log: () => {},
      });
    }
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([
      { pinKey: "wk:group:g1", chatId: "-100123", messageId: 715 },
    ]);
  });
});

/**
 * F2 (invisible-worker-cards review): the gateway's status-pin reconcile reads
 * its `prev` claim from an in-memory map at the top of the reconcile, then
 * awaits. Two overlapping reconciles for ONE key with OPPOSITE desires could
 * both capture a stale `prev` → a turn-end `{pinned:false}` clears the durable
 * row while a flood-delayed open-pin lands, leaving a stuck pin with no row.
 *
 * These tests exercise the REAL fix primitives — `withPinReconcileLock` +
 * `reconcileAndPersistStatusPin` + `executePinLeg` + `decidePinAction` — composed
 * exactly as the gateway wires them (read prev INSIDE the per-key lock), and
 * prove the row survives. The `noLock` control models the pre-fix ordering
 * (prev read OUTSIDE the lock) and shows it regresses — so the lock, not luck,
 * is what fixes it.
 */
describe("status-pin-store — F2 per-key reconcile serialization", () => {
  // A gateway-faithful reconcile: an in-memory claim map (the `prev` source read
  // at the TOP of the reconcile), the real decide→op mapping, and
  // reconcileAndPersistStatusPin driving executePinLeg against a call-counting
  // pin API. An optional gate lets a test hold ONE reconcile's applyPin open to
  // force the exact interleave. `serialize` toggles the F2 fix.
  function makeReconciler(fs: StatusPinStoreFsSeam, opts: { serialize: boolean }) {
    const claims = new Map<string, StatusPinClaim>();
    const pinCalls: number[] = [];
    const unpinCalls: number[] = [];
    const api: PinBotApi = {
      pinChatMessage: async (_c, id) => {
        pinCalls.push(id);
      },
      unpinChatMessage: async (_c, id) => {
        unpinCalls.push(id);
      },
    };
    // Drives the REAL production orchestrator the gateway calls, so the persist
    // ordering and the RETARGET two-leg expansion under test are the shipped
    // ones — not a copy that could drift out from under this suite.
    function core(pinKey: string, chatId: string, desired: DesiredPin, gate?: Promise<void>) {
      return runStatusPinReconcile({
        pinKey,
        chatId,
        prev: prevOf(claims, pinKey), // read BEFORE the store op (the F2 window)
        desired,
        persist: { path: PATH, fs },
        runPin: async (action, from) => {
          if (gate) await gate; // hold the pin open inside the store lock
          return executePinLeg({ api, chatId, prevState: from, action });
        },
        claims,
      });
    }
    function reconcile(
      pinKey: string,
      chatId: string,
      desired: DesiredPin,
      gate?: Promise<void>,
    ) {
      return opts.serialize
        ? withPinReconcileLock(pinKey, () => core(pinKey, chatId, desired, gate))
        : core(pinKey, chatId, desired, gate);
    }
    return { reconcile, claims, pinCalls, unpinCalls };
  }

  // The exact review sequence: a flood-delayed OPEN-pin (A) is in-flight inside
  // the store lock; a turn-end UNPIN (B) starts during A's await window and
  // reads prev=null (A has not set the claim yet). Pre-fix, B's clear then drops
  // the disk row A wrote — stranding a live in-memory claim with NO durable row.
  async function runStrandingSequence(serialize: boolean) {
    const { fs } = memFs();
    const r = makeReconciler(fs, { serialize });
    let releaseA!: () => void;
    const gateA = new Promise<void>((res) => {
      releaseA = res;
    });
    // A: open-pin 900, held open at applyPin.
    const aDone = r.reconcile("fg:c:3", "-100123", { pinned: true, messageId: 900 }, gateA);
    // Let A reach its applyPin await (pending row on disk; claim NOT yet set).
    await Promise.resolve();
    await Promise.resolve();
    // B: turn-end unpin, starts now — reads prev from the in-memory claim map.
    const bDone = r.reconcile("fg:c:3", "-100123", { pinned: false });
    await Promise.resolve();
    releaseA();
    await Promise.all([aDone, bDone]);
    return { fs, claims: r.claims, unpinCalls: r.unpinCalls, pinCalls: r.pinCalls };
  }

  it("serialized: turn-end unpin waits for the in-flight open-pin, so the pinned message is genuinely UNPINNED (not stranded)", async () => {
    const { fs, claims, pinCalls, unpinCalls } = await runStrandingSequence(true);
    const rows = loadStatusPins(PATH, fs);
    // Under serialization B runs only after A fully settles, so B reads
    // prev={900}, issues a REAL unpin of the pinned message, and clears the row
    // and claim together. The Telegram pin is cleaned up — nothing stuck.
    expect(pinCalls).toEqual([900]); // A pinned it
    expect(unpinCalls).toEqual([900]); // B unpinned it (the fix)
    expect(idOnly(rows)).toEqual([]);
    expect(claims.get("fg:c:3") ?? null).toBeNull();
  });

  it("pre-fix control (no per-key lock): the same interleave STRANDS the pinned message — pinned, row cleared, NEVER unpinned", async () => {
    const { fs, unpinCalls, pinCalls } = await runStrandingSequence(false);
    const rows = loadStatusPins(PATH, fs);
    // Reproduces the F2 defect the lock removes: B read prev=null during A's
    // await window, so its clear was a NO-OP unpin (issued no Telegram unpin)
    // yet still dropped the durable row A wrote — while A's pin call landed. The
    // message 900 stays pinned on Telegram with NO durable row and no unpin ever
    // issued → stuck until a boot cleanup that can no longer see it.
    expect(pinCalls).toEqual([900]); // message 900 WAS pinned
    expect(unpinCalls).toEqual([]); // …but never unpinned (no-op clear on prev=null)
    expect(idOnly(rows)).toEqual([]); // …and the durable row is gone → unreapable
  });

  it("serialized steady-state noop reconciles add ZERO pin/unpin API calls (finn-flood guard)", async () => {
    const { fs } = memFs();
    const r = makeReconciler(fs, { serialize: true });
    // First open pins exactly once.
    await r.reconcile("wk:group:g1", "-100123", { pinned: true, messageId: 900 });
    expect(r.pinCalls).toEqual([900]);
    expect(r.unpinCalls).toEqual([]);

    // 20 steady-state edits — each a re-pin of the SAME id → decidePinAction
    // noop → executePinLeg issues NO Telegram call. The serialization + F1
    // row-preservation must not add a single pin/unpin API call.
    for (let i = 0; i < 20; i++) {
      await r.reconcile("wk:group:g1", "-100123", { pinned: true, messageId: 900 });
    }
    expect(r.pinCalls).toEqual([900]); // still exactly one pin, ever
    expect(r.unpinCalls).toEqual([]); // never unpinned
    // The durable row is intact throughout (F1).
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([
      { pinKey: "wk:group:g1", chatId: "-100123", messageId: 900 },
    ]);
  });

  // ── RETARGET: a single reconcile must leave the NEW surface pinned ────────
  // The foreground activity card reconciles its `fg:` pin exactly once, when a
  // card OPENs (narrative-lane.ts). The ack-first reopen path nulls
  // `activityMessageId` mid-turn, so a fresh card opens and that ONE reconcile
  // is the only chance to move the pin. It used to emit an unpin and stop:
  // nothing pinned, and a durable row that had been deleted — so neither the
  // mid-session reaper nor the next boot's sweep had anything to work from.
  it("RETARGET: one reconcile unpins the old card, pins the NEW one, and leaves the durable row on the new id", async () => {
    const { fs } = memFs();
    const r = makeReconciler(fs, { serialize: true });

    await r.reconcile("fg:c:7", "-100123", { pinned: true, messageId: 900 });
    expect(r.pinCalls).toEqual([900]);
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([
      { pinKey: "fg:c:7", chatId: "-100123", messageId: 900 },
    ]);

    // The card is re-posted mid-turn — ONE reconcile, new message id.
    await r.reconcile("fg:c:7", "-100123", { pinned: true, messageId: 901 });

    expect(r.unpinCalls).toEqual([900]); // stale card unpinned
    expect(r.pinCalls).toEqual([900, 901]); // …AND the new card pinned
    expect(r.claims.get("fg:c:7")?.messageId).toBe(901);
    // The durable row tracks the message that is genuinely pinned, so the
    // mid-session reaper and the boot sweep can both still reach it.
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([
      { pinKey: "fg:c:7", chatId: "-100123", messageId: 901 },
    ]);
  });

  it("RETARGET: a never-confirmed unpin keeps the OLD id in the durable row (no unreapable orphan)", async () => {
    // #3664 Defect B composed with the retarget: the old message is provably
    // still pinned, so we must NOT pin the new one and must NOT lose the row —
    // otherwise the chat holds a pin nothing on disk names.
    const { fs } = memFs();
    const claims = new Map<string, StatusPinClaim>();
    const pinCalls: number[] = [];
    const unpinCalls: number[] = [];
    let floodTheUnpin = false;
    const api: PinBotApi = {
      pinChatMessage: async (_c, id) => {
        pinCalls.push(id);
      },
      unpinChatMessage: async (_c, id) => {
        unpinCalls.push(id);
        if (floodTheUnpin) throw makeFloodWaitActiveError(300, Date.now() + 300_000, null);
      },
    };
    const reconcile = (desired: DesiredPin) =>
      runStatusPinReconcile({
        pinKey: "fg:c:8",
        chatId: "-100123",
        prev: prevOf(claims, "fg:c:8"),
        desired,
        persist: { path: PATH, fs },
        runPin: (action, from) =>
          executePinLeg({ api, chatId: "-100123", prevState: from, action }),
        claims,
      });

    await reconcile({ pinned: true, messageId: 900 });
    floodTheUnpin = true;
    await reconcile({ pinned: true, messageId: 901 });

    expect(unpinCalls).toEqual([900]); // attempted…
    expect(pinCalls).toEqual([900]); // …and the pin leg was correctly SKIPPED
    expect(claims.get("fg:c:8")?.messageId).toBe(900); // claim retained
    expect(idOnly(loadStatusPins(PATH, fs))).toEqual([
      { pinKey: "fg:c:8", chatId: "-100123", messageId: 900 },
    ]);
  });
});
