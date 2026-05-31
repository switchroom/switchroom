/**
 * mtcute-backed Telegram user-account driver for the UAT harness.
 *
 * Issue: https://github.com/switchroom/switchroom/issues/865
 *
 * The driver is a Telegram **user account** (not a bot) because bots
 * cannot read other bots' messages even with privacy mode disabled
 * and admin rights — see Telegram Bots FAQ. The driver sends fixture
 * inbounds and observes everything the test bot emits.
 *
 * Phase 2 wires real mtcute lifecycle: `MemoryStorage` so no SQLite
 * is touched, `importSession` to load the bearer string, real
 * `connect`/`disconnect`, real `sendText` (with forum-topic routing),
 * and `observeMessages` backed by `onNewMessage`/`onEditMessage`.
 *
 * Security: never log session strings, never log message bodies that
 * might contain auth codes (see `auth-code-redact.ts` for the
 * production pattern).
 */

import {
  MemoryStorage,
  TelegramClient,
  getMarkedPeerId,
  InputMedia,
} from "@mtcute/node";
import type { Message } from "@mtcute/node";

export interface DriverOptions {
  /** Telegram developer credential — `api_id` from my.telegram.org. */
  apiId: number;
  /** Telegram developer credential — `api_hash` from my.telegram.org. */
  apiHash: string;
  /**
   * Session string previously minted by `bun run uat:login` and
   * stored in vault under `telegram-uat-driver-session`. Bearer-
   * equivalent — never log.
   */
  session: string;
}

export interface SendTextOptions {
  /**
   * Forum topic id. For supergroups with topics enabled this is the
   * `message_thread_id` from the Bot API. mtcute maps it to the
   * `replyTo` parameter on send — the topic's "top message id" is
   * what the server expects.
   */
  messageThreadId?: number;
  /** Reply-quote a specific earlier message id. */
  replyTo?: number;
}

export interface ObservedMessage {
  chatId: number;
  messageId: number;
  threadId?: number;
  text: string;
  /**
   * Sender's user_id (or channel_id, for posts in a channel). Used by
   * `expectMessage` to filter `from: "bot"` vs `from: "driver"`.
   */
  senderUserId: number;
  fromBot: boolean;
  date: Date;
  /** `true` when this observation is an edit of an earlier message. */
  edited: boolean;
  /**
   * `true` when this message was delivered as a silent push (Telegram
   * `silent` flag, set by the sender's `disable_notification: true`).
   * Used to verify the conversational-pacing contract: mid-turn updates
   * must be silent, only the final answer should ping.
   */
  silent: boolean;
}

export interface ObservedButton {
  /** Visible label on the button. */
  text: string;
  /**
   * Inline-callback button payload (Bot API `callback_data`). UTF-8
   * decoded from the raw `Uint8Array` mtcute exposes. Undefined for
   * URL buttons / web-app buttons / other non-callback button kinds.
   */
  callbackData?: string;
  /** URL for `url` buttons; undefined for callback buttons. */
  url?: string;
}

/**
 * 2-D matrix of inline buttons, matching Bot API's
 * `inline_keyboard: [[{text, callback_data}, ...], ...]`.
 *
 * Only `type === "inline"` keyboards are returned by `getKeyboard` —
 * reply-keyboard / force-reply / hide markups aren't used by the
 * gateway for vault UX flows and would require a separate driver
 * surface (typing the reply instead of tapping).
 */
export type ObservedKeyboard = ObservedButton[][];

export interface ObservedReaction {
  chatId: number;
  messageId: number;
  emoji: string;
  /** Reaction add (`+`) vs remove (`-`). */
  op: "+" | "-";
  date: Date;
}

export interface ObservedPin {
  chatId: number;
  messageId: number;
  pinned: boolean;
  date: Date;
}

/**
 * Thin wrapper. Concrete mtcute use is intentionally narrow so the
 * scenarios don't get tangled up in raw MTProto types.
 */
export class Driver {
  private client: TelegramClient | null = null;

  constructor(private readonly opts: DriverOptions) {}

