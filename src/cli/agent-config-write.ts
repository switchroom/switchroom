/**
 * `switchroom schedule add|remove` — the WRITE half of the agent-config
 * broker (switchroom #1163, Phase E).
 *
 * Companion to the read-only commands in `agent-config.ts`. Same
 * identity-resolution model (env-pinned $SWITCHROOM_AGENT_NAME inside
 * containers; explicit --agent flag on the host) and same audit-log
 * convention. Cross-agent writes are denied with exit 7 via the shared
 * `resolveTargetAgent` helper.
 *
 * Schedule overlay files land at:
 *   ~/.switchroom/agents/<agent>/schedule.d/<slug>.yaml
 *
 * where `<slug> = cron-<sha256(cron + prompt)[:12]>` (matches the
 * Phase-D cron-unit hash so add/remove round-trip cleanly via the same
 * filename derivation).
 *
 * Security gate — operator-authored entries in switchroom.yaml may
 * declare `secrets:`, but agent-authored overlay entries cannot. A
 * non-empty `secrets:` list on an overlay write triggers
 * `E_OVERLAY_SECRETS_REQUIRES_APPROVAL` (exit 9) without writing
 * anything. The next PR will replace the rejection with an approval-
 * card flow that surfaces the request to the operator.
 *
 * Structured error codes (emitted as a single JSON line to stderr;
 * exit codes noted):
 *   - E_OVERLAY_SECRETS_REQUIRES_APPROVAL  (9)
 *   - E_CRON_TOO_FREQUENT                  (9)  – < 5 min interval
 *   - E_QUOTA_EXCEEDED                     (9)  – > 20 entries
 *   - E_WRITE_REQUIRES_RECREATE            (9)  – defensive
 *   - E_INVALID_CRON / E_INVALID_PROMPT    (1)
 *   - E_NOT_FOUND                          (1)  – remove target missing
 */

import type { Command } from "commander";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import {
  appendAudit,
  resolveTargetAgent,
  scheduleLiveNote,
  scheduleRestartRequired,
} from "./agent-config.js";
import {
  writeOverlayEntry,
  deleteOverlayEntry,
  listOverlayEntries,
} from "../config/overlay-writer.js";
import { filterOverlaySecrets } from "../config/overlay-secrets-filter.js";
import { cronUnitName, cronUnitHash } from "../agents/cron-unit-name.js";
import { dryRunReconcile, violatesMinInterval } from "../agents/reconcile-dry-run.js";
import {
  reconcileAgentCronOnly,
  type ReconcileBridgeResult,
  type ReconcileBridgeError,
} from "./reconcile-bridge.js";
import {
  stagePendingScheduleEntry,
  listPendingScheduleEntries,
  commitPendingScheduleEntry,
  denyPendingScheduleEntry,
  type PendingReasonCode,
} from "./agent-config-pending.js";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  formatScheduleReport,
  parseScheduleJsonl,
  summarizeScheduleReport,
} from "../scheduler/schedule-report.js";
import { buildEnvelope, type ErrorEnvelope } from "../host-control/protocol.js";

const MAX_ENTRIES_PER_AGENT = 20;

/** Min-interval cron floor (minutes). Mirrors `violatesMinInterval`. */
const MIN_CRON_INTERVAL_MIN = 5;

/**
 * Returns the **smallest gap (in minutes)** between consecutive fires
 * implied by the minutes column of a 5-field cron expr. This is the
 * rejection signal used by the min-interval floor: if the smallest
 * gap is below `MIN_CRON_INTERVAL_MIN`, the schedule fires too fast
 * and is refused.
 *
 * Semantics by minute-field shape:
 *   - `*`        → 1  (fires every minute)
 *   - `*\/N`     → N  (stepped cadence)
 *   - CSV list   → smallest pairwise gap between sorted values
 *                  (e.g. `0,1,2` → 1, `0,30` → 30, `0,15,30,45` → 15)
 *   - anything else (ranges, mixed) → 0 (unknown)
 *
 * NOTE: this is **not** the worst-case wait between fires. For CSV
 * lists clustered at the top of the hour like `0,1,2 * * * *`, the
 * worst-case wait is ~58 min (minute 2 → next hour's minute 0), but
 * the *smallest* gap is 1 — which is what the floor cares about.
 * Surfaced as `requested_interval_min` in the error envelope's
 * `quota_exceeded.current` field; receivers should read it as "the
 * tightest cadence the schedule implies", not "the user's wait time".
 */
