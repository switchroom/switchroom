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
  /**
   * The rich-formatting entities Telegram actually attached to the
   * rendered message (bold / italic / code / pre / text_link / …),
   * normalized from mtcute's `Message.entities`. This is what the
   * highest-fidelity UAT layer asserts on: not the markdown we SENT, but
   * the entity structure Telegram PARSED and will render. Empty array for
   * a plain-text message with no formatting.
   *
   * Empty (never undefined) when the message body could not be decoded to
   * real text+entities (see `text === "\x01"` sentinel below).
   */
  entities: ObservedEntity[];
  /**
   * The `t.me/c/<internal_chat>/<msgid>` (or `t.me/<username>/<msgid>`)
   * permalink to this message, for human eyeball reference in UAT output.
   * `undefined` for chats that don't support message links (private DMs) —
   * mtcute's `Message.link` getter throws there, so we swallow and leave it
   * unset rather than fail the observation.
   */
  link?: string;
}

/**
 * One rich-formatting entity as Telegram parsed it, flattened from
 * mtcute's `MessageEntity` into the fields a UAT assertion cares about.
 * `kind` is mtcute's entity kind (`bold`, `italic`, `code`, `pre`,
 * `text_link`, `blockquote`, …); `text` is the exact inner substring the
 * entity spans; `offset`/`length` are UTF-16 code-unit coordinates (the
 * same units Telegram uses on the wire).
 */
