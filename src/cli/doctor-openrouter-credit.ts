/**
 * OpenRouter credit doctor check.
 *
 * PR #3868 made a spent OpenRouter balance visible AFTER it breaks a request
 * (raw 402 → operator card, never to an end user). This is the proactive half:
 * see the shortfall coming.
 *
 * The interesting outcome is the one that will actually apply to the fleet
 * today — a key with NO per-key credit limit. `GET /api/v1/key` reports
 * `limit`/`limit_remaining` as `null` for an uncapped key and carries no
 * account-balance field at all, so there is genuinely nothing to threshold.
 * This check says exactly that, as a WARN with the console action, rather than
 * a green tick that means nothing. See `src/openrouter/credit.ts` for the
 * verified endpoint contract.
 *
 * The API key is read through the NORMAL vault path at runtime (injected here
 * as `readSecret`, so tests drive every branch with a fake and no live
 * credential is ever needed). The key VALUE is never logged, never returned,
 * and never placed in a check `detail` — only the vault key NAME appears.
 */

import type { CheckStatus } from "./doctor-status.js";
import {
  OPENROUTER_VAULT_KEY,
  assessFetchFailure,
  evaluateCredit,
  fetchKeySnapshot,
  type CreditFetchFn,
} from "../openrouter/credit.js";

/** Mirror of `CheckResult` in doctor.ts (imported there, not from there — the
 *  doctor modules avoid a circular import by re-declaring the shape). */
export interface OpenRouterCheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

export interface OpenRouterCreditDeps {
  /**
   * Read a secret by vault key NAME. Returns `null` when no grant/entry
   * exists. Injected so this module never touches the vault directly and tests
   * need no credential.
   */
  readSecret: (key: string) => Promise<string | null>;
  fetchFn: CreditFetchFn;
  /** True when the fleet actually routes through OpenRouter. */
  enabled: boolean;
}

const CHECK_NAME = "OpenRouter credit";

/**
 * Returns exactly one result. Never throws — doctor sections must not be able
 * to abort the run.
 */
export async function runOpenRouterCreditChecks(
  deps: OpenRouterCreditDeps,
): Promise<OpenRouterCheckResult[]> {
  if (!deps.enabled) {
    return [
      {
        name: CHECK_NAME,
        status: "skip",
        detail: "No OpenRouter-backed model is configured in the LiteLLM proxy config.",
      },
    ];
  }

  let apiKey: string | null;
  try {
    apiKey = await deps.readSecret(OPENROUTER_VAULT_KEY);
  } catch (err) {
    return [
      {
        name: CHECK_NAME,
        status: "skip",
        detail: `Could not read vault key \`${OPENROUTER_VAULT_KEY}\` (${(err as Error).message}).`,
      },
    ];
  }

  if (!apiKey) {
    return [
      {
        name: CHECK_NAME,
        status: "warn",
        detail:
          `The proxy routes through OpenRouter but vault key \`${OPENROUTER_VAULT_KEY}\` is not ` +
          `readable here, so credit cannot be monitored.`,
        fix: `Grant read access to \`${OPENROUTER_VAULT_KEY}\`, or store it if it is missing.`,
      },
    ];
  }

  const fetched = await fetchKeySnapshot(apiKey, deps.fetchFn);
  const assessment =
    fetched.kind === "ok" ? evaluateCredit(fetched.snapshot) : assessFetchFailure(fetched);

  return [
    {
      name: CHECK_NAME,
      status: assessment.status,
      detail: assessment.detail,
      ...(assessment.fix ? { fix: assessment.fix } : {}),
    },
  ];
}

/**
 * Does the LiteLLM proxy config route anything through OpenRouter? Reads the
 * config TEXT rather than parsing, so it works on a partially-valid file.
 */
export function usesOpenRouter(litellmConfigText: string | null): boolean {
  if (!litellmConfigText) return false;
  return litellmConfigText.includes("openrouter/") || litellmConfigText.includes("OPENROUTER_API_KEY");
}
