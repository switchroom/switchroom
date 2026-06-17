/**
 * Tier-0 poll state — reference/rfcs/cheap-cron-sessions.md §2.1.
 *
 * Durable cursor per poll `state_key`, on the /state/agent/ volume so it
 * survives restart and is NOT touched by reconcile (reconcile writes
 * scaffold/config, never runtime state).
 *
 * Two correctness properties it encodes:
 *
 *  - First-run-no-escalate: a key with no recorded baseline records the
 *    baseline and does NOT escalate (else every existing Brevo contact
 *    emails on day one). `get()===undefined` is the first-run signal.
 *
 *  - Write-ahead idempotency (the double-escalation race): before a poll
 *    dispatches its Tier-1 escalation, it advances the cursor AND records
 *    `pendingEscalation` in ONE atomic write. A restart mid-escalation
 *    re-polls, sees the already-advanced cursor → no new data → no
 *    re-escalation (the double-EMAIL guard — the property that matters).
 *
 *    NOTE: `pendingEscalation` is the forward hook for a crash that lands
 *    AFTER the cursor advance but BEFORE a delivered dispatch (a lost-hit
 *    window, not a double-fire). The boot-replay CONSUMER that re-dispatches
 *    a dangling `pendingEscalation` is STAGED with the main() live-wiring —
 *    it is written + cleared here but not yet read back. Until that lands a
 *    crash in this narrow window drops the hit; documented, not yet closed.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PollStateEntry {
  /** The last-seen cursor (e.g. max contact id), as a string for JSON stability. */
  value: string;
  /** Epoch-ms of the fire that advanced the cursor (audit). */
  escalatedAt?: number;
  /** Set between cursor-advance and dispatch-ack; a crash here re-sends once. */
  pendingEscalation?: string;
}

export interface PollStateStore {
  /** undefined ⟹ first run for this key (record baseline, do not escalate). */
  get(key: string): PollStateEntry | undefined;
  /** Atomically advance the cursor and stage the escalation (write-ahead). */
  writeAhead(key: string, value: string, fireTs: number, diff: string): void;
  /** Record a baseline with no escalation (first run / no-op tracking). */
  setBaseline(key: string, value: string): void;
  /** Clear pendingEscalation once the escalation is dispatched. */
  clearPending(key: string): void;
}

type StateFile = Record<string, PollStateEntry>;

/** File-backed store with atomic (temp+rename) writes. One file per agent. */
export function createFilePollStateStore(path: string): PollStateStore {
  function read(): StateFile {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as StateFile;
    } catch {
      return {};
    }
  }
  function write(state: StateFile): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, path);
  }
  return {
    get(key) {
      return read()[key];
    },
    writeAhead(key, value, fireTs, diff) {
      const state = read();
      state[key] = { value, escalatedAt: fireTs, pendingEscalation: diff };
      write(state);
    },
    setBaseline(key, value) {
      const state = read();
      const prev = state[key];
      state[key] = { value, escalatedAt: prev?.escalatedAt };
      write(state);
    },
    clearPending(key) {
      const state = read();
      const e = state[key];
      if (e?.pendingEscalation !== undefined) {
        delete e.pendingEscalation;
        write(state);
      }
    },
  };
}

/** In-memory store for tests. */
export function createMemoryPollStateStore(seed: StateFile = {}): PollStateStore {
  const state: StateFile = { ...seed };
  return {
    get: (key) => state[key],
    writeAhead: (key, value, fireTs, diff) => {
      state[key] = { value, escalatedAt: fireTs, pendingEscalation: diff };
    },
    setBaseline: (key, value) => {
      state[key] = { value, escalatedAt: state[key]?.escalatedAt };
    },
    clearPending: (key) => {
      if (state[key]?.pendingEscalation !== undefined) delete state[key]!.pendingEscalation;
    },
  };
}
