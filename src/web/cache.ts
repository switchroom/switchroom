/**
 * A tiny stale-while-revalidate (SWR) cache for the dashboard's read-only
 * panels.
 *
 * The dashboard re-computes several expensive panels per request (docker
 * inspect, broker RPC, hindsight HTTP probes, hostd round-trips, per-agent
 * sqlite reads). Without a cache, every tab-open / poll-tick hammers the
 * host. SWR gives the operator a *fast* response (the cached value) while
 * a single background refresh keeps the value reasonably fresh — the
 * dashboard is observability, not a transactional surface, so serving a
 * few-seconds-stale value is the right trade.
 *
 * Semantics (per key):
 *   - **cold** (no entry): await the producer, store it, return it
 *     fresh. The first read pays the full cost — there's nothing to serve.
 *   - **fresh** (age < ttlMs): return the cached value WITHOUT calling the
 *     producer. `stale:false`.
 *   - **stale** (age >= ttlMs): return the cached (last-good) value
 *     IMMEDIATELY with `stale:true`, and kick a SINGLE background refresh.
 *     Concurrent stale reads share that one refresh (single-flight via the
 *     `refreshing` guard) — they don't stampede the producer. On refresh
 *     SUCCESS the entry is replaced (value + fetchedAt). On refresh ERROR
 *     the last-good entry is KEPT and `refreshing` is cleared, so a later
 *     read retries the refresh — a flapping producer never blanks the
 *     panel and never throws to the caller.
 *
 * A stale read NEVER throws (it always has last-good to serve). Only a
 * cold read can throw — there's no value yet, so the producer's rejection
 * propagates (the route handler degrades, as it does today).
 *
 * `now` is injectable so tests can drive the TTL deterministically. The
 * dashboard server is a single long-lived process, so a module-level
 * instance with a plain Map is the cache (bounded by the small fixed set
 * of route keys).
 */

/** A cache read result: the value plus when it was produced and whether
 *  it's being served past its TTL (a background refresh is/was kicked). */
export interface CachedResult<T> {
  value: T;
  /** Unix ms when `value` was produced by the producer. */
  dataAsOf: number;
  /** True when the value is older than its TTL (served stale-while-revalidate). */
  stale: boolean;
}

interface Entry {
  /** Last successfully-produced value. Typed `unknown` — callers assert T. */
  value: unknown;
  /** Unix ms when `value` was produced. */
  fetchedAt: number;
  /** Single-flight guard: a background refresh is in progress for this key. */
  refreshing: boolean;
}

export class SwrCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Get the cached value for `key`, producing it via `producer` when cold,
   * and refreshing it in the background when stale. See the class doc for
   * the full stale-while-revalidate semantics. Never throws on a stale
   * read; a cold read propagates the producer's rejection.
   *
   * @param key       cache key (one per route).
   * @param ttlMs     freshness window — at/after this age the value is stale.
   * @param producer  async function that computes a fresh value.
   */
  async get<T>(
    key: string,
    ttlMs: number,
    producer: () => Promise<T>,
  ): Promise<CachedResult<T>> {
    const existing = this.entries.get(key);

    // Cold: nothing to serve — pay the full cost and store it fresh.
    if (!existing) {
      const value = await producer();
      const fetchedAt = this.now();
      this.entries.set(key, { value, fetchedAt, refreshing: false });
      return { value, dataAsOf: fetchedAt, stale: false };
    }

    const age = this.now() - existing.fetchedAt;

    // Fresh: serve the cached value without touching the producer.
    if (age < ttlMs) {
      return {
        value: existing.value as T,
        dataAsOf: existing.fetchedAt,
        stale: false,
      };
    }

    // Stale: serve last-good IMMEDIATELY and kick a single background
    // refresh (single-flight — concurrent stale reads share it).
    if (!existing.refreshing) {
      existing.refreshing = true;
      // Fire-and-forget. We deliberately do NOT await — the caller gets
      // the stale value now; the refresh updates the entry for the NEXT
      // read. Errors are swallowed (keep last-good, clear the guard so a
      // later read retries).
      void producer().then(
        (value) => {
          this.entries.set(key, {
            value,
            fetchedAt: this.now(),
            refreshing: false,
          });
        },
        () => {
          // Refresh failed — keep the last-good entry, just clear the
          // in-flight guard so a subsequent stale read can retry.
          const cur = this.entries.get(key);
          if (cur) cur.refreshing = false;
        },
      );
    }

    return {
      value: existing.value as T,
      dataAsOf: existing.fetchedAt,
      stale: true,
    };
  }

  /** Test hook: drop all cached entries. */
  clear(): void {
    this.entries.clear();
  }
}
