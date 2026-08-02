/**
 * Inbound dedup for the Buzz sidecar (Phase 1, M2 layer 1).
 *
 * A Nostr relay can redeliver an event (resubscribe with an overlapping
 * `since`, a reconnect replay, a relay bounce). Without dedup the same event id
 * would inject a turn twice. This store is the durable guard: an in-memory LRU
 * of PROCESSED event ids backed by an append-only JSONL journal, fsync'd after
 * each record so a sidecar restart replays zero already-injected events.
 *
 * Contract with the pump: check `has(id)` BEFORE injecting; call `record(id)`
 * (which appends+fsyncs) AFTER a successful inject. This durable journal closes
 * the normal case (relay resend, reconnect replay, sidecar restart). One
 * residual remains and is NOT closed in this branch: a crash in the narrow
 * window between the inject landing and `record` completing can re-inject
 * exactly one event. Closing that residual needs a hub-side dedup ring in the
 * gateway's inject path, which is deferred to a later phase (M2 layer 2 — not
 * present here). Never the reverse ordering: recording before the inject lands
 * would silently drop an event on a crash.
 *
 * The filesystem is injected so the pure LRU/journal logic is unit-testable
 * with an in-memory fake.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface DedupFsLike {
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

const NODE_FS: DedupFsLike = {
  existsSync,
  mkdirSync: (p, opts) => { mkdirSync(p, opts); },
  readFileSync: (p, enc) => readFileSync(p, enc),
  writeFileSync: (p, data) => writeFileSync(p, data),
  renameSync: (from, to) => renameSync(from, to),
  openSync: (p, flags) => openSync(p, flags),
  writeSync: (fd, data) => { writeSync(fd, data); },
  fsyncSync: (fd) => fsyncSync(fd),
  closeSync: (fd) => closeSync(fd),
  // appendFileSync kept out of the interface — we hold an append fd for fsync.
};

export interface DedupStore {
  /** True iff `id` was already processed (in the LRU / replayed journal). */
  has(id: string): boolean;
  /** Mark `id` processed: add to the LRU AND append+fsync to the journal.
   *  Idempotent — recording a known id is a no-op (no duplicate journal line). */
  record(id: string): void;
  /** Number of ids currently tracked in memory. */
  size(): number;
  /** Release the append fd. */
  close(): void;
}

export interface DedupOptions {
  journalPath: string;
  /** Max ids retained in memory / after boot compaction. Default 10_000. */
  capacity?: number;
  fs?: DedupFsLike;
  log?: (msg: string) => void;
}

/**
 * Open (and boot-compact) the dedup store. On construction it reads any
 * existing journal, loads the last `capacity` unique ids into the LRU, and
 * rewrites the journal compacted (bounding on-disk growth), then opens a
 * persistent append fd.
 */
export function createDedupStore(opts: DedupOptions): DedupStore {
  const capacity = opts.capacity ?? 10_000;
  const fs = opts.fs ?? NODE_FS;
  const log = opts.log ?? (() => {});
  const journalPath = opts.journalPath;

  // Insertion-ordered set → LRU. A Map<string,true> preserves insertion order;
  // eviction removes the oldest key.
  const lru = new Map<string, true>();

  function add(id: string): void {
    if (lru.has(id)) return;
    lru.set(id, true);
    while (lru.size > capacity) {
      const oldest = lru.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      lru.delete(oldest);
    }
  }

  // --- Boot compaction ---
  try {
    const dir = dirname(journalPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(journalPath)) {
      const raw = fs.readFileSync(journalPath, "utf8");
      const ids: string[] = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as { id?: unknown };
          if (typeof parsed.id === "string" && parsed.id) ids.push(parsed.id);
        } catch {
          // Tolerate a torn final line (crash mid-write) — skip it.
        }
      }
      // Keep only the last `capacity` unique ids, oldest-first.
      const seen = new Set<string>();
      const kept: string[] = [];
      for (let i = ids.length - 1; i >= 0 && kept.length < capacity; i--) {
        if (!seen.has(ids[i])) {
          seen.add(ids[i]);
          kept.push(ids[i]);
        }
      }
      kept.reverse();
      for (const id of kept) add(id);
      // Rewrite compacted, atomically (tmp + rename).
      const tmp = `${journalPath}.tmp`;
      fs.writeFileSync(tmp, kept.map((id) => JSON.stringify({ id })).join("\n") + (kept.length ? "\n" : ""));
      fs.renameSync(tmp, journalPath);
      log(`buzz dedup: compacted journal, ${lru.size} ids retained`);
    }
  } catch (err) {
    // A journal we cannot read must not crash the sidecar — degrade to an
    // empty in-memory LRU. Same-session duplicates are still guarded by the LRU
    // as it refills; note the cross-restart guarantee is degraded until the
    // journal is writable again (the deferred hub-side dedup ring would add a
    // second layer here, but is not present in this branch).
    log(`buzz dedup: journal load failed, starting empty: ${(err as Error).message}`);
    lru.clear();
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(journalPath, "a");
  } catch (err) {
    log(`buzz dedup: could not open append fd: ${(err as Error).message}`);
    fd = null;
  }

  return {
    has(id: string): boolean {
      return lru.has(id);
    },
    record(id: string): void {
      if (lru.has(id)) return;
      add(id);
      if (fd !== null) {
        try {
          fs.writeSync(fd, JSON.stringify({ id }) + "\n");
          fs.fsyncSync(fd);
        } catch (err) {
          log(`buzz dedup: journal append failed: ${(err as Error).message}`);
        }
      }
    },
    size(): number {
      return lru.size;
    },
    close(): void {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* nothing to do */ }
        fd = null;
      }
    },
  };
}