export interface ObservedEntity {
  kind: string;
  offset: number;
  length: number;
  text: string;
  /** Destination for `text_link` entities; undefined otherwise. */
  url?: string;
  /** Language info string for `pre` fenced blocks; undefined otherwise. */
  language?: string;
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
    // (no interactive login) we have to drive that lifecycle ourselves,
    // otherwise `onNewMessage` / `onEditMessage` never fire and
    // `observeMessages` silently waits forever. Symptom: `expectMessage`
    // timing out even though the bot's reply has arrived in the chat
    // (visible in Telegram).
    //
    // `notifyLoggedIn` is the lifecycle call `start()` makes from its
    // login callback but a manually-imported session skips — it tells the
    // updates manager the client is authorized (and seeds self into the
    // peer cache). mtcute 0.30's own docs recommend calling it, or
    // otherwise ensuring the user is logged in, before `startUpdatesLoop`.
    // Resolve self from the imported session and notify BEFORE starting
    // the loop, matching what `start()` does internally.
    const me = await this.client.getMe();
    await this.client.notifyLoggedIn(me.raw);
    await this.client.startUpdatesLoop();
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    await this.client.destroy();
    this.client = null;
  }

  /**
   * Populate the local peer cache with the account's dialogs so a
   * supergroup referenced by its marked id (e.g. `-100…`) becomes
   * resolvable. The driver runs on `MemoryStorage`, which starts EMPTY
   * every connect — a bot username resolves on demand (server lookup),
   * but a supergroup with no public username has no resolution path
   * until mtcute has seen it via the dialog list (which carries the
   * channel's `access_hash`). Call this once before sending to /
   * observing a supergroup. Best-effort: drains up to `limit` dialogs.
   * Requires the driver account to be a MEMBER of the supergroup — if a
   * later `sendText` still throws "Peer … not found in local cache",
   * the account isn't in the group.
   */
  async primeDialogs(limit = 200): Promise<void> {
    const c = this.requireClient();
    let seen = 0;
    for await (const _dialog of c.iterDialogs({ limit })) {
      void _dialog; // draining caches each peer's access_hash as a side effect
      if (++seen >= limit) break;
    }
  }

  /**
   * True if `chatId` is resolvable (its access_hash is known) — i.e. a
   * peer the account can address. Call after {@link primeDialogs}.
   * Non-intrusive: sends nothing. A forum supergroup the driver account
   * is in resolves true; a chat referenced by a wrong/foreign marked id
   * (e.g. a BASIC group given a supergroup-style `-100…` id, or a chat
   * the driver isn't a member of) resolves false. Used to skip supergroup
   * scenarios cleanly when the test forum isn't wired.
   */
  async canResolve(chatId: number): Promise<boolean> {
    const c = this.requireClient();
    try {
      await c.resolvePeer(chatId);
      return true;
    } catch {
      return false;
    }
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

    // Defensive wrapper: a throw inside the listener propagates out of
    // mtcute's `onNewMessage`/`onEditMessage` emitter (it does not catch
    // listener errors) and drops the update entirely, so `observeMessages`
    // would silently never yield it. `toObserved` is already hardened against
    // the known `PeersIndex` throw, but any future getter that throws must
    // NOT be allowed to swallow an observation — log and move on instead.
    const dispatchObserved = (msg: Message, edited: boolean): void => {
      let observed: ObservedMessage;
      try {
        observed = toObserved(msg, edited);
      } catch (err) {
        // eslint-disable-next-line no-console -- harness diagnostic
        console.warn(
          `[uat/driver] observeMessages: dropping unobservable message ` +
          `(id=${msg.id}): ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      if (observed.chatId !== chatId) return;
      if (targetThread !== undefined && observed.threadId !== targetThread) return;
      dispatch(observed);
    };
    const onNew = (msg: Message): void => dispatchObserved(msg, false);
    const onEdit = (msg: Message): void => dispatchObserved(msg, true);

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
   *
   * **DM / bot-reaction limitation:** when a BOT calls
   * `setMessageReaction` on a DM, Telegram's MTProto server does NOT
   * deliver `updateMessageReactions` to the human user's account.
   * The server only delivers `updateBotMessageReaction` to the BOT's
   * own update stream, so `onRawUpdate` never fires for the driver.
   * For DM bot-reaction assertions, use {@link pollReactions} instead
   * — it calls `messages.getMessagesReactions` directly (pull, not
   * push) to read the current reaction set on any message.
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
   * Pull a window of chat history in SERVER SEND-ORDER (ascending message_id —
   * the actual on-screen order). The Phase-3 helper the `observeMessages`
   * doc-comment references: unlike the new+edit observer stream, this is a pull
   * that sees ALL messages already in the chat, including ones that landed
   * before the observer started — required to assert ordering across a
   * re-prompt boundary (`jtbd-reply-is-last-dm`, design §11 cases 3 & 4).
   *
   * mtcute's `getHistory` returns newest-first by default (and `reverse=true`
   * needs an offset, returning [] otherwise), so we fetch then sort ascending
   * by message_id to recover send-order. Each entry is mapped to the same
   * `ObservedMessage` shape the assertions/predicates consume.
   */
  async getHistory(
    chatId: number,
    limit = 100,
  ): Promise<ObservedMessage[]> {
    const c = this.requireClient();
    const messages = await c.getHistory(chatId, { limit });
    return messages
      .map((m) => toObserved(m, false))
      .sort((a, b) => a.messageId - b.messageId);
  }

  /**
   * Poll the current set of emoji reactions on a message by making a
   * direct `messages.getMessagesReactions` MTProto call.
   *
   * Unlike {@link observeReactions}, this is a **pull** operation —
   * it does not depend on push updates from the Telegram server. This
   * makes it the correct verification method for DM bot-reaction
   * scenarios: when a bot calls `setMessageReaction` on a DM, Telegram
   * does not deliver `updateMessageReactions` to the user account, but
   * the reaction IS queryable via this API.
   *
   * Returns an array of emoji strings currently on the message
   * (e.g. `["👍"]`, `["👀", "🤔"]`). Returns an empty array when
   * no reactions are set, or when `getMessageReactionsById` returns
   * null (message deleted / not visible).
   *
   * Custom-emoji reactions are excluded (the documentId can't be
   * trivially shown as a string without resolving it).
   */
  async pollReactions(chatId: number, messageId: number): Promise<string[]> {
    const c = this.requireClient();
    const results = await c.getMessageReactionsById(chatId, [messageId]);
    const msgReactions = results[0];
    if (!msgReactions) return [];
    const emojis: string[] = [];
    for (const rc of msgReactions.reactions) {
      const emoji = rc.emoji;
      if (typeof emoji === "string") {
        emojis.push(emoji);
      }
      // Long (custom emoji document id) — skip, can't stringify cheaply
    }
    return emojis;
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
  // Bot API 10.1 rich messages (`sendMessage` with `{ markdown }`) used to
  // arrive as `messageMediaUnsupported` with an empty `message.message` on
  // the pinned mtcute (0.27.x). With mtcute >=0.30 the message decodes to
  // real text + entities, so we surface those directly. The
  // `messageMediaUnsupported` sentinel path is KEPT as a defensive fallback:
  // if a future Bot API / TL-layer change ever regresses the decode, the
  // `\x01` sentinel still lets text-presence assertions fire (and the
  // formatting scenario will flag the empty-entities case loudly rather than
  // silently pass). It is no longer expected to trigger on the happy path.
  const rawText = msg.text ?? "";
  // Bot API 10.1 rich messages (`sendRichMessage({ markdown })`) arrive on the
  // wire in a NEW TL field — `message.richMessage` — with the legacy `message`
  // string left EMPTY and NO `entities`. mtcute 0.30 does not yet map that
  // field onto `Message.text`/`Message.entities`, so `msg.text` is "" and the
  // observation looks textless. This is the sibling case to the
  // `messageMediaUnsupported` sentinel below: the visible text is on the wire,
  // just in a shape the getter doesn't decode. Flatten the `richMessage`
  // page-block/RichText tree ourselves into plain text + entities. (Confirmed
  // via a raw-TL dump on the uat-host runner, #2744.)
  const richDecoded =
    rawText === "" && msg.raw._ === "message"
      ? decodeRichMessage((msg.raw as { richMessage?: unknown }).richMessage)
      : null;
  const isRichMedia = rawText === "" && !richDecoded &&
    msg.raw._ === "message" && msg.raw.media?._ === "messageMediaUnsupported";
  // Resolve chat/sender ids from the RAW TL peer, not the `msg.chat` /
  // `msg.sender` getters. Those getters look the peer up in the update's
  // `PeersIndex` and THROW `MtArgumentError` ("peer not available in this
  // index") when it's absent — which happens for the driver because it runs
  // on `MemoryStorage` (empty peer cache each connect), so an incoming bot
  // reply can arrive before that peer has been cached. An unguarded throw
  // here propagates out of the mtcute `onNewMessage`/`onEditMessage` emitter
  // (that emitter does not catch listener errors), so the WHOLE update is
  // dropped and `observeMessages` never yields it — the exact "bot replied
  // fast but `expectMessage` timed out" failure. `getMarkedPeerId` reads the
  // raw TL peer directly and never touches the index, so it can't throw.
  const chatId = getMarkedPeerId(msg.raw.peerId);
  const rawFrom = msg.raw._ === "message" || msg.raw._ === "messageService"
    ? msg.raw.fromId
    : undefined;
  const senderUserId = rawFrom
    ? getMarkedPeerId(rawFrom)
    : chatId; // no explicit sender ⇒ the DM peer is the sender (bot reply in a DM)
  return {
    chatId,
    messageId: msg.id,
    threadId: msg.replyToMessage?.threadId ?? undefined,
    text: isRichMedia ? "\x01" : (richDecoded ? richDecoded.text : rawText),
    senderUserId,
    fromBot: safeIsFromBot(msg),
    date: msg.date,
    edited,
    silent: msg.isSilent,
    entities: isRichMedia
      ? []
      : (richDecoded ? richDecoded.entities : toObservedEntities(msg)),
    link: safeMessageLink(msg),
  };
}

/**
 * Flatten mtcute's `Message.entities` into the `ObservedEntity[]` the UAT
 * assertions consume. Pulls the entity `url` (text_link) and `language`
 * (pre) out of the discriminated `params` union so scenarios can assert on
 * link destinations and fenced-block languages, not just the span kind.
 */
function toObservedEntities(msg: Message): ObservedEntity[] {
  // Real mtcute always populates `.entities` (empty array for unformatted
  // text). Guard against a message shape that lacks it (e.g. a hand-rolled
  // test double) so the observation degrades to "no entities" rather than
  // throwing and taking down the whole scenario.
  const entities = msg.entities ?? [];
  return entities.map((e): ObservedEntity => {
    const params = e.params;
    return {
      kind: e.kind,
      offset: e.offset,
      length: e.length,
      text: e.text,
      url: params.kind === "text_link" ? params.url : undefined,
      language: params.kind === "pre" ? params.language : undefined,
    };
  });
}

/**
 * Decode a Bot API 10.1 rich message (`message.richMessage`) into flat
 * `{ text, entities }`, mirroring what `Message.text` + `Message.entities`
 * would carry if mtcute mapped the field. Returns `null` when the value isn't
 * a `richMessage` (so callers fall back to the legacy `message` string).
 *
 * On the wire a `richMessage` is Telegram's Instant-View page tree: a list of
 * `pageBlock`s, each carrying a `RichText` node (or, for tables/lists,
 * structured children). We model the block kinds Telegram's GFM parser
 * actually emits for a chat rich message, all shapes grounded against
 * `@mtcute/tl@223.0.0` (the TL layer mtcute 0.30 ships):
 *
 *   - `pageBlockParagraph`      — styled inline text (`.text: RichText`).
 *   - `pageBlockPreformatted`   — fenced code → one `pre` entity spanning the
 *                                 whole block, carrying `.language`.
 *   - `pageBlockHeader` /       — a markdown heading (`# …` / `## …`) →
 *     `pageBlockSubheader`        rendered as a `bold` entity over the line
 *                                 (Telegram has no first-class heading entity;
 *                                 GFM headings surface as bold on a phone).
 *   - `pageBlockBlockquote` /   — `> …` quote → a `blockquote` entity over the
 *     `pageBlockPullquote`        quote body (`.text`; `.caption` follows on a
 *                                 newline, unstyled).
 *   - `pageBlockList`           — unordered list; `.items: PageListItem[]`
 *                                 (`pageListItemText.text: RichText` or
 *                                 `pageListItemBlocks.blocks: PageBlock[]`),
 *                                 each item rendered `• ` + inline content.
 *   - `pageBlockOrderedList`    — ordered list; `.items: PageListOrderedItem[]`
 *                                 (`…Text` / `…Blocks`) each carrying a `.num`
 *                                 label rendered `<num>. ` + content.
 *   - `pageBlockTable`          — `.title: RichText`, `.rows: PageTableRow[]`,
 *                                 each `.cells: PageTableCell[]` with an
 *                                 optional `.text: RichText` (+ `.header`).
 *                                 Cells join with " | ", rows with newlines;
 *                                 header cells emit a `bold` entity.
 *   - `pageBlockDivider`        — a horizontal rule (`---`) → a literal "———"
 *                                 line, no entity.
 *
 * NOTE (grounding): TL layer 223 has NO `textSpoiler` RichText kind. GFM
 * spoiler syntax (`||…||`) surfaces on the IV wire as `textMarked`
 * ("highlighted text") — so `textMarked` maps to the Bot API `spoiler`
 * entity. `textStrike`/`textUnderline` ARE first-class RichText kinds and
 * map to `strikethrough`/`underline` directly.
 *
 * Blocks are joined with a newline. The RichText tree is a
 * discriminated union: leaf `textPlain` carries a string; `textConcat` holds a
 * `texts[]` sequence; the styled wrappers (`textBold`/`textItalic`/`textFixed`/
 * `textUrl`/…) nest another RichText in `.text`. We flatten depth-first,
 * tracking UTF-16 code-unit offsets (JS string `.length` is already UTF-16, the
 * same units Telegram uses on the wire) and emit an `ObservedEntity` for each
 * styled span so the render-fidelity assertions see the same entity structure
 * the legacy `entities` path produces.
 */
export function decodeRichMessage(
  rich: unknown,
): { text: string; entities: ObservedEntity[] } | null {
  const rm = rich as
    | { _?: string; blocks?: Array<Record<string, unknown>> }
    | undefined;
  if (!rm || rm._ !== "richMessage" || !Array.isArray(rm.blocks)) return null;

  let text = "";
  const entities: ObservedEntity[] = [];

  const emit = (
    kind: string,
    start: number,
    extra?: { url?: string; language?: string },
  ): void => {
    const length = text.length - start;
    if (length <= 0) return;
    entities.push({
      kind,
      offset: start,
      length,
      text: text.slice(start, start + length),
      url: extra?.url,
      language: extra?.language,
    });
  };

  // Depth-first walk of a RichText node, appending plain text to `text` and
  // pushing an entity for each styled wrapper (mapping TL kinds to mtcute's).
  const walk = (node: unknown): void => {
    const n = node as {
      _?: string;
      text?: unknown;
      texts?: unknown[];
      url?: string;
    };
    if (!n || typeof n._ !== "string") return;
    switch (n._) {
      case "textEmpty":
        return;
      case "textPlain":
        if (typeof n.text === "string") text += n.text;
        return;
      case "textConcat":
        for (const t of n.texts ?? []) walk(t);
        return;
      case "textBold": {
        const s = text.length;
        walk(n.text);
        emit("bold", s);
        return;
      }
      case "textItalic": {
        const s = text.length;
        walk(n.text);
        emit("italic", s);
        return;
      }
      case "textUnderline": {
        const s = text.length;
        walk(n.text);
        emit("underline", s);
        return;
      }
      case "textStrike": {
        const s = text.length;
        walk(n.text);
        emit("strikethrough", s);
        return;
      }
      case "textFixed": {
        // Inline fixed-width (`code_token`) → Bot API `code` entity.
        const s = text.length;
        walk(n.text);
        emit("code", s);
        return;
      }
      case "textMarked": {
        // TL layer 223 has no `textSpoiler`; GFM `||spoiler||` rides the
        // IV "highlighted text" node (`textMarked`) → Bot API `spoiler`.
        const s = text.length;
        walk(n.text);
        emit("spoiler", s);
        return;
      }
      case "textUrl": {
        const s = text.length;
        walk(n.text);
        emit("text_link", s, { url: n.url });
        return;
      }
      case "textEmail": {
        const s = text.length;
        walk(n.text);
        emit("email", s);
        return;
      }
      default:
        // Any other wrapper (marked/sub/superscript/phone/anchor/…) — keep its
        // visible text but don't classify the span; the render assertions only
        // key off the kinds the gateway emits.
        if (n.text !== undefined) walk(n.text);
        return;
    }
  };

  // Emit a span that Telegram has no first-class entity for (heading, table
  // header) but which renders styled on a phone — we pick the closest Bot API
  // entity so the render-fidelity assertions can key off it.
  const emitOver = (kind: string, start: number): void => emit(kind, start);

  // Walk one IV page-block, appending its text to `text` and pushing entities.
  // Recursive: lists/tables nest paragraph-like children.
  const walkBlock = (block: Record<string, unknown> | undefined): void => {
    if (!block || typeof block._ !== "string") return;
    switch (block._) {
      case "pageBlockPreformatted": {
        // Fenced code block → one `pre` entity spanning the whole block, with
        // the language string Telegram tagged the fence with.
        const s = text.length;
        walk(block.text);
        const length = text.length - s;
        if (length > 0) {
          entities.push({
            kind: "pre",
            offset: s,
            length,
            text: text.slice(s, s + length),
            url: undefined,
            language: (block.language as string) || undefined,
          });
        }
        return;
      }
      case "pageBlockHeader":
      case "pageBlockSubheader": {
        // GFM heading (`#`/`##`) → no first-class Telegram heading entity;
        // it renders bold on a phone, so we model it as a `bold` span.
        const s = text.length;
        walk(block.text);
        emitOver("bold", s);
        return;
      }
      case "pageBlockBlockquote":
      case "pageBlockPullquote": {
        // `> …` quote → `blockquote` entity over the quote body. `.caption`
        // (if any) follows on its own line, unstyled.
        const s = text.length;
        walk(block.text);
        emitOver("blockquote", s);
        const caption = block.caption as Record<string, unknown> | undefined;
        if (caption && caption._ && caption._ !== "textEmpty") {
          text += "\n";
          walk(caption);
        }
        return;
      }
      case "pageBlockList": {
        // Unordered list. Items are pageListItemText (RichText) or
        // pageListItemBlocks (nested page blocks); each gets a "• " bullet.
        const items = (block.items as Array<Record<string, unknown>>) ?? [];
        items.forEach((item, i) => {
          if (i > 0) text += "\n";
          text += "• ";
          if (item._ === "pageListItemText") {
            walk(item.text);
          } else if (item._ === "pageListItemBlocks") {
            const blocks = (item.blocks as Array<Record<string, unknown>>) ?? [];
            blocks.forEach((b, j) => {
              if (j > 0) text += "\n";
              walkBlock(b);
            });
          }
        });
        return;
      }
      case "pageBlockOrderedList": {
        // Ordered list. Items carry a `.num` label ("1", "2", …).
        const items = (block.items as Array<Record<string, unknown>>) ?? [];
        items.forEach((item, i) => {
          if (i > 0) text += "\n";
          text += `${(item.num as string) || String(i + 1)}. `;
          if (item._ === "pageListOrderedItemText") {
            walk(item.text);
          } else if (item._ === "pageListOrderedItemBlocks") {
            const blocks = (item.blocks as Array<Record<string, unknown>>) ?? [];
            blocks.forEach((b, j) => {
              if (j > 0) text += "\n";
              walkBlock(b);
            });
          }
        });
        return;
      }
      case "pageBlockTable": {
        // `.title` (optional) on its own line, then rows joined by newline,
        // cells within a row joined by " | ". Header cells emit a `bold` span.
        const title = block.title as Record<string, unknown> | undefined;
        let wroteTitle = false;
        if (title && title._ && title._ !== "textEmpty") {
          walk(title);
          wroteTitle = true;
        }
        const rows = (block.rows as Array<Record<string, unknown>>) ?? [];
        rows.forEach((row, ri) => {
          if (ri > 0 || wroteTitle) text += "\n";
          const cells = (row.cells as Array<Record<string, unknown>>) ?? [];
          cells.forEach((cell, ci) => {
            if (ci > 0) text += " | ";
            const s = text.length;
            if (cell.text !== undefined) walk(cell.text);
            if (cell.header) emitOver("bold", s);
          });
        });
        return;
      }
      case "pageBlockDivider": {
        // Horizontal rule (`---`). No entity; a literal rule line.
        text += "———";
        return;
      }
      default:
        // pageBlockParagraph, footer, kicker, title, subtitle, and any other
        // text-bearing block — inline walk of `.text`.
        walk(block.text);
        return;
    }
  };

  for (const block of rm.blocks) {
    if (text.length > 0) text += "\n"; // join blocks in send order
    walkBlock(block);
  }

  return { text, entities };
}

/**
 * `Message.link` throws (`MtArgumentError`) for chats that don't support
 * message permalinks — notably private DMs, which is exactly where most
 * UAT scenarios run. Swallow that and leave the field unset rather than
 * blow up the whole observation; group/channel messages still get a real
 * `t.me/c/<chat>/<msgid>` link for human eyeball reference.
 */
function safeMessageLink(msg: Message): string | undefined {
  try {
    return msg.link;
  } catch {
    return undefined;
  }
}

/**
 * Whether the message was sent by a bot. Reads `msg.sender`, which resolves
 * the peer via the update's `PeersIndex` and THROWS `MtArgumentError` when
 * that peer isn't cached (the driver's `MemoryStorage` starts empty, so an
 * incoming reply can arrive before its sender is cached). We only need
 * `fromBot` for coarse classification, and `expectMessage`'s `from: "bot"`
 * filter keys off `senderUserId` (resolved from the raw peer above), not this
 * flag — so a swallowed lookup degrades to `false` rather than dropping the
 * whole observation. Group/DM messages with a cached sender still classify
 * correctly.
 */
function safeIsFromBot(msg: Message): boolean {
  try {
    return msg.sender.type === "user" && msg.sender.isBot === true;
  } catch {
    return false;
  }
}
