/**
 * run.ts — one tick of the OpenRouter credit watch.
 *
 * Orchestration only: read the key (vault), read the snapshot (HTTP), evaluate
 * (`./credit.ts` — the SAME evaluator `switchroom doctor` uses, so the two can
 * never disagree about what "low" means), decide (`./watch.ts`), deliver, and
 * persist the re-notify ledger.
 *
 * Everything that touches the world is injected, so the tests drive every
 * outcome — including "the key is out of credit" — with fakes and no live
 * credential. The API key VALUE never appears in a log line, a notice, or the
 * returned result; only the vault key NAME does.
 *
 * EXIT CODES (cron-meaningful, matching `switchroom hindsight-watch`):
 *   0  — ran, nothing firing
 *  10  — ran, a credit signal is firing (DM sent unless suppressed by the
 *        6 h re-notify window)
 *   1  — could NOT complete: OpenRouter unreachable, the vault key
 *        unreadable, the state file unwritable, or an alert that reached no
 *        gateway. Loud by design — a watchdog that cannot see, or cannot
 *        speak, is an incident, not a no-op.
 */

import {
  OPENROUTER_VAULT_KEY,
  assessFetchFailure,
  evaluateCredit,
  fetchKeySnapshot,
  type CreditAssessment,
  type CreditFetchFn,
} from "./credit.js";
import { loadState, saveState } from "./state.js";
import { decideNotification, type CreditWatchState } from "./watch.js";

export interface TickDeps {
  statePath: string;
  /** Reads the vault by key NAME. Returns null when absent or ungranted. */
  readSecret: (key: string) => Promise<string | null>;
  fetchFn: CreditFetchFn;
  /** Deliver one operator DM. Resolves false when no gateway accepted it. */
  notify: (text: string) => Promise<boolean>;
  now?: () => number;
  dryRun?: boolean;
  log: (msg: string) => void;
}

export interface TickResult {
  assessment: CreditAssessment;
  /** The DM that was sent (or, under --dry-run, would have been). */
  notice: string | null;
  /** True when a signal is firing, whether or not it DM'd this tick. */
  firing: boolean;
  /** True when a DM was actually delivered. */
  delivered: boolean;
  exitCode: 0 | 1 | 10;
}

export async function tick(deps: TickDeps): Promise<TickResult> {
  const now = deps.now?.() ?? Date.now();

  let apiKey: string | null = null;
  try {
    apiKey = await deps.readSecret(OPENROUTER_VAULT_KEY);
  } catch (err) {
    deps.log(`openrouter-watch: vault read failed for \`${OPENROUTER_VAULT_KEY}\`: ${(err as Error).message}`);
  }
  if (!apiKey) {
    // Cannot see. Loud in the cron log; NOT a DM — an ungranted vault key is a
    // host-side configuration problem the operator meets in `switchroom
    // doctor`, and DMing about it hourly would be paging about a static fact.
    deps.log(
      `openrouter-watch: vault key \`${OPENROUTER_VAULT_KEY}\` is not readable — credit cannot be checked.`,
    );
    return {
      assessment: {
        status: "skip",
        detail: `Vault key \`${OPENROUTER_VAULT_KEY}\` unreadable.`,
        actionable: false,
      },
      notice: null,
      firing: false,
      delivered: false,
      exitCode: 1,
    };
  }

  const fetched = await fetchKeySnapshot(apiKey, deps.fetchFn);
  const assessment =
    fetched.kind === "ok" ? evaluateCredit(fetched.snapshot) : assessFetchFailure(fetched);

  const prior: CreditWatchState = loadState(deps.statePath);
  const decision = decideNotification(assessment, prior, now);

  let delivered = false;
  if (decision.notice && !deps.dryRun) {
    delivered = await deps.notify(decision.notice);
  }

  // Persist ONLY when the DM actually landed (or there was none to send).
  // Recording a notification that never reached anyone would start a 6 h
  // silence about a live incident nobody has heard about — the single worst
  // failure this watchdog can have.
  if (!deps.dryRun && (decision.notice === null || delivered)) {
    try {
      saveState(deps.statePath, decision.nextState);
    } catch (err) {
      deps.log(`openrouter-watch: could not persist state: ${(err as Error).message}`);
      return { assessment, notice: decision.notice, firing: decision.firing, delivered, exitCode: 1 };
    }
  }

  if (decision.notice && !deps.dryRun && !delivered) {
    deps.log("openrouter-watch: alert reached no gateway — undelivered, will retry next tick");
    return { assessment, notice: decision.notice, firing: decision.firing, delivered, exitCode: 1 };
  }

  const cannotComplete = fetched.kind === "unreachable";
  const exitCode: 0 | 1 | 10 = cannotComplete ? 1 : decision.firing ? 10 : 0;
  return { assessment, notice: decision.notice, firing: decision.firing, delivered, exitCode };
}
