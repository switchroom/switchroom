/**
 * Shared read side for the gateway's small JSON state stores
 * (`pending-card-store.ts`, `scoped-grant-store.ts`,
 * `missed-approvals-store.ts`, `always-allow-persist-queue.ts`).
 *
 * Problem: each of those stores read its backing file with a bare
 * `try { JSON.parse(readFileSync(...)) } catch { return [] }`. Combined
 * with a non-atomic `writeFileSync` straight over the destination (fixed
 * separately — every writer now goes through `atomicWriteFileSync`), a
 * crash between truncate and write left a TORN file. On the next boot the
 * parse threw, the catch swallowed it, and the store came up EMPTY: every
 * pending approval card and every live scoped grant silently forgotten,
 * with nothing in the logs. The operator just saw dead buttons.
 *
 * Losing security state must be OBSERVABLE. So a parse failure here is
 * never silent:
 *   - the corrupt bytes are preserved by renaming them aside to
 *     `<file>.corrupt-<epoch-ms>` (never deleted — they're the forensic
 *     record of what was lost, and the only chance of manual recovery);
 *   - a loud `telegram gateway: <store> CORRUPT …` line goes to stderr,
 *     the same channel the surrounding stores already log write failures
 *     on (the gateway's stderr is captured in the agent's runtime log);
 *   - the caller gets `undefined` and starts from an empty store — the
 *     process still boots, it just no longer does so in silence.
 *
 * Quarantine fires ONLY for corrupt CONTENT (unparseable JSON, or a shape
 * the store rejects). A missing file is the normal cold-start case and is
 * silent. Any other fs error (EACCES, EIO, …) is logged loudly but does
 * NOT quarantine — renaming a file we merely failed to read would destroy
 * good state over a transient fault.
 */

import { readFileSync, renameSync } from 'node:fs'

/** Default sink — matches the stores' existing `process.stderr.write` use. */
const defaultLog = (line: string): void => {
  process.stderr.write(line)
}

/**
 * Move a corrupt/unusable store file aside so its bytes survive, and log
 * loudly. Exported for stores whose corruption is a SHAPE failure (valid
 * JSON, wrong structure) that only the store itself can detect.
 */
export function quarantineCorruptStoreFile(
  filePath: string,
  store: string,
  reason: string,
  log: (line: string) => void = defaultLog,
): void {
  const quarantined = `${filePath}.corrupt-${Date.now()}`
  let preserved = quarantined
  try {
    renameSync(filePath, quarantined)
  } catch (err) {
    preserved = `NOT preserved (${(err as Error).message})`
  }
  log(
    `telegram gateway: ${store} CORRUPT — ${reason}. ` +
      `Persisted state was LOST and the store is starting EMPTY; ` +
      `corrupt file ${preserved}\n`,
  )
}

/**
 * Read + parse a store's backing JSON file.
 *
 * Returns `undefined` when there is nothing usable to load — the caller
 * substitutes its own empty value. Distinguishes the three cases above:
 * missing (silent), corrupt (quarantine + loud), unreadable (loud only).
 */
export function readStoreJsonSync(
  filePath: string,
  store: string,
  log: (line: string) => void = defaultLog,
): unknown {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    log(
      `telegram gateway: ${store} read FAILED path=${filePath}: ` +
        `${(err as Error).message} — starting EMPTY for this read\n`,
    )
    return undefined
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    quarantineCorruptStoreFile(
      filePath,
      store,
      `unparseable JSON (${(err as Error).message}) — likely a torn write from a crash mid-persist`,
      log,
    )
    return undefined
  }
}
