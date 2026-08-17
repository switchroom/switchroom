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
 *   (b) for each directive→rule pair, the normalized rule text preserves every
 *       GUARDRAIL the directive carries — its polarity/scope modals (matched by
 *       synonym class, so "don't"≡"NEVER" and "only"≡"sole"), its load-bearing
 *       facts (ALL-CAPS names, case/instrument codes), and any required-verbatim
 *       quoted line — and is not truncated ⇒ `truncated_or_drifted`. ILLUSTRATIVE
 *       tokens (sample toasts/commands the directive quoted as examples, incidental
 *       prose proper nouns) are NOT demanded; requiring them verbatim in a ~400B
 *       rule condensed from a ~10KB directive is a condensation artifact, not a
 *       dropped guardrail. See the tokenizer section for the exact class split.
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
// Calibrated tokenizer — GUARDRAIL vs ILLUSTRATIVE keyword classes
// ---------------------------------------------------------------------------
//
// M2→M3 triage condenses a ~10KB verbose directive into a ~400B rule. The old
// tokenizer demanded every quoted phrase / proper noun / exact modal token
// survive verbatim, which false-flagged ~100% of valid condensed drafts (a
// "don't"→"NEVER" reword, a "only"→"sole" reword, a dropped illustrative
// example). This tokenizer separates what a guardrail actually IS (polarity,
// scope, load-bearing named facts, required-verbatim wording) from the prose
// the directive used to explain it (samples, incidental proper nouns), and
// demands only the former. The failure mode we refuse to introduce is the
// inverse: a calibration so loose it greenlights a genuinely dropped guardrail.
// The `truncated_or_drifted` acceptance tests pin that boundary.

/**
 * Synonym classes for the scope/polarity modals a guardrail cannot lose. A
 * class is TRIGGERED when the directive uses one of its `trigger` words; the
 * obligation is SATISFIED when the rule contains ANY of the (broader) `satisfy`
 * words. So "don't send" ≡ "NEVER send" ≡ "do not send" (all `neg`), and
 * "only Ken" ≡ "Ken alone" via "sole"/"solely" (`only`). Deliberately small,
 * explicit, and documented — not a thesaurus.
 *
 * Trigger sets are the DISTINCTIVE, unambiguous scope/polarity words only
 * (never/cannot/only/always/…), NOT incidental "no"/"not"/"all"/"each" which
 * appear constantly in non-scope senses and would over-trigger. Satisfy sets
 * are broad so any faithful reword counts. Plain obligation "must"/"shall" is
 * intentionally NOT a class: it marks obligation strength, not polarity or
 * scope, and an imperative reword ("Always call X" / "Confirm before Y")
 * preserves the obligation without the literal token — demanding it survive is
 * a condensation artifact with no safety loss (every rule in the block is
 * already mandatory by construction).
 */
const MODAL_CLASSES = {
  neg: {
    trigger: ["never", "cannot", "can't", "don't", "do not", "won't", "must not", "may not", "shall not"],
    satisfy: ["never", "no", "not", "don't", "dont", "cannot", "can't", "cant", "won't", "wont", "shan't", "none", "nor", "without", "avoid", "refuse", "neither", "prohibit", "forbid", "ban"],
  },
  only: {
    trigger: ["only", "sole", "solely", "exclusively", "nothing but"],
    satisfy: ["only", "sole", "solely", "exclusively", "just", "alone", "purely"],
  },
  universal: {
    // Trigger only on EXPLICIT scope phrases, NOT bare "always". Bare "always"
    // is, like plain "must", usually emphasis on a rule that is already
    // unconditional by construction ("always format X" ⇒ "X"), and condensation
    // legitimately drops it — flagging that is a false positive with no safety
    // loss. Deliberate scope phrases ("in all cases", "without exception") ARE
    // load-bearing and stay mandatory, matched by any universal synonym.
    trigger: ["whenever", "every time", "in all cases", "all cases", "at all times", "in every case", "without exception", "no exception"],
    satisfy: ["always", "every", "each", "all", "everything", "whenever", "any", "must", "never", "no exception", "without exception"],
  },
} as const;

type ModalClass = keyof typeof MODAL_CLASSES;

/** Strong required-verbatim cues. A double-quoted string counts as a GUARDRAIL
 *  (must survive verbatim) only when one of these immediately precedes it — the
 *  directive is telling the agent to emit that exact wording (e.g. a deferral
 *  line "…MUST end with exactly:"). Absent a cue, a quoted string is a SAMPLE
 *  (toast text, example message) and is illustrative. Kept narrow on purpose:
 *  loose cues like "say"/"append" would wrongly promote sample toasts. */
