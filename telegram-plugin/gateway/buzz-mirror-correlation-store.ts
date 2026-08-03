/**
 * Durable msg→Buzz correlation store for the hub-side mirror (#4222).
 *
 * `BuzzMirror` records `${chatId}:${messageId}` → the published Buzz event it
 * mirrored to, so a later `edit_message` on that Telegram message can publish a
 * superseding `correction`. Before this module that map lived IN MEMORY ONLY
 * (a bounded FIFO). After a gateway restart the map was empty, so a correction
 * to an answer mirrored before the restart was SILENTLY skipped — the Buzz copy
 * went stale with no signal.
 *
 * This store closes that gap the same way the sidecar's inbound dedup does
 * (`src/buzz-gateway/dedup.ts`): an in-memory insertion-ordered map backed by an
 * append-only JSONL journal, fsync'd after each record so a gateway restart
 * reloads the correlation and corrections survive. It lives at a DIFFERENT path
 * from the sidecar's `journal.jsonl` (`mirror-correlation.jsonl`) — the two share
 * `$TELEGRAM_STATE_DIR/buzz/` and a filename collision would corrupt both.
 *
 * Bounding: on construction the journal is compacted to the last `capacity`
 * unique keys (matching the in-memory FIFO bound); during a session the journal
 * is re-compacted in place once it grows past `capacity * COMPACTION_FACTOR`
 * appends, so it never grows unbounded even in a long-lived gateway.
 *
 * The filesystem is injected so the pure map/journal logic is unit-testable with
 * an in-memory fake (see `buzz-mirror-correlation-store.test.ts`). When no
 * journal path is configured (dev/one-shot contexts, or `TELEGRAM_STATE_DIR`
 * unset) the store degrades to in-memory only — identical bound, no durability.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** The value a Telegram message key maps to: the Buzz event that mirrored it. */
export interface CorrelationValue {
  eventId: string;
  channelId: string;
  /**
   * The NIP-10 thread ROOT of `eventId` (#4280 follow-up — outbound thread
   * continuity). For a top-level mirror this equals `eventId` itself; for a
   * mirror that threaded under a parent it is that parent's thread root. Lets a
   * LATER outbound reply whose Telegram antecedent is THIS message emit a correct
   * NIP-10 `root` marker (thread root) alongside the `reply` marker (this
   * `eventId`, the immediate parent), instead of collapsing a deep thread to a
   * single mislabelled root. Optional for backward compatibility: a journal
   * record written before this field existed replays with `threadRoot`
   * undefined, degrading to a `reply`-only tag (still valid NIP-10).
   */
  threadRoot?: string;
}

export interface CorrelationFsLike {
  existsSync(path: string): boolean;
  mkdirSync(path: string, opts: { recursive: true }): void;
  readFileSync(path: string, enc: "utf8"): string;
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  openSync(path: string, flags: "a"): number;
  writeSync(fd: number, data: string): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
}

const NODE_FS: CorrelationFsLike = {
  existsSync,
  mkdirSync: (p, opts) => {
    mkdirSync(p, opts);
  },
  readFileSync: (p, enc) => readFileSync(p, enc),
  writeFileSync: (p, data) => writeFileSync(p, data),
  renameSync: (from, to) => renameSync(from, to),
  openSync: (p, flags) => openSync(p, flags),
  writeSync: (fd, data) => {
    writeSync(fd, data);
  },
  fsyncSync: (fd) => fsyncSync(fd),
  closeSync: (fd) => closeSync(fd),
};

export interface CorrelationStore {
  /** The Buzz event `key` was mirrored to, or undefined if not tracked. */
  get(key: string): CorrelationValue | undefined;
  /** Record `key` → `value`: update memory (FIFO) AND append+fsync the journal. */
  set(key: string, value: CorrelationValue): void;
  /** Number of keys currently tracked in memory. */
  size(): number;
  /** Release the append fd. */
  close(): void;
}

export interface CorrelationStoreOptions {
  /** Journal path. Omit for in-memory-only (no durability, same bound). */
  journalPath?: string;
  /** Max keys retained in memory / after compaction. Default 4096 (MAX_TRACKED). */
  capacity?: number;
  fs?: CorrelationFsLike;
  log?: (msg: string) => void;
}

/** Re-compact the on-disk journal once appends exceed capacity * this factor. */
const COMPACTION_FACTOR = 4;

interface JournalRecord {
  key?: unknown;
  eventId?: unknown;
  channelId?: unknown;
  threadRoot?: unknown;
}

/**
 * Open (and boot-compact) the correlation store. On construction it replays any
 * existing journal into the in-memory map (last-write-wins per key, oldest-first
 * insertion order preserved), keeps the last `capacity` unique keys, rewrites the
 * journal compacted, then opens a persistent append fd.
 */
