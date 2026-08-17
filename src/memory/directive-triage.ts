/**
 * Directive-triage card generator — Memory v2 M2 (carve-M2.md §2, §4a;
 * redteam-M2.md §4, §5).
 *
 * Pure, IO-free: given a bank's directive list (+ optional per-directive
 * classification overrides an agent supplies from its own judgement), sort
 * every directive into exactly one of E-45's five categories and render ONE
 * consolidated markdown card. No network, no MCP call, no bank write lives
 * here — {@link buildDirectiveTriageRows} and {@link renderDirectiveTriageCard}
 * are pure functions over data, which is what makes them directly testable
 * (carve-M2.md T2) and safe to run against a live bank's `list_directives`
 * output without risk.
 *
 * ## Safety properties this module is responsible for (redteam-M2.md §4)
 *
 * 1. **Completeness** — every input directive produces exactly one output
 *    row. No directive can silently vanish from the card (the M6-redteam-§4
 *    failure class: a parser that returns `[]` and passes every per-row
 *    check trivially). Callers/tests should assert row count and row-name
 *    set equal the input before trusting anything else on the card.
 * 2. **Default-KEEP, signal-per-row** — a directive is only ever proposed
 *    for retirement when it carries a genuine deterministic signal (a
 *    `superseded-by:<name>` tag, or an override whose `signal` field is
 *    non-empty). A category or override with no signal renders KEEP, never
 *    retire — an age/vibe retirement in disguise is refused at the type
 *    level, not by reviewer discipline.
 * 3. **rules-block can never become a retire action** — even an override
 *    that names `category: "rules-block"` cannot produce `action: "retire"`.
 *    It always renders `"stage-for-m3"` (M2 Decision 3: leave rules-block
 *    directives ACTIVE, staged + measured, until M3 flips the agent). The
 *    apply-batch executor (`directive-triage-executor.ts`) enforces the same
 *    rule again, independently, so this is defense in depth, not the only
 *    gate.
 * 4. **Visual separation** — the rendered card puts every KEEP/staged row
 *    (the live guardrails) in a section physically before the retirement
 *    candidates, so a distracted skim of "what's below the fold" cannot
 *    land on a guardrail.
 */

import {
  hasRulesBlockMarker,
  type HindsightDirective,
} from "./hindsight-directive-admin.js";

/** E-45's five triage buckets. Every directive lands in exactly one. */
export type DirectiveTriageCategory =
  | "rules-block"
  | "reflect-directive"
  | "disposition"
  | "retire"
  | "retain-as-memory";

export const DIRECTIVE_TRIAGE_CATEGORIES: readonly DirectiveTriageCategory[] = [
  "rules-block",
  "reflect-directive",
  "disposition",
  "retire",
  "retain-as-memory",
];

/**
 * What M2 actually does with a row.
 *   - `keep`         — stays active, no change.
 *   - `retire`       — deactivate via `deactivate_directive` (the apply-batch
 *                       executor performs this).
 *   - `stage-for-m3` — reserved for `rules-block` rows: counted into the
 *                       residue measurement, its text staged for M3's
 *                       `rule add`, but left ACTIVE in M2 (Decision 3).
 */
export type DirectiveTriageAction = "keep" | "retire" | "stage-for-m3";

/**
 * An agent's own classification input for one directive, when the
 * deterministic tag scan (supersession) does not already resolve it.
 *
 * `signal` is REQUIRED and must be non-empty prose naming the deterministic
 * reason (a mechanization reference, a category-error rationale, a
 * disposition-config pointer) — never a bare vote. An override with an
 * empty/whitespace-only signal is treated as no override at all: the row
 * falls back to the default-KEEP path. This is what makes "default to KEEP"
 * a property of the data shape, not something a caller can accidentally skip.
 */
export interface DirectiveTriageOverride {
  category: DirectiveTriageCategory;
  signal: string;
}