export function extractCronSmallestGapMin(expr: string): number {
  const fields = expr.trim().split(/\s+/);
  if (fields.length < 5) return 0;
  const min = fields[0];
  if (min === "*") return 1;
  const step = min.match(/^\*\/(\d+)$/);
  if (step) return Number(step[1]);
  if (min.includes(",")) {
    const parts = min.split(",").map((s) => Number(s)).filter((n) => Number.isFinite(n));
    if (parts.length >= 2) {
      const sorted = [...parts].sort((a, b) => a - b);
      let smallest = Infinity;
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i] - sorted[i - 1];
        if (gap > 0 && gap < smallest) smallest = gap;
      }
      return Number.isFinite(smallest) ? smallest : 0;
    }
  }
  return 0;
}

/**
 * Defense-in-depth check that the caller is the operator host CLI,
 * not an agent shell-out. Returns `{ ok: true }` when the caller may
 * proceed; otherwise an exit-7 reason payload the CLI wrapper emits
 * and process.exit's on.
 *
 * **This is not a capability boundary** — it inspects env, which an
 * agent that can spawn child processes can scrub (`env -u
 * SWITCHROOM_AGENT_NAME …`). True capability hardening (uid/gid
 * check, host-only socket, mode-0400 token file outside the container
 * mount) is a tracked follow-up. The env check still raises the bar
 * meaningfully: it blocks the naive shell-out path and forces an
 * attacker to be deliberate about env scrubbing, which leaves a
 * trace in audit logs.
 *
 * Override: `SWITCHROOM_OPERATOR=1` bypasses the check for trusted
 * host shells (CI, recovery, manual operator sessions) where the env
 * pin happens to be set for unrelated reasons.
 *
 * @param env  Inject for tests; defaults to `process.env`.
 */
export function checkOperatorContext(
  verb: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; message: string } {
  if (env.SWITCHROOM_OPERATOR === "1") return { ok: true };
  const agentEnv = env.SWITCHROOM_AGENT_NAME;
  if (agentEnv && agentEnv.length > 0) {
    return {
      ok: false,
      message: `schedule pending ${verb} is operator-only; refusing because $SWITCHROOM_AGENT_NAME=${agentEnv} (set SWITCHROOM_OPERATOR=1 to override on a trusted host)`,
    };
  }
  return { ok: true };
}

type ErrorCode =
  | "E_OVERLAY_SECRETS_REQUIRES_APPROVAL"
  | "E_CRON_TOO_FREQUENT"
  | "E_QUOTA_EXCEEDED"
  | "E_WRITE_REQUIRES_RECREATE"
  | "E_INVALID_CRON"
  | "E_INVALID_PROMPT"
  | "E_NOT_FOUND"
  | "E_RECONCILE_FAILED"
  | "E_SLUG_COLLISION"
  | "E_OPERATOR_ONLY"
  | "E_INTERNAL";

/**
 * Reconcile DI hook — overridable for tests. Defaults to the live
 * hot-apply path from #1185 via the bridge module.
 */
export type ReconcileFn = (
  agent: string,
) => ReconcileBridgeResult | ReconcileBridgeError;

/**
 * Build the structured `error_envelope` (#1758 / #1770 Phase 3) for
 * codes whose fix kind is well-defined. Returns `undefined` for codes
 * we haven't migrated yet — callers spread it into the JSON line so an
 * `undefined` simply elides the field, preserving byte-identity of the
 * legacy `{ code, message, ...extra }` shape for any decoder still
 * string-matching the old form.
 */
function buildEnvelopeForCode(
  code: ErrorCode,
  message: string,
  extra: Record<string, unknown>,
): ErrorEnvelope | undefined {
  // #1778 — request_id is now optional on ErrorEnvelopeSchema. CLI
  // emit sites no longer fabricate a placeholder; receivers correlate
  // via audit_id / surrounding context.
  if (code === "E_CRON_TOO_FREQUENT") {
    return buildEnvelope(code, message, {
      kind: "quota_exceeded",
      quota: "cron_min_interval_minutes",
      current: typeof extra.requested_interval_min === "number"
        ? (extra.requested_interval_min as number)
        : 0,
      limit: MIN_CRON_INTERVAL_MIN,
    });
  }
  if (code === "E_QUOTA_EXCEEDED") {
    const current = typeof extra.current === "number"
      ? (extra.current as number)
      : MAX_ENTRIES_PER_AGENT;
    return buildEnvelope(code, message, {
      kind: "quota_exceeded",
      quota: "schedule_entries_per_agent",
      current,
      limit: MAX_ENTRIES_PER_AGENT,
    });
  }
  return undefined;
}

