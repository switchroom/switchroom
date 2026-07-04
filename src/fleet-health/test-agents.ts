/**
 * Fleet Health — test/synthetic agent classification.
 *
 * Some agents are NOT production principals: `test-harness` is the sanctioned
 * UAT canary (see `src/cli/rollout.ts`) that *deliberately* exercises failure
 * paths — represent/obligation escalation, killed turns, silent no-ops — every
 * time the end-to-end Telegram UAT runs. Counting its occurrences as real
 * production drift badly inflates a job spec's `frequency` and `reach` (a
 * single test agent dominated `feel-like-a-colleague:represent:obligation-
 * escalation` at 341/418 occurrences), burying the genuine production signal.
 *
 * The scanner MUST exclude these agents from the drift frequency/reach counts
 * so the ledger ranks by real principal-facing impact. This is the single
 * source of truth for "is this a test/synthetic agent" — keep the rule here so
 * the scan, the ledger, and any future consumer never drift apart.
 */

/** Exact-match slugs that are sanctioned test/UAT agents, never production. */
export const TEST_AGENT_SLUGS: ReadonlySet<string> = new Set(["test-harness"]);

/** Slug prefixes reserved for test/synthetic/UAT agents. An operator naming an
 *  agent `test-*`, `synthetic-*`, or `uat-*` has flagged it as non-production;
 *  the fleet-health scanner treats it the same as `test-harness`. */
export const TEST_AGENT_PREFIXES: readonly string[] = [
  "test-",
  "synthetic-",
  "uat-",
];

/**
 * True when `agent` is a test/synthetic/UAT agent whose findings must NOT count
 * as production drift. Pure + case-insensitive on the slug.
 */
export function isTestAgent(agent: string): boolean {
  const slug = agent.trim().toLowerCase();
  if (!slug) return false;
  if (TEST_AGENT_SLUGS.has(slug)) return true;
  return TEST_AGENT_PREFIXES.some((p) => slug.startsWith(p));
}
