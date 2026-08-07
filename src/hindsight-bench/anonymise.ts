/**
 * Bank-name anonymisation for persisted bench result files (#4499).
 *
 * A `BenchResult` is captured against the operator's LIVE Hindsight instance,
 * so every bank-bearing field in it carries a real bank id — which is to say
 * the operator's private fleet roster, including per-person profile banks. The
 * result files are then committed to a PUBLIC repo as regression baselines.
 * PR #4495 did exactly that and published fourteen bank names with their row
 * counts before anyone noticed.
 *
 * The fix is deterministic and lives at CAPTURE time rather than in review
 * discipline: nothing writes a `BenchResult` to disk without passing through
 * `anonymiseResult` first, so an identifying name cannot reach a file destined
 * for the repo even if the operator forgets. The terminal summary still prints
 * real names — it is not a file and it is not committed.
 *
 * ## Why ordinals by row count, not a hash
 *
 * The pseudonym must satisfy three things at once:
 *
 *  - **Non-reversible.** Bank names are short, guessable and already appear in
 *    this repo as documentation examples, so an unsalted hash of a name would
 *    be confirmable by dictionary in seconds. A salted hash would need the salt
 *    persisted somewhere, which is a mapping file by another name.
 *  - **Stable across runs.** `--contention-compare` and the AC1 repeat check
 *    join two result files on `(bank, concurrency)`. A pseudonym that changed
 *    between runs would silently turn every cell into `unmatched`.
 *  - **Order-preserving.** The benchmark's entire x-axis is bank size, and the
 *    narrative reads "bank size is not the dominant axis". A pseudonym that
 *    scrambled the size ordering would destroy the artefact's only reason to
 *    exist.
 *
 * Rank in `db.bankRows` (descending by rows, as the snapshot query emits it)
 * satisfies all three: `bank-01` is always the largest bank, the mapping is
 * reproducible from the file itself, and the name is unrecoverable from it.
 * Row counts are deliberately PRESERVED — they are the measurement, and a
 * size histogram without names is not a roster.
 *
 * The mapping is returned so a caller can show the operator which pseudonym is
 * which. It must never be written beside the result file.
 */

import type { BenchResult } from "./types.js";

/** Shape of a pseudonym: two-or-more digits so `bank-10` sorts after `bank-09`. */
export const PSEUDONYM_RE = /^bank-\d{2,}$/;

/** Render rank `n` (1-based) as a zero-padded pseudonym. */
function pseudonym(n: number, width: number): string {
  return `bank-${String(n).padStart(width, "0")}`;
}

/**
 * Build the real-name → pseudonym map for one result.
 *
 * `db.bankRows` is the authority because it is the full, size-ordered census of
 * the instance. Banks that appear in `config.banks`, `cells` or `arms` without
 * a `bankRows` entry are still mapped — appended in first-seen order after the
 * census — so a partial or hand-edited file cannot leak a name through a gap.
 */
export function buildBankMap(result: BenchResult): Map<string, string> {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (b: string): void => {
    if (b !== "" && !seen.has(b)) {
      seen.add(b);
      ordered.push(b);
    }
  };

  for (const r of result.db?.bankRows ?? []) push(r.bank);
  for (const b of result.config?.banks ?? []) push(b);
  for (const c of result.cells ?? []) push(c.bank);
  for (const a of result.arms ?? []) push(a.bank);

  const width = Math.max(2, String(ordered.length).length);
  const map = new Map<string, string>();
  ordered.forEach((bank, i) => map.set(bank, pseudonym(i + 1, width)));
  return map;
}

/** A result with every bank-bearing field pseudonymised, plus the map used. */
export interface AnonymisedResult {
  result: BenchResult;
  /** real bank id → pseudonym. Show it to the operator; never persist it. */
  mapping: Map<string, string>;
}

/**
 * Return a deep-ish copy of `result` with every bank identifier replaced.
 *
 * Fields rewritten: `config.banks[]`, `db.bankRows[].bank`, `cells[].bank`,
 * `arms[].bank`. Everything else — row counts, latencies, index names, server
 * version — is carried through untouched, because none of it names a bank and
 * all of it is load-bearing for the measurement.
 *
 * `config.label` is operator free text and is NOT rewritten: there is no way to
 * find a bank name inside arbitrary prose without a name list, and having one
 * would defeat the purpose. The repo-side lint gate is what catches a name that
 * gets typed into a label or a narrative.
 *
 * Idempotent: re-running over already-anonymised input is a no-op, because
 * `bank-01`… map to themselves under the same rank ordering.
 */
export function anonymiseResult(result: BenchResult): AnonymisedResult {
  const mapping = buildBankMap(result);
  const sub = (b: string): string => mapping.get(b) ?? b;

  return {
    mapping,
    result: {
      ...result,
      config: { ...result.config, banks: (result.config?.banks ?? []).map(sub) },
      db: {
        ...result.db,
        bankRows: (result.db?.bankRows ?? []).map((r) => ({ ...r, bank: sub(r.bank) })),
      },
      cells: (result.cells ?? []).map((c) => ({ ...c, bank: sub(c.bank) })),
      arms: result.arms === null ? null : result.arms.map((a) => ({ ...a, bank: sub(a.bank) })),
    },
  };
}

/** One `real → pseudonym` line per bank, for the operator's terminal only. */
export function formatBankMapping(mapping: ReadonlyMap<string, string>): string {
  return [...mapping.entries()].map(([real, pseudo]) => `  ${pseudo}  ${real}`).join("\n");
}
