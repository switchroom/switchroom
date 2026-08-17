/**
 * Tier-1 directive⇄rules EQUIVALENCE check — the deterministic (no-model,
 * no-network) half of the Memory v2 M3 directive-flip UAT gate.
 *
 * Before an agent is flipped (`memory.inject_directives: false`), its
 * always-on directive residue moves into the CLAUDE.md rules block. This
 * module proves — by construction, with no model in the loop — that the
 * migrated rules still carry every guardrail the directives did: nothing
 * dropped, nothing silently truncated, nothing invented.
 *
 * It is PURE and UNIT-TESTABLE:
 *   - the injected side is the directive objects the recall hook actually
 *     cached (`directives_cache.<agent>.json`, schema {id,name,content,
 *     priority}); the caller cross-checks that cache against the live bank
 *     before handing it here (same admin resolution as `resolveDirectiveAdmin`
 *     in `src/cli/memory-directive.ts`).
 *   - the rules side is parsed with {@link parseRulesBlock} from
 *     `src/memory/rules-block.ts` — IMPORTED, never re-implemented, so the
 *     parser this check trusts is byte-for-byte the one the store writes.
 *   - the residue filter reuses {@link RESIDUE_CATEGORIES} from
 *     `src/memory/directive-residue.ts`, so "which directives must have a
 *     rule" is the SAME set the byte-budget harness measures.
 *
 * The equivalence contract (all four must hold for PASS):
 *   (a) every ACTIVE residue directive (categories rules-block +
 *       reflect-directive) appears in `mapping`, mapped to a PRESENT rule id
 *       or an explicit `retired:<reason>`. Unmapped, or mapped to an absent
 *       rule / an empty retirement reason ⇒ `missing_from_rules`.
 *   (b) for each directive→rule pair, the normalized rule text contains every
 *       negation/scope keyword the directive carries (quoted strings, proper
 *       nouns, modals never/always/don't/only/must) and is not truncated ⇒
 *       `truncated_or_drifted`.
 *   (c) the rendered rules block is ≤ 6144 bytes AND the sentinel's rule count
 *       equals the actual rule count.
 *   (d) reverse: no rule lacks a mapping source ⇒ `unsourced_rules`.
 *
 * Empty all three lists AND (c) holding ⇒ PASS.
 */

import {
  parseRulesBlock,
  renderRulesBlock,
  RULES_BLOCK_BUDGET_BYTES,
  type Rule,
  type ParsedRulesBlock,
} from "../../../src/memory/rules-block.js";
import { RESIDUE_CATEGORIES } from "../../../src/memory/directive-residue.js";

/** The injected side: one row of `directives_cache.<agent>.json`. `category`
 *  / `isActive` are optional — when the caller has classified the directive
 *  (via `buildDirectiveTriageRows`) it passes them so this module can filter
 *  to the residue set itself; when absent, the directive is treated as an
 *  active residue directive already (caller pre-filtered). */
export interface FlipDirective {
  id: string;
  name: string;
  content: string;
  priority: number;
  /** One of the E-45 triage categories, when known. */
  category?: string;
  /** Defaults to true when omitted. */
  isActive?: boolean;
}

/**
 * `mapping[directiveId]` is either a rule id (e.g. `R-01`) that must be
 * present in the parsed block, or the literal `retired:<reason>` marking a
 * directive deliberately dropped (with a non-empty reason). A directive id
 * absent from this map is an unmapped guardrail ⇒ FAIL.
 */
export type DirectiveRuleMapping = Record<string, string>;

const RETIRED_PREFIX = "retired:";

export interface MissingEntry {
  id: string;
  name: string;
  /** Why it counts as missing: `unmapped`, `absent-rule`, or `empty-retire-reason`. */
  reason: "unmapped" | "absent-rule" | "empty-retire-reason";
  /** The mapping target, when there was one. */
  mappedTo?: string;
}

export interface DriftEntry {
  id: string;
  name: string;
  ruleId: string;
  /** Directive keywords not found in the rule text. */
  missingKeywords: string[];
  /** True when the rule text looks truncated (ellipsis or strict prefix). */
  truncated: boolean;
}

export interface UnsourcedRule {
  id: string;
  text: string;
}