function emitError(code: ErrorCode, message: string, extra: Record<string, unknown> = {}): void {
  const error_envelope = buildEnvelopeForCode(code, message, extra);
  // Legacy `{ code, message, ...extra }` preserved verbatim. The
  // `error_envelope` (when present) is appended as a sibling key —
  // mirrors the Phase 2 `{ ...built, error: legacy }` byte-identity
  // pattern. Decoders that only read `code`/`message` see no change.
  const line: Record<string, unknown> = { code, message, ...extra };
  if (error_envelope) line.error_envelope = error_envelope;
  process.stderr.write(JSON.stringify(line) + "\n");
}

function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case "E_OVERLAY_SECRETS_REQUIRES_APPROVAL":
    case "E_CRON_TOO_FREQUENT":
    case "E_QUOTA_EXCEEDED":
    case "E_WRITE_REQUIRES_RECREATE":
    case "E_SLUG_COLLISION":
      return 9;
    case "E_INVALID_CRON":
    case "E_INVALID_PROMPT":
    case "E_NOT_FOUND":
    case "E_INTERNAL":
      return 1;
    case "E_OPERATOR_ONLY":
      return 7;
    case "E_RECONCILE_FAILED":
      return 10;
  }
}

interface AddOpts {
  agent?: string;
  cronExpr: string;
  prompt: string;
  secrets?: string[];
  name?: string;
  /**
   * Cheap-cron tier hint (reference/rfcs/cheap-cron-sessions.md). A known-cheap
   * model id (sonnet/haiku) routes this fire to a fresh, minimal-context
   * cron session (Tier 1) instead of the agent's full live session (Tier 2),
   * cutting per-fire token cost. Honoured only when SWITCHROOM_CHEAP_CRON is
   * on; otherwise inert (the fire still runs as a normal turn). Agent-authorable
   * — no security gate (unlike `poll`, which needs an operator egress commit).
   */
  model?: string;
  /** Tier hint: 'fresh' → minimal-context cheap session (Tier 1); 'agent' →
   *  the agent's live session (Tier 2). Unset → inferred from `model`. */
  context?: "fresh" | "agent";
  /** Test-only: override overlay root. */
  root?: string;
  /**
   * Reconcile trigger. Defaults to the production hot-apply bridge.
   * Tests inject a mock. Pass `null` to skip reconcile entirely (used
   * by the existing test suite which doesn't load a real config).
   */
  reconcile?: ReconcileFn | null;
}

interface RemoveOpts {
  agent?: string;
  name?: string;
  cronHash?: string;
  /** Test-only: override overlay root. */
  root?: string;
  /** See AddOpts.reconcile. */
  reconcile?: ReconcileFn | null;
}

export interface ScheduleAddResult {
  ok: true;
  slug: string;
  path: string;
  cron_hash: string;
  would_recreate: false;
  /** Since #2293 the in-agent scheduler hot-reloads the overlay, so this
   *  is `false` by default (entry is live within ~30s). It is only `true`
   *  when hot-reload is disabled (`SWITCHROOM_SCHEDULER_HOT_RELOAD=0`). */
  restart_required: boolean;
  restart_hint: string;
}

export interface ScheduleErrorResult {
  ok: false;
  code: ErrorCode;
  message: string;
  exit: number;
  /**
   * Structured side-channel for the envelope builder (#1770). Optional
   * per-code numerics like `current`, `requested_interval_min` that
   * `buildEnvelopeForCode` lifts into `fix.quota_exceeded` fields.
   * Not part of the legacy stderr JSON shape — keys are spread into
   * `extra` only when an emit site routes through them.
   */
  meta?: Record<string, unknown>;
}

/**
 * Returned by {@link scheduleAddOrStage} when a security gate trips
 * and the entry has been staged for operator approval (instead of
 * hard-rejected). Exit code is 0 — the agent's call SUCCEEDED, the
 * commit is just pending.
 */
export interface ScheduleStagedResult {
  ok: true;
  staged: true;
  stage_id: string;
  reason: PendingReasonCode;
  summary: string;
  /** Operator-facing path on disk. */
  yaml_path: string;
}

/**
 * Programmatic add — used by the CLI command and by tests. Returns a
 * structured result so callers can decide how to surface it (CLI prints
 * + exits; tests assert).
 */
