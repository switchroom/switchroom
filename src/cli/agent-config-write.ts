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
import { existsSync, readFileSync } from "node:fs";

const MAX_ENTRIES_PER_AGENT = 20;

type ErrorCode =
  | "E_OVERLAY_SECRETS_REQUIRES_APPROVAL"
  | "E_CRON_TOO_FREQUENT"
  | "E_QUOTA_EXCEEDED"
  | "E_WRITE_REQUIRES_RECREATE"
  | "E_INVALID_CRON"
  | "E_INVALID_PROMPT"
  | "E_NOT_FOUND"
  | "E_RECONCILE_FAILED"
  | "E_INTERNAL";

/**
 * Reconcile DI hook — overridable for tests. Defaults to the live
 * hot-apply path from #1185 via the bridge module.
 */
export type ReconcileFn = (
  agent: string,
) => ReconcileBridgeResult | ReconcileBridgeError;

function emitError(code: ErrorCode, message: string, extra: Record<string, unknown> = {}): void {
  process.stderr.write(JSON.stringify({ code, message, ...extra }) + "\n");
}

function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case "E_OVERLAY_SECRETS_REQUIRES_APPROVAL":
    case "E_CRON_TOO_FREQUENT":
    case "E_QUOTA_EXCEEDED":
    case "E_WRITE_REQUIRES_RECREATE":
      return 9;
    case "E_INVALID_CRON":
    case "E_INVALID_PROMPT":
    case "E_NOT_FOUND":
    case "E_INTERNAL":
      return 1;
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
}

export interface ScheduleErrorResult {
  ok: false;
  code: ErrorCode;
  message: string;
  exit: number;
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
  };
}

export interface ScheduleRemoveResult {
  ok: true;
  slug: string;
  path: string;
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
  return { ok: true, slug: match.slug, path: match.path };
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
    .action(async (opts: {
      agent?: string;
      cron: string;
      prompt: string;
      secrets?: string;
      name?: string;
    }) => {
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
      let r: ScheduleAddResult | ScheduleErrorResult;
      let resolvedAgent = opts.agent ?? "<unknown>";
      try {
        r = scheduleAdd({
          agent: opts.agent,
          cronExpr: opts.cron,
          prompt: opts.prompt,
          secrets,
          name: opts.name,
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
        emitError(r.code, r.message);
        appendAudit(
          resolvedAgent,
          "schedule.add",
          { cron: opts.cron, prompt: opts.prompt, name: opts.name, code: r.code, would_recreate: false },
          r.exit,
        );
        process.exit(r.exit);
      }
      process.stdout.write(JSON.stringify({
        ok: true,
        slug: r.slug,
        cron_hash: r.cron_hash,
        path: r.path,
        would_recreate: false,
      }) + "\n");
      appendAudit(
        resolvedAgent,
        "schedule.add",
        { cron: opts.cron, prompt: opts.prompt, name: opts.name, cron_hash: r.cron_hash, would_recreate: false },
        0,
      );
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
        emitError(r.code, r.message);
        appendAudit(resolvedAgent, "schedule.remove", { ...opts, code: r.code }, r.exit);
        process.exit(r.exit);
      }
      process.stdout.write(JSON.stringify({ ok: true, slug: r.slug, path: r.path }) + "\n");
      appendAudit(resolvedAgent, "schedule.remove", { ...opts, slug: r.slug }, 0);
    });
}

void cronUnitName; // imported above for future use; keep tree-shaker honest
