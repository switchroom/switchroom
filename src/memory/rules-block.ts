/**
 * rules-block — Memory v2 M1 shared contract (carve-M1.md §1/§3).
 *
 * Pure, IO-free. Owns the marker constants, the rules/index block
 * render+parse round-trip, the canonical serialization the sentinel
 * hashes, and the byte-budget/contradiction helpers. Both M1
 * implementer streams (core-logic + integration-surfaces) build
 * against this file, so its render/parse/hash behaviour is pinned
 * FIRST with a golden vector (`rules-block.test.ts`) before either
 * stream's hash fixtures land — red-team M1 ordering fix (§F): this is
 * the "byte-exact canonical serialization recipe," not just
 * TypeScript signatures.
 *
 * Design constraints this file encodes:
 *  - Rendering is CANONICAL (stable key order, normalized whitespace)
 *    so `computeSentinel` hashes the *canonical rule set*, not raw
 *    block bytes — a `switchroom apply` reflow of the surrounding
 *    Yours section must never false-trip the sentinel (carve §4,
 *    "composeTwoSectionClaudeMd fixed-point vs sentinel").
 *  - The mutation log row shape mirrors `audit-hashchain.ts`'s
 *    `chainRow`/`verifyAuditChain` contract exactly — this file does
 *    not invent chaining, it only defines the domain row that gets
 *    chained (see {@link RuleMutationEntry}).
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

export const RULES_BLOCK_BEGIN = "<!-- switchroom:rules:begin -->";
export const RULES_BLOCK_END = "<!-- switchroom:rules:end -->";
export const INDEX_BLOCK_BEGIN = "<!-- switchroom:index:begin -->";
export const INDEX_BLOCK_END = "<!-- switchroom:index:end -->";

/** Byte budget for the two rendered blocks TOGETHER (carve §3, "Two
 *  different budgets" — this is NOT the whole-`CLAUDE.md` 200-line
 *  doctor guideline, a separate §2.1 concern). */
export const RULES_BLOCK_BUDGET_BYTES = 6144;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** A single sanctioned standing rule living in the rules block. */
export interface Rule {
  /** Stable id, e.g. `R-01`. Assigned by the store, never reused after retire. */
  id: string;
  /** The rule text itself (free-form, one line rendered — newlines stripped). */
  text: string;
  /** Where the rule came from — e.g. `telegram` (a conversational ask) or an
   *  explicit `agent-config` MCP caller name. Free text, not enumerated. */
  source: string;
  /** ISO-8601 UTC creation timestamp. */
  created_at: string;
}

/** A retired rule as it appears in `memory/rules-archive.md` (never loaded). */
export interface ArchivedRule extends Rule {
  status: "retired";
  retired_at: string;
  /** Rule id this retirement was superseded by, if any. */
  superseded_by?: string;
}

/** Mutation-log domain row — the `entry` `chainRow` chains (audit-hashchain.ts
 *  appends `_seq`/`_prev`/`_hash` LAST, so this shape is exactly what
 *  `JSON.stringify`s into the chained line's body). */
export interface RuleMutationEntry {
  id: string;
  action: "create" | "retire" | "edit-yours";
  actor: string;
  source: string;
  ts: string;
  /** sha256 of the canonical rule-set serialization AFTER this mutation. */
  blockHash: string;
  [key: string]: unknown;
}

export interface RulesSentinel {
  hash: string;
  count: number;
}

export interface ParsedRulesBlock {
  rules: Rule[];
  sentinel: RulesSentinel | null;
}

export interface ParsedIndexBlock {
  models: string[];
}

// ---------------------------------------------------------------------------
// Canonical serialization + sentinel
// ---------------------------------------------------------------------------

/**
 * Canonical JSON serialization of a rule set: sorted by `id`, fixed key
 * order per rule (`id`, `text`, `source`, `created_at`), no incidental
 * whitespace. This — not the rendered markdown bytes — is what
 * {@link computeSentinel} hashes, so a whitespace-only reflow of the
 * surrounding file can never change the hash.
 */