export function scheduleAdd(opts: AddOpts): ScheduleAddResult | ScheduleErrorResult {
  let agent: string;
  try {
    agent = resolveTargetAgent(opts.agent);
  } catch (err) {
    // Cross-agent denials surface here. We re-throw so the CLI wrapper
    // can mirror the read-side exit-7 convention.
    throw err;
  }

  const entry: Record<string, unknown> = {
    cron: opts.cronExpr,
    prompt: opts.prompt,
  };
  if (opts.secrets && opts.secrets.length > 0) entry.secrets = opts.secrets;
  if (opts.name) entry.name = opts.name;
  // Cheap-cron tier hints (active by default; SWITCHROOM_CHEAP_CRON=0/false/off
  // is the kill-switch). Plain ScheduleEntry fields validated by
  // ScheduleEntrySchema on reconcile.
  if (opts.model) entry.model = opts.model;
  if (opts.context) entry.context = opts.context;

  // We construct the doc as { schedule: [entry] }. `name` is NOT a
  // schema field on ScheduleEntrySchema today — we stash it in a
  // top-level alias map inside the file so remove-by-name can find it
  // without breaking schema-strict overlay loading.
  const doc: Record<string, unknown> = {
    schedule: [
      // Skip name in the schedule entry (schema-strict) — name lives in
      // the wrapper below.
      Object.fromEntries(
        Object.entries(entry).filter(([k]) => k !== "name"),
      ),
    ],
  };
  const yamlText = (() => {
    const body = yamlStringify(doc);
    // Stash agent-facing name as a YAML comment header so the file is
    // identifiable by humans and by `remove --name`. Comment lines are
    // ignored by the loader.
    const header = opts.name ? `# name: ${opts.name}\n` : "";
    return header + body;
  })();

  // Dry-run reconcile (schema validate + cron-only assertion)
  const dry = dryRunReconcile({ agent, yamlText });
  if (!dry.ok) {
    const code = dry.code === "E_PARSE" ? "E_INVALID_CRON" : dry.code;
    const result: ScheduleErrorResult = {
      ok: false,
      code,
      message: dry.message,
      exit: exitCodeFor(code),
    };
    return result;
  }

  // Min-interval check
  if (violatesMinInterval(opts.cronExpr)) {
    return {
      ok: false,
      code: "E_CRON_TOO_FREQUENT",
      message: "cron interval is tighter than the minimum (5 minutes)",
      exit: 9,
      meta: { requested_interval_min: extractCronSmallestGapMin(opts.cronExpr) },
    };
  }

  // Secrets-rejection gate
  const rej = filterOverlaySecrets(dry.doc, "overlay");
  if (rej) {
    return {
      ok: false,
      code: "E_OVERLAY_SECRETS_REQUIRES_APPROVAL",
      message: rej.message,
      exit: 9,
    };
  }

  // Quota check
  const existing = listOverlayEntries(agent, { root: opts.root });
  if (existing.length >= MAX_ENTRIES_PER_AGENT) {
    return {
      ok: false,
      code: "E_QUOTA_EXCEEDED",
      message: `agent already has ${existing.length} overlay entries (max ${MAX_ENTRIES_PER_AGENT})`,
      exit: 9,
      meta: { current: existing.length },
    };
  }

  const hash = cronUnitHash(opts.cronExpr, opts.prompt);
  const slug = `cron-${hash}`;

  // Snapshot prior on-disk state for rollback. Read BEFORE write so a
  // reconcile-failure rollback can restore exactly what was there
  // (handles the rare hash-collision / pre-seeded-file case).
  let priorContent: string | null = null;
  try {
    const prior = listOverlayEntries(agent, { root: opts.root }).find(
      (e) => e.slug === slug,
    );
    if (prior) priorContent = prior.raw;
  } catch {
    /* ignore — rollback degrades to delete */
  }

  const path = writeOverlayEntry(agent, slug, yamlText, { root: opts.root });

  // Default reconcile: production hot-apply. Tests override via the
  // `reconcile` param; when `opts.root` is supplied (test-only) we also
  // default reconcile off, because the test harness doesn't have a
  // real switchroom.yaml on disk.
  const reconcileFn =
    opts.reconcile === undefined
      ? (opts.root ? null : reconcileAgentCronOnly)
      : opts.reconcile;
  if (reconcileFn) {
    const rr = reconcileFn(agent);
    if (!rr.ok) {
      // Rollback: delete the just-written file (or restore prior content
      // if there was one). Best-effort — log if rollback itself fails.
      try {
        if (priorContent !== null) {
          writeOverlayEntry(agent, slug, priorContent, { root: opts.root });
        } else {
          deleteOverlayEntry(agent, slug, { root: opts.root });
        }
      } catch {
        /* rollback failure: caller still gets E_RECONCILE_FAILED */
      }
      return {
        ok: false,
        code: "E_RECONCILE_FAILED",
        message: `overlay write succeeded but reconcile failed: ${rr.error}`,
        exit: 10,
      };
    }
  }

  return {
    ok: true,
    slug,
    path,
    cron_hash: hash,
    would_recreate: false,
    restart_required: scheduleRestartRequired(),
    restart_hint: scheduleLiveNote(agent),
  };
}