  async connect(): Promise<void> {
    // MemoryStorage keeps all session state in memory — the session
    // string we hold in `opts.session` is the only durable source of
    // truth. This sidesteps SQLite entirely (native bindings, file
    // locking, ephemeral STATE_DIR cleanup) and makes per-scenario
    // teardown a no-op for the driver's storage layer.
    this.client = new TelegramClient({
      apiId: this.opts.apiId,
      apiHash: this.opts.apiHash,
      storage: new MemoryStorage(),
    });

    // `force: true` because MemoryStorage is always empty at construct
    // time — without force, mtcute treats the (non-existent) prior
    // session as authoritative and silently ignores ours.
    await this.client.importSession(this.opts.session, true);
    await this.client.connect();
    // `connect()` opens the transport but does NOT start the updates
    // dispatch loop — that's `start()`'s job. For a returning session
    // (no interactive login) we have to call `startUpdatesLoop()`
    // ourselves, otherwise `onNewMessage` / `onEditMessage` never
    // fire and `observeMessages` silently waits forever. Symptom:
    // `expectMessage` timing out even though the bot's reply has
    // arrived in the chat (visible in Telegram).
    await this.client.startUpdatesLoop();
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    await this.client.destroy();
    this.client = null;
  }

  async sendText(
    chatId: number,
    text: string,
    opts?: SendTextOptions,
  ): Promise<{ messageId: number }> {
    const c = this.requireClient();
    // mtcute's CommonSendParams.replyTo doubles as the forum-topic
    // target — passing the topic's top-message id routes the new
    // message into that topic. Explicit `opts.replyTo` (quote-reply)
    // takes precedence if both are set; this matches Bot API
    // behaviour where `reply_to_message_id` overrides
    // `message_thread_id`.
    const replyTo = opts?.replyTo ?? opts?.messageThreadId;
    const sent = await c.sendText(chatId, text, replyTo ? { replyTo } : undefined);
    return { messageId: sent.id };
  }

  /**
   * Return the driver's own Telegram user_id. Cached after first call.
   */
  async getMyUserId(): Promise<number> {
    const c = this.requireClient();
    const me = await c.getMe();
    return me.id;
  }

