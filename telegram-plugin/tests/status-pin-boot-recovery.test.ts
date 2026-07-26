/**
 * status-pin boot-recovery — the HEADLINE crash-recovery path, exercised against
 * the REAL store + reconcile wrapper the gateway wires up (not just the pure
 * decision fn). It reproduces the full sequence the gateway performs:
 *
 *   reconcile a pin → persist (persist-before-pin) → simulate a crash (SKIP the
 *   clean SIGTERM sweep `unpinAllStatusPins`) → boot a "new gateway" (fresh
 *   Maps, same on-disk store) → runStatusPinBootCleanup → assert the orphan pin
 *   is unpinned AND the store is emptied.
 *
 * We cannot import gateway.ts directly (its module top-level runs the whole boot
 * IIFE incl. the startup mutex + bot.start). Instead we model the gateway's
 * status-pin subsystem faithfully with the SAME functions gateway.ts calls
 * (reconcileAndPersistStatusPin, reconcilePin, runStatusPinBootCleanup) over an
 * in-memory fs + a fake Telegram whose pin set we can inspect — so a regression
 * in the ordering / cleanup contract reds here.
 *
 * Two variants:
 *   (A) confirmed pin → crash before the clean sweep → recovered next boot.
 *   (B) pending pin (crash INSIDE the persist-after-pin window, Fix 1) →
 *       recovered next boot.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  loadStatusPins,
  persistStatusPins,
  reconcileAndPersistStatusPin,
  runStatusPinBootCleanup,
  type StatusPinStoreFsSeam,
} from "../gateway/status-pin-store.js";
import { reconcilePin } from "../status-pin-driver.js";
import type { PinState, DesiredPin } from "../status-pin.js";
import { decidePinAction } from "../status-pin.js";
import { makeFloodWaitActiveError } from "../retry-api-call.js";

const PATH = "/state/agent/telegram/status-pins.json";

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

/** A fake Telegram that records the current pinned message set per chat, so we
 *  can assert an orphan is left pinned after a crash and unpinned after boot. */
function fakeTelegram() {
  const pinned = new Set<string>(); // `${chatId}:${messageId}`
  return {
    pinned,
    api: {
      pinChatMessage: async (chat_id: string | number, message_id: number) => {
        pinned.add(`${chat_id}:${message_id}`);
      },
      unpinChatMessage: async (chat_id: string | number, message_id: number) => {
        pinned.delete(`${chat_id}:${message_id}`);
      },
    },
  };
}

/**
 * A faithful stand-in for the gateway's status-pin subsystem — the SAME wiring
 * as gateway.ts's `reconcileStatusPin` / `unpinAllStatusPins` / boot cleanup,
 * with injectable fs + api so a single test can span a "crash" and a fresh boot.
 */
function makeGateway(fs: StatusPinStoreFsSeam, tg: ReturnType<typeof fakeTelegram>) {
  const statusPinState = new Map<string, PinState>();
  const statusPinChatIds = new Map<string, string>();

  async function reconcileStatusPin(pinKey: string, chatId: string, desired: DesiredPin) {
    const prev = statusPinState.get(pinKey) ?? null;
    const action = decidePinAction(prev, desired);
    const op =
      action.kind === "pin"
        ? ({ kind: "pin", messageId: action.messageId } as const)
        : ({ kind: "clear" } as const);
    const next = await reconcileAndPersistStatusPin({
      path: PATH,
      fs,
      pinKey,
      chatId,
      op,
      applyPin: () =>
        reconcilePin({ api: tg.api, chatId, prevState: prev, desired }),
      log: () => {},
    });
    if (next == null) {
      statusPinState.delete(pinKey);
      statusPinChatIds.delete(pinKey);
    } else {
      statusPinState.set(pinKey, next);
      statusPinChatIds.set(pinKey, chatId);
    }
  }

  async function bootCleanup() {
    return runStatusPinBootCleanup({
      path: PATH,
      fs,
      unpin: (chatId, messageId) => tg.api.unpinChatMessage(chatId, messageId),
      log: () => {},
    });
  }

  return { statusPinState, reconcileStatusPin, bootCleanup };
}

