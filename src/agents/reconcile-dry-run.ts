/**
 * Dry-run reconcile for agent-config write tools (switchroom #1163, Phase E).
 *
 * Before flipping a staged overlay file into place, we validate that the
 * proposed change is hot-cron-only — i.e. the resulting reconcile would
 * regenerate cron scripts and nothing else. If a non-cron path would
 * change, we abort with `E_WRITE_REQUIRES_RECREATE` so the agent can't
 * bypass restart-required gates via overlay edits.
 *
 * The "prev → next config classifier" the original Phase E plan referred
 * to (`classifyChange(prev, next)`) does not yet exist in lifecycle.ts —
 * the existing `classifyChangeKind(path)` is path-based. We bridge the
 * gap by:
 *
 *   1. Parsing the proposed overlay YAML
 *   2. Schema-validating each entry against `ScheduleEntrySchema`
 *   3. Computing the planned cron-unit filename and asserting it
 *      classifies as "cron"
 *
 * That's enough to defend against the obvious self-grant footguns. A
 * follow-up PR can replace this with the full prev/next config diff
 * once the lifecycle classifier lands.
 */

import { parse as parseYaml } from "yaml";
import { OverlayDocSchema, type OverlayDoc } from "../config/overlay-schema.js";
import { ScheduleEntrySchema } from "../config/schema.js";
import { cronUnitName } from "./cron-unit-name.js";
import { classifyChangeKind } from "./lifecycle.js";
import { cronMinuteSmallestGapMin } from "../scheduler/cron-gap.js";

export interface DryRunOk {
  ok: true;
  doc: OverlayDoc;
  /** Planned cron-unit filenames (basename, no extension). */
  would_write_units: string[];
  would_recreate: false;
}

export interface DryRunErr {
  ok: false;
  code:
    | "E_INVALID_PROMPT"
    | "E_INVALID_CRON"
    | "E_WRITE_REQUIRES_RECREATE"
    | "E_PARSE";
  message: string;
  details?: unknown;
}

export type DryRunResult = DryRunOk | DryRunErr;

const MIN_CRON_INTERVAL_SECS = 5 * 60;

/**
 * Cron-interval floor check. Delegates to the shared minute-cadence helper
 * (`cronMinuteSmallestGapMin`, src/scheduler/cron-gap.ts), which expands the
 * minute field to the set of matched minutes and computes the smallest
 * circular gap. This covers `*`, `*\/N`, single values, CSV lists, ranges
 * (`0-4`), and step-on-range/list (`0-30/2`) — closing the earlier bypass
 * where CSV/range forms slipped past the floor (switchroom #1783).
 *
 * A gap of 0 means "unknown / unparseable minute field" and passes through
 * (we don't bring in a full cron parser); operator-approved entries via
 * switchroom.yaml are unaffected.
 */
export function violatesMinInterval(cron: string): boolean {
  const gapMin = cronMinuteSmallestGapMin(cron);
  return gapMin > 0 && gapMin * 60 < MIN_CRON_INTERVAL_SECS;
}

export function dryRunReconcile(input: {
  agent: string;
  yamlText: string;
}): DryRunResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(input.yamlText);
  } catch (err) {
    return {
      ok: false,
      code: "E_PARSE",
      message: `yaml parse error: ${(err as Error).message}`,
    };
  }
  const docResult = OverlayDocSchema.safeParse(parsed);
  if (!docResult.success) {
    // Try to give a more specific code if the failure is on cron / prompt.
    const issue = docResult.error.errors[0];
    const path = issue?.path?.join(".") ?? "";
    if (path.includes("cron")) {
      return {
        ok: false,
        code: "E_INVALID_CRON",
        message: issue?.message ?? "invalid cron",
        details: docResult.error.errors,
      };
    }
    if (path.includes("prompt")) {
      return {
        ok: false,
        code: "E_INVALID_PROMPT",
        message: issue?.message ?? "invalid prompt",
        details: docResult.error.errors,
      };
    }
    return {
      ok: false,
      code: "E_INVALID_CRON",
      message: docResult.error.errors.map((e) => e.message).join("; "),
      details: docResult.error.errors,
    };
  }
  const doc = docResult.data;
  const wouldWrite: string[] = [];
  for (const entry of doc.schedule ?? []) {
    // Per-entry schema check (already covered by OverlayDocSchema, but
    // belt-and-braces for explicitness).
    const entryCheck = ScheduleEntrySchema.safeParse(entry);
    if (!entryCheck.success) {
      return {
        ok: false,
        code: "E_INVALID_CRON",
        message: entryCheck.error.errors.map((e) => e.message).join("; "),
      };
    }
    const unit = cronUnitName(entry.cron, entry.prompt);
    // The path that reconcile would write under: <agentDir>/telegram/<unit>.sh
    const fakePath = `/agents/${input.agent}/telegram/${unit}.sh`;
    if (classifyChangeKind(fakePath) !== "cron") {
      return {
        ok: false,
        code: "E_WRITE_REQUIRES_RECREATE",
        message: `proposed change would require a recreate (path=${fakePath})`,
      };
    }
    wouldWrite.push(unit);
  }
  return { ok: true, doc, would_write_units: wouldWrite, would_recreate: false };
}
