#!/usr/bin/env node
/**
 * check-bench-baseline-anonymised
 *
 * Second-layer gate for the #4499 leak: committed `hindsight-bench` baselines
 * may only name banks by pseudonym.
 *
 * ── What happened ───────────────────────────────────────────────────────
 *
 * PR #4495 committed raw bench artefacts to this PUBLIC repo. Every result
 * file is captured against the operator's LIVE Hindsight, so `config.banks`,
 * `db.bankRows[].bank`, `cells[].bank` and `arms[].bank` carried real bank
 * ids — publishing the operator's private fleet roster, personal profile banks
 * included, with a row count beside each one. `check-no-pii-secrets` passed
 * clean on it: that gate blocks a KNOWN list of scrubbed identifiers, and a
 * bank name that has never been scrubbed before is not on it. A blocklist
 * cannot catch the next agent that gets added to the fleet.
 *
 * ── The real fix, and why this exists anyway ────────────────────────────
 *
 * The durable fix is at CAPTURE time: `src/hindsight-bench/anonymise.ts` runs
 * on every `BenchResult` before it is written to disk, so the CLI cannot emit
 * a file containing a real bank id. That closes the path these artefacts came
 * down. This gate is the second layer, for the paths it does not own — a file
 * hand-edited after capture, an artefact produced by an older build, a number
 * typed into the narrative by hand.
 *
 * ── The rules ───────────────────────────────────────────────────────────
 *
 * STRUCTURAL (machine-written artefacts, `docs/baselines/**` .json/.csv):
 *   every bank-bearing field must match /^bank-\d{2,}$/. This is a WHITELIST
 *   of shape, not a blocklist of names, so it fails on a bank id nobody has
 *   seen before — which is the property `check-no-pii-secrets` lacks.
 *
 * SHAPE (prose, `docs/baselines/** /*.md` + `docs/hindsight-bench*.md`): the
 *   three forms a bank is actually cited in are gated —
 *     `<token>`@c<N>              a per-cell citation
 *     `<token>` (<12,345> rows)   a roster listing
 *     any cell under a `bank` column in a markdown table
 *   These are deterministic and need no vocabulary list. They do NOT claim to
 *   catch an arbitrary bare mention in a sentence; the capture-time
 *   anonymiser is what makes that case not arise, and in practice a document
 *   that names a bank at all also cites one of these three shapes.
 *
 * Run: `npm run lint:bench-baseline-anonymised` (also part of `npm run lint`).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The only legal bank identifier in a committed artefact. */
export const PSEUDONYM_RE = /^bank-\d{2,}$/;

const BASELINE_DIR = "docs/baselines";
/** Narrative docs that quote the baselines. Missing files are skipped. */
const PROSE_FILES = ["docs/hindsight-bench-baseline.md", "docs/hindsight-bench.md"];

/** This script documents the shapes it forbids; never scan it. */
const SELF = "scripts/check-bench-baseline-anonymised.mjs";

function walk(dir) {
  const abs = join(repoRoot, dir);
  let entries;
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const p = join(abs, e);
    if (statSync(p).isDirectory()) out.push(...walk(relative(repoRoot, p)));
    else out.push(relative(repoRoot, p));
  }
  return out;
}

/** Collect every bank-bearing value in a parsed BenchResult-shaped object. */
export function bankFields(doc) {
  const found = [];
  const push = (field, value) => {
    if (typeof value === "string") found.push({ field, value });
  };
  for (const b of doc?.config?.banks ?? []) push("config.banks[]", b);
  for (const r of doc?.db?.bankRows ?? []) push("db.bankRows[].bank", r?.bank);
  for (const c of doc?.cells ?? []) push("cells[].bank", c?.bank);
  for (const a of doc?.arms ?? []) push("arms[].bank", a?.bank);
  return found;
}

/** Violations in one JSON artefact. */
export function checkJson(relPath, text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return [{ file: relPath, detail: `is not parseable JSON: ${e.message}` }];
  }
  // Only BenchResult-shaped files are in scope; anything else under
  // docs/baselines/ belongs to a different harness and is left alone.
  if (doc?.cells === undefined || doc?.config === undefined) return [];
  return bankFields(doc)
    .filter(({ value }) => !PSEUDONYM_RE.test(value))
    .map(({ field, value }) => ({
      file: relPath,
      detail: `${field} = ${JSON.stringify(value)} is not a bank-NN pseudonym`,
    }));
}