const VERBATIM_CUE_RE =
  /(?:\bexactly\b|\bverbatim\b|\bword[- ]for[- ]word\b|\bverbatim wording\b|\bliteral(?:ly)?\b|\bthe exact (?:line|wording|text|phrase|words|sentence)\b|\bthese exact words\b|\bexact wording\b)\s*[:,]?\s*["“]?$/i;

/** Load-bearing named facts that condensation MUST carry through:
 *  - ALL-CAPS name runs (2+ consecutive ALL-CAPS words) — directives SHOUT
 *    these because they are load-bearing parties/executors: "GARY DAVID BROWN",
 *    "IAN THOMAS GOODFELLOW". Directives ALSO shout for EMPHASIS ("NO HTML",
 *    "THREE REFERENCE NUMBERS", "THE VIBE"), so a run is treated as a name only
 *    when NONE of its words is a common English word (see EMPHASIS_STOPWORDS).
 *    This is an NER-lite pre-filter, not a dictionary; a name built entirely
 *    from common words is inherently ambiguous and left to human adjudication.
 *  - case / instrument reference codes — a contiguous alnum token mixing an
 *    uppercase letter and a digit (AG779131P, TR10399), or a STRUCTURED
 *    acronym+number run with ≥2 numeric groups or a ≥5-digit group
 *    ("CAV 2026 00037"). Bare acronym+single-small-number ("PR 286") is an
 *    incidental reference, not a case code, and is excluded.
 *  Both are dropped to ILLUSTRATIVE when they sit in an example context
 *  ("e.g. AG779131P", "such as …") — a directive listing sample formats is not
 *  asserting a fact the rule must carry. */
const ALLCAPS_NAME_RE = /\b[A-Z]{2,}(?:\s+[A-Z]{2,}){1,}\b/g;
const CODE_TOKEN_RE = /\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{4,}\b/g;
const CODE_ACRONYM_NUM_RE = /\b[A-Z]{2,5}(?:\s+\d{2,}){1,}\b/g;

/** An `e.g.`/`such as`/`for example` marker in the ~48 chars immediately
 *  before a fact match ⇒ the fact is a SAMPLE, not an asserted guardrail. No
 *  trailing `\b` — markers ending in `.` ("e.g.") have no word boundary before
 *  the following space — and the run after the marker forbids sentence
 *  terminators (`.?!:;`) so the marker must be in the SAME clause as the fact. */
const EXAMPLE_CONTEXT_RE =
  /(?:\be\.?\s?g\.?|\bi\.?\s?e\.?|\bsuch as|\bfor example|\bfor instance|\bexamples?\b|\bincluding\b|\blike\b)[^.?!:;]{0,48}$/i;

/** Common English words a directive may SHOUT for emphasis rather than name.
 *  An ALL-CAPS run containing any of these is emphasis, not a party name.
 *  Explicit and bounded on purpose — extend as new emphasis vocabulary shows
 *  up in triage, never with plausible surname tokens (BROWN/DAVID/THOMAS stay
 *  OUT so real names survive). */
const EMPHASIS_STOPWORDS = new Set([
  "THE", "A", "AN", "AND", "OR", "BUT", "NOR", "FOR", "SO", "IF", "OF", "TO",
  "IN", "ON", "AT", "BY", "AS", "IS", "ARE", "BE", "NOT", "NO", "ALL", "ANY",
  "EACH", "EVERY", "THIS", "THAT", "IT", "WE", "YOU", "DO", "USE", "PER",
  "VIA", "YES", "NOW", "THEN", "HERE", "WITH", "WITHOUT", "ONLY", "NEVER",
  "ALWAYS", "MUST", "OVER", "UNDER", "ONE", "TWO", "THREE", "FOUR", "FIVE",
  "REFERENCE", "NUMBER", "NUMBERS", "DAILY", "WEEKLY", "MONTHLY", "ROLLING",
  "IMPACT", "VIBE", "LINE", "LINES", "BREAK", "BREAKS", "ROW", "ROWS", "HTML",
  "CSS", "JSON", "YAML", "CODE", "VERBATIM", "LITERAL", "LITERALLY", "AUTO",
  "TOTAL", "NET", "TARGET", "BURN", "FIXED", "RECORDS", "WIN", "SEND",
]);

/** True when an ALL-CAPS run reads as a load-bearing proper NAME rather than
 *  shouted emphasis. Requires ≥3 words (full legal names — "GARY DAVID BROWN",
 *  "IAN THOMAS GOODFELLOW" — clear this; two-word ALL-CAPS is far more often
 *  emphasis, e.g. "NO HTML"/"THE VIBE"/"COACHING FRAME", so it is treated as
 *  illustrative) AND no word in the common-emphasis stopword set (rejects
 *  three-word emphasis like "THREE REFERENCE NUMBERS"/"ROLLING WEEKLY IMPACT").
 *  A load-bearing two-word name must survive via a Titlecase mention or a
 *  required-verbatim quote (as "Fiona Jessep" does in the deferral line), not
 *  this ALL-CAPS pre-filter. */
function isNameRun(run: string): boolean {
  const words = run.split(/\s+/);
  return words.length >= 3 && words.every((w) => !EMPHASIS_STOPWORDS.has(w));
}

/** True when a structured case/instrument code (≥2 numeric groups or a ≥5-digit
 *  group), so an incidental "PR 286" reference does not read as a case number. */
function isStructuredCode(run: string): boolean {
  const groups = run.match(/\d{2,}/g) ?? [];
  return groups.length >= 2 || groups.some((g) => g.length >= 5);
}

/** True when the char span before `index` is an example-listing context. */
function inExampleContext(content: string, index: number): boolean {
  return EXAMPLE_CONTEXT_RE.test(content.slice(0, index));
}

/** Exclusivity "only"/"sole"/… as a real scope word. Excludes the three ways
 *  "only" over-triggered on real drafts, none of which is exclusivity scope:
 *   - the "-only" of a compound/directive name ("fiona-facts-only", "step-only");
 *   - the temporal "only until/once/then/…" ("lasts only until restart");
 *   - the quantifier "only <number>" ("only 2.7% apart", "only 3 items"). */
const ONLY_TRIGGER_RE =
  /(?<![-\w'’])(?:only|solely|exclusively|sole)\b(?!\s+(?:until|when|once|then|after|before|if|while|as|because|since|about|around|some|roughly|approximately|\d|a\s+few|[½¼¾]))/i;

/** Incidental Titlecase proper nouns (Buildkite, Ken, Playwright, Twitter).
 *  Extracted so the tokenizer surface stays inspectable, but classed
 *  ILLUSTRATIVE and never demanded — the biggest source of the old
 *  false-positive rate. A genuinely load-bearing name relies on the ALL-CAPS /
 *  code fact patterns above, or on surviving inside a required-verbatim quote. */
const PROPER_NOUN_STOPWORDS = new Set([
  "The", "A", "An", "This", "That", "These", "Those", "It", "Its", "If",
  "When", "While", "Do", "Don", "Set", "Use", "Never", "Always", "Only",
  "Must", "Not", "No", "Every", "Each", "Any", "All", "For", "And", "But",
  "Or", "So", "Then", "Prefer", "Avoid", "Ask", "Refuse", "Keep", "Treat",
  "Read", "Write", "Run", "Call", "Send", "Reply", "You", "Your", "We",
  "I", "Before", "After",
]);
const PROPER_NOUN_RE = /\b[A-Z][a-zA-Z0-9_.-]*[a-z][a-zA-Z0-9_.-]*\b/g;

/** Double-quote (straight + curly) and backtick only. Single-quote extraction
 *  is DELETED on purpose: `'…'` matched contraction apostrophes ("Ken's own
 *  session … don't") and captured enormous spurious "quotes" — the single
 *  largest artifact source in the baseline. Real single-quoted phrases do not
 *  occur in these directives; the risk is not worth it. */
const DOUBLE_QUOTE_RE = /["“]([^"”]+)["”]/g;
const BACKTICK_RE = /`([^`]+)`/g;

export interface Keyword {
  /** `modal` = a synonym-classed polarity/scope obligation; `quote` = a quoted
   *  string; `fact` = a load-bearing named fact; `proper` = an incidental
   *  proper noun. */
  kind: "quote" | "modal" | "fact" | "proper";
  /** Whether the rule MUST preserve this. Only `guardrail` keywords are
   *  enforced; `illustrative` keywords are extracted but never demanded. */
  klass: "guardrail" | "illustrative";
  /** The token as it should be searched for / reported (already trimmed). For
   *  modals this is the directive's own trigger word (for readable reports). */
  value: string;
  /** For `kind === "modal"`: which synonym class must survive. */
  modalClass?: ModalClass;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary containment for a single alnum-ish token (apostrophes treated
 *  as punctuation, so `cannot` is not satisfied by `cannon` and `never` is not
 *  satisfied by `nevertheless`). */
function containsWord(normalizedText: string, word: string): boolean {
  const stem = normalize(word).replace(/['’]/g, "'");
  if (/\s/.test(stem)) return normalizedText.includes(stem);
  const re = new RegExp(`(^|[^a-z0-9])${escapeRe(stem)}([^a-z0-9]|$)`);
  return re.test(normalizedText);
}

/** True when the directive triggers `cls` (uses one of its trigger words). The
 *  `only` class uses a refined matcher that ignores "-only" compounds and
 *  temporal "only until/once/…" (both over-triggered on real drafts). */
function directiveTriggersModal(normalizedContent: string, cls: ModalClass): boolean {
  if (cls === "only") return ONLY_TRIGGER_RE.test(normalizedContent);
  return MODAL_CLASSES[cls].trigger.some((w) => containsWord(normalizedContent, w));
}

/** True when the rule satisfies `cls` (contains any of its satisfy words). */
function ruleSatisfiesModal(normalizedRuleText: string, cls: ModalClass): boolean {
  return MODAL_CLASSES[cls].satisfy.some((w) => containsWord(normalizedRuleText, w));
}

/** First trigger word the directive used for `cls`, for readable reporting. */
function firstTrigger(normalizedContent: string, cls: ModalClass): string {
  return MODAL_CLASSES[cls].trigger.find((w) => containsWord(normalizedContent, w)) ?? cls;
}

/**
 * Extract the calibrated keyword set from a directive's content. Deterministic.
 * Each keyword carries a GUARDRAIL/ILLUSTRATIVE class; only guardrail keywords
 * are enforced against the rule (see {@link ruleContainsKeyword} and the drift
 * loop). Exported for direct unit testing.
 */
export function extractKeywords(content: string): Keyword[] {
  const out: Keyword[] = [];
  const seen = new Set<string>();
  const push = (kw: Keyword) => {
    const value = kw.value.trim();
    if (value.length === 0) return;
    const key = `${kw.kind}:${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...kw, value });
  };

  const norm = normalize(content);

  // (1) Modal synonym classes — guardrail. One keyword per triggered class.
  for (const cls of Object.keys(MODAL_CLASSES) as ModalClass[]) {
    if (directiveTriggersModal(norm, cls)) {
      push({ kind: "modal", klass: "guardrail", value: firstTrigger(norm, cls), modalClass: cls });
    }
  }

  // (2) Quoted strings. Backtick = code sample ⇒ illustrative. Double-quote =
  //     guardrail only when a required-verbatim cue immediately precedes it.
  for (const m of content.matchAll(DOUBLE_QUOTE_RE)) {
    const before = content.slice(0, m.index ?? 0);
    const cued = VERBATIM_CUE_RE.test(before);
    push({ kind: "quote", klass: cued ? "guardrail" : "illustrative", value: m[1] });
  }
  for (const m of content.matchAll(BACKTICK_RE)) {
    push({ kind: "quote", klass: "illustrative", value: m[1] });
  }

  // (3) Load-bearing facts — guardrail: ALL-CAPS proper-name runs and
  //     case/instrument codes a condensed rule cannot silently drop. Emphasis
  //     ALL-CAPS, incidental "PR 286" refs, and example-listed codes are
  //     downgraded to illustrative (see the helpers above).
  const fact = (value: string, index: number, guardrail: boolean) =>
    push({ kind: "fact", klass: guardrail && !inExampleContext(content, index) ? "guardrail" : "illustrative", value });
  for (const m of content.matchAll(ALLCAPS_NAME_RE)) fact(m[0], m.index ?? 0, isNameRun(m[0]));
  for (const m of content.matchAll(CODE_TOKEN_RE)) fact(m[0], m.index ?? 0, true);
  for (const m of content.matchAll(CODE_ACRONYM_NUM_RE)) fact(m[0], m.index ?? 0, isStructuredCode(m[0]));

  // (4) Incidental Titlecase proper nouns — illustrative (extracted, not demanded).
  for (const m of content.matchAll(PROPER_NOUN_RE)) {
    const w = m[0];
    if (PROPER_NOUN_STOPWORDS.has(w)) continue;
    push({ kind: "proper", klass: "illustrative", value: w });
  }
  return out;
}

/** True when `ruleText` (normalized) preserves the GUARDRAIL keyword. Modals
 *  are satisfied by any member of their synonym class; quoted/fact phrases are
 *  substring-matched (case-insensitive); single tokens are word-boundary
 *  matched. Illustrative keywords are always treated as preserved (never
 *  demanded). */
function ruleContainsKeyword(normalizedRuleText: string, kw: Keyword): boolean {
  if (kw.klass === "illustrative") return true;
  if (kw.kind === "modal" && kw.modalClass) {
    return ruleSatisfiesModal(normalizedRuleText, kw.modalClass);
  }
  const needle = normalize(kw.value);
  if (/\s/.test(needle)) return normalizedRuleText.includes(needle);
  return containsWord(normalizedRuleText, needle);
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
