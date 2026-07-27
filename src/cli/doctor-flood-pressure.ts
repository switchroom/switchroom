/**
 * Telegram 429 flood-pressure doctor probe.
 *
 * ## Why this exists
 *
 * On 2026-07-27T20:19:57Z an agent's bot token took a `retry_after=15908`
 * (4.4 hour) Telegram flood ban. It was not the first: the same token had
 * taken a 3713s (62 minute) ban 44 hours earlier, and a 21397s and a 27951s
 * ban a fortnight before that. Telegram escalates its penalty on repeat
 * offences, so each of those was a leading indicator of the next — and every
 * one of them was recorded only in a gateway log nobody was reading.
 *
 * The rate cause was fixed separately (#3847). This probe closes the other
 * half: making the escalation VISIBLE before it becomes a multi-hour outage.
 *
 * ## Why not grep the log
 *
 * `gateway-supervisor.log` is not a sound source. `grep -c 429` over the real
 * file returns 804 hits where only 101 are actual 429s — the rest are chat
 * ids, message ids and byte counts that happen to contain the digits. It also
 * rotates (the run-up to the 2026-07-27 ban straddles a `.gz` boundary), and
 * two different code paths emit two different 429 line shapes.
 *
 * The gateway already observes every 429 in-process:
 * `telegram-plugin/retry-api-call.ts` calls `onFloodWait(retry_after, opts)`
 * in its `error_code === 429` branch, before either log line, and every
 * wiring of that hook funnels through `makeFloodWaitRecorder`. So the ledger
 * this probe reads is written from the one place that cannot miss a 429.
 *
 * ## Signal
 *
 * Severity, not volume. Raw daily count is actively misleading — in 16 days of
 * real data the highest-count day (12 events) was entirely benign while the
 * day before the 4.4h outage had 4 events, one of them a 62-minute ban. The
 * tiers live in `classifyFlood429Pressure`; this module is only the per-agent
 * I/O around them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveAgentsDir } from "../config/loader.js";
import {
  classifyFlood429Pressure,
  flood429LedgerPath,
  readFlood429LedgerResult,
} from "../../telegram-plugin/flood-429-ledger.js";
import type { SwitchroomConfig } from "../config/schema.js";
import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

export interface FloodPressureDeps {
  /** Defaults to `resolveAgentsDir(config)`, resolved lazily + guarded. */
  agentsDir?: string;
  /** File read seam — injected in tests. Must throw on a missing file. */
  readFile?: (p: string) => string;
  /** Clock seam — injected in tests. */
  now?: number;
}

/**
 * The remediation text is identical for every tier, because the operator's
 * move is the same: the ban itself cannot be cleared client-side, so the only
 * useful action is to cut the outbound rate that earned it.
 */
const FIX =
  "A flood ban is server-side and cannot be cleared early — cut the outbound " +
  "rate that earns it. Check the gateway's `send-gate stats` and " +
  "`edit-flood-fuse` lines for the class doing the sending (progress cards and " +
  "the worker feed are the usual culprits), and see " +
  "`telegram-plugin/edit-flood-fuse.ts` for the per-class ceilings.";

/**
 * For each configured agent, classify its 429 pressure ledger.
 *
 * Silent (no row) for an agent with no ledger — a fresh agent, an agent that
 * has never been 429'd, or a pre-upgrade agent whose gateway does not yet
 * write one. A healthy ledger is also silent: this section reports problems
 * only, matching the directive-count check's posture.
 */
export function runFloodPressureChecks(
  config: SwitchroomConfig,
  deps: FloodPressureDeps = {},
): CheckResult[] {
  const results: CheckResult[] = [];
  const agents = Object.keys(config.agents ?? {});
  if (agents.length === 0) return results;

  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const now = deps.now ?? Date.now();

  let agentsDir = deps.agentsDir;
  if (agentsDir === undefined) {
    try {
      agentsDir = resolveAgentsDir(config);
    } catch {
      agentsDir = undefined;
    }
  }
  if (agentsDir === undefined) {
    return [
      {
        name: "telegram flood pressure",
        status: "warn",
        detail:
          "could not resolve the agents directory (no switchroom block) — " +
          "skipped the 429 flood-pressure check",
      },
    ];
  }

  for (const name of agents) {
    const path = flood429LedgerPath(join(agentsDir, name, "telegram"));
    const read = readFlood429LedgerResult(path, readFile);

    // "Never been 429'd" and "cannot read the evidence" must not look the
    // same — a silently-unreadable ledger would present as a perfectly
    // healthy agent, which is the whole failure mode this probe exists to
    // end. Absent stays silent; unreadable/corrupt earns a row.
    if (read.status === "unreadable" || read.status === "corrupt") {
      results.push({
        name: `429 flood pressure: ${name}`,
        status: "warn",
        detail:
          `the 429 pressure ledger at ${path} is ${read.status} ` +
          `(${read.error ?? "no detail"}) — this agent's flood history cannot be ` +
          `read, so an escalating ban would go unreported here.`,
        fix:
          `Check the file's ownership and mode (it is written 0644 by the ` +
          `gateway's flood breaker), or delete it to start a fresh ledger: ` +
          `rm ${path}`,
      });
      continue;
    }
    if (read.episodes.length === 0) continue;

    const verdict = classifyFlood429Pressure(read.episodes, now);
    if (!verdict) continue;

    results.push({
      name: `429 flood pressure: ${name}`,
      status: verdict.status,
      detail: verdict.detail,
      fix: FIX,
    });
  }

  return results;
}