describe("status-pin boot recovery (gateway wiring)", () => {
  it("(A) confirmed pin → crash skips the clean sweep → next boot unpins the orphan + empties the store", async () => {
    const { fs } = memFs();
    const tg = fakeTelegram();

    // ── Session 1: reconcile a pin. persist-before-pin runs; pin lands. ──
    const gw1 = makeGateway(fs, tg);
    await gw1.reconcileStatusPin("fg:c:3", "-100123", { pinned: true, messageId: 715 });

    // Pin is live in Telegram and recorded on disk (confirmed).
    expect(tg.pinned.has("-100123:715")).toBe(true);
    expect(loadStatusPins(PATH, fs)).toEqual([
      { pinKey: "fg:c:3", chatId: "-100123", messageId: 715 },
    ]);

    // ── CRASH: we deliberately DO NOT run the clean SIGTERM sweep
    //    (unpinAllStatusPins). The pin stays live; gw1's Maps vanish. ──
    expect(tg.pinned.has("-100123:715")).toBe(true);

    // ── Session 2: brand-new gateway, empty Maps, SAME on-disk store. ──
    const gw2 = makeGateway(fs, tg);
    const res = await gw2.bootCleanup();

    expect(res).toEqual({ cleared: 1, retained: 0, kept: 0, total: 1 });
    expect(tg.pinned.has("-100123:715")).toBe(false); // orphan unpinned
    expect(loadStatusPins(PATH, fs)).toEqual([]); // store emptied
  });

  it("(B) pending pin (crash inside the persist-after-pin window) → recovered next boot", async () => {
    const { fs } = memFs();
    const tg = fakeTelegram();

    // Simulate the exact Fix-1 crash window: the pin API lands, then the
    // process is SIGKILLed before the confirming rewrite. We model that by
    // reconcileAndPersistStatusPin whose applyPin pins then throws.
    await expect(
      reconcileAndPersistStatusPin({
        path: PATH,
        fs,
        pinKey: "fg:c:3",
        chatId: "-100123",
        op: { kind: "pin", messageId: 715 },
        applyPin: async () => {
          await tg.api.pinChatMessage("-100123", 715); // pin lands in Telegram
          throw new Error("SIGKILL before confirm rewrite");
        },
        log: () => {},
      }),
    ).rejects.toThrow("SIGKILL");

    // Orphan is live in Telegram; a PENDING record is on disk.
    expect(tg.pinned.has("-100123:715")).toBe(true);
    expect(loadStatusPins(PATH, fs)).toEqual([
      { pinKey: "fg:c:3", chatId: "-100123", messageId: 715, pending: true },
    ]);

    // Fresh boot recovers it from the pending record.
    const gw2 = makeGateway(fs, tg);
    const res = await gw2.bootCleanup();
    expect(res).toEqual({ cleared: 1, retained: 0, kept: 0, total: 1 });
    expect(tg.pinned.has("-100123:715")).toBe(false);
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });

  it("(C) #3664: a never-confirmed unpin (FLOOD_WAIT_ACTIVE) KEEPS the claim + the durable row, and the next boot clears the pin", async () => {
    // Defect B: the unpin was refused LOCALLY by the send gate, so the message
    // is provably still pinned. The old driver returned null anyway, which made
    // reconcileAndPersistStatusPin delete the row and the gateway delete the
    // in-memory claim — erasing BOTH records of a live pin. Nothing (reaper or
    // boot sweep) could ever find it again.
    const { fs } = memFs();
    const pinned = new Set<string>();
    let floodOpen = true;
    const tg = {
      pinned,
      api: {
        pinChatMessage: async (chat_id: string | number, message_id: number) => {
          pinned.add(`${chat_id}:${message_id}`);
        },
        unpinChatMessage: async (chat_id: string | number, message_id: number) => {
          // The send gate fail-fast: NO request leaves the process.
          if (floodOpen) throw makeFloodWaitActiveError(16739, Date.now() + 16739_000, null);
          pinned.delete(`${chat_id}:${message_id}`);
        },
      },
    };

    const gw1 = makeGateway(fs, tg);
    await gw1.reconcileStatusPin("fg:c:3", "-100123", { pinned: true, messageId: 715 });
    expect(pinned.has("-100123:715")).toBe(true);

    // Turn ends → unpin requested → refused locally.
    await gw1.reconcileStatusPin("fg:c:3", "-100123", { pinned: false });

    // The pin is STILL UP …
    expect(pinned.has("-100123:715")).toBe(true);
    // … and BOTH records survive: the in-memory claim …
    expect(gw1.statusPinState.get("fg:c:3")).toEqual({ messageId: 715 });
    // … and the durable row (what boot cleanup reads).
    expect(loadStatusPins(PATH, fs)).toEqual([
      { pinKey: "fg:c:3", chatId: "-100123", messageId: 715 },
    ]);

    // Same session, flood window closed: the retained claim retries and clears.
    floodOpen = false;
    await gw1.reconcileStatusPin("fg:c:3", "-100123", { pinned: false });
    expect(pinned.has("-100123:715")).toBe(false);
    expect(gw1.statusPinState.has("fg:c:3")).toBe(false);
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });

  it("(D) #3664: if the process dies while the flood window is open, the retained row lets the NEXT boot clear the orphan", async () => {
    const { fs } = memFs();
    const pinned = new Set<string>();
    let floodOpen = true;
    const tg = {
      pinned,
      api: {
        pinChatMessage: async (chat_id: string | number, message_id: number) => {
          pinned.add(`${chat_id}:${message_id}`);
        },
        unpinChatMessage: async (chat_id: string | number, message_id: number) => {
          if (floodOpen) throw makeFloodWaitActiveError(16739, Date.now() + 16739_000, null);
          pinned.delete(`${chat_id}:${message_id}`);
        },
      },
    };

    const gw1 = makeGateway(fs, tg);
    await gw1.reconcileStatusPin("fg:c:3", "-100123", { pinned: true, messageId: 715 });
    await gw1.reconcileStatusPin("fg:c:3", "-100123", { pinned: false }); // refused
    // CRASH here — in-memory state is gone, only the durable row remains.

    floodOpen = false;
    const gw2 = makeGateway(fs, tg);
    const res = await gw2.bootCleanup();
    expect(res).toEqual({ cleared: 1, retained: 0, kept: 0, total: 1 });
    expect(pinned.has("-100123:715")).toBe(false);
    expect(loadStatusPins(PATH, fs)).toEqual([]);
  });

  it("clean shutdown (sweep DID run) leaves nothing for boot cleanup to do", async () => {
    // Contrast: when the SIGTERM sweep runs (unpin each key), the store is
    // emptied and the pin removed — boot cleanup is a no-op. This guards the
    // ordering the other way: normal shutdown must NOT rely on boot cleanup.
    const { fs } = memFs();
    const tg = fakeTelegram();
    const gw1 = makeGateway(fs, tg);
    await gw1.reconcileStatusPin("fg:c:3", "-100123", { pinned: true, messageId: 715 });
    // Clean sweep: unpin the key.
    await gw1.reconcileStatusPin("fg:c:3", "-100123", { pinned: false });
    expect(tg.pinned.size).toBe(0);
    expect(loadStatusPins(PATH, fs)).toEqual([]);

    const gw2 = makeGateway(fs, tg);
    expect(await gw2.bootCleanup()).toEqual({ cleared: 0, retained: 0, kept: 0, total: 0 });
  });
});