/**
 * Stage-or-add wrapper used by the CLI / MCP path. Calls
 * {@link scheduleAdd}; if it rejects with one of the three
 * approval-gated codes, stages the entry under `.pending/` and
 * returns a {@link ScheduleStagedResult} (exit 0 — the request was
 * recorded, not denied). All other failures pass through unchanged.
 *
 * Why this lives next to `scheduleAdd` rather than inside it: the
 * direct write path is used by tests + the legacy operator CLI where
 * a reject should remain a reject. The MCP path explicitly wants
 * the approval flow.
 */
export function scheduleAddOrStage(
  opts: AddOpts,
): ScheduleAddResult | ScheduleStagedResult | ScheduleErrorResult {
  const r = scheduleAdd(opts);
  if (r.ok) return r;
  let stageReason: PendingReasonCode | null = null;
  if (r.code === "E_OVERLAY_SECRETS_REQUIRES_APPROVAL") stageReason = "secrets_requires_approval";
  else if (r.code === "E_CRON_TOO_FREQUENT") stageReason = "cron_too_frequent";
  else if (r.code === "E_QUOTA_EXCEEDED") stageReason = "quota_exceeded";
  if (stageReason === null) return r;

  const agent = resolveTargetAgent(opts.agent);
  const entry: {
    cron: string;
    prompt: string;
    secrets?: string[];
    name?: string;
    model?: string;
    context?: "fresh" | "agent";
  } = {
    cron: opts.cronExpr,
    prompt: opts.prompt,
  };
  if (opts.secrets && opts.secrets.length > 0) entry.secrets = opts.secrets;
  if (opts.name) entry.name = opts.name;
  if (opts.model) entry.model = opts.model;
  if (opts.context) entry.context = opts.context;

  // Reconstruct the YAML body we WOULD have written. Mirrors the
  // scheduleAdd doc-build (filter `name` out of the schedule entry;
  // stash agent-facing name in a leading comment for round-trip).
  const doc: Record<string, unknown> = {
    schedule: [
      Object.fromEntries(Object.entries(entry).filter(([k]) => k !== "name")),
    ],
  };
  const yamlText =
    (opts.name ? `# name: ${opts.name}\n` : "") + yamlStringify(doc);

  const summary = (() => {
    const parts: string[] = [`cron=${opts.cronExpr}`];
    if (opts.secrets?.length) parts.push(`secrets=[${opts.secrets.join(",")}]`);
    parts.push(`prompt=${opts.prompt.slice(0, 60)}${opts.prompt.length > 60 ? "…" : ""}`);
    return parts.join(" ");
  })();

  const staged = stagePendingScheduleEntry({
    agent,
    yamlText,
    reason: stageReason,
    summary,
    entry,
    root: opts.root,
  });
  return {
    ok: true,
    staged: true,
    stage_id: staged.stageId,
    reason: stageReason,
    summary,
    yaml_path: staged.yamlPath,
  };
}

export interface ScheduleRemoveResult {
  ok: true;
  slug: string;
  path: string;
  /** `false` by default (hot-reload removes the entry within ~30s); `true`
   *  only when `SWITCHROOM_SCHEDULER_HOT_RELOAD=0`. */
  restart_required: boolean;
  restart_hint: string;
}

