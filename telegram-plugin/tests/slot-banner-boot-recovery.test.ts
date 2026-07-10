/**
 * slot-banner boot-recovery (#421) — the crash-recovery path for the pinned
 * OAuth slot banner, exercised against the REAL shared status-pin store +
 * the REAL banner driver the gateway wires up.
 *
 * The bug this guards: the slot banner's pin state used to live ONLY in a
 * module-global `let pinnedBannerState`. A gateway restart while a banner was
 * pinned lost that record, so the orphaned banner stayed pinned forever. The
 * fix routes the banner pin THROUGH the same status-pins.json store (a distinct
 * `banner:` pinKey), so the ONE existing runStatusPinBootCleanup unpins it on
 * boot — no parallel store, no second boot hook.
 *
 * We model the gateway's banner-persistence wiring faithfully with the SAME
 * functions gateway.ts calls (refreshBanner + its persist hooks →
 * persistStatusPins; runStatusPinBootCleanup) over an in-memory fs + a fake
 * Telegram whose pin set we can inspect. A regression in the ordering / cleanup
 * contract reds here.
 *
 * Variants:
 *   (A) confirmed banner pin → crash before any clean unpin → recovered next boot.
 *   (B) pending banner pin (crash INSIDE the persist-after-pin window) →
 *       recovered next boot.
 *   (C) clean unpin (return to default slot) → nothing left for boot cleanup.
 */
import { describe, it, expect } from "vitest";
import {
  loadStatusPins,
  persistStatusPins,
  runStatusPinBootCleanup,
  type PersistedStatusPin,
  type StatusPinStoreFsSeam,
} from "../gateway/status-pin-store.js";
import { refreshBanner } from "../slot-banner-driver.js";
import type { BannerState } from "../slot-banner.js";

const PATH = "/state/agent/telegram/status-pins.json";
const OWNER = "-100999";
const AGENT = "clerk";
const DEFAULT = "default";
const BANNER_PIN_KEY = "banner:owner";

function memFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const fs: StatusPinStoreFsSeam = {
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`);
      return files.get(p)!;
    },
    writeFileSync: (p, d) => files.set(p, d),
    renameSync: (a, b) => {
      if (!files.has(a)) throw new Error(`ENOENT ${a}`);
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    existsSync: (p) => files.has(p),
  };
  return { fs, files };
}

/** A fake Telegram that records the current pinned message set per chat, plus a
 *  monotonic message-id source for sends, so we can assert an orphan is left
 *  pinned after a crash and unpinned after boot. */
function fakeTelegram(startMessageId = 500) {
  const pinned = new Set<string>(); // `${chatId}:${messageId}`
  let nextId = startMessageId;
  return {
    pinned,
    bot: {
      api: {
        sendRichMessage: async (chat_id: string | number) => {
          void chat_id;
          return { message_id: nextId++ };
        },
        pinChatMessage: async (chat_id: string | number, message_id: number) => {
          pinned.add(`${chat_id}:${message_id}`);
        },
        unpinChatMessage: async (chat_id: string | number, message_id: number) => {
          pinned.delete(`${chat_id}:${message_id}`);
        },
        // Unused by the pin path but required by the BannerBotApi surface.
        sendMessage: async (chat_id: string | number) => {
          void chat_id;
          return { message_id: nextId++ };
        },
        editMessageText: async () => undefined,
      },
    },
  };
}

/**
 * A faithful stand-in for the gateway's slot-banner persistence wiring — the
 * SAME shape as gateway.ts's `persistBannerRow` + `snapshotStatusPins` (which
 * folds the banner row into the shared status-pin set) + the banner driver's
 * persist hooks + the ONE runStatusPinBootCleanup, with injectable fs + api so a
 * single test can span a "crash" and a fresh boot.
 */
function makeGateway(fs: StatusPinStoreFsSeam, tg: ReturnType<typeof fakeTelegram>) {
  let bannerPersistedRow: PersistedStatusPin | null = null;
  let pinnedBannerState: BannerState | null = null;

  // Mirrors gateway.ts snapshotStatusPins(): map-backed status pins (none in
  // this isolated harness) PLUS the banner row.
  const snapshotStatusPins = (): PersistedStatusPin[] =>
    bannerPersistedRow ? [bannerPersistedRow] : [];

  const persistBannerRow = (row: PersistedStatusPin | null): void => {
    bannerPersistedRow = row;
    persistStatusPins(PATH, fs, snapshotStatusPins(), () => {});
  };

  async function refreshPinnedBanner(currentSlot: string | null) {
    pinnedBannerState = await refreshBanner({
      bot: tg.bot as never,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot,
      defaultSlot: DEFAULT,
      prevState: pinnedBannerState,
      onError: () => {},
      persist: {
        pending: (chatId, messageId) =>
          persistBannerRow({ pinKey: BANNER_PIN_KEY, chatId, messageId, pending: true }),
        confirm: (chatId, messageId) =>
          persistBannerRow({ pinKey: BANNER_PIN_KEY, chatId, messageId }),
        clear: () => persistBannerRow(null),
      },
    });
  }

  async function bootCleanup() {
    return runStatusPinBootCleanup({
      path: PATH,
      fs,
      unpin: (chatId, messageId) => tg.bot.api.unpinChatMessage(chatId, messageId),
      log: () => {},
    });
  }

  return {
    refreshPinnedBanner,
    bootCleanup,
    get bannerState() {
      return pinnedBannerState;
    },
  };
}

describe("slot-banner boot recovery (gateway wiring)", () => {
  it("(A) confirmed banner pin → crash → next boot unpins the orphan + empties the store", async () => {
    const { fs } = memFs();
    const tg = fakeTelegram();

    // ── Session 1: agent fails over to a non-default slot → banner pinned. ──
    const gw1 = makeGateway(fs, tg);
    await gw1.refreshPinnedBanner("personal");

    // Banner is live in Telegram and recorded on disk (confirmed).
    expect(gw1.bannerState?.slot).toBe("personal");
    const msgId = gw1.bannerState!.messageId;
    expect(tg.pinned.has(`${OWNER}:${msgId}`)).toBe(true);
    expect(loadStatusPins(PATH, fs)).toEqual([
      { pinKey: BANNER_PIN_KEY, chatId: OWNER, messageId: msgId },
    ]);

    // ── CRASH: no clean unpin runs; gw1's in-memory state vanishes. ──
    expect(tg.pinned.has(`${OWNER}:${msgId}`)).toBe(true);

    // ── Session 2: brand-new gateway, empty state, SAME on-disk store. ──
    const gw2 = makeGateway(fs, tg);
    const res = await gw2.bootCleanup();

    expect(res).toEqual({ cleared: 1, retained: 0, kept: 0, total: 1 });
    expect(tg.pinned.has(`${OWNER}:${msgId}`)).toBe(false); // orphan unpinned
    expect(loadStatusPins(PATH, fs)).toEqual([]); // store emptied
  });

  it("(B) pending banner pin (crash inside the persist-after-pin window) → recovered next boot", async () => {
    const { fs } = memFs();
    const tg = fakeTelegram();

    // Simulate the exact crash window: the message is sent + the pending record
    // written, the pin API lands, then the process dies before the confirm
    // rewrite. We reproduce that by calling refreshBanner but faulting the
    // confirm hook (stands in for a SIGKILL between pin and confirm).
    const bannerRow: PersistedStatusPin[] = [];
    const persistRow = (row: PersistedStatusPin | null) => {
      bannerRow.length = 0;
      if (row) bannerRow.push(row);
      persistStatusPins(PATH, fs, [...bannerRow], () => {});
    };

    await refreshBanner({
      bot: tg.bot as never,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: "personal",
      defaultSlot: DEFAULT,
      prevState: null,
      onError: () => {},
      persist: {
        pending: (chatId, messageId) =>
          persistRow({ pinKey: BANNER_PIN_KEY, chatId, messageId, pending: true }),
        // The confirm rewrite never runs (crash). The driver guards the hook,
        // so throwing here models the process dying at exactly that point while
        // leaving the pending record + live pin behind.
        confirm: () => {
          throw new Error("SIGKILL before confirm rewrite");
        },
        clear: () => persistRow(null),
      },
    });

    // Orphan is live in Telegram; a PENDING record is on disk.
    const rec = loadStatusPins(PATH, fs);
    expect(rec).toHaveLength(1);
    expect(rec[0].pending).toBe(true);
    expect(tg.pinned.has(`${OWNER}:${rec[0].messageId}`)).toBe(true);

    // Fresh boot recovers it from the pending record.
    const gw2 = makeGateway(fs, tg);
    const res = await gw2.bootCleanup();
    expect(res).toEqual({ cleared: 1, retained: 0, kept: 0, total: 1 });
    expect(tg.pinned.has(`${OWNER}:${rec[0].messageId}`)).toBe(false);
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });

  it("(C) clean return to default slot unpins + drops the record → boot cleanup is a no-op", async () => {
    const { fs } = memFs();
    const tg = fakeTelegram();
    const gw1 = makeGateway(fs, tg);

    await gw1.refreshPinnedBanner("personal");
    const msgId = gw1.bannerState!.messageId;
    expect(tg.pinned.has(`${OWNER}:${msgId}`)).toBe(true);

    // Return to default: banner unpins and drops its persisted claim.
    await gw1.refreshPinnedBanner(DEFAULT);
    expect(gw1.bannerState).toBeNull();
    expect(tg.pinned.has(`${OWNER}:${msgId}`)).toBe(false);
    expect(loadStatusPins(PATH, fs)).toEqual([]);

    const gw2 = makeGateway(fs, tg);
    expect(await gw2.bootCleanup()).toEqual({ cleared: 0, retained: 0, kept: 0, total: 0 });
  });
});