export interface DirectiveTriageRow {
  id: string;
  name: string;
  priority: number;
  isActive: boolean;
  category: DirectiveTriageCategory;
  /** The deterministic signal backing this row's category/action. */
  signal: string;
  action: DirectiveTriageAction;
  /** Present only when the signal is a `superseded-by:<name>` tag. */
  supersededBy?: string;
}

const SUPERSEDED_BY_TAG_RE = /^superseded-by:(.+)$/;

/**
 * Classify one directive.
 *
 * Priority order (M2 redteam B1 — fixed from the original "tag scan always
 * wins" ordering, which let a stale `superseded-by:` tag mask a genuine
 * rules-block classification and silently disarm the executor's guard):
 *
 *   1. A persisted {@link hasRulesBlockMarker} tag, or a caller override
 *      naming `category: "rules-block"`, wins over EVERYTHING else,
 *      including a conflicting `superseded-by:` tag — and unlike every
 *      other category below, a rules-block override wins EVEN WITH AN
 *      EMPTY/WHITESPACE `signal`. Every other category's empty-signal
 *      override falls through to default-KEEP (fail-safe); rules-block
 *      fails CLOSED instead, because falling through here would let a
 *      stale `superseded-by:` tag win and classify `retire`. Reachable
 *      mundanely: `DirectiveAdmin.reactivate()` leaves a stale
 *      `superseded-by` tag in place, and tags are settable via
 *      PATCH/`create_directive` — so a genuinely rules-block directive
 *      can end up carrying both signals.
 *   2. An already-inactive directive never comes out `action: "retire"`
 *      (M2 redteam M1) — there is nothing left to retire, and re-running
 *      `deactivate` on it would be a wasted/misleading call.
 *   3. The deterministic `superseded-by:` tag scan.
 *   4. A caller-supplied non-rules-block override with a real signal.
 *   5. Default-KEEP.
 */
export function classifyDirective(
  directive: HindsightDirective,
  override?: DirectiveTriageOverride,
): Pick<DirectiveTriageRow, "category" | "signal" | "action" | "supersededBy"> {
  const isActive = directive.is_active !== false;
  const overrideSignal = override?.signal.trim();

  // 1. Rules-block wins over everything — marker tag, then override.
  if (hasRulesBlockMarker(directive.tags)) {
    return {
      category: "rules-block",
      signal: "carries the rules-block marker tag — staged for M3, never retired",
      action: "stage-for-m3",
    };
  }
  if (override && override.category === "rules-block") {
    // Decision 3, enforced at classification time too (defense in depth
    // alongside the DirectiveAdmin-level chokepoint and the apply-batch
    // executor's own pre-check): a rules-block row can NEVER come out of
    // this function as `action: "retire"`. Deliberately does NOT gate on
    // `overrideSignal` being non-empty the way every other category below
    // does — "default to KEEP on an empty signal" is the right fail-safe
    // for every OTHER category, but rules-block must fail CLOSED: an
    // empty-signal rules-block override falling through to the tag scan
    // below would let a stale `superseded-by:` tag on a genuinely
    // rules-block directive classify as `retire` at this layer (the
    // DirectiveAdmin marker backstop still refuses the actual deactivate
    // call, so this was never independently exploitable — but the
    // classifier itself should never assert `retire` for a directive its
    // own caller just told it is rules-block).
    return {
      category: "rules-block",
      signal:
        overrideSignal ||
        "rules-block override with no signal text — staged for M3, never retired",
      action: "stage-for-m3",
    };
  }

  // 2/3. Deterministic supersession-tag scan (only meaningful for an
  // ACTIVE directive — an inactive one has nothing left to retire).
  const supersessionTag = (directive.tags ?? [])
    .map((t) => SUPERSEDED_BY_TAG_RE.exec(t))
    .find((m): m is RegExpExecArray => m !== null);
  if (supersessionTag) {
    const winner = supersessionTag[1];
    return {
      category: "retire",
      signal: isActive
        ? `superseded by '${winner}' (superseded-by tag)`
        : `superseded by '${winner}' (superseded-by tag) — already inactive, nothing to retire`,
      action: isActive ? "retire" : "keep",
      supersededBy: winner,
    };
  }

  // 4. Caller-supplied override (non-rules-block).
  if (override && overrideSignal) {
    if (override.category === "reflect-directive") {
      return { category: "reflect-directive", signal: overrideSignal, action: "keep" };
    }
    // disposition / retire / retain-as-memory
    return {
      category: override.category,
      signal: isActive
        ? overrideSignal
        : `${overrideSignal} — already inactive, nothing to retire`,
      action: isActive ? "retire" : "keep",
    };
  }

  // 5. No deterministic signal at all — default-KEEP (redteam-M2.md §4).
  return {
    category: "reflect-directive",
    signal: "no deterministic signal — defaults to KEEP",
    action: "keep",
  };
}