  /**
   * Unpin every pinned message in `chatId`. Used by the harness's
   * settle phase: a stale pin from the previous scenario's turn would
   * otherwise be reused by the gateway via edit (no new pin event),
   * making `expectPinnedCard` time out. Best-effort — logs and swallows
   * Telegram errors so an unrelated network drop / flood-wait doesn't
   * abort spinUp before the scenario runs. The next assertion (e.g.
   * `expectPinnedCard`) will fail loudly with its own deadline if the
   * unpin actually mattered, so the warning is enough to root-cause
   * post-hoc without a silent failure mode.
   */
  async unpinAllMessages(chatId: number): Promise<void> {
    const c = this.requireClient();
    await c.unpinAllMessages(chatId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console -- harness diagnostic
      console.warn(`[uat/driver] unpinAllMessages(${chatId}) failed: ${msg}`);
    });
  }

  /**
   * Resolve a bot username (with or without `@`) to its user_id. The
   * resulting id doubles as the chat_id for DMing the bot from the
   * driver — Telegram DMs use the peer's user_id as the chat_id.
   */
  async resolveBotUserId(username: string): Promise<number> {
    const c = this.requireClient();
    const handle = username.startsWith("@") ? username : `@${username}`;
    const peer = await c.resolvePeer(handle);
    // For a bot/user the resolved peer is `inputPeerUser` carrying the
    // numeric `userId` we need.
    const u = peer as { userId?: number; channelId?: number };
    if (typeof u.userId === "number") return u.userId;
    throw new Error(
      `Driver.resolveBotUserId: '${handle}' did not resolve to a user (got ${JSON.stringify(peer)})`,
    );
  }

  /**
   * Subscribe to new + edited messages in `chatId` (optionally
   * filtered to a forum topic). Returns an async iterable so scenarios
   * can `for await` until a predicate matches. Each yielded value
   * carries an `edited` flag so the scenario can distinguish initial
   * sends from progress-card edits.
   *
   * Backfill: mtcute's emitters fire only for live updates, not
   * history. Scenarios that need to observe a message sent before
   * the observer started should poll `getHistory` directly (Phase 3
   * helper). The smoke test sends *after* `observeMessages` starts,
   * so no backfill needed.
   */
  observeMessages(
    chatId: number,
    opts?: { threadId?: number },
  ): AsyncIterable<ObservedMessage> {
    const c = this.requireClient();
    const targetThread = opts?.threadId;
    const queue: ObservedMessage[] = [];
    const waiters: Array<(m: IteratorResult<ObservedMessage>) => void> = [];
    let closed = false;

    const dispatch = (m: ObservedMessage): void => {
      const w = waiters.shift();
      if (w) w({ value: m, done: false });
      else queue.push(m);
    };

    const onNew = (msg: Message): void => {
      const observed = toObserved(msg, false);
      if (observed.chatId !== chatId) return;
      if (targetThread !== undefined && observed.threadId !== targetThread) return;
      dispatch(observed);
    };
    const onEdit = (msg: Message): void => {
      const observed = toObserved(msg, true);
      if (observed.chatId !== chatId) return;
      if (targetThread !== undefined && observed.threadId !== targetThread) return;
      dispatch(observed);
    };

    c.onNewMessage.add(onNew);
    c.onEditMessage.add(onEdit);

    const close = (): void => {
      if (closed) return;
      closed = true;
      c.onNewMessage.remove(onNew);
      c.onEditMessage.remove(onEdit);
      while (waiters.length > 0) {
        waiters.shift()?.({ value: undefined as never, done: true });
      }
    };

    return {
      [Symbol.asyncIterator](): AsyncIterator<ObservedMessage> {
        return {
          next(): Promise<IteratorResult<ObservedMessage>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined as never, done: true });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
          return(): Promise<IteratorResult<ObservedMessage>> {
            close();
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    };
  }

  /**
   * Subscribe to message-reaction add/remove ops in `chatId` (and
   * optionally on a specific `messageId`).
   *
   * Implementation notes:
   *
   * - mtcute parses `updateBotMessageReaction` for bot accounts; for
   *   USER accounts (the driver) we have to handle the raw
   *   `updateMessageReactions` ourselves via `onRawUpdate`. The TL
   *   carries the full new reaction set, not a delta — we diff
   *   against the prior set we've cached for the same `msgId` to
   *   emit add (`+`) / remove (`-`) ops.
   *
   * - DM / group / supergroup all supported. `chatId` follows the
   *   Bot API marked-id convention (positive for users, negative
   *   for groups, -100… for supergroups/channels). Internally we
   *   normalize the raw `peer` field with mtcute's `getMarkedPeerId`
   *   so callers never see raw TL peer types.
   *
   * - `threadId` filters to a forum-topic id (the raw update's
   *   `topMsgId`). Useful for supergroup-with-topics scenarios; a
   *   no-op for DMs/basic groups.
   *
   * - Reactions are emitted only when they CHANGE. The initial
   *   reaction-add fires as `op: "+"`; a follow-up
   *   `setMessageReaction` that REPLACES the prior emoji emits `-`
   *   for the old + `+` for the new.
   *
   * - Custom emojis (`reactionCustomEmoji`) are skipped — scenarios
   *   that need them aren't in scope and parsing them would require
   *   resolving the document id to an alias.
   */
  observeReactions(
    chatId: number,
    opts?: { messageId?: number; threadId?: number },
  ): AsyncIterable<ObservedReaction> {
    const c = this.requireClient();
    const targetMsgId = opts?.messageId;
    const targetThread = opts?.threadId;
    const queue: ObservedReaction[] = [];
    const waiters: Array<(m: IteratorResult<ObservedReaction>) => void> = [];
    let closed = false;
    const prior = new Map<number, Set<string>>();

    const dispatch = (r: ObservedReaction): void => {
      const w = waiters.shift();
      if (w) w({ value: r, done: false });
      else queue.push(r);
    };

    const onRaw = (info: { update: unknown }): void => {
      const u = info.update as {
        _: string;
        peer?: unknown;
        msgId?: number;
        topMsgId?: number;
        reactions?: {
          results?: Array<{
            reaction: { _: string; emoticon?: string };
          }>;
        };
      };
      if (u._ !== "updateMessageReactions") return;
      if (!u.peer) return;
      // mtcute's getMarkedPeerId handles peerUser / peerChat / peerChannel
      // uniformly — normalizes to Bot API marked-id form (-100... for
      // supergroups, -... for basic groups, positive for users).
      let peerId: number;
      try {
        peerId = getMarkedPeerId(u.peer as Parameters<typeof getMarkedPeerId>[0]);
      } catch {
        return; // unrecognized peer shape
      }
      if (peerId !== chatId) return;
      const msgId = u.msgId;
      if (typeof msgId !== "number") return;
      if (targetMsgId !== undefined && msgId !== targetMsgId) return;
      if (targetThread !== undefined && u.topMsgId !== targetThread) return;

      const now = new Set<string>();
      for (const rc of u.reactions?.results ?? []) {
        if (
          rc.reaction?._ === "reactionEmoji" &&
          typeof rc.reaction.emoticon === "string"
        ) {
          now.add(rc.reaction.emoticon);
        }
      }
      const before = prior.get(msgId) ?? new Set<string>();
      const date = new Date();
      for (const e of now) {
        if (!before.has(e)) {
          dispatch({ chatId, messageId: msgId, emoji: e, op: "+", date });
        }
      }
      for (const e of before) {
        if (!now.has(e)) {
          dispatch({ chatId, messageId: msgId, emoji: e, op: "-", date });
        }
      }
      prior.set(msgId, now);
    };

    c.onRawUpdate.add(onRaw);

    const close = (): void => {
      if (closed) return;
      closed = true;
      c.onRawUpdate.remove(onRaw);
      while (waiters.length > 0) {
        waiters.shift()?.({ value: undefined as never, done: true });
      }
    };

    return {
      [Symbol.asyncIterator](): AsyncIterator<ObservedReaction> {
        return {
          next(): Promise<IteratorResult<ObservedReaction>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined as never, done: true });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
          return(): Promise<IteratorResult<ObservedReaction>> {
            close();
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    };
  }

  /**
   * Subscribe to pin/unpin events on `chatId`. Used for
   * progress-card-lifecycle assertions.
   *
   * mtcute doesn't expose a parsed event for `updatePinnedMessages`
   * — it comes through raw. Same shape as `observeReactions`. The
   * raw update carries `messages: number[]` (one or many msg ids
   * pinned/unpinned in one batch) plus a `pinned?: boolean` flag.
   *
   * DM / group / supergroup all supported. `chatId` follows the Bot
   * API marked-id convention; internally we normalize the raw `peer`
   * field with mtcute's `getMarkedPeerId`.
   *
   * Forum-topic filtering (the `threadId` opt) is currently unused
   * here — `updatePinnedMessages` doesn't carry `topMsgId`, only
   * the chat-level peer + message ids. Scenarios that need per-topic
   * pin scoping should filter consumer-side via `driver.getMessage`
   * to look up the pinned message's thread context.
   */
  observePins(
    chatId: number,
    _opts?: { threadId?: number },
  ): AsyncIterable<ObservedPin> {
    const c = this.requireClient();
    const queue: ObservedPin[] = [];
    const waiters: Array<(p: IteratorResult<ObservedPin>) => void> = [];
    let closed = false;

    const dispatch = (p: ObservedPin): void => {
      const w = waiters.shift();
      if (w) w({ value: p, done: false });
      else queue.push(p);
    };

    const onRaw = (info: { update: unknown }): void => {
      const u = info.update as {
        _: string;
        pinned?: boolean;
        peer?: unknown;
        messages?: number[];
      };
      if (u._ !== "updatePinnedMessages") return;
      if (!u.peer) return;
      let peerId: number;
      try {
        peerId = getMarkedPeerId(u.peer as Parameters<typeof getMarkedPeerId>[0]);
      } catch {
        return; // unrecognized peer shape
      }
      if (peerId !== chatId) return;
      const ids = u.messages ?? [];
      const pinned = u.pinned !== false; // default-true per TL (`pinned` omitted = pin)
      const date = new Date();
      for (const messageId of ids) {
        dispatch({ chatId, messageId, pinned, date });
      }
    };

    c.onRawUpdate.add(onRaw);

    const close = (): void => {
      if (closed) return;
      closed = true;
      c.onRawUpdate.remove(onRaw);
      while (waiters.length > 0) {
        waiters.shift()?.({ value: undefined as never, done: true });
      }
    };

    return {
      [Symbol.asyncIterator](): AsyncIterator<ObservedPin> {
        return {
          next(): Promise<IteratorResult<ObservedPin>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined as never, done: true });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
          return(): Promise<IteratorResult<ObservedPin>> {
            close();
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    };
  }

  /**
   * Fetch a single message by id. Used by `expectPinnedCard` to grab
   * the card text once a pin event fires (the pin update carries
   * just the id — content has to be looked up separately).
   *
   * Returns `null` when the message doesn't exist or has been
   * deleted between the pin event and this lookup.
   */
  async getMessage(
    chatId: number,
    messageId: number,
  ): Promise<ObservedMessage | null> {
    const c = this.requireClient();
    const results = await c.getMessages(chatId, [messageId]);
    const msg = results[0];
    if (!msg) return null;
    return toObserved(msg, false);
  }

  /**
   * Fetch the inline keyboard attached to a bot message, if any.
   * Returns `null` for messages without an inline_keyboard (or with
   * a non-inline markup like force-reply).
   *
   * Used by vault UX scenarios that need to:
   * 1. Drive the gateway-published vault save card, audit/allow flow,
   *    or grant approval card (epic #1012).
   * 2. Find the `[Allow]` / `[Save]` / `[Approve]` button to press by
   *    its label, then pass `button.callbackData` to `pressButton`.
   *
   * Callback `data` is decoded from the raw `Uint8Array` to UTF-8
   * string; the gateway always encodes callback_data as ASCII/UTF-8,
   * so this matches Bot API consumers' view. URL buttons surface as
   * `{ text, url }` with `callbackData: undefined`.
   */
  async getKeyboard(
    chatId: number,
    messageId: number,
  ): Promise<ObservedKeyboard | null> {
    const c = this.requireClient();
    const results = await c.getMessages(chatId, [messageId]);
    const msg = results[0] as { markup?: { type: string; buttons: unknown[][] } } | null;
    if (!msg) return null;
    const markup = msg.markup;
    if (!markup || markup.type !== "inline") return null;
    const decoder = new TextDecoder();
    return markup.buttons.map((row) =>
      row.map((b) => {
        const btn = b as {
          _: string;
          text: string;
          data?: Uint8Array;
          url?: string;
        };
        const out: ObservedButton = { text: btn.text };
        if (btn._ === "keyboardButtonCallback" && btn.data) {
          out.callbackData = decoder.decode(btn.data);
        }
        if (btn._ === "keyboardButtonUrl" && btn.url) {
          out.url = btn.url;
        }
        return out;
      }),
    );
  }

  /**
   * Press an inline-keyboard callback button — the MTProto path that
   * mirrors what tapping the button in the Telegram client does.
   *
   * The bot receives a `callback_query` update. Bot-side handlers
   * (e.g. the gateway's vault-audit one-tap allow handler from
   * #969 P2b, or the agent-grant-request flow proposed in #1012)
   * fire as if a real operator tapped.
   *
   * Note: the driver user must be in the bot's admin allowlist for
   * any admin-gated button (most `/vault` callbacks are admin-gated).
   * The harness's `test-harness` agent already includes the driver
   * via `--allow-from` at agent-add time, so admin actions work
   * end-to-end out of the box.
   */
  async pressButton(
    chatId: number,
    messageId: number,
    callbackData: string,
  ): Promise<void> {
    const c = this.requireClient();
    await c.getCallbackAnswer({
      chatId,
      message: messageId,
      data: callbackData,
    });
  }

  /**
   * Send a voice note. Wraps mtcute's `sendMedia` + `InputMedia.voice`
   * factory. The `oggPath` must be a path to an OGG/Opus audio file
   * (Telegram only accepts that codec for voice notes); other audio
   * formats render as a generic audio attachment and `voice_in`
   * transcription on the bot side will skip them.
   *
   * Generating a fixture locally:
   *   ffmpeg -f lavfi -i anullsrc=r=48000:cl=mono -t 1 \
   *     -c:a libopus -b:a 32k tests/fixtures/voice/silence-1s.opus
   *
   * The scenario at `scenarios/voice-inbound-dm.test.ts` references
   * a fixture path but is `describe.skip`'d until the fixture is
   * committed (kept out of git to keep the repo small until needed).
   */
  async sendVoice(
    chatId: number,
    oggPath: string,
    opts?: SendTextOptions,
  ): Promise<{ messageId: number }> {
    const c = this.requireClient();
    const replyTo = opts?.replyTo ?? opts?.messageThreadId;
    const media = InputMedia.voice(oggPath);
    const sent = await c.sendMedia(
      chatId,
      media,
      replyTo ? { replyTo } : undefined,
    );
    return { messageId: sent.id };
  }

  /**
   * Send a photo album (Telegram media_group) — multiple photos posted as
   * one group, the way a forwarded album or a multi-image paste arrives.
   * Exercises the gateway's A2 multi-attachment coalescing: with
   * coalesce.max_attachments default 10, the whole album folds into ONE
   * Claude turn (the agent sees image_path, image_path_2, …). The optional
   * caption rides on the first item, matching Telegram client behaviour.
   * Returns every sent message id (one per album item).
   */
  async sendAlbum(
    chatId: number,
    photoPaths: string[],
    caption?: string,
    opts?: SendTextOptions,
  ): Promise<{ messageIds: number[] }> {
    const c = this.requireClient();
    const replyTo = opts?.replyTo ?? opts?.messageThreadId;
    // mtcute reads a bare string as a file_id/URL; the `file:` scheme is
    // what forces an upload from local disk (see normalize-input-media).
    const medias = photoPaths.map((p, i) =>
      InputMedia.photo(`file:${p}`, i === 0 && caption ? { caption } : undefined),
    );
    const sent = await c.sendMediaGroup(
      chatId,
      medias,
      replyTo ? { replyTo } : undefined,
    );
    return { messageIds: sent.map((m) => m.id) };
  }

  /**
   * Send or remove an emoji reaction on a target message. Used by the
   * UAT reaction-trigger scenario (#1074) to exercise the gateway's
   * MessageReactionUpdated handler — the driver reacts to a bot reply,
   * the bot's reaction-trigger pipeline synthesizes a new inbound turn
   * to the agent.
   *
   * Pass `emoji: null` to remove the existing reaction (mtcute's
   * `sendReaction` collapses send + remove into one method).
   */
  async sendReaction(
    chatId: number,
    messageId: number,
    emoji: string | null,
  ): Promise<void> {
    const c = this.requireClient();
    await c.sendReaction({
      chatId,
      message: messageId,
      emoji: emoji === null ? null : emoji,
    });
  }

  /**
   * Send a geolocation point. Used by the UAT location-inbound scenario
   * to exercise the gateway's `message:location` handler (#1077).
   */
  async sendLocation(
    chatId: number,
    latitude: number,
    longitude: number,
    opts?: SendTextOptions,
  ): Promise<{ messageId: number }> {
    const c = this.requireClient();
    const replyTo = opts?.replyTo ?? opts?.messageThreadId;
    const media = InputMedia.geo(latitude, longitude);
    const sent = await c.sendMedia(
      chatId,
      media,
      replyTo ? { replyTo } : undefined,
    );
    return { messageId: sent.id };
  }

  private requireClient(): TelegramClient {
    if (!this.client) {
      throw new Error("Driver not connected — call connect() first");
    }
    return this.client;
  }
}

function toObserved(msg: Message, edited: boolean): ObservedMessage {
  return {
    chatId: msg.chat.id,
    messageId: msg.id,
    threadId: msg.replyToMessage?.threadId ?? undefined,
    text: msg.text ?? "",
    senderUserId: msg.sender.id,
    fromBot: msg.sender.type === "user" && msg.sender.isBot === true,
    date: msg.date,
    edited,
    silent: msg.isSilent,
  };
}
