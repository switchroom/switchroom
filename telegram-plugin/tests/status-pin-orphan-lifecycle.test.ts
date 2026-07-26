/**
 * #3634 — "the progress card stays pinned after the turn completes."
 *
 * Two independent defects kept a finished activity card pinned forever. Both
 * are asserted here as OUTCOMES ("is anything still pinned in Telegram?"), so
 * each test fails against the pre-fix code:
 *
 *   D1 — the boot orphan-pin sweep ran at module-eval time, thousands of lines
 *        before `lockedBot` was assigned, so every unpin it issued threw
 *        `undefined is not an object (evaluating 'lockedBot.api')`. It never
 *        cleaned up anything on any agent; after BOOT_UNPIN_MAX_ATTEMPTS boots
 *        the row was forfeited and the pin became permanent.
 *
 *   D2 — a RUNTIME unpin that failed (FLOOD_WAIT_ACTIVE / 5xx / rights revoked)
 *        dropped the in-memory claim AND deleted the durable row, so the still-
 *        pinned message had nothing on disk naming it and boot cleanup could
 *        never see it.
 */

import { describe, it, expect } from "vitest";
import {
  loadStatusPins,
  persistStatusPins,
  reconcileAndPersistStatusPin,
  runStatusPinBootCleanup,
  orphanPinKey,
  BOOT_UNPIN_MAX_ATTEMPTS,
  type PersistedStatusPin,
  type StatusPinStoreFsSeam,
} from "../gateway/status-pin-store.js";
import { reconcilePin, type PinBotApi } from "../status-pin-driver.js";
import { PinRightsCache } from "../status-pin.js";
import {
  runBootPinSweep,
  createBotReadyGate,
} from "../gateway/boot-pin-sweep.js";
import {
  createOrphanPinRegistry,
  ORPHAN_PIN_MAX_ATTEMPTS,
} from "../gateway/status-pin-orphans.js";

const PATH = "/state/agent/telegram/status-pins.json";

function memFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const fs: StatusPinStoreFsSeam = {
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`);
      return files.get(p)!;
    },
    writeFileSync: (p, d) => {
      files.set(p, d);
    },
    renameSync: (a, b) => {
      if (!files.has(a)) throw new Error(`ENOENT ${a}`);
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    existsSync: (p) => files.has(p),
  };
  return { fs, files };
}

/** A Telegram stand-in that tracks what is actually pinned in the chat, so a
 *  test can assert the OUTCOME ("nothing is pinned") rather than the fact that
 *  some unpin function was called. */
function fakeChat() {
  const pinned = new Set<number>();
  const unpinCalls: number[] = [];
  return {
    pinned,
    unpinCalls,
    pin: (id: number) => pinned.add(id),
    unpin: async (_chatId: string, messageId: number) => {
      unpinCalls.push(messageId);
      pinned.delete(messageId);
      return {};
    },
  };
}

describe("#3634 D1: the boot pin sweep must not run before the bot exists", () => {
  /**
   * Models the real gateway shape: `lockedBot` is a `let … !: Bot` that is
   * undefined until initGatewayBot() assigns it, and the pin API closes over
   * it. Pre-fix the sweep was fired at module-eval time, so this deref threw.
   */
  function gatewayLike() {
    const chat = fakeChat();
    let lockedBot: { unpin: (c: string, m: number) => Promise<unknown> } | undefined;
    const gate = createBotReadyGate();
    const unpinViaBot = (chatId: string, messageId: number) =>
      // The literal pre-fix failure: dereferencing an unset `lockedBot`.
      lockedBot!.unpin(chatId, messageId);
    return {
      chat,
      gate,
      unpinViaBot,
      initBot: () => {
        lockedBot = { unpin: chat.unpin };
        gate.markReady();
      },
    };
  }

  it("clears an orphaned pin from a prior session (fails if the sweep races initGatewayBot)", async () => {
    const { fs } = memFs();
    const g = gatewayLike();
    g.chat.pin(715);
    persistStatusPins(PATH, fs, [
      { pinKey: "fg:-100123:_", chatId: "-100123", messageId: 715 },
    ]);

    // Boot order, faithfully: the sweep is fired (fire-and-forget) from the
    // startup-mutex block, and initGatewayBot() only assigns the bot later.
    const sweep = runBootPinSweep({
      botReady: g.gate.ready,
      scanDmChatIds: () => [],
      statusPinCleanup: () =>
        runStatusPinBootCleanup({
          path: PATH,
          fs,
          unpin: g.unpinViaBot,
          log: () => {},
        }),
      activityCardReaper: async () => {},
      queuedCardReaper: async () => {},
      enableDmSweep: () => {},
      sweepDm: async () => {},
      log: () => {},
    });

    // Nothing may have been attempted yet — the bot does not exist.
    await Promise.resolve();
    expect(g.chat.unpinCalls).toEqual([]);

    g.initBot();
    await sweep;

    // OUTCOME: the orphaned pin is gone from the chat and from the store.
    expect(g.chat.pinned.size).toBe(0);
    expect(g.chat.unpinCalls).toEqual([715]);
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });

  it("runs the store scan before the gate and the API steps in order after it", async () => {
    const g = gatewayLike();
    const order: string[] = [];
    const sweep = runBootPinSweep({
      botReady: g.gate.ready,
      scanDmChatIds: () => {
        order.push("scan");
        return ["8248703757"];
      },
      statusPinCleanup: async () => {
        order.push("status-pins");
      },
      activityCardReaper: async () => {
        order.push("activity-cards");
      },
      queuedCardReaper: async () => {
        order.push("queued-cards");
      },
      enableDmSweep: () => order.push("enable-dm"),
      sweepDm: async (id) => {
        order.push(`dm:${id}`);
      },
      log: () => {},
    });
    await Promise.resolve();
    expect(order).toEqual(["scan"]); // gate holds everything else

    g.initBot();
    await sweep;
    expect(order).toEqual([
      "scan",
      "status-pins",
      "activity-cards",
      "queued-cards",
      "enable-dm",
      "dm:8248703757",
    ]);
  });

  it("a throwing step does not strand the steps behind it", async () => {
    const g = gatewayLike();
    g.initBot();
    const order: string[] = [];
    await runBootPinSweep({
      botReady: g.gate.ready,
      scanDmChatIds: () => ["1"],
      statusPinCleanup: async () => {
        throw new Error("boom");
      },
      activityCardReaper: async () => {
        order.push("activity-cards");
      },
      queuedCardReaper: async () => {
        order.push("queued-cards");
      },
      enableDmSweep: () => order.push("enable-dm"),
      sweepDm: async (id) => {
        order.push(`dm:${id}`);
      },
      log: () => {},
    });
    expect(order).toEqual([
      "activity-cards",
      "queued-cards",
      "enable-dm",
      "dm:1",
    ]);
  });
});

describe("#3634 D2: a runtime unpin that does not land stays recorded", () => {
  function floodingApi(): PinBotApi {
    return {
      pinChatMessage: async () => ({}),
      unpinChatMessage: async () => {
        throw new Error("FLOOD_WAIT_ACTIVE");
      },
    };
  }

  it("reports the unpin outcome while still dropping the claim", async () => {
    const outcomes: Array<[string, number]> = [];
    const next = await reconcilePin({
      api: floodingApi(),
      chatId: "-100123",
      prevState: { messageId: 715 },
      desired: { pinned: false },
      onError: () => {},
      onUnpinOutcome: (o, id) => outcomes.push([o, id]),
    });
    // Drop-on-unpin is unchanged: state must never wedge.
    expect(next).toBeNull();
    expect(outcomes).toEqual([["failed", 715]]);
  });

  it("reports 'ok' only when Telegram accepted the unpin", async () => {
    const chat = fakeChat();
    chat.pin(715);
    const outcomes: Array<[string, number]> = [];
    await reconcilePin({
      api: {
        pinChatMessage: async () => ({}),
        unpinChatMessage: (c, m) => chat.unpin(String(c), m),
      },
      chatId: "-100123",
      prevState: { messageId: 715 },
      desired: { pinned: false },
      onUnpinOutcome: (o, id) => outcomes.push([o, id]),
    });
    expect(outcomes).toEqual([["ok", 715]]);
    expect(chat.pinned.size).toBe(0);
  });

  it("reports 'skipped-no-rights' when the rights cache suppresses the call", async () => {
    const rightsCache = new PinRightsCache();
    rightsCache.block("-100123");
    const outcomes: Array<[string, number]> = [];
    let called = 0;
    await reconcilePin({
      api: {
        pinChatMessage: async () => ({}),
        unpinChatMessage: async () => {
          called++;
          return {};
        },
      },
      chatId: "-100123",
      prevState: { messageId: 715 },
      desired: { pinned: false },
      rightsCache,
      onUnpinOutcome: (o, id) => outcomes.push([o, id]),
    });
    expect(called).toBe(0);
    expect(outcomes).toEqual([["skipped-no-rights", 715]]);
  });

  it("re-homes a failed unpin as a durable orphan row instead of deleting it", async () => {
    const { fs } = memFs();
    persistStatusPins(PATH, fs, [
      { pinKey: "fg:-100123:_", chatId: "-100123", messageId: 715 },
    ]);

    const next = await reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey: "fg:-100123:_",
      chatId: "-100123",
      op: { kind: "clear" },
      applyPin: async () => null,
      unpinFailedMessageId: () => 715,
      log: () => {},
    });

    expect(next).toBeNull();
    const rows = loadStatusPins(PATH, fs);
    // Live key released (a fresh turn may claim it immediately)…
    expect(rows.find((r) => r.pinKey === "fg:-100123:_")).toBeUndefined();
    // …but the leaked pin is still named on disk.
    expect(rows).toEqual([
      {
        pinKey: orphanPinKey("-100123", 715),
        chatId: "-100123",
        messageId: 715,
      },
    ]);
  });

  it("a successful unpin still clears the row (no orphan is invented)", async () => {
    const { fs } = memFs();
    persistStatusPins(PATH, fs, [
      { pinKey: "fg:-100123:_", chatId: "-100123", messageId: 715 },
    ]);
    await reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey: "fg:-100123:_",
      chatId: "-100123",
      op: { kind: "clear" },
      applyPin: async () => null,
      unpinFailedMessageId: () => null,
      log: () => {},
    });
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });
});

describe("#3634: no pin outlives its turn, across a restart", () => {
  it("a flood-wait'd turn-end unpin is finished by the next boot's sweep", async () => {
    const { fs } = memFs();
    const chat = fakeChat();
    chat.pin(715); // the activity card, pinned while working

    // ── Turn end, mid flood ban: the unpin throws. ────────────────────────
    let leaked: number | null = null;
    await reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey: "fg:-100123:_",
      chatId: "-100123",
      op: { kind: "clear" },
      applyPin: () =>
        reconcilePin({
          api: {
            pinChatMessage: async () => ({}),
            unpinChatMessage: async () => {
              throw new Error("FLOOD_WAIT_ACTIVE");
            },
          },
          chatId: "-100123",
          prevState: { messageId: 715 },
          desired: { pinned: false },
          onError: () => {},
          onUnpinOutcome: (o, id) => {
            if (o !== "ok") leaked = id;
          },
        }),
      unpinFailedMessageId: () => leaked,
      log: () => {},
    });
    expect(chat.pinned.has(715)).toBe(true); // still pinned — the bug's symptom

    // ── Restart. The boot sweep (with a bot that now exists) finishes it. ──
    const gate = createBotReadyGate();
    gate.markReady();
    await runBootPinSweep({
      botReady: gate.ready,
      scanDmChatIds: () => [],
      statusPinCleanup: () =>
        runStatusPinBootCleanup({ path: PATH, fs, unpin: chat.unpin, log: () => {} }),
      activityCardReaper: async () => {},
      queuedCardReaper: async () => {},
      enableDmSweep: () => {},
      sweepDm: async () => {},
      log: () => {},
    });

    expect(chat.pinned.size).toBe(0);
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });

  it("boot cleanup treats an orphan row as work-scoped (no expiresAt to survive)", async () => {
    const { fs } = memFs();
    const chat = fakeChat();
    chat.pin(42);
    const row: PersistedStatusPin = {
      pinKey: orphanPinKey("-100123", 42),
      chatId: "-100123",
      messageId: 42,
    };
    persistStatusPins(PATH, fs, [row]);
    const res = await runStatusPinBootCleanup({
      path: PATH,
      fs,
      unpin: chat.unpin,
      log: () => {},
    });
    expect(res.cleared).toBe(1);
    expect(res.kept).toBe(0);
    expect(chat.pinned.size).toBe(0);
  });

  it("a permanently undeliverable orphan is forfeited, not retried forever", async () => {
    const { fs } = memFs();
    persistStatusPins(PATH, fs, [
      {
        pinKey: orphanPinKey("-100123", 42),
        chatId: "-100123",
        messageId: 42,
        attempts: BOOT_UNPIN_MAX_ATTEMPTS - 1,
      },
    ]);
    const res = await runStatusPinBootCleanup({
      path: PATH,
      fs,
      unpin: async () => {
        throw new Error("chat not found");
      },
      log: () => {},
    });
    expect(res.retained).toBe(0);
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });
});

describe("#3634: in-process orphan retry", () => {
  it("clears the leaked pin at the next reconcile in that chat", async () => {
    const chat = fakeChat();
    chat.pin(715);
    const cleared: string[] = [];
    const reg = createOrphanPinRegistry({
      unpin: chat.unpin,
      clearRow: (k) => cleared.push(k),
      log: () => {},
    });
    reg.register("-100123", 715);
    reg.register("-100123", 715); // idempotent
    expect(reg.size()).toBe(1);

    await reg.drain("-100123");

    expect(chat.pinned.size).toBe(0);
    expect(reg.size()).toBe(0);
    expect(cleared).toEqual([orphanPinKey("-100123", 715)]);
  });

  it("only drains the chat it was asked for", async () => {
    const chat = fakeChat();
    const reg = createOrphanPinRegistry({
      unpin: chat.unpin,
      clearRow: () => {},
      log: () => {},
    });
    reg.register("-100123", 1);
    reg.register("-100999", 2);
    await reg.drain("-100123");
    expect(chat.unpinCalls).toEqual([1]);
    expect(reg.size()).toBe(1);
  });

  it("keeps retrying a transient failure, then forfeits in-process to the durable row", async () => {
    let fail = true;
    const seen: number[] = [];
    const cleared: string[] = [];
    const reg = createOrphanPinRegistry({
      unpin: async (_c, m) => {
        seen.push(m);
        if (fail) throw new Error("FLOOD_WAIT_ACTIVE");
        return {};
      },
      clearRow: (k) => cleared.push(k),
      log: () => {},
    });
    reg.register("-100123", 715);

    await reg.drain("-100123");
    expect(reg.size()).toBe(1); // retained for the next turn
    fail = false;
    await reg.drain("-100123");
    expect(reg.size()).toBe(0);
    expect(seen).toEqual([715, 715]);
    expect(cleared).toEqual([orphanPinKey("-100123", 715)]);

    // …and a permanently failing one is bounded.
    const reg2 = createOrphanPinRegistry({
      unpin: async () => {
        throw new Error("nope");
      },
      clearRow: () => {},
      log: () => {},
    });
    reg2.register("-100123", 9);
    for (let i = 0; i < ORPHAN_PIN_MAX_ATTEMPTS; i++) await reg2.drain("-100123");
    expect(reg2.size()).toBe(0);
  });

  it("does not stack concurrent drains of the same chat", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const reg = createOrphanPinRegistry({
      unpin: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return {};
      },
      clearRow: () => {},
      log: () => {},
    });
    reg.register("-100123", 1);
    reg.register("-100123", 2);
    await Promise.all([reg.drain("-100123"), reg.drain("-100123")]);
    expect(maxInFlight).toBe(1);
    expect(reg.size()).toBe(0);
  });
});