export interface EquivalenceReport {
  pass: boolean;
  missing_from_rules: MissingEntry[];
  truncated_or_drifted: DriftEntry[];
  unsourced_rules: UnsourcedRule[];
  /** Rendered bytes of the rules block (renderRulesBlock over the parsed set). */
  renderedBytes: number;
  budgetBytes: number;
  withinBudget: boolean;
  /** Sentinel's declared rule count (null when no sentinel line was parsed). */
  sentinelCount: number | null;
  ruleCount: number;
  sentinelMatchesCount: boolean;
  /** How many directives formed the residue obligation set. */
  residueDirectiveCount: number;
}

// ---------------------------------------------------------------------------
// Fixed tokenizer — negation / scope keywords a rule must preserve
// ---------------------------------------------------------------------------

/** Common capitalized sentence-openers / imperatives that are NOT proper
 *  nouns — excluded so the proper-noun scan doesn't demand them of the rule
 *  text. Deliberately small and fixed (deterministic), not a dictionary. */
const PROPER_NOUN_STOPWORDS = new Set(
  [
    "The", "A", "An", "This", "That", "These", "Those", "It", "Its", "If",
    "When", "While", "Do", "Don", "Set", "Use", "Never", "Always", "Only",
    "Must", "Not", "No", "Every", "Each", "Any", "All", "For", "And", "But",
    "Or", "So", "Then", "Prefer", "Avoid", "Ask", "Refuse", "Keep", "Treat",
    "Read", "Write", "Run", "Call", "Send", "Reply", "You", "Your", "We",
    "I", "Before", "After",
  ].map((w) => w),
);

const MODAL_RE = /\b(never|always|only|must)\b/gi;
// NON-global on purpose: used only with `.test()`. A `/g` regex advances its
// `lastIndex` on each `.test()` and, because this constant is module-level and
// reused across calls, that persisted offset would make a later
// `extractKeywords` miss a "don't" at position 0. `.test()` on a non-global
// regex is stateless.
const DONT_RE = /\bdon['’]?t\b/i;
const QUOTE_RES = [/"([^"]+)"/g, /'([^']+)'/g, /`([^`]+)`/g];
const PROPER_NOUN_RE = /\b[A-Z][a-zA-Z0-9_.-]*[a-z][a-zA-Z0-9_.-]*\b/g;