export function createCorrelationStore(
  opts: CorrelationStoreOptions = {},
): CorrelationStore {
  const capacity = opts.capacity ?? 4096;
  const fs = opts.fs ?? NODE_FS;
  const log = opts.log ?? (() => {});
  const journalPath = opts.journalPath;

  // Insertion-ordered map → FIFO. Re-setting a key moves it to newest.
  const map = new Map<string, CorrelationValue>();

  function put(key: string, value: CorrelationValue): void {
    if (map.has(key)) map.delete(key); // move to newest on update
    map.set(key, value);
    while (map.size > capacity) {
      const oldest = map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  function encodeRecord(key: string, v: CorrelationValue): string {
    // Omit threadRoot when absent so pre-existing (pre-threadRoot) journals round-
    // trip byte-identically and a value that never carried a root stays compact.
    const record: { key: string; eventId: string; channelId: string; threadRoot?: string } = {
      key,
      eventId: v.eventId,
      channelId: v.channelId,
    };
    if (v.threadRoot) record.threadRoot = v.threadRoot;
    return JSON.stringify(record);
  }

  function serialize(): string {
    let out = "";
    for (const [key, v] of map) {
      out += encodeRecord(key, v) + "\n";
    }
    return out;
  }

  // Number of physical lines in the journal since the last compaction (seeded to
  // the compacted size below). Bounds on-disk growth in a long-lived session.
  let journalLines = 0;

  // --- Boot compaction (only when a journal path is configured) ---
  if (journalPath) {
    try {
      const dir = dirname(journalPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(journalPath)) {
        const raw = fs.readFileSync(journalPath, "utf8");
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as JournalRecord;
            if (
              typeof parsed.key === "string" &&
              parsed.key &&
              typeof parsed.eventId === "string" &&
              parsed.eventId &&
              typeof parsed.channelId === "string" &&
              parsed.channelId
            ) {
              // Replay in order — put() enforces last-write-wins + FIFO bound.
              // threadRoot is optional (added post-#4280): accept a non-empty
              // string, otherwise leave undefined so an older record degrades to
              // a reply-only tag rather than corrupting the map.
              const threadRoot =
                typeof parsed.threadRoot === "string" && parsed.threadRoot
                  ? parsed.threadRoot
                  : undefined;
              put(parsed.key, { eventId: parsed.eventId, channelId: parsed.channelId, threadRoot });
            }
          } catch {
            // Tolerate a torn final line (crash mid-write) — skip it.
          }
        }
        // Rewrite compacted, atomically (tmp + rename).
        const tmp = `${journalPath}.tmp`;
        fs.writeFileSync(tmp, serialize());
        fs.renameSync(tmp, journalPath);
        journalLines = map.size;
        log(`buzz-mirror correlation: compacted journal, ${map.size} keys retained`);
      }
    } catch (err) {
      // A journal we cannot read must not disturb the gateway — degrade to an
      // empty in-memory map. The cross-restart guarantee is degraded until the
      // journal is writable again, but the Telegram copy is unaffected.
      log(
        `buzz-mirror correlation: journal load failed, starting empty: ${(err as Error).message}`,
      );
      map.clear();
      journalLines = 0;
    }
  }

  let fd: number | null = null;
  if (journalPath) {
    try {
      fd = fs.openSync(journalPath, "a");
    } catch (err) {
      log(`buzz-mirror correlation: could not open append fd: ${(err as Error).message}`);
      fd = null;
    }
  }

  function compactInPlace(): void {
    if (!journalPath) return;
    try {
      // Close the append fd, rewrite from memory, reopen.
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* nothing to do */
        }
        fd = null;
      }
      const tmp = `${journalPath}.tmp`;
      fs.writeFileSync(tmp, serialize());
      fs.renameSync(tmp, journalPath);
      journalLines = map.size;
      fd = fs.openSync(journalPath, "a");
    } catch (err) {
      log(`buzz-mirror correlation: in-session compaction failed: ${(err as Error).message}`);
    }
  }

  return {
    get(key: string): CorrelationValue | undefined {
      return map.get(key);
    },
    set(key: string, value: CorrelationValue): void {
      put(key, value);
      if (fd !== null && journalPath) {
        try {
          fs.writeSync(fd, encodeRecord(key, value) + "\n");
          fs.fsyncSync(fd);
          journalLines++;
          if (journalLines > capacity * COMPACTION_FACTOR) compactInPlace();
        } catch (err) {
          log(`buzz-mirror correlation: journal append failed: ${(err as Error).message}`);
        }
      }
    },
    size(): number {
      return map.size;
    },
    close(): void {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* nothing to do */
        }
        fd = null;
      }
    },
  };
}
