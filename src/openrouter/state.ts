/**
 * Durable state for the OpenRouter credit watch: the re-notify ledger.
 *
 * Lives at `~/.switchroom/openrouter-watch/state.json` (tmp+rename, 0600),
 * matching `src/hindsight-watch/state.ts`. Two properties, both deliberate:
 *
 *  - A torn / absent / garbage file degrades to an EMPTY ledger, never a
 *    throw. The worst consequence of an empty ledger is ONE extra operator
 *    DM about a shortfall that is genuinely still firing — strictly better
 *    than a crashed cron, and it fails toward telling the operator rather
 *    than toward silence.
 *  - A write failure is NOT swallowed: `saveState` throws and the caller
 *    exits 1. A watchdog that cannot persist its ledger would re-fire the
 *    same alert every single hour, which trains the operator to mute it.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { CreditWatchState } from "./watch.js";

interface Persisted extends CreditWatchState {
  v: 1;
}

/** Default state-file path, honouring `SWITCHROOM_HOME` like the rest of the CLI. */
export function defaultStatePath(
  home: string = process.env.SWITCHROOM_HOME ?? process.env.HOME ?? homedir(),
): string {
  return resolve(home, ".switchroom", "openrouter-watch", "state.json");
}

/** Read the ledger, degrading to empty on absent/torn/foreign-version files. */
export function loadState(path: string): CreditWatchState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const s = parsed as Partial<Persisted>;
  if (s.v !== 1) return {};
  const out: CreditWatchState = {};
  if (typeof s.lastNotifiedAt === "number" && Number.isFinite(s.lastNotifiedAt)) {
    out.lastNotifiedAt = s.lastNotifiedAt;
  }
  if (typeof s.lastNotifiedStatus === "string") out.lastNotifiedStatus = s.lastNotifiedStatus;
  // A ledger with a status but no timestamp cannot express a cooldown, and
  // `decideNotification` would treat it as "never notified" anyway. Normalise
  // it away rather than persisting a shape that means nothing.
  if (out.lastNotifiedAt === undefined) delete out.lastNotifiedStatus;
  return out;
}

/** Atomic write. Throws on failure — the caller must exit loudly. */
export function saveState(path: string, state: CreditWatchState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const payload: Persisted = { v: 1, ...state };
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
