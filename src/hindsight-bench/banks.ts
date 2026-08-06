/**
 * Bank selection for the size axis.
 *
 * The fleet's real banks span four orders of magnitude (228,761 rows down to
 * 12, measured live 2026-08-07), so *which* banks a sweep picks decides whether
 * the curve says anything. Picking the top N measures one decade and calls it a
 * size sweep.
 */

/** A bank and its `memory_units` row count. */
export interface BankRows {
  bank: string;
  rows: number;
}

export class BankSelectionError extends Error {}

/**
 * Resolve a `--banks` spec against the live bank list.
 *
 * Accepted forms:
 *  - `all`         — every bank with at least one row, largest first.
 *  - `top:<n>`     — the n largest.
 *  - `spread:<n>`  — n banks spread evenly in **log(rows)** space, always
 *                    including the largest and smallest. This is the default
 *                    because it is the only one of the three that samples the
 *                    real distribution rather than one end of it.
 *  - a comma list  — exactly those banks, in the order given.
 *
 * Banks with 0 rows are excluded from `all`/`top`/`spread` (there is no size
 * point to plot) but an explicit comma list is honoured as written — an
 * operator naming an empty bank is asking a deliberate question.
 */
export function selectBanks(available: readonly BankRows[], spec: string): string[] {
  const nonEmpty = available.filter((b) => b.rows > 0).sort((a, b) => b.rows - a.rows);
  const trimmed = spec.trim();

  if (trimmed === "all") return nonEmpty.map((b) => b.bank);

  const top = /^top:(\d+)$/.exec(trimmed);
  if (top !== null) return nonEmpty.slice(0, Math.max(1, Number(top[1]))).map((b) => b.bank);

  const spread = /^spread:(\d+)$/.exec(trimmed);
  if (spread !== null) {
    const n = Math.max(1, Number(spread[1]));
    if (nonEmpty.length <= n) return nonEmpty.map((b) => b.bank);
    // Walk evenly in log space between the smallest and largest bank, taking
    // the nearest not-yet-chosen bank at each target. Ascending, then reported
    // largest-first so it reads like the other specs.
    const asc = [...nonEmpty].sort((a, b) => a.rows - b.rows);
    const lo = Math.log10((asc[0] as BankRows).rows);
    const hi = Math.log10((asc[asc.length - 1] as BankRows).rows);
    const chosen = new Set<string>();
    for (let i = 0; i < n; i++) {
      const target = lo + ((hi - lo) * i) / (n - 1);
      let best: BankRows | null = null;
      let bestD = Infinity;
      for (const b of asc) {
        if (chosen.has(b.bank)) continue;
        const d = Math.abs(Math.log10(b.rows) - target);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      if (best !== null) chosen.add(best.bank);
    }
    return nonEmpty.filter((b) => chosen.has(b.bank)).map((b) => b.bank);
  }

  const named = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (named.length === 0) throw new BankSelectionError(`--banks "${spec}" selected nothing`);
  const known = new Set(available.map((b) => b.bank));
  const missing = named.filter((n) => !known.has(n));
  if (missing.length > 0) {
    throw new BankSelectionError(
      `--banks names ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not in this instance ` +
        `(known: ${available.map((b) => b.bank).join(", ")})`,
    );
  }
  return named;
}

/** Parse `1,4,8,16` into ascending, deduplicated, positive integers. */
export function parseConcurrency(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < 1) {
      throw new BankSelectionError(`--concurrency "${spec}": "${part.trim()}" is not a positive integer`);
    }
    out.add(n);
  }
  if (out.size === 0) throw new BankSelectionError("--concurrency selected nothing");
  return [...out].sort((a, b) => a - b);
}