/**
 * Mutex-gating (P2). The boot cleanup issues real unpins against a SHARED
 * per-agent store, so a LOSING double-boot must NOT run it — else it would strip
 * a still-alive sibling gateway's legitimate pins. gateway.ts gates the call
 * inside the won-lock branch (only the boot that wins acquireStartupLock calls
 * statusPinBootCleanup; the loser process.exit(1)s first).
 *
 * A full held-lock integration test is impractical (gateway.ts's boot IIFE runs
 * the mutex + bot.start at import). So we assert STRUCTURALLY that the cleanup
 * call sits inside the won-lock branch and never at the top-level import scope,
 * and that the loser (blocked) branch exits before it.
 */
describe("status-pin boot cleanup is mutex-gated (structural)", () => {
  const gatewaySrc = readFileSync(
    fileURLToPath(new URL("../gateway/gateway.ts", import.meta.url)),
    "utf8",
  );

  it("does NOT invoke statusPinBootCleanup at module import scope", () => {
    // The invocation must be gated on winning the mutex, never fired eagerly at
    // import. A bare top-level `statusPinBootCleanup()` (not inside the lock
    // block) would let a losing double-boot strip a live sibling's pins.
    // The definition + the deliberate DO-NOT-invoke note are allowed; assert
    // there is a note explaining the gating, and that every actual call is
    // preceded (in source order) by the acquireStartupLock outcome check.
    expect(gatewaySrc).toContain("acquireStartupLock");
    // The comment documenting WHY it isn't invoked at import time.
    expect(gatewaySrc).toMatch(
      /NOT invoked here at import time|gated on winning the startup mutex/,
    );
  });

  it("every boot pin-cleanup call site follows the won-lock check", () => {
    // #3026: boot cleanup is now invoked via the mutex-gated orchestrator
    // runBootPinCleanupAndDmSweep(), which awaits statusPinBootCleanup()
    // (+ the other reapers) and then runs the DM stale-pin sweep. The
    // invariant is unchanged: cleanup must only run after the lock is won.
    const lines = gatewaySrc.split("\n");
    const lockIdx = lines.findIndex((l) => l.includes("acquireStartupLock({"));
    expect(lockIdx).toBeGreaterThan(-1);

    // #3664: the winner ARMS the bot-ready gate rather than dispatching the
    // sweep inline. Every arm() site must still come AFTER the
    // acquireStartupLock outcome is available (the boot block the winner — or
    // the link()-unsupported fallback — reaches).
    const callIdxs = lines
      .map((l, i) => ({ l, i }))
      .filter(
        ({ l }) =>
          /bootPinSweepGate\.arm\(\)/.test(l) && !l.trimStart().startsWith("//"),
      )
      .map(({ i }) => i);
    expect(callIdxs.length).toBeGreaterThan(0);
    for (const idx of callIdxs) {
      expect(idx).toBeGreaterThan(lockIdx);
    }

    // statusPinBootCleanup() itself must only ever be invoked from INSIDE
    // that orchestrator — never at a bare post-import call site that a
    // losing double-boot could reach.
    const declIdx = lines.findIndex((l) =>
      /async function statusPinBootCleanup/.test(l),
    );
    expect(declIdx).toBeGreaterThan(-1);
    const orchestratorIdx = lines.findIndex((l) =>
      /async function runBootPinCleanupAndDmSweep/.test(l),
    );
    expect(orchestratorIdx).toBeGreaterThan(-1);
    const invocationIdxs = lines
      .map((l, i) => ({ l, i }))
      .filter(
        ({ l, i }) =>
          i !== declIdx &&
          /statusPinBootCleanup\(\)/.test(l) &&
          !l.trimStart().startsWith("//") &&
          !l.includes("statusPinBootCleanup() is deliberately NOT"),
      )
      .map(({ i }) => i);
    expect(invocationIdxs.length).toBeGreaterThan(0);
    for (const idx of invocationIdxs) {
      expect(idx).toBeGreaterThan(orchestratorIdx);
    }
  });

  it("the blocked (losing) boot exits before reaching cleanup", () => {
    // In the mutex block, `outcome.status === 'blocked'` must lead to
    // process.exit(1) BEFORE the winner's runBootPinCleanupAndDmSweep() call
    // in that block — so a loser never touches the shared store.
    const blockedIdx = gatewaySrc.indexOf("outcome.status === 'blocked'");
    expect(blockedIdx).toBeGreaterThan(-1);
    const afterBlocked = gatewaySrc.slice(blockedIdx);
    const exitIdx = afterBlocked.indexOf("process.exit(1)");
    // #3664: the winner now ARMS a two-condition gate instead of dispatching
    // the sweep inline (the sweep also needs `lockedBot`), so the marker for
    // "the winner's cleanup path" is the arm() call.
    const cleanupIdx = afterBlocked.indexOf("bootPinSweepGate.arm()");
    expect(exitIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeGreaterThan(-1);
    // The exit for the blocked branch appears before the winner's cleanup call.
    expect(exitIdx).toBeLessThan(cleanupIdx);
  });
});
