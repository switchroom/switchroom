/**
 * In-process LRU cache mapping Notion page/block IDs → parent database
 * UUIDs (or null when the page has no DB ancestor).
 *
 * RFC reference/rfcs/notion-integration.md §8.3.
 *
 * Used by the PreToolUse hook to avoid re-walking the
 * page→parent→...→DB chain on every Notion write. The mapping is
 * stable for the lifetime of the container unless the operator
 * physically moves pages between DBs in Notion's UI (rare; clear via
 * launcher restart).
 *
 * Pure module — no I/O, no globals. The launcher / hook owns its own
 * cache instance.
 *
 * **Cache miss is OK.** When the cache doesn't know an ID, the
 * resolver walks Notion's API and writes the result. A miss costs
 * 1–4 API calls; a hit is free.
 *
 * **TTL is a refresh trigger, not eviction.** Entries past TTL are
 * treated as misses, NOT removed. Removal happens only via LRU
 * eviction when the cache is full. This lets stale entries serve as
 * a hint during a transient API blip.
 */

const DEFAULT_CACHE_SIZE = 5000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface PageDbCacheEntry {
  /** Resolved parent database UUID, or null when no DB ancestor exists. */
  dbId: string | null;
  /** Wall-clock ms when this entry was last written. */
  writtenAt: number;
}

export interface PageDbCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  /** Injectable now() for tests. */
  now?: () => number;
}

export class PageDbCache {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  // Map preserves insertion order, so for true LRU we re-insert on
  // every read (delete + set). Cheap; Maps are O(1) for both.
  private readonly entries = new Map<string, PageDbCacheEntry>();

  hits = 0;
  misses = 0;
  staleHits = 0;
  evictions = 0;

  constructor(opts: PageDbCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_CACHE_SIZE;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Look up `id`. Returns:
   *   - `{ kind: "hit", dbId }` — fresh entry.
   *   - `{ kind: "stale", dbId }` — entry exists but past TTL; caller
   *     should re-resolve and write back. Useful as a hint during
   *     transient API problems.
   *   - `{ kind: "miss" }` — no entry.
   */
  get(id: string):
    | { kind: "hit"; dbId: string | null }
    | { kind: "stale"; dbId: string | null }
    | { kind: "miss" } {
    const entry = this.entries.get(id);
    if (!entry) {
      this.misses += 1;
      return { kind: "miss" };
    }
    // LRU: re-insert so this is now the most-recently-used.
    this.entries.delete(id);
    this.entries.set(id, entry);

    const age = this.now() - entry.writtenAt;
    if (age > this.ttlMs) {
      this.staleHits += 1;
      return { kind: "stale", dbId: entry.dbId };
    }
    this.hits += 1;
    return { kind: "hit", dbId: entry.dbId };
  }

  /**
   * Write/overwrite the mapping for `id`. Evicts the LRU entry when
   * the cache is at capacity.
   */
  set(id: string, dbId: string | null): void {
    if (this.entries.has(id)) {
      this.entries.delete(id);
    }
    this.entries.set(id, { dbId, writtenAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }

  /** Invalidate a single entry (e.g. on a known move). */
  invalidate(id: string): boolean {
    return this.entries.delete(id);
  }

  /** Drop everything — operators can request this via launcher restart. */
  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.staleHits = 0;
    this.evictions = 0;
  }

  size(): number {
    return this.entries.size;
  }

  /** Snapshot for doctor probes / UAT introspection. */
  snapshot(): {
    size: number;
    maxEntries: number;
    ttlMs: number;
    hits: number;
    misses: number;
    staleHits: number;
    evictions: number;
    hitRate: number;
  } {
    const total = this.hits + this.misses + this.staleHits;
    return {
      size: this.entries.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
      staleHits: this.staleHits,
      evictions: this.evictions,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }
}
