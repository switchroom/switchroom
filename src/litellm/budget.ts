/**
 * budget.ts — the spend caps switchroom puts on every per-agent LiteLLM
 * virtual key, and the one place their defaults are decided.
 *
 * WHY
 * ---
 * A per-agent virtual key is, without a budget, a bearer token for the whole
 * upstream account balance. A runaway loop, a mis-tuned retry, or a
 * compromised agent can spend the entire OpenRouter/OpenAI balance before
 * anyone notices — and the first symptom is every OTHER agent failing, because
 * they share that balance. A cap converts an unbounded fleet-wide outage into a
 * bounded, single-agent one that names its own cause.
 *
 * VERIFIED AGAINST LITELLM SOURCE (`litellm/proxy/_types.py`, read 2026-07-28):
 *   - `GenerateRequestBase.max_budget: Optional[float]`      → /key/generate ✅ /key/update ✅
 *   - `GenerateRequestBase.budget_duration: Optional[str]`   → /key/generate ✅ /key/update ✅
 *   - `GenerateKeyRequest.soft_budget: Optional[float]`      → /key/generate ✅ /key/update ❌
 *
 * That last row is a real constraint, not an oversight: `UpdateKeyRequest`
 * extends `KeyRequestBase`, NOT `GenerateKeyRequest`, so `soft_budget` has no
 * update path. Changing it takes effect only when a key is (re)generated. The
 * hard cap and the window CAN be healed onto an existing key — which is why
 * `updateKeyBudget` exists and only sends those two.
 *
 * WHY THESE DEFAULTS
 * ------------------
 * `max_budget` USD per `budget_duration`. The numbers are chosen to be
 * CONSERVATIVE-BUT-NOT-ANNOYING: high enough that ordinary agent work never
 * touches them, low enough that hitting one is unambiguous evidence of a
 * runaway rather than a busy week.
 *
 *  - Anthropic traffic is subscription-funded through the OAuth passthrough and
 *    is NOT metered by these keys, so the cap only governs the paid third-party
 *    lane (OpenRouter et al.) — a lane whose normal fleet usage is small.
 *  - A 30-day window matches how the underlying provider accounts are topped
 *    up and billed, so "spent the month's allowance" and "hit the cap" line up.
 *  - A LIFETIME cap (a `max_budget` with NO `budget_duration`) is the trap
 *    here: LiteLLM never resets it, so the key permanently dies the first time
 *    it is reached. Both are always sent together for exactly that reason.
 *
 * The default is a floor, not a ceiling: raise it per-agent in
 * `switchroom.yaml` (`litellm.max_budget`) for an agent that genuinely needs
 * more. Removing the cap entirely is possible but is a decision, not a default.
 *
 * NOT COVERED BY THIS FILE — the per-key credit limit in the OPENROUTER
 * DASHBOARD is a separate, provider-side control that switchroom cannot set:
 * OpenRouter exposes no API to create or limit provisioning keys. Setting it is
 * a MANUAL OPERATOR ACTION at https://openrouter.ai/settings/keys. The LiteLLM
 * cap here bounds what one AGENT can spend; the dashboard limit bounds what the
 * whole PROXY can spend if its key ever leaks. They are complementary.
 */

/**
 * Hard cap, USD, per window, for one agent's virtual key.
 *
 * 25 USD / 30 days. Sizing: fleet third-party (non-Anthropic) spend runs at
 * cents-to-low-dollars per agent-month in normal operation, so this is roughly
 * an order of magnitude of headroom — a busy month cannot trip it, while a
 * runaway loop trips it in hours instead of draining the account.
 */
export const DEFAULT_KEY_MAX_BUDGET_USD = 25;

/**
 * Advisory threshold, USD. Crossing it raises a LiteLLM budget alert while the
 * key keeps working — the warning shot before the hard stop. 60% of the hard
 * cap leaves real time to react.
 */
export const DEFAULT_KEY_SOFT_BUDGET_USD = 15;

/**
 * Rolling reset window, LiteLLM duration syntax. NEVER leave this unset
 * alongside a `max_budget`: LiteLLM then treats the cap as a lifetime budget
 * that never resets, and the key dies permanently the first time it is hit.
 */
export const DEFAULT_KEY_BUDGET_DURATION = "30d";

/** The resolved caps applied to one key. */
export interface KeyBudget {
  maxBudget: number;
  softBudget?: number;
  budgetDuration: string;
}

/** Config shape as it arrives from `switchroom.yaml`'s `litellm:` block. */
export interface KeyBudgetConfig {
  max_budget?: number;
  soft_budget?: number;
  budget_duration?: string;
}

/**
 * Resolve the caps for one key from config + defaults.
 *
 * Rules, all of them chosen so a misconfiguration degrades toward SAFER rather
 * than toward unbounded:
 *  - an absent `max_budget` takes the conservative default (opting OUT is
 *    explicit: `max_budget: 0`);
 *  - `max_budget: 0` (or negative) means "no cap" and returns `null` — the
 *    caller then sends no budget fields at all, so LiteLLM is not handed a
 *    zero-dollar budget that would block every request;
 *  - a `budget_duration` is ALWAYS emitted alongside a cap, so a cap can never
 *    silently become a permanent lifetime kill-switch;
 *  - a `soft_budget` at or above the hard cap is dropped rather than sent: it
 *    could never fire before the hard stop, and shipping a dead alert is worse
 *    than shipping none.
 */
export function resolveKeyBudget(config: KeyBudgetConfig | undefined): KeyBudget | null {
  const raw = config?.max_budget;
  const maxBudget = raw === undefined ? DEFAULT_KEY_MAX_BUDGET_USD : raw;
  if (!Number.isFinite(maxBudget) || maxBudget <= 0) return null;

  const budgetDuration =
    config?.budget_duration && config.budget_duration.length > 0
      ? config.budget_duration
      : DEFAULT_KEY_BUDGET_DURATION;

  const rawSoft = config?.soft_budget ?? DEFAULT_KEY_SOFT_BUDGET_USD;
  const softBudget =
    Number.isFinite(rawSoft) && rawSoft > 0 && rawSoft < maxBudget ? rawSoft : undefined;

  return { maxBudget, softBudget, budgetDuration };
}

/**
 * Human summary for the `switchroom apply` transcript. The operator should be
 * able to read what cap landed without querying the proxy.
 */
export function describeKeyBudget(budget: KeyBudget | null): string {
  if (budget == null) return "no spend cap (uncapped key)";
  const soft = budget.softBudget != null ? `, alert at $${budget.softBudget}` : "";
  return `cap $${budget.maxBudget}/${budget.budgetDuration}${soft}`;
}
