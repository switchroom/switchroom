/**
 * Residue-measurement harness — Memory v2 M2 (carve-M2.md T4, §4d; UAT-5).
 *
 * M2's real downstream deliverable is a NUMBER, not a mutation: the rendered
 * token size of the always-on residue a bank will keep injecting into every
 * `reflect` after triage — the `reflect-directive` rows (genuine guardrails
 * that stay active) plus the `rules-block` rows (staged for M3, but still
 * ACTIVE and still injected until that agent's flip — Decision 3). That
 * number is what sets M3's Surface-A rules budget (design-v2.md §8.6):
 * triage first, cap after.
 *
 * The per-directive rendered line mirrors
 * `vendor/hindsight-memory/scripts/lib/directives.py`
 * `format_active_directives_block`'s exact line shape
 * (`"{i}. [P{priority}] {name}: {content}"`) so the estimate reflects what
 * actually gets injected, not an arbitrary summary. Token estimation reuses
 * `estimateTokens` from `src/cli/debug.ts` — the fleet's one standing
 * bytes→tokens ratio (~3.7 chars/token, ±~15%) — rather than inventing a
 * second, divergent estimator.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { estimateTokens } from "../cli/debug.js";
import type { DirectiveTriageRow } from "./directive-triage.js";
import type { HindsightDirective } from "./hindsight-directive-admin.js";

/** Categories counted into the always-on residue (design-v2.md §8.6). */
const RESIDUE_CATEGORIES = new Set(["rules-block", "reflect-directive"]);

export interface DirectiveResidueMeasurement {
  agent: string;
  /** Rows counted into the residue (rules-block + reflect-directive). */
  residueDirectiveCount: number;
  /** Total rows on the card, for context (not part of the residue itself). */
  totalDirectiveCount: number;
  residueBytes: number;
  residueTokensEstimate: number;
}

/**
 * Render the exact line `format_active_directives_block` would emit for one
 * directive, so the byte count this harness measures matches what the recall
 * hook actually injects.
 */
function renderInjectedLine(index: number, directive: HindsightDirective): string {
  const priority = directive.priority ?? 0;
  const name = (directive.name ?? "").trim() || "(unnamed)";
  const content = (directive.content ?? "").trim();
  return `${index}. [P${priority}] ${name}: ${content}`;
}

/**
 * Measure one agent's post-triage residue.
 *
 * `directivesByName` supplies the full `content` text (triage rows don't
 * carry it — the card generator deliberately works off the lighter
 * `HindsightDirective` shape) so the estimate is computed against real
 * rendered bytes, not a row-count proxy.
 */
export function measureDirectiveResidue(
  agent: string,
  rows: readonly DirectiveTriageRow[],
  directivesByName: ReadonlyMap<string, HindsightDirective>,
): DirectiveResidueMeasurement {
  const residueRows = rows.filter((r) => RESIDUE_CATEGORIES.has(r.category));

  const lines = residueRows.map((row, i) => {
    const directive = directivesByName.get(row.name);
    if (!directive) {
      throw new Error(
        `measureDirectiveResidue: row '${row.name}' has no matching directive ` +
          "in directivesByName — pass the SAME list the rows were built from.",
      );
    }
    return renderInjectedLine(i + 1, directive);
  });

  const residueBytes = lines.reduce(
    (sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, // +1 newline
    0,
  );

  return {
    agent,
    residueDirectiveCount: residueRows.length,
    totalDirectiveCount: rows.length,
    residueBytes,
    residueTokensEstimate: estimateTokens(residueBytes),
  };
}

/**
 * Append one agent's measurement to the durable artifact (`m2-residue.md`).
 * Creates the file (and its directory) with a header on first write for that
 * path. Idempotent-append: re-running for the same agent adds a new row
 * rather than overwriting, so the artifact is also a measurement history.
 */
export function writeDirectiveResidueArtifact(
  path: string,
  measurement: DirectiveResidueMeasurement,
): void {
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(path)) {
    appendFileSync(
      path,
      "# M2 residue measurement\n\n" +
        "Rendered token size of the always-on directive residue " +
        "(`rules-block` + `reflect-directive` rows) per agent, post-triage. " +
        "Sets M3's Surface-A rules budget (design-v2.md §8.6).\n\n" +
        "| agent | residue directives | total directives | residue bytes | residue tokens (est.) |\n" +
        "|---|---|---|---|---|\n",
      "utf8",
    );
  }
  appendFileSync(
    path,
    `| ${measurement.agent} | ${measurement.residueDirectiveCount} | ` +
      `${measurement.totalDirectiveCount} | ${measurement.residueBytes} | ` +
      `${measurement.residueTokensEstimate} |\n`,
    "utf8",
  );
}