export function scheduleRemove(opts: RemoveOpts): ScheduleRemoveResult | ScheduleErrorResult {
  const agent = resolveTargetAgent(opts.agent);
  if (!opts.name && !opts.cronHash) {
    return {
      ok: false,
      code: "E_INVALID_CRON",
      message: "schedule_remove requires `name` or `cron_hash`",
      exit: 1,
    };
  }
  const entries = listOverlayEntries(agent, { root: opts.root });
  let match: { slug: string; path: string } | null = null;
  if (opts.cronHash) {
    const targetSlug = `cron-${opts.cronHash}`;
    const hit = entries.find((e) => e.slug === targetSlug);
    if (hit) match = hit;
  } else if (opts.name) {
    for (const e of entries) {
      // Match `# name: <name>` comment header OR a top-level `name:` line.
      const re = new RegExp(`(^|\\n)#\\s*name:\\s*${opts.name}\\s*(\\n|$)`);
      if (re.test(e.raw)) {
        match = e;
        break;
      }
      // Also handle parsed doc with name at top level (future-proofing).
      try {
        const parsed = parseYaml(e.raw) as { name?: string };
        if (parsed && parsed.name === opts.name) {
          match = e;
          break;
        }
      } catch {
        /* skip */
      }
    }
  }
  if (!match) {
    return {
      ok: false,
      code: "E_NOT_FOUND",
      message: `no overlay entry found for ${opts.name ? `name=${opts.name}` : `cron_hash=${opts.cronHash}`}`,
      exit: 1,
    };
  }
  // Capture prior content for rollback before we delete.
  let priorContent: string | null = null;
  try {
    if (existsSync(match.path)) priorContent = readFileSync(match.path, "utf-8");
  } catch {
    /* ignore — reconcile failure rollback will just be a no-op */
  }
  deleteOverlayEntry(agent, match.slug, { root: opts.root });

  const reconcileFn =
    opts.reconcile === undefined
      ? (opts.root ? null : reconcileAgentCronOnly)
      : opts.reconcile;
  if (reconcileFn) {
    const rr = reconcileFn(agent);
    if (!rr.ok) {
      // Rollback: restore the deleted file's content.
      try {
        if (priorContent !== null) {
          writeOverlayEntry(agent, match.slug, priorContent, { root: opts.root });
        }
      } catch {
        /* best-effort */
      }
      return {
        ok: false,
        code: "E_RECONCILE_FAILED",
        message: `overlay delete succeeded but reconcile failed: ${rr.error}`,
        exit: 10,
      };
    }
  }
  return {
    ok: true,
    slug: match.slug,
    path: match.path,
    restart_required: scheduleRestartRequired(),
    restart_hint: scheduleLiveNote(agent),
  };
}