/**
 * Build one row per input directive. Preserves input order and count
 * 1:1 — no directive is dropped, deduped, or synthesized.
 *
 * `overrides` is keyed by directive `id`, not `name` (M2 redteam LOW): a
 * name is not unique once a windows-boxes-class reconcile is in flight (old
 * + new superset copy briefly share a name), and an id-keyed map is the
 * only shape that stays correct in that state.
 */
export function buildDirectiveTriageRows(
  directives: readonly HindsightDirective[],
  overrides?: ReadonlyMap<string, DirectiveTriageOverride>,
): DirectiveTriageRow[] {
  return directives.map((d) => {
    const classified = classifyDirective(d, overrides?.get(d.id));
    return {
      id: d.id,
      name: d.name,
      priority: d.priority ?? 0,
      isActive: d.is_active !== false,
      ...classified,
    };
  });
}

export interface DirectiveTriageCard {
  /** Rendered markdown, ready to post as the one consolidated operator card. */
  text: string;
  rows: DirectiveTriageRow[];
}

const CATEGORY_LABEL: Record<DirectiveTriageCategory, string> = {
  "rules-block": "rules-block (staged for M3)",
  "reflect-directive": "reflect-directive",
  disposition: "disposition",
  retire: "retire",
  "retain-as-memory": "retain-as-memory",
};

function renderRow(row: DirectiveTriageRow): string {
  const flag = row.isActive ? "" : " [already inactive]";
  return (
    `- **${row.name}**${flag} — priority ${row.priority}, ` +
    `category \`${CATEGORY_LABEL[row.category]}\`\n` +
    `  signal: ${row.signal}`
  );
}

/**
 * Render the ONE consolidated triage card for a bank's directive set.
 *
 * Two sections, in this fixed order, so live guardrails are never below the
 * retirement pile: KEEP/staged rows first, retirement candidates last.
 * Priority is shown on every row because `directives.py` sorts
 * priority-descending and drops the lowest-priority directives past
 * `MAX_DIRECTIVES` — the reviewer needs it to catch a triage that would
 * retire a high-priority guardrail while keeping a low-priority stale one.
 */
export function renderDirectiveTriageCard(
  rows: readonly DirectiveTriageRow[],
): DirectiveTriageCard {
  const keep = rows.filter((r) => r.action !== "retire");
  const retire = rows.filter((r) => r.action === "retire");

  const lines: string[] = [];
  lines.push("# Directive triage");
  lines.push("");
  lines.push(
    `${rows.length} directive(s) reviewed. This is a budget + hygiene pass, ` +
      "not a rescue from silent drops (nothing here is currently being " +
      "silently dropped — see M2 framing note).",
  );
  lines.push("");
  lines.push(`## Keep / staged (${keep.length}) — live guardrails, do not touch lightly`);
  lines.push("");
  if (keep.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const row of keep) lines.push(renderRow(row));
  }
  lines.push("");
  lines.push(
    `## Retirement candidates (${retire.length}) — each carries a deterministic signal`,
  );
  lines.push("");
  if (retire.length === 0) {
    lines.push("_(none — nothing meets a deterministic retirement signal)_");
  } else {
    for (const row of retire) lines.push(renderRow(row));
  }

  return { text: lines.join("\n"), rows: [...rows] };
}
