/**
 * Unit tests for the UAT mtcute driver wrapper.
 *
 * Issue: https://github.com/switchroom/switchroom/issues/865
 *
 * These mock `@mtcute/node`; no real network or session string is
 * required. The real-Telegram side lives in
 * `telegram-plugin/uat/scenarios/`.
 *
 * Why this file lives at repo-root `tests/` rather than next to
 * `telegram-plugin/uat/driver.ts`: the buildkite pipeline runs
 * `bun test` from `telegram-plugin/`, and bun's vitest-compat shim
 * doesn't cover `vi.mock` / `vi.resetModules`. Moving the tests
 * outside `telegram-plugin/` keeps vitest discovery intact while
 * sidestepping bun's discovery.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Driver as DriverType,
  ObservedMessage,
} from "../telegram-plugin/uat/driver.js";

class MockEmitter<T> {
  private listeners = new Set<(v: T) => void>();
  add(fn: (v: T) => void): void {
    this.listeners.add(fn);
  }
  remove(fn: (v: T) => void): void {
    this.listeners.delete(fn);
  }
  emit(v: T): void {
    for (const fn of this.listeners) fn(v);
  }
  get size(): number {
    return this.listeners.size;
  }
}

const mockClient = {
  importSession: vi.fn(async () => undefined),
  connect: vi.fn(async () => undefined),
  startUpdatesLoop: vi.fn(async () => undefined),
  destroy: vi.fn(async () => undefined),
  sendText: vi.fn(async () => ({ id: 999 })),
  sendMedia: vi.fn(async () => ({ id: 1234 })),
  getMessages: vi.fn(async (_chatId: number, _ids: number[]) => [null]),
  getCallbackAnswer: vi.fn(async () => ({ message: "ok" })),
  onNewMessage: new MockEmitter<unknown>(),
  onEditMessage: new MockEmitter<unknown>(),
  onRawUpdate: new MockEmitter<unknown>(),
};

const TelegramClientCtor = vi.fn().mockImplementation(() => mockClient);

// Real implementation of mtcute's marked-peer-id helper. Inlined here
// because `vi.mock("@mtcute/node", ...)` below replaces ALL exports;
// re-export from a partial passthrough would couple this test file
// to mtcute's internal layout. The semantics are stable per
// `@mtcute/core/utils/peer-utils.js`:
//   peerUser  → userId
//   peerChat  → -chatId
//   peerChannel → -1e12 - channelId
function getMarkedPeerIdImpl(peer: { _: string; userId?: number; chatId?: number; channelId?: number }): number {
  switch (peer._) {
    case "peerUser":
    case "inputPeerUser":
      return peer.userId!;
    case "peerChat":
    case "inputPeerChat":
      return -peer.chatId!;
    case "peerChannel":
    case "inputPeerChannel":
      return -1e12 - peer.channelId!;
    default:
      throw new Error(`Invalid peer: ${peer._}`);
  }
}

// Build the `raw` slice a Message double needs so `toObserved` can read the
// chat/sender ids off the RAW TL peer (index-free). Mirrors mtcute's marked-id
// convention: positive ⇒ user (peerUser), -100…-prefixed ⇒ channel, other
// negative ⇒ basic chat. `fromId` defaults to the same peer as the chat (a bot
// reply in a DM has no explicit fromId; the peer IS the sender).
function rawWithPeer(
  markedChatId: number,
  markedFromId?: number,
): { _: "message"; peerId: unknown; fromId?: unknown; media: undefined } {
  const toRawPeer = (id: number): unknown => {
    if (id > 0) return { _: "peerUser", userId: id };
    if (id <= -1e12) return { _: "peerChannel", channelId: -1e12 - id };
    return { _: "peerChat", chatId: -id };
  };
  return {
    _: "message",
    peerId: toRawPeer(markedChatId),
    fromId: markedFromId !== undefined ? toRawPeer(markedFromId) : undefined,
    media: undefined,
  };
}

vi.mock("@mtcute/node", () => ({
  MemoryStorage: class {},
  TelegramClient: TelegramClientCtor,
  getMarkedPeerId: getMarkedPeerIdImpl,
  // Stand-in for mtcute's `InputMedia.voice(filePath)` factory.
  // Production returns an `InputMediaVoice` object; tests just need
  // to assert that the factory was called with the file path and
  // that the result was handed to client.sendMedia.
  InputMedia: {
    voice: (file: string) => ({ __type: "InputMediaVoice", file }),
  },
}));

let Driver: typeof DriverType;

beforeEach(async () => {
  vi.clearAllMocks();
  mockClient.onNewMessage = new MockEmitter<unknown>();
  mockClient.onEditMessage = new MockEmitter<unknown>();
  mockClient.onRawUpdate = new MockEmitter<unknown>();
  Driver = (await import("../telegram-plugin/uat/driver.js")).Driver;
});

afterEach(() => {
  // Drop the dynamic-import cache so each test sees a fresh module
  // graph. Without this, a future refactor that moves state to
  // module scope would silently leak across tests.
  vi.resetModules();
});

describe("Driver.connect", () => {
  it("creates an mtcute client with MemoryStorage, imports session with force=true, then connects", async () => {
    // fails when: a future refactor drops `force: true` on
    // importSession — mtcute treats the missing-prior-session as
    // authoritative and silently ignores ours, leaving the client
    // unauthenticated. The smoke scenario would then hang on the
    // first send instead of failing fast at connect.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();

    expect(TelegramClientCtor).toHaveBeenCalledTimes(1);
    const ctorArgs = TelegramClientCtor.mock.calls[0]?.[0] as {
      storage: object;
      apiId: number;
      apiHash: string;
    };
    expect(ctorArgs.apiId).toBe(1);
    expect(ctorArgs.apiHash).toBe("h");
    expect(ctorArgs.storage).toBeDefined();
    expect(ctorArgs.storage.constructor.name).toBe("MemoryStorage");

    expect(mockClient.importSession).toHaveBeenCalledWith("S", true);
    expect(mockClient.connect).toHaveBeenCalledTimes(1);

    const importOrder = mockClient.importSession.mock.invocationCallOrder[0];
    const connectOrder = mockClient.connect.mock.invocationCallOrder[0];
    expect(importOrder).toBeLessThan(connectOrder!);
  });

  it("calls startUpdatesLoop after connect so onNewMessage / onEditMessage fire for live updates", async () => {
    // fails when: someone "simplifies" the connect chain by dropping
    // the startUpdatesLoop call — `client.connect()` alone opens the
    // transport but DOES NOT start dispatching incoming updates to
    // the parsed emitters. Symptom is silent: messages arrive in
    // Telegram (visible in the chat) but `observeMessages` never
    // yields them, and `expectMessage` waits the full timeout. Took
    // a debug session against a real bot reply to find the first
    // time; this test exists so the second time is a unit-test
    // failure on the PR, not a 90-second timeout in CI.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    expect(mockClient.startUpdatesLoop).toHaveBeenCalledTimes(1);
    const connectOrder = mockClient.connect.mock.invocationCallOrder[0];
    const loopOrder = mockClient.startUpdatesLoop.mock.invocationCallOrder[0];
    // Loop must start AFTER connect — calling startUpdatesLoop before
    // there's a transport throws.
    expect(connectOrder).toBeLessThan(loopOrder!);
  });
});

describe("Driver.sendText", () => {
  it("forwards messageThreadId via replyTo so messages route into the right forum topic", async () => {
    // fails when: a refactor drops the messageThreadId→replyTo
    // mapping — mtcute then sends to the supergroup's "general" topic
    // and the UAT scenario observes its message in the wrong topic,
    // typically presenting as `expectMessage` timing out because
    // the per-topic observer filter rejects it.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();

    await driver.sendText(-1001234567890, "hi", { messageThreadId: 42 });
    expect(mockClient.sendText).toHaveBeenCalledWith(
      -1001234567890,
      "hi",
      { replyTo: 42 },
    );
  });

  it("explicit replyTo (quote-reply) takes precedence over messageThreadId", async () => {
    // fails when: the precedence is flipped — quoting a specific
    // message would silently route to the wrong topic instead.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();

    await driver.sendText(-100, "quote", { messageThreadId: 10, replyTo: 555 });
    expect(mockClient.sendText).toHaveBeenCalledWith(-100, "quote", {
      replyTo: 555,
    });
  });

  it("omits the params object when no thread or reply target is given", async () => {
    // fails when: a refactor always passes `{ replyTo: undefined }`,
    // which some mtcute versions reject with VALIDATE_ERROR. Cleanest
    // is to pass undefined as the params entirely.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();

    await driver.sendText(-100, "bare");
    expect(mockClient.sendText).toHaveBeenCalledWith(-100, "bare", undefined);
  });
});

describe("Driver.observeMessages", () => {
  function fakeMessage(opts: {
    chatId: number;
    id: number;
    text: string;
    threadId?: number;
    fromBot?: boolean;
  }): unknown {
    return {
      id: opts.id,
      text: opts.text,
      date: new Date(),
      chat: { id: opts.chatId },
      sender: { type: "user", isBot: opts.fromBot === true },
      // `toObserved` reads the RAW TL peer for chat/sender ids (index-free,
      // never-throws). A real mtcute Message always carries `raw.peerId`; a
      // marked chat id maps back to a raw peer (negative-100… ⇒ channel,
      // negative ⇒ chat, positive ⇒ user).
      raw: rawWithPeer(opts.chatId),
      replyToMessage: opts.threadId !== undefined
        ? { threadId: opts.threadId }
        : undefined,
    };
  }

  it("yields onNewMessage events filtered by chatId and threadId", async () => {
    // fails when: filtering moves to a post-yield consumer. Topics
    // generate ~50-100 incidental system events per run; pushing the
    // filter into the iterator keeps scenarios reading only what they
    // asked for and prevents queue blow-up.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observeMessages(-100, { threadId: 7 })[Symbol.asyncIterator]();

    mockClient.onNewMessage.emit(fakeMessage({ chatId: -999, id: 1, text: "wrong chat" }));
    mockClient.onNewMessage.emit(fakeMessage({ chatId: -100, id: 2, text: "wrong thread", threadId: 8 }));
    mockClient.onNewMessage.emit(fakeMessage({ chatId: -100, id: 3, text: "match", threadId: 7 }));

    const first = await iter.next();
    expect(first.done).toBe(false);
    const m = first.value as ObservedMessage;
    expect(m.messageId).toBe(3);
    expect(m.text).toBe("match");
    expect(m.threadId).toBe(7);
    expect(m.edited).toBe(false);

    await iter.return?.();
  });

  it("observes a bot DM reply whose peer is NOT in the update's index (regression: #2742 mtcute 0.30 silent-drop)", async () => {
    // Root cause: the driver runs on MemoryStorage (empty peer cache each
    // connect), so a bot's reply can arrive before its peer is cached. When
    // `toObserved` read `msg.chat.id` / `msg.sender.id`, those getters look
    // the peer up in the update's PeersIndex and THROW MtArgumentError when
    // it's absent. That throw propagated out of mtcute's onNewMessage emitter
    // (which does not catch listener errors), dropping the whole update — so
    // `observeMessages` never yielded it and `expectMessage(/\S/, {from:"bot"})`
    // timed out even though the bot had replied fast. The fix reads chat/sender
    // ids off the RAW TL peer (index-free), so this must now be observed.
    //
    // This double reproduces the throw: `chat` and `sender` are getters that
    // throw the exact mtcute error, while `raw.peerId` / `raw.fromId` carry
    // the bot user id — the id the DM chat is keyed on.
    const BOT = 12345;
    const throwingMsg = {
      id: 555,
      text: "4",
      date: new Date(),
      replyToMessage: undefined,
      isSilent: false,
      entities: [],
      raw: rawWithPeer(BOT, BOT),
      get chat(): never {
        throw new Error("Given peer is not available in this index.");
      },
      get sender(): never {
        throw new Error("Given peer is not available in this index.");
      },
    };

    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observeMessages(BOT)[Symbol.asyncIterator]();

    mockClient.onNewMessage.emit(throwingMsg);

    const first = await iter.next();
    expect(first.done).toBe(false);
    const m = first.value as ObservedMessage;
    expect(m.messageId).toBe(555);
    expect(m.chatId).toBe(BOT);
    expect(m.senderUserId).toBe(BOT);
    expect(m.text).toBe("4");
    // sender getter threw, so fromBot degrades to false — but senderUserId
    // (what `from: "bot"` filters on) is correct, which is what matters.
    expect(m.fromBot).toBe(false);

    await iter.return?.();
  });

  it("emits onEditMessage as observations with edited=true", async () => {
    // fails when: edit tracking is dropped — the progress-card
    // lifecycle scenario relies on observing edits to a pinned card
    // to confirm the working→done phase transition.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observeMessages(-100)[Symbol.asyncIterator]();

    mockClient.onEditMessage.emit(fakeMessage({ chatId: -100, id: 5, text: "edited" }));
    const first = await iter.next();
    const m = first.value as ObservedMessage;
    expect(m.messageId).toBe(5);
    expect(m.edited).toBe(true);

    await iter.return?.();
  });

  it("removes listeners on iterator return so closed scenarios don't leak handlers", async () => {
    // fails when: cleanup is dropped — listener Set grows across
    // scenarios and the same Message ends up dispatched to every
    // historical observer. Second scenario in a session sees ghost
    // matches and flakes.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    expect(mockClient.onNewMessage.size).toBe(0);

    const iter = driver.observeMessages(-100)[Symbol.asyncIterator]();
    expect(mockClient.onNewMessage.size).toBe(1);
    expect(mockClient.onEditMessage.size).toBe(1);

    await iter.return?.();
    expect(mockClient.onNewMessage.size).toBe(0);
    expect(mockClient.onEditMessage.size).toBe(0);

    const after = await iter.next();
    expect(after.done).toBe(true);
  });
});

describe("Driver.observeReactions", () => {
  // Helper — build a raw `updateMessageReactions` shape.
  function rxUpdate(opts: {
    peerUserId: number;
    msgId: number;
    emojis: string[];
  }): { update: unknown } {
    return {
      update: {
        _: "updateMessageReactions",
        peer: { _: "peerUser", userId: opts.peerUserId },
        msgId: opts.msgId,
        reactions: {
          results: opts.emojis.map((e) => ({
            reaction: { _: "reactionEmoji", emoticon: e },
          })),
        },
      },
    };
  }

  it("emits a `+emoji` op on first reaction", async () => {
    // fails when: the prior-set diff logic loses its initial empty
    // baseline — first reaction wouldn't be classified as "new" and
    // expectReaction would time out on the very first emoji.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observeReactions(67890, { messageId: 67050 })[Symbol.asyncIterator]();
    mockClient.onRawUpdate.emit(rxUpdate({
      peerUserId: 67890,
      msgId: 67050,
      emojis: ["👀"],
    }));
    const first = await iter.next();
    expect(first.done).toBe(false);
    const r = first.value as { emoji: string; op: string };
    expect(r.emoji).toBe("👀");
    expect(r.op).toBe("+");
    await iter.return?.();
  });

  it("computes -old +new when setMessageReaction replaces the prior emoji", async () => {
    // fails when: the diff direction inverts (would emit -new instead
    // of -old) or the prior set isn't updated, producing duplicate
    // emissions on the next call. Pins the gateway's actual
    // call pattern: setMessageReaction REPLACES, doesn't add.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observeReactions(67890, { messageId: 67050 })[Symbol.asyncIterator]();
    mockClient.onRawUpdate.emit(rxUpdate({
      peerUserId: 67890, msgId: 67050, emojis: ["👀"],
    }));
    mockClient.onRawUpdate.emit(rxUpdate({
      peerUserId: 67890, msgId: 67050, emojis: ["👍"],
    }));
    // Order: +👀, then on the replace event +👍 + -👀 (order of those
    // last two doesn't matter, but both must come through).
    const ops: Array<{ emoji: string; op: string }> = [];
    for (let i = 0; i < 3; i++) {
      const n = await iter.next();
      if (n.done) break;
      const v = n.value as { emoji: string; op: string };
      ops.push({ emoji: v.emoji, op: v.op });
    }
    expect(ops).toEqual(expect.arrayContaining([
      { emoji: "👀", op: "+" },
      { emoji: "👍", op: "+" },
      { emoji: "👀", op: "-" },
    ]));
    await iter.return?.();
  });

  it("filters out updates for the wrong chat or message", async () => {
    // fails when: the chat/msg filter widens — scenarios would see
    // reactions from every chat the driver is part of, flooding the
    // queue and likely matching unrelated emoji shapes by accident.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observeReactions(67890, { messageId: 67050 })[Symbol.asyncIterator]();
    mockClient.onRawUpdate.emit(rxUpdate({ peerUserId: 99, msgId: 67050, emojis: ["💩"] }));
    mockClient.onRawUpdate.emit(rxUpdate({ peerUserId: 67890, msgId: 1, emojis: ["💩"] }));
    mockClient.onRawUpdate.emit(rxUpdate({ peerUserId: 67890, msgId: 67050, emojis: ["👀"] }));
    const first = await iter.next();
    const r = first.value as { emoji: string };
    expect(r.emoji).toBe("👀");
    await iter.return?.();
  });

  it("skips custom-emoji reactions (out of scope for Phase 2b)", async () => {
    // fails when: someone adds support for `reactionCustomEmoji`
    // without resolving the document_id to an alias. Custom emojis
    // would leak through as opaque "documentId=..." strings and break
    // expectReaction's exact-match.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observeReactions(67890, { messageId: 67050 })[Symbol.asyncIterator]();
    mockClient.onRawUpdate.emit({
      update: {
        _: "updateMessageReactions",
        peer: { _: "peerUser", userId: 67890 },
        msgId: 67050,
        reactions: {
          results: [
            { reaction: { _: "reactionCustomEmoji", documentId: { high: 0, low: 1 } } },
            { reaction: { _: "reactionEmoji", emoticon: "👀" } },
          ],
        },
      },
    });
    const first = await iter.next();
    const r = first.value as { emoji: string };
    expect(r.emoji).toBe("👀"); // custom emoji silently skipped
    await iter.return?.();
  });

  it("removes its onRawUpdate listener on iterator return", async () => {
    // fails when: cleanup is dropped — `onRawUpdate` listeners
    // accumulate across scenarios. Unlike `onNewMessage`, the raw
    // update fires for EVERY Telegram event the driver receives
    // (typing, presence, etc.), so a leaked listener is much
    // louder than for the message observer.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    expect(mockClient.onRawUpdate.size).toBe(0);
    const iter = driver.observeReactions(67890)[Symbol.asyncIterator]();
    expect(mockClient.onRawUpdate.size).toBe(1);
    await iter.return?.();
    expect(mockClient.onRawUpdate.size).toBe(0);
  });

  // Group / supergroup / forum-topic support (Phase 2e — #866).
  // The driver normalizes raw `peer` fields via mtcute's
  // `getMarkedPeerId` so callers pass the Bot API marked id
  // uniformly regardless of chat type.

  function rxUpdatePeerChannel(opts: {
    channelId: number;
    msgId: number;
    topMsgId?: number;
    emojis: string[];
  }): { update: unknown } {
    return {
      update: {
        _: "updateMessageReactions",
        peer: { _: "peerChannel", channelId: opts.channelId },
        msgId: opts.msgId,
        topMsgId: opts.topMsgId,
        reactions: {
          results: opts.emojis.map((e) => ({
            reaction: { _: "reactionEmoji", emoticon: e },
          })),
        },
      },
    };
  }

  it("accepts peerChannel (supergroup) updates with the marked -100... chatId", async () => {
    // fails when: peer normalization regresses past the unified
    // getMarkedPeerId call — supergroup scenarios that pass the
    // canonical -1001234567890 chat_id would silently see zero
    // reactions because the filter would reject peerChannel
    // updates outright.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    // -1e12 - 1234567890 === -1001234567890 (matches Bot API form
    // of channel_id 1234567890).
    const chatId = -1001234567890;
    const iter = driver.observeReactions(chatId, { messageId: 5 })[Symbol.asyncIterator]();
    mockClient.onRawUpdate.emit(rxUpdatePeerChannel({
      channelId: 1234567890,
      msgId: 5,
      emojis: ["👀"],
    }));
    const first = await iter.next();
    expect(first.done).toBe(false);
    const r = first.value as { chatId: number; emoji: string };
    expect(r.chatId).toBe(chatId);
    expect(r.emoji).toBe("👀");
    await iter.return?.();
  });

  it("filters by threadId (forum topic) when supplied", async () => {
    // fails when: the topMsgId filter is dropped — supergroup
    // scenarios using forum topics would observe reactions from
    // EVERY topic in the group, flooding the queue and matching
    // emoji shapes from unrelated topics.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const chatId = -1001234567890;
    const iter = driver.observeReactions(chatId, { messageId: 5, threadId: 100 })[Symbol.asyncIterator]();
    mockClient.onRawUpdate.emit(rxUpdatePeerChannel({
      channelId: 1234567890, msgId: 5, topMsgId: 200, emojis: ["💩"],
    }));
    mockClient.onRawUpdate.emit(rxUpdatePeerChannel({
      channelId: 1234567890, msgId: 5, topMsgId: 100, emojis: ["👀"],
    }));
    const first = await iter.next();
    const r = first.value as { emoji: string };
    expect(r.emoji).toBe("👀"); // 💩 from topic 200 skipped
    await iter.return?.();
  });

  it("skips updates with an unrecognized peer shape rather than crashing", async () => {
    // fails when: an unexpected peer kind throws past the try/catch
    // — a single forward-incompatible update (Telegram adds peer
    // types over time) would tear down the listener mid-scenario.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observeReactions(67890, { messageId: 5 })[Symbol.asyncIterator]();
    // Garbage peer — must not throw.
    mockClient.onRawUpdate.emit({
      update: {
        _: "updateMessageReactions",
        peer: { _: "peerUnknownFuture" },
        msgId: 5,
        reactions: { results: [{ reaction: { _: "reactionEmoji", emoticon: "👀" } }] },
      },
    });
    // Real peer should still work after the bad one.
    mockClient.onRawUpdate.emit({
      update: {
        _: "updateMessageReactions",
        peer: { _: "peerUser", userId: 67890 },
        msgId: 5,
        reactions: { results: [{ reaction: { _: "reactionEmoji", emoticon: "👍" } }] },
      },
    });
    const first = await iter.next();
    const r = first.value as { emoji: string };
    expect(r.emoji).toBe("👍");
    await iter.return?.();
  });
});

describe("Driver.observePins (peer types)", () => {
  function pinUpdatePeerChannel(opts: {
    channelId: number;
    msgIds: number[];
  }): { update: unknown } {
    return {
      update: {
        _: "updatePinnedMessages",
        pinned: true,
        peer: { _: "peerChannel", channelId: opts.channelId },
        messages: opts.msgIds,
      },
    };
  }

  it("accepts peerChannel pin events using the marked -100... chatId", async () => {
    // fails when: the peer normalization regresses for pins (mirror
    // bug to the reactions one). Pin scenarios in supergroups
    // would never trigger expectPinnedCard.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const chatId = -1001234567890;
    const iter = driver.observePins(chatId)[Symbol.asyncIterator]();
    mockClient.onRawUpdate.emit(pinUpdatePeerChannel({
      channelId: 1234567890,
      msgIds: [42],
    }));
    const first = await iter.next();
    const p = first.value as { chatId: number; messageId: number; pinned: boolean };
    expect(p.chatId).toBe(chatId);
    expect(p.messageId).toBe(42);
    expect(p.pinned).toBe(true);
    await iter.return?.();
  });
});

describe("Driver lifecycle", () => {
  it("disconnect is safe to call without connect()", async () => {
    // fails when: a refactor removes the `if (!this.client) return`
    // guard — scenarios that throw during connect leave a corrupted
    // Driver, and tearDown's idempotent disconnect would then throw,
    // masking the original failure.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await expect(driver.disconnect()).resolves.toBeUndefined();
    expect(mockClient.destroy).not.toHaveBeenCalled();
  });

  it("sendText before connect() throws a clear error pointing at connect()", async () => {
    // fails when: the requireClient guard is dropped — sendText would
    // dereference a null client and throw a TypeError that doesn't
    // point at the missing connect() call, leaving the operator
    // wondering what's wrong.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await expect(driver.sendText(-100, "x")).rejects.toThrow(/call connect/);
  });
});

describe("Driver.observePins", () => {
  function pinUpdate(opts: {
    peerUserId: number;
    msgIds: number[];
    pinned?: boolean;
  }): { update: unknown } {
    return {
      update: {
        _: "updatePinnedMessages",
        pinned: opts.pinned,
        peer: { _: "peerUser", userId: opts.peerUserId },
        messages: opts.msgIds,
      },
    };
  }

  it("yields one event per pinned messageId for a batched pin update", async () => {
    // fails when: a refactor walks only msgIds[0] — the gateway can
    // batch-pin a card + its boot header in one update; missing the
    // second id would cause expectPinnedCard to wait forever on
    // scenarios that pin > 1 message per turn.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observePins(67890)[Symbol.asyncIterator]();
    mockClient.onRawUpdate.emit(pinUpdate({
      peerUserId: 67890,
      msgIds: [101, 102],
      pinned: true,
    }));
    const a = await iter.next();
    const b = await iter.next();
    expect((a.value as { messageId: number }).messageId).toBe(101);
    expect((b.value as { messageId: number }).messageId).toBe(102);
    expect((a.value as { pinned: boolean }).pinned).toBe(true);
    await iter.return?.();
  });

  it("treats omitted `pinned` flag as pin (TL default-true), explicit false as unpin", async () => {
    // fails when: the default flips — the TL says `pinned` defaults
    // to true when omitted. If we default to false, every standalone
    // pin update reads as an unpin and expectPinnedCard skips it.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observePins(67890)[Symbol.asyncIterator]();
    mockClient.onRawUpdate.emit(pinUpdate({ peerUserId: 67890, msgIds: [101] }));
    mockClient.onRawUpdate.emit(pinUpdate({
      peerUserId: 67890,
      msgIds: [101],
      pinned: false,
    }));
    const a = await iter.next();
    const b = await iter.next();
    expect((a.value as { pinned: boolean }).pinned).toBe(true);
    expect((b.value as { pinned: boolean }).pinned).toBe(false);
    await iter.return?.();
  });

  it("filters by chatId so cross-chat pins don't bleed into the iterator", async () => {
    // fails when: peer.userId filtering moves to a downstream
    // consumer — every chat the driver is in would flood the
    // observer with unrelated pin events.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observePins(67890)[Symbol.asyncIterator]();
    mockClient.onRawUpdate.emit(pinUpdate({ peerUserId: 99, msgIds: [999] }));
    mockClient.onRawUpdate.emit(pinUpdate({ peerUserId: 67890, msgIds: [101] }));
    const first = await iter.next();
    expect((first.value as { messageId: number }).messageId).toBe(101);
    await iter.return?.();
  });

  it("removes the onRawUpdate listener on iterator return", async () => {
    // fails when: cleanup is dropped — onRawUpdate is high-volume,
    // a leaked listener accumulates handlers across scenarios.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    expect(mockClient.onRawUpdate.size).toBe(0);
    const iter = driver.observePins(67890)[Symbol.asyncIterator]();
    expect(mockClient.onRawUpdate.size).toBe(1);
    await iter.return?.();
    expect(mockClient.onRawUpdate.size).toBe(0);
  });
});

describe("Driver.getMessage", () => {
  it("wraps getMessages with a single-id call and converts the result to ObservedMessage", async () => {
    // fails when: a refactor passes the id as scalar rather than [id]
    // — mtcute's `getMessages` accepts MaybeArray<number> and we want
    // the array path so the result indexing is stable.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    mockClient.getMessages.mockResolvedValueOnce([
      {
        id: 42,
        text: "✅ Done",
        date: new Date("2026-05-11T04:30:00Z"),
        chat: { id: 67890 },
        sender: { id: 67890, type: "user", isBot: true },
        raw: rawWithPeer(67890),
        replyToMessage: undefined,
      } as never,
    ]);
    const msg = await driver.getMessage(67890, 42);
    expect(mockClient.getMessages).toHaveBeenCalledWith(67890, [42]);
    expect(msg).not.toBeNull();
    expect(msg?.messageId).toBe(42);
    expect(msg?.text).toBe("✅ Done");
    expect(msg?.fromBot).toBe(true);
  });

  it("returns null when the message has been deleted (mtcute returns null in that slot)", async () => {
    // fails when: a refactor unwraps without checking null — scenarios
    // that fetch right after a card-edit race could crash on a
    // genuinely-deleted message; the contract is "return null, let
    // caller poll".
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    mockClient.getMessages.mockResolvedValueOnce([null]);
    const msg = await driver.getMessage(67890, 999);
    expect(msg).toBeNull();
  });
});

describe("toObserved — rich formatting surface (issue #2739)", () => {
  // Minimal mtcute-Message-shaped double carrying the getters toObserved
  // reads. `entities` mirrors mtcute's flattened MessageEntity (kind +
  // offset/length/text + discriminated params).
  function mockMsg(overrides: Record<string, unknown>): unknown {
    return {
      id: 7,
      text: "",
      date: new Date("2026-07-02T00:00:00Z"),
      chat: { id: 111 },
      sender: { id: 222, type: "user", isBot: true },
      replyToMessage: undefined,
      raw: {
        _: "message",
        peerId: { _: "peerUser", userId: 111 },
        fromId: { _: "peerUser", userId: 222 },
        media: undefined,
      },
      isSilent: false,
      entities: [],
      ...overrides,
    };
  }

  it("surfaces entities (kind/text/url/language) from a decoded rich message", async () => {
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    mockClient.getMessages.mockResolvedValueOnce([
      mockMsg({
        text: "a bold phrase and a code_token and the repo",
        entities: [
          { kind: "bold", offset: 2, length: 11, text: "bold phrase", params: { kind: "bold" } },
          { kind: "code", offset: 25, length: 10, text: "code_token", params: { kind: "code" } },
          {
            kind: "text_link",
            offset: 44,
            length: 4,
            text: "repo",
            params: { kind: "text_link", url: "https://example.com/r" },
          },
          {
            kind: "pre",
            offset: 0,
            length: 5,
            text: "x=1\n",
            params: { kind: "pre", language: "bash" },
          },
        ],
        link: "https://t.me/c/111/7",
      } as never),
    ]);
    const msg = await driver.getMessage(111, 7);
    expect(msg?.text).not.toBe("\x01");
    expect(msg?.entities.map((e) => e.kind)).toEqual([
      "bold",
      "code",
      "text_link",
      "pre",
    ]);
    const link = msg?.entities.find((e) => e.kind === "text_link");
    expect(link?.url).toBe("https://example.com/r");
    const pre = msg?.entities.find((e) => e.kind === "pre");
    expect(pre?.language).toBe("bash");
    expect(msg?.link).toBe("https://t.me/c/111/7");
  });

  it("keeps the \\x01 sentinel and empty entities for undecoded rich media", async () => {
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    mockClient.getMessages.mockResolvedValueOnce([
      mockMsg({
        text: "",
        raw: {
          _: "message",
          peerId: { _: "peerUser", userId: 111 },
          fromId: { _: "peerUser", userId: 222 },
          media: { _: "messageMediaUnsupported" },
        },
        entities: [],
      } as never),
    ]);
    const msg = await driver.getMessage(111, 7);
    expect(msg?.text).toBe("\x01");
    expect(msg?.entities).toEqual([]);
  });

  it("leaves link undefined when the .link getter throws (private DM)", async () => {
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const thrower = mockMsg({ text: "hi" }) as Record<string, unknown>;
    Object.defineProperty(thrower, "link", {
      get() {
        throw new Error("chat does not support message links");
      },
    });
    mockClient.getMessages.mockResolvedValueOnce([thrower as never]);
    const msg = await driver.getMessage(111, 7);
    expect(msg?.text).toBe("hi");
    expect(msg?.link).toBeUndefined();
  });
});

describe("Driver.sendVoice", () => {
  it("wraps sendMedia with an InputMedia.voice carrying the file path", async () => {
    // fails when: a refactor switches to sending the OGG as a
    // generic document — Telegram only renders OGG/Opus as a voice
    // note when sent via inputMediaUploadedDocument with a voice
    // attribute. mtcute's InputMedia.voice factory builds the
    // right shape; bypassing it sends the file as an attachment
    // instead, which the bot's voice_in skill ignores.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const sent = await driver.sendVoice(67890, "/tmp/silence.opus");
    expect(mockClient.sendMedia).toHaveBeenCalledTimes(1);
    const [chatId, media, params] = mockClient.sendMedia.mock.calls[0] as [
      number,
      { __type: string; file: string },
      unknown,
    ];
    expect(chatId).toBe(67890);
    expect(media.__type).toBe("InputMediaVoice");
    expect(media.file).toBe("/tmp/silence.opus");
    expect(params).toBeUndefined();
    expect(sent.messageId).toBe(1234);
  });

  it("forwards messageThreadId via replyTo for forum-topic targeting", async () => {
    // fails when: voice sends bypass the same threadId→replyTo
    // routing that sendText uses — a forum-topic voice-inbound
    // scenario would deliver the OGG into the supergroup's
    // general topic instead of the test-scoped topic, polluting
    // unrelated chats.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    await driver.sendVoice(-1001234567890, "/tmp/silence.opus", {
      messageThreadId: 200,
    });
    const [, , params] = mockClient.sendMedia.mock.calls[0] as [
      number,
      unknown,
      { replyTo: number },
    ];
    expect(params.replyTo).toBe(200);
  });

  it("rejects voice sends before connect() with a clear error", async () => {
    // fails when: the requireClient guard is dropped — a scenario
    // that races a connect-failure would throw a TypeError on
    // null client instead of the "call connect() first" pointer.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await expect(
      driver.sendVoice(-100, "/tmp/x.opus"),
    ).rejects.toThrow(/call connect/);
  });
});

describe("Driver.getKeyboard", () => {
  function fakeMsgWithKeyboard(buttons: Array<Array<{ _: string; text: string; data?: string; url?: string }>>): unknown {
    return {
      id: 42,
      text: "Approve grant?",
      date: new Date(),
      chat: { id: 67890 },
      sender: { id: 67890, type: "user", isBot: true },
      markup: {
        type: "inline",
        buttons: buttons.map((row) =>
          row.map((b) => {
            const out: { _: string; text: string; data?: Uint8Array; url?: string } = {
              _: b._,
              text: b.text,
            };
            if (b.data) out.data = new TextEncoder().encode(b.data);
            if (b.url) out.url = b.url;
            return out;
          }),
        ),
      },
    };
  }

  it("parses inline keyboard buttons with UTF-8-decoded callback_data", async () => {
    // fails when: a refactor swaps the decoding direction (Uint8Array
    // → hex/base64 instead of UTF-8) — every vault-UX scenario that
    // matches buttons by callback_data (e.g. "allow:agent=gymbro")
    // would silently match nothing.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    mockClient.getMessages.mockResolvedValueOnce([
      fakeMsgWithKeyboard([
        [
          { _: "keyboardButtonCallback", text: "Allow", data: "allow:gymbro:fatsecret" },
          { _: "keyboardButtonCallback", text: "Deny", data: "deny:gymbro:fatsecret" },
        ],
      ]) as never,
    ]);
    const kb = await driver.getKeyboard(67890, 42);
    expect(kb).not.toBeNull();
    expect(kb).toHaveLength(1);
    expect(kb![0]).toHaveLength(2);
    expect(kb![0]![0]).toEqual({
      text: "Allow",
      callbackData: "allow:gymbro:fatsecret",
    });
    expect(kb![0]![1]).toEqual({
      text: "Deny",
      callbackData: "deny:gymbro:fatsecret",
    });
  });

  it("represents URL buttons with `url` set and `callbackData` omitted", async () => {
    // fails when: URL buttons surface with bogus callbackData (e.g.
    // the URL itself decoded as bytes). A scenario that tries to
    // pressButton(callbackData=URL) would fail server-side with
    // BUTTON_DATA_INVALID instead of falling back to opening the URL.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    mockClient.getMessages.mockResolvedValueOnce([
      fakeMsgWithKeyboard([
        [{ _: "keyboardButtonUrl", text: "Open dashboard", url: "https://example.com" }],
      ]) as never,
    ]);
    const kb = await driver.getKeyboard(67890, 42);
    expect(kb![0]![0]).toEqual({
      text: "Open dashboard",
      url: "https://example.com",
    });
    expect(kb![0]![0]!.callbackData).toBeUndefined();
  });

  it("returns null for messages with no markup or non-inline markup", async () => {
    // fails when: a refactor surfaces force-reply / reply-keyboard
    // shapes as `ObservedKeyboard` — scenarios that expect inline
    // buttons would press a "phantom" button that never existed on
    // the wire.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    mockClient.getMessages.mockResolvedValueOnce([
      { id: 42, text: "no buttons", date: new Date(), chat: { id: 1 }, sender: { id: 1, type: "user", isBot: true }, markup: null } as never,
    ]);
    expect(await driver.getKeyboard(67890, 42)).toBeNull();

    mockClient.getMessages.mockResolvedValueOnce([
      {
        id: 42, text: "force reply", date: new Date(),
        chat: { id: 1 }, sender: { id: 1, type: "user", isBot: true },
        markup: { type: "force_reply" },
      } as never,
    ]);
    expect(await driver.getKeyboard(67890, 42)).toBeNull();
  });

  it("returns null when the message has been deleted", async () => {
    // fails when: deleted-race recovery is dropped — scenarios that
    // fetch a keyboard right after a card-edit-delete race would
    // crash; the contract is "return null, let caller poll".
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    mockClient.getMessages.mockResolvedValueOnce([null]);
    expect(await driver.getKeyboard(67890, 42)).toBeNull();
  });
});

describe("Driver.pressButton", () => {
  it("calls getCallbackAnswer with the chat+message+data triple", async () => {
    // fails when: a refactor passes the callback_data as `Uint8Array`
    // (instead of letting mtcute encode the string) — mtcute's
    // getCallbackAnswer accepts both, but production code that
    // assumes ASCII payloads would break for any future binary-
    // callback_data button. The harness keeps it as a string for
    // symmetry with how `getKeyboard` returns it.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    await driver.pressButton(67890, 42, "allow:gymbro:fatsecret");
    expect(mockClient.getCallbackAnswer).toHaveBeenCalledWith({
      chatId: 67890,
      message: 42,
      data: "allow:gymbro:fatsecret",
    });
  });

  it("rejects when called before connect()", async () => {
    // fails when: the requireClient guard is dropped — same
    // class of bug as sendText/sendVoice/getMessage before
    // connect.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await expect(
      driver.pressButton(67890, 42, "x"),
    ).rejects.toThrow(/call connect/);
  });
});