export function registerAgentConfigWriteCommands(program: Command): void {
  const schedule = program
    .command("schedule")
    .description("Add / remove an agent's scheduled cron entries (overlay-backed)");

  schedule
    .command("add")
    .description("Append a schedule entry to the agent's overlay dir")
    .requiredOption("--cron <expr>", "Cron expression")
    .requiredOption("--prompt <text>", "Prompt to fire at the scheduled time")
    .option("--agent <name>", "Target agent (defaults to $SWITCHROOM_AGENT_NAME)")
    .option("--secrets <list>", "Comma-separated vault keys (REJECTED for agent-authored overlays)")
    .option("--name <slug>", "Optional human-readable name (a-z 0-9 -)")
    .option(
      "--model <id>",
      "Cheap-cron tier hint: a known-cheap model (sonnet/haiku) routes this fire to a fresh, minimal-context cron session (Tier 1) instead of the agent's full live session (Tier 2), cutting token cost. Active by default; SWITCHROOM_CHEAP_CRON=0 is the kill-switch.",
    )
    .option(
      "--context <mode>",
      "Tier hint: 'fresh' (minimal-context cheap session) or 'agent' (full live session). Unset → inferred from --model.",
    )
    .option(
      "--stage-on-reject",
      "When a security gate trips (secrets/quota/min-interval), stage the entry under .pending/ for operator approval instead of rejecting with exit 9. Used by the MCP path; operator CLI defaults to off.",
    )
    .action(async (opts: {
      agent?: string;
      cron: string;
      prompt: string;
      secrets?: string;
      name?: string;
      model?: string;
      context?: string;
      stageOnReject?: boolean;
    }) => {
      if (opts.context && opts.context !== "fresh" && opts.context !== "agent") {
        emitError("E_INVALID_PROMPT", "--context must be 'fresh' or 'agent'");
        process.exit(1);
      }
      const secrets = opts.secrets
        ? opts.secrets.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      if (opts.name && !/^[a-z0-9-]{1,40}$/.test(opts.name)) {
        emitError("E_INVALID_PROMPT", "name must match [a-z0-9-]{1,40}");
        try {
          appendAudit(opts.agent ?? "<unknown>", "schedule.add", { ...opts, ok: false, code: "E_INVALID_PROMPT" }, 1);
        } catch { /* ignore */ }
        process.exit(1);
      }
      let r: ScheduleAddResult | ScheduleStagedResult | ScheduleErrorResult;
      let resolvedAgent = opts.agent ?? "<unknown>";
      try {
        const addFn = opts.stageOnReject ? scheduleAddOrStage : scheduleAdd;
        r = addFn({
          agent: opts.agent,
          cronExpr: opts.cron,
          prompt: opts.prompt,
          secrets,
          name: opts.name,
          model: opts.model,
          context: opts.context as "fresh" | "agent" | undefined,
        });
      } catch (err) {
        // Cross-agent denial path (matches read-side: exit 7).
        process.stderr.write(`${(err as Error).message}\n`);
        appendAudit(resolvedAgent, "schedule.add", { ...opts, ok: false }, 7);
        process.exit(7);
      }
      if (opts.agent) resolvedAgent = opts.agent;
      else if (process.env.SWITCHROOM_AGENT_NAME) resolvedAgent = process.env.SWITCHROOM_AGENT_NAME;
      if (!r.ok) {
        emitError(r.code, r.message, r.meta ?? {});
        appendAudit(
          resolvedAgent,
          "schedule.add",
          { cron: opts.cron, prompt: opts.prompt, name: opts.name, code: r.code, would_recreate: false },
          r.exit,
        );
        process.exit(r.exit);
      }
      if ("staged" in r) {
        process.stdout.write(JSON.stringify({
          ok: true,
          staged: true,
          stage_id: r.stage_id,
          reason: r.reason,
          summary: r.summary,
          yaml_path: r.yaml_path,
        }) + "\n");
        appendAudit(
          resolvedAgent,
          "schedule.add",
          { cron: opts.cron, prompt: opts.prompt, name: opts.name, staged: true, stage_id: r.stage_id, reason: r.reason },
          0,
        );
        return;
      }
      process.stdout.write(JSON.stringify({
        ok: true,
        slug: r.slug,
        cron_hash: r.cron_hash,
        path: r.path,
        would_recreate: false,
        restart_required: r.restart_required,
        restart_hint: r.restart_hint,
      }) + "\n");
      appendAudit(
        resolvedAgent,
        "schedule.add",
        { cron: opts.cron, prompt: opts.prompt, name: opts.name, cron_hash: r.cron_hash, would_recreate: false },
        0,
      );
    });

  const pending = schedule
    .command("pending")
    .description("Manage agent-requested schedule entries awaiting operator approval");

  /** Defense-in-depth: see {@link checkOperatorContext} for limits. */
  function requireOperatorContext(verb: string): void {
    const r = checkOperatorContext(verb);
    if (!r.ok) {
      emitError("E_OPERATOR_ONLY", r.message);
      process.exit(7);
    }
  }

  pending
    .command("list")
    .description("List entries staged by the agent and awaiting approval")
    .requiredOption("--agent <name>", "Target agent")
    .action(async (opts: { agent: string }) => {
      requireOperatorContext("list");
      // Bypass resolveTargetAgent — that helper enforces the
      // env-pin equality check used by agent-authored writes. The
      // pending verbs are operator-only (see requireOperatorContext)
      // and explicitly take any agent name on the host.
      const agent = opts.agent;
      const entries = listPendingScheduleEntries(agent);
      process.stdout.write(
        JSON.stringify({
          ok: true,
          agent,
          count: entries.length,
          entries: entries.map((e) => ({
            stage_id: e.stageId,
            staged_at: e.meta.staged_at,
            reason: e.meta.reason,
            summary: e.meta.summary,
            entry: e.meta.entry,
            yaml_path: e.yamlPath,
          })),
        }) + "\n",
      );
    });

  pending
    .command("commit <stageId>")
    .description("Approve a staged entry — moves it into the live schedule.d/ and reconciles")
    .requiredOption("--agent <name>", "Target agent")
    .action(async (stageId: string, opts: { agent: string }) => {
      requireOperatorContext("commit");
      const agent = opts.agent;
      const r = commitPendingScheduleEntry({ agent, stageId });
      if (!r.committed) {
        if (r.reason === "slug_collision") {
          emitError(
            "E_SLUG_COLLISION",
            `pending entry ${stageId} cannot be committed — a live schedule.d entry with the same slug already exists`,
          );
          appendAudit(agent, "schedule.pending.commit", { stage_id: stageId, ok: false, reason: r.reason }, 9);
          process.exit(9);
        }
        emitError("E_NOT_FOUND", `pending entry ${stageId} not found for agent ${agent}`);
        appendAudit(agent, "schedule.pending.commit", { stage_id: stageId, ok: false }, 1);
        process.exit(1);
      }
      const rr = reconcileAgentCronOnly(agent);
      if (!rr.ok) {
        emitError("E_RECONCILE_FAILED", `committed but reconcile failed: ${rr.error}`);
        appendAudit(agent, "schedule.pending.commit", { stage_id: stageId, slug: r.slug, ok: false, reconcile: rr.error }, 10);
        process.exit(10);
      }
      process.stdout.write(JSON.stringify({ ok: true, stage_id: stageId, slug: r.slug, path: r.path }) + "\n");
      appendAudit(agent, "schedule.pending.commit", { stage_id: stageId, slug: r.slug }, 0);
    });

  pending
    .command("deny <stageId>")
    .description("Discard a staged entry without committing")
    .requiredOption("--agent <name>", "Target agent")
    .action(async (stageId: string, opts: { agent: string }) => {
      requireOperatorContext("deny");
      const agent = opts.agent;
      const r = denyPendingScheduleEntry({ agent, stageId });
      if (!r.denied) {
        emitError("E_NOT_FOUND", `pending entry ${stageId} not found for agent ${agent}`);
        appendAudit(agent, "schedule.pending.deny", { stage_id: stageId, ok: false }, 1);
        process.exit(1);
      }
      process.stdout.write(JSON.stringify({ ok: true, stage_id: stageId, denied: true }) + "\n");
      appendAudit(agent, "schedule.pending.deny", { stage_id: stageId }, 0);
    });

  schedule
    .command("remove")
    .description("Remove an overlay-managed schedule entry by name or cron_hash")
    .option("--agent <name>", "Target agent (defaults to $SWITCHROOM_AGENT_NAME)")
    .option("--name <slug>", "Human-readable name passed at add time")
    .option("--cron-hash <hex>", "12-hex content hash (matches cron-<hash>.yaml)")
    .action(async (opts: { agent?: string; name?: string; cronHash?: string }) => {
      let r: ScheduleRemoveResult | ScheduleErrorResult;
      let resolvedAgent = opts.agent ?? "<unknown>";
      try {
        r = scheduleRemove({
          agent: opts.agent,
          name: opts.name,
          cronHash: opts.cronHash,
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        appendAudit(resolvedAgent, "schedule.remove", { ...opts, ok: false }, 7);
        process.exit(7);
      }
      if (opts.agent) resolvedAgent = opts.agent;
      else if (process.env.SWITCHROOM_AGENT_NAME) resolvedAgent = process.env.SWITCHROOM_AGENT_NAME;
      if (!r.ok) {
        emitError(r.code, r.message, r.meta ?? {});
        appendAudit(resolvedAgent, "schedule.remove", { ...opts, code: r.code }, r.exit);
        process.exit(r.exit);
      }
      process.stdout.write(JSON.stringify({
        ok: true,
        slug: r.slug,
        path: r.path,
        restart_required: r.restart_required,
        restart_hint: r.restart_hint,
      }) + "\n");
      appendAudit(resolvedAgent, "schedule.remove", { ...opts, slug: r.slug }, 0);
    });

  schedule
    .command("report [agent]")
    .description("Cheap-cron cost breakdown from the agent's scheduler.jsonl (Tier 0/1/2 fire counts)")
    .option("--jsonl <path>", "Read a local scheduler.jsonl instead of docker-exec into the container")
    .option("--since <iso>", "Only count fires at/after this ISO timestamp")
    .option("--json", "Emit the summary as JSON")
    .action((agentArg: string | undefined, opts: { jsonl?: string; since?: string; json?: boolean }) => {
      const agent = agentArg ?? process.env.SWITCHROOM_AGENT_NAME;
      if (!agent) {
        process.stderr.write("schedule report: pass an agent name (or set $SWITCHROOM_AGENT_NAME)\n");
        process.exit(2);
      }
      let blob: string;
      if (opts.jsonl) {
        blob = existsSync(opts.jsonl) ? readFileSync(opts.jsonl, "utf-8") : "";
      } else {
        try {
          // Mirrors the inspection pattern used elsewhere: read in-container state.
          blob = execFileSync("docker", ["exec", `switchroom-${agent}`, "cat", "/state/agent/scheduler.jsonl"], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
          });
        } catch {
          process.stderr.write(
            `schedule report: could not read scheduler.jsonl from container switchroom-${agent} ` +
            `(is it running? try --jsonl <path>)\n`,
          );
          process.exit(1);
        }
      }
      const sinceMs = opts.since ? Date.parse(opts.since) : undefined;
      if (opts.since && Number.isNaN(sinceMs)) {
        process.stderr.write(`schedule report: invalid --since '${opts.since}'\n`);
        process.exit(2);
      }
      const summary = summarizeScheduleReport(parseScheduleJsonl(blob), sinceMs ? { sinceMs } : {});
      if (opts.json) {
        process.stdout.write(JSON.stringify({ agent, ...summary }) + "\n");
      } else {
        process.stdout.write(formatScheduleReport(agent, summary) + "\n");
      }
    });
}

void cronUnitName; // imported above for future use; keep tree-shaker honest