export interface Keyword {
  kind: "quote" | "modal" | "proper";
  /** The token as it should be searched for (already trimmed). */
  value: string;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the fixed keyword set from a directive's content. Deterministic:
 * quoted phrases (verbatim), the modals never/always/don't/only/must, and
 * proper nouns (a capitalized word with at least one interior lowercase,
 * minus a fixed stopword set). Exported for direct unit testing.
 */
export function extractKeywords(content: string): Keyword[] {
  const out: Keyword[] = [];
  const seen = new Set<string>();
  const push = (kind: Keyword["kind"], raw: string) => {
    const value = raw.trim();
    if (value.length === 0) return;
    const key = `${kind}:${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, value });
  };

  for (const re of QUOTE_RES) {
    for (const m of content.matchAll(re)) push("quote", m[1]);
  }
  for (const m of content.matchAll(MODAL_RE)) push("modal", m[1].toLowerCase());
  if (DONT_RE.test(content)) push("modal", "don't");
  for (const m of content.matchAll(PROPER_NOUN_RE)) {
    const w = m[0];
    if (PROPER_NOUN_STOPWORDS.has(w)) continue;
    push("proper", w);
  }
  return out;
}

/** True when `ruleText` (normalized) contains the keyword. Quoted phrases are
 *  substring-matched; single-word modals/proper-nouns are word-boundary
 *  matched so `must` doesn't spuriously satisfy on `mustard`. */
function ruleContainsKeyword(normalizedRuleText: string, kw: Keyword): boolean {
  const needle = normalize(kw.value);
  if (kw.kind === "quote" || /\s/.test(needle)) {
    return normalizedRuleText.includes(needle);
  }
  // don't → the apostrophe is punctuation; match the stem.
  const stem = needle.replace(/['’]/g, "'");
  const re = new RegExp(`(^|[^a-z0-9])${escapeRe(stem)}([^a-z0-9]|$)`);
  return re.test(normalizedRuleText);
}

/** A rule text looks truncated when it ends in an ellipsis, or is a strict
 *  prefix of the directive content (normalized) — i.e. it was cut short. */
function looksTruncated(ruleText: string, directiveContent: string): boolean {
  const t = ruleText.trim();
  if (t.endsWith("…") || t.endsWith("...")) return true;
  const nr = normalize(ruleText);
  const nc = normalize(directiveContent);
  return nr.length > 0 && nc.length > nr.length && nc.startsWith(nr);
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** The active residue subset of the injected directives. When a directive
 *  carries a `category`, it must be a residue category; an explicit
 *  `isActive: false` excludes it. */
export function residueDirectives(directives: readonly FlipDirective[]): FlipDirective[] {
  return directives.filter((d) => {
    if (d.isActive === false) return false;
    if (d.category !== undefined) return RESIDUE_CATEGORIES.has(d.category);
    return true;
  });
}

export function compareDirectivesToRules(
  directives: readonly FlipDirective[],
  parsedRules: ParsedRulesBlock | null,
  mapping: DirectiveRuleMapping,
): EquivalenceReport {
  const rules: Rule[] = parsedRules?.rules ?? [];
  const rulesById = new Map<string, Rule>(rules.map((r) => [r.id, r]));
  const residue = residueDirectives(directives);

  const missing_from_rules: MissingEntry[] = [];
  const truncated_or_drifted: DriftEntry[] = [];
  const sourcedRuleIds = new Set<string>();

  for (const d of residue) {
    const target = mapping[d.id];
    if (target === undefined) {
      missing_from_rules.push({ id: d.id, name: d.name, reason: "unmapped" });
      continue;
    }
    if (target.startsWith(RETIRED_PREFIX)) {
      const reason = target.slice(RETIRED_PREFIX.length).trim();
      if (reason.length === 0) {
        missing_from_rules.push({
          id: d.id,
          name: d.name,
          reason: "empty-retire-reason",
          mappedTo: target,
        });
      }
      // A valid `retired:<reason>` is a satisfied obligation — no rule needed.
      continue;
    }
    const rule = rulesById.get(target);
    if (!rule) {
      missing_from_rules.push({
        id: d.id,
        name: d.name,
        reason: "absent-rule",
        mappedTo: target,
      });
      continue;
    }
    sourcedRuleIds.add(rule.id);

    // (b) drift / truncation.
    const normalizedRuleText = normalize(rule.text);
    const missingKeywords = extractKeywords(d.content)
      .filter((kw) => !ruleContainsKeyword(normalizedRuleText, kw))
      .map((kw) => kw.value);
    const truncated = looksTruncated(rule.text, d.content);
    if (missingKeywords.length > 0 || truncated) {
      truncated_or_drifted.push({
        id: d.id,
        name: d.name,
        ruleId: rule.id,
        missingKeywords,
        truncated,
      });
    }
  }

  // (d) reverse: every rule must have a directive sourcing it.
  const unsourced_rules: UnsourcedRule[] = rules
    .filter((r) => !sourcedRuleIds.has(r.id))
    .map((r) => ({ id: r.id, text: r.text }));

  // (c) budget + sentinel integrity.
  const rendered = renderRulesBlock(rules);
  const renderedBytes = Buffer.byteLength(rendered, "utf8");
  const withinBudget = renderedBytes <= RULES_BLOCK_BUDGET_BYTES;
  const sentinelCount = parsedRules?.sentinel?.count ?? null;
  const ruleCount = rules.length;
  const sentinelMatchesCount = sentinelCount === ruleCount;

  const pass =
    missing_from_rules.length === 0 &&
    truncated_or_drifted.length === 0 &&
    unsourced_rules.length === 0 &&
    withinBudget &&
    sentinelMatchesCount;

  return {
    pass,
    missing_from_rules,
    truncated_or_drifted,
    unsourced_rules,
    renderedBytes,
    budgetBytes: RULES_BLOCK_BUDGET_BYTES,
    withinBudget,
    sentinelCount,
    ruleCount,
    sentinelMatchesCount,
    residueDirectiveCount: residue.length,
  };
}
