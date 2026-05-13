/**
 * Heuristic pass/fail scoring for the agent-self-sufficiency UAT.
 *
 * Each result also carries the verbatim reply so the report's triage
 * table can show the operator exactly what the agent said. Scoring is
 * deliberately permissive — we're testing whether the agent
 * understood the *intent* (and reached for the right tool), not
 * whether the reply matches a specific phrasing.
 *
 * Failure modes the runner needs to distinguish from "wrong answer":
 *
 *   - timeout:     agent never replied within the budget. Could mean
 *                  the agent is wedged, the bot token's wrong, or
 *                  Telegram is throttling. Reported separately so the
 *                  operator doesn't conflate "didn't reply" with
 *                  "replied wrong".
 *   - send_error:  driver couldn't even deliver the inbound (bot
 *                  username missing, mtcute connection died, etc.).
 *                  These bubble up as `error` results, not `fail`.
 */

import type { CriterionSpec, Paraphrase } from "./paraphrases.js";
import { patternFor } from "./paraphrases.js";

export type Outcome = "pass" | "fail" | "timeout" | "error";

export interface CaseResult {
  agent: string;
  criterion: CriterionSpec["id"];
  paraphrase: Paraphrase;
  outcome: Outcome;
  /** Verbatim reply text, empty for timeout/error. Trimmed; markdown
   *  preserved so the report can show what the user actually saw. */
  reply: string;
  /** Wall-clock ms from sendDM to first reply (or to timeout). */
  durationMs: number;
  /** Optional error message for `error` outcomes. */
  errorMessage?: string;
}

/**
 * Score a single reply against a criterion. The runner does NOT call
 * this on timeouts or errors — those outcomes are set directly. For
 * `2b_your_name` and other criteria with `__INJECTED_AGENT_NAME__` in
 * their passPattern, the caller passes the agent name so the matcher
 * substitutes correctly.
 */
export function scoreReply(
  spec: CriterionSpec,
  reply: string,
  injection: { agentName: string },
): Outcome {
  if (!reply.trim()) return "fail";
  const normalized = stripMarkdown(reply).toLowerCase();
  return patternFor(spec, injection).test(normalized) ? "pass" : "fail";
}

/**
 * Strip markdown bold/italic/code-fence markers and collapse runs of
 * whitespace. Permissive on purpose — the scorer's regex matches
 * against words, not formatting.
 */
function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Aggregate per-criterion / per-agent / per-shape pass rates. Pure
 * function — easy to test.
 */
export interface Aggregate {
  byCriterion: Map<string, { pass: number; fail: number; timeout: number; error: number }>;
  byAgent: Map<string, { pass: number; fail: number; timeout: number; error: number }>;
  byShape: Map<string, { pass: number; fail: number; timeout: number; error: number }>;
}

export function aggregate(results: readonly CaseResult[]): Aggregate {
  const acc: Aggregate = {
    byCriterion: new Map(),
    byAgent: new Map(),
    byShape: new Map(),
  };
  const bump = (
    m: Aggregate["byCriterion"],
    k: string,
    outcome: Outcome,
  ): void => {
    const row = m.get(k) ?? { pass: 0, fail: 0, timeout: 0, error: 0 };
    row[outcome] += 1;
    m.set(k, row);
  };
  for (const r of results) {
    bump(acc.byCriterion, r.criterion, r.outcome);
    bump(acc.byAgent, r.agent, r.outcome);
    bump(acc.byShape, r.paraphrase.shape, r.outcome);
  }
  return acc;
}