export function canonicalizeRules(rules: Rule[]): string {
  const sorted = [...rules].sort((a, b) => a.id.localeCompare(b.id));
  const shaped = sorted.map((r) => ({
    id: r.id,
    text: r.text,
    source: r.source,
    created_at: r.created_at,
  }));
  return JSON.stringify(shaped);
}

/** sha256 hex + count over the canonical rule-set serialization. */
export function computeSentinel(rules: Rule[]): RulesSentinel {
  const canonical = canonicalizeRules(rules);
  const hash = createHash("sha256").update(canonical).digest("hex");
  return { hash, count: rules.length };
}

/** The literal sentinel comment line embedded as the rules block's last line. */
export function renderSentinelLine(sentinel: RulesSentinel): string {
  return `<!-- switchroom:rules:sentinel sha256=${sentinel.hash} rules=${sentinel.count} -->`;
}

const SENTINEL_LINE_RE =
  /^<!-- switchroom:rules:sentinel sha256=([0-9a-f]{64}) rules=(\d+) -->$/;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One rule line, canonical shape: `- **R-01** (source: telegram, added
 *  2026-08-17T00:00:00.000Z): <text>`. Escapes stray newlines in `text`
 *  (a rule is always a single rendered line). */
function renderRuleLine(r: Rule): string {
  const flat = r.text.replace(/\s+/g, " ").trim();
  return `- **${r.id}** (source: ${r.source}, added ${r.created_at}): ${flat}`;
}

/**
 * Render the full rules block, markers included. Rules are rendered in
 * `id` sort order (canonical — matches {@link canonicalizeRules}) so the
 * rendered bytes are a deterministic function of the rule set.
 */
export function renderRulesBlock(rules: Rule[]): string {
  const sorted = [...rules].sort((a, b) => a.id.localeCompare(b.id));
  const lines = [
    RULES_BLOCK_BEGIN,
    "Standing rules — sanctioned via the `memory rule` tool. Do not hand-edit;",
    "edits made outside the tool break the tamper sentinel below.",
    "",
    ...(sorted.length > 0 ? sorted.map(renderRuleLine) : ["(none)"]),
    "",
    renderSentinelLine(computeSentinel(sorted)),
    RULES_BLOCK_END,
  ];
  return lines.join("\n");
}

/**
 * Parse a rules block out of arbitrary surrounding text. Returns `null`
 * if the markers are absent (the M1 "dark" no-op case). A present block
 * with no rule lines parses to `{ rules: [], sentinel }`.
 */
export function parseRulesBlock(text: string): ParsedRulesBlock | null {
  const begin = text.indexOf(RULES_BLOCK_BEGIN);
  const end = text.indexOf(RULES_BLOCK_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  const body = text.slice(begin + RULES_BLOCK_BEGIN.length, end);
  const lines = body.split("\n").map((l) => l.trim());
  const rules: Rule[] = [];
  let sentinel: RulesSentinel | null = null;
  const ruleLineRe =
    /^- \*\*([^*]+)\*\* \(source: ([^,]+), added ([^)]+)\): (.*)$/;
  for (const line of lines) {
    if (line.length === 0) continue;
    const sentinelMatch = SENTINEL_LINE_RE.exec(line);
    if (sentinelMatch) {
      sentinel = { hash: sentinelMatch[1], count: Number(sentinelMatch[2]) };
      continue;
    }
    const m = ruleLineRe.exec(line);
    if (m) {
      rules.push({ id: m[1], source: m[2], created_at: m[3], text: m[4] });
    }
  }
  return { rules, sentinel };
}