/** Violations in one CSV artefact (any file with a `bank` column). */
export function checkCsv(relPath, text) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = header.indexOf("bank");
  if (idx === -1) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    // The bank column carries a bare identifier — no commas, no quoting — so
    // a naive split is exact here and a CSV parser would add no fidelity.
    const value = (lines[i].split(",")[idx] ?? "").trim();
    if (value !== "" && !PSEUDONYM_RE.test(value)) {
      out.push({ file: relPath, detail: `line ${i + 1}: bank column = "${value}" is not a bank-NN pseudonym` });
    }
  }
  return out;
}

/**
 * Free-text citation shapes, each capturing the bank token in group 1.
 *
 * Both are unambiguous: a token suffixed `@c<N>` is a bench CELL reference and
 * a token followed by a parenthesised three-plus-digit count is a roster
 * listing. Neither occurs in this corpus around anything but a bank.
 */
const PROSE_SHAPES = [
  { id: "per-cell citation `bank`@cN", re: /`([^`\n]+?)`@c\d+/g },
  { id: "roster listing `bank` (N rows)", re: /`([^`\n]+?)`\s*\([\d,]{3,}(?:\s*rows)?\)/g },
];

/** Split a markdown cell row into trimmed cell texts. */
function cells(line) {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * Bank identifiers cited in a markdown table.
 *
 * Column-scoped rather than shape-scoped: a table row is only checked when its
 * own header row declares a `bank` column. Matching "backticked token beside a
 * number" instead would flag every config table in the corpus
 * (`| \`shared_buffers\` | 6144 MB |`), and a gate that cries wolf gets
 * disabled.
 */
export function checkTables(relPath, text) {
  const out = [];
  const lines = text.split("\n");
  let col = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trimStart().startsWith("|")) {
      col = -1;
      continue;
    }
    const c = cells(line);
    if (col === -1) {
      // Candidate header: the NEXT line must be the `|---|` separator.
      const next = lines[i + 1] ?? "";
      if (/^\s*\|[\s:|-]+\|\s*$/.test(next)) col = c.indexOf("bank");
      continue;
    }
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
    const value = (c[col] ?? "").replace(/`/g, "").trim();
    if (value !== "" && !PSEUDONYM_RE.test(value)) {
      out.push({
        file: relPath,
        detail: `line ${i + 1}: bank column = "${value}" is not a bank-NN pseudonym`,
      });
    }
  }
  return out;
}

/** Violations in one markdown file. */
export function checkProse(relPath, text) {
  const out = [];
  for (const { id, re } of PROSE_SHAPES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const token = m[1];
      // `@cN` citations may carry the suffix inside the backticks.
      const bare = token.replace(/@c\d+$/, "");
      if (!PSEUDONYM_RE.test(bare)) {
        out.push({ file: relPath, detail: `${id}: \`${token}\` is not a bank-NN pseudonym` });
      }
    }
  }
  out.push(...checkTables(relPath, text));
  return out;
}

export function collectViolations() {
  const violations = [];
  for (const rel of walk(BASELINE_DIR)) {
    if (rel === SELF) continue;
    const text = readFileSync(join(repoRoot, rel), "utf8");
    if (rel.endsWith(".json")) violations.push(...checkJson(rel, text));
    else if (rel.endsWith(".csv")) violations.push(...checkCsv(rel, text));
    else if (rel.endsWith(".md")) violations.push(...checkProse(rel, text));
  }
  for (const rel of PROSE_FILES) {
    let text;
    try {
      text = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    violations.push(...checkProse(rel, text));
  }
  return violations;
}

// Run as a script, not when imported by the test suite.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const violations = collectViolations();
  if (violations.length > 0) {
    console.error("check-bench-baseline-anonymised: real bank identifiers in committed baselines\n");
    for (const v of violations) console.error(`  ${v.file}: ${v.detail}`);
    console.error(
      "\nCommitted hindsight-bench baselines must name banks as bank-01, bank-02, … — " +
        "a real bank id publishes the operator's private fleet roster (#4499).\n" +
        "Re-capture with a current build: src/hindsight-bench/anonymise.ts pseudonymises\n" +
        "every result file at write time. Do not hand-edit a name back in.",
    );
    process.exit(1);
  }
  console.log("check-bench-baseline-anonymised: ok");
}