/** Render the index block: one line per mental-model name, sorted. */
export function renderIndexBlock(modelNames: string[]): string {
  const sorted = [...modelNames].sort();
  const lines = [
    INDEX_BLOCK_BEGIN,
    "Knowledge index — mirrors this bank's mental models (regenerated on " +
      "sanctioned model writes; doctor diffs it daily against the engine).",
    "",
    ...(sorted.length > 0 ? sorted.map((m) => `- ${m}`) : ["(none)"]),
    INDEX_BLOCK_END,
  ];
  return lines.join("\n");
}

/** Parse an index block; `null` if markers absent. */
export function parseIndexBlock(text: string): ParsedIndexBlock | null {
  const begin = text.indexOf(INDEX_BLOCK_BEGIN);
  const end = text.indexOf(INDEX_BLOCK_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  const body = text.slice(begin + INDEX_BLOCK_BEGIN.length, end);
  const models = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
  return { models };
}

// ---------------------------------------------------------------------------
// Generic marker-block upsert (shared by both block kinds)
// ---------------------------------------------------------------------------

/**
 * Replace the marker-delimited span `[begin..end]` (inclusive) inside
 * `text` with `renderedBlock` (which must itself start with `begin` and
 * end with `end`). If the markers are absent, APPEND the block (with a
 * blank-line separator) — the first-write case. Byte-exact: does not
 * touch anything outside the span (or, on append, anything at all
 * before the appended block).
 */
export function upsertMarkerBlock(
  text: string,
  begin: string,
  end: string,
  renderedBlock: string,
): string {
  const b = text.indexOf(begin);
  const e = text.indexOf(end);
  if (b === -1 || e === -1 || e < b) {
    const sep = text.trimEnd().length > 0 ? "\n\n" : "";
    return `${text.trimEnd()}${sep}${renderedBlock}\n`.replace(/^\n+/, (m) =>
      text.trimEnd().length > 0 ? m : "",
    );
  }
  const before = text.slice(0, b);
  const after = text.slice(e + end.length);
  return `${before}${renderedBlock}${after}`;
}

/** Remove a marker-delimited span entirely (including one adjacent blank
 *  line on each side, best-effort). No-op if markers absent. */
export function stripMarkerBlock(text: string, begin: string, end: string): string {
  const b = text.indexOf(begin);
  const e = text.indexOf(end);
  if (b === -1 || e === -1 || e < b) return text;
  const before = text.slice(0, b).replace(/\n{1,2}$/, "");
  const after = text.slice(e + end.length).replace(/^\n{1,2}/, "");
  const sep = before.length > 0 && after.length > 0 ? "\n\n" : "";
  return `${before}${sep}${after}`;
}

// ---------------------------------------------------------------------------
// Byte budget
// ---------------------------------------------------------------------------

/** UTF-8 byte length of the two rendered blocks TOGETHER. */
export function renderedByteLen(rulesBlock: string, indexBlock: string): number {
  return Buffer.byteLength(rulesBlock, "utf8") + Buffer.byteLength(indexBlock, "utf8");
}

// ---------------------------------------------------------------------------
// Contradiction check (structural — OQ1 scoping adopted from carve-M1.md)
// ---------------------------------------------------------------------------

export interface ContradictionResult {
  /** True only for an EXACT (normalized) duplicate of an existing active rule. */
  duplicateOf?: string;
}

/**
 * Structural contradiction check (OQ1): deterministic semantic
 * contradiction is not achievable here, so this ships exact-duplicate
 * detection only — a normalized (whitespace-collapsed, case-folded)
 * text match against the active set. An explicit `supersedes` argument
 * is honored by the STORE (it retires the named rule as part of the
 * same mutation), not by this pure check. Anything short of an exact
 * duplicate is surfaced to the user as a possible-conflict prompt by
 * the caller — this function never auto-blocks on a soft signal.
 */
export function checkContradiction(
  newRuleText: string,
  active: Rule[],
): ContradictionResult {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const target = norm(newRuleText);
  const dup = active.find((r) => norm(r.text) === target);
  return dup ? { duplicateOf: dup.id } : {};
}
