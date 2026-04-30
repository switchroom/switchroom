import type { Command } from "commander";
import { join } from "node:path";

import {
  computeFingerprint,
  list as listStore,
  prune as pruneStore,
  record as recordStore,
  resolve as resolveStore,
  SEVERITY_RANK,
  type IssueSeverity,
} from "../issues/index.js";

/**
 * `switchroom issues <subcommand>` — write/read the per-agent issue
 * sink. Phase 0.2 of #424. The CLI exists so shell hooks can call it
 * via `bin/run-hook.sh` without re-implementing the JSONL contract.
 *
 * Storage location resolves from $TELEGRAM_STATE_DIR (set by start.sh
 * for every agent process). All subcommands accept --state-dir for
 * explicit override (used by tests and the wrapper script).
 */

const VALID_SEVERITIES: IssueSeverity[] = ["info", "warn", "error", "critical"];

function resolveStateDir(opts: { stateDir?: string }): string {
  if (opts.stateDir) return opts.stateDir;
  const envDir = process.env.TELEGRAM_STATE_DIR;
  if (envDir) return envDir;
  throw new Error(
    "issues: TELEGRAM_STATE_DIR is unset and --state-dir was not passed",
  );
}

function resolveAgentName(opts: { agent?: string }): string {
  if (opts.agent) return opts.agent;
  const envName = process.env.SWITCHROOM_AGENT_NAME;
  if (envName) return envName;
  throw new Error(
    "issues: SWITCHROOM_AGENT_NAME is unset and --agent was not passed",
  );
}

function readDetailFromStdin(): string | undefined {
  // Synchronously read all of stdin. Used by `record --detail-stdin`
  // so callers can pipe stderr through without shell-quoting hell.
  // Cap at 64KB; the store will truncate further to DETAIL_MAX_BYTES.
  const fs = require("node:fs") as typeof import("node:fs");
  try {
    const buf = fs.readFileSync(0, { encoding: "utf-8" });
    return buf || undefined;
  } catch {
    return undefined;
  }
}

export function registerIssuesCommand(program: Command): void {
  const issues = program
    .command("issues")
    .description("Per-agent issue sink — surface silent failures to Telegram");

  issues
    .command("record")
    .description("Record an issue occurrence (coalesces by source+code)")
    .requiredOption("--severity <level>", "info | warn | error | critical")
    .requiredOption("--source <id>", "Stable source id, e.g. hook:handoff")
    .requiredOption("--code <id>", "Machine-readable failure code")
    .requiredOption("--summary <text>", "One-line description")
    .option("--detail <text>", "Optional longer detail (e.g. stderr tail)")
    .option(
      "--detail-stdin",
      "Read --detail from stdin instead of an arg",
      false,
    )
    .option("--agent <name>", "Override SWITCHROOM_AGENT_NAME")
    .option("--state-dir <path>", "Override TELEGRAM_STATE_DIR")
    .option("--quiet", "Don't print the resulting fingerprint to stdout", false)
    .action(
      (opts: {
        severity: string;
        source: string;
        code: string;
        summary: string;
        detail?: string;
        detailStdin?: boolean;
        agent?: string;
        stateDir?: string;
        quiet?: boolean;
      }) => {
        if (!VALID_SEVERITIES.includes(opts.severity as IssueSeverity)) {
          process.stderr.write(
            `issues record: invalid --severity "${opts.severity}" ` +
              `(want one of: ${VALID_SEVERITIES.join(", ")})\n`,
          );
          process.exit(2);
        }
        let detail = opts.detail;
        if (opts.detailStdin) detail = readDetailFromStdin();

        try {
          const stateDir = resolveStateDir(opts);
          const agent = resolveAgentName(opts);
          const event = recordStore(stateDir, {
            agent,
            severity: opts.severity as IssueSeverity,
            source: opts.source,
            code: opts.code,
            summary: opts.summary,
            detail,
          });
          if (!opts.quiet) {
            process.stdout.write(event.fingerprint + "\n");
          }
        } catch (err) {
          process.stderr.write(`issues record: ${(err as Error).message}\n`);
          process.exit(1);
        }
      },
    );

  issues
    .command("resolve [fingerprint]")
    .description("Mark an issue (or all matches) resolved")
    .option("--agent <name>", "Override SWITCHROOM_AGENT_NAME")
    .option("--state-dir <path>", "Override TELEGRAM_STATE_DIR")
    .option(
      "--source <id>",
      "Compose fingerprint from --source + --code instead of passing one",
    )
    .option("--code <id>", "Used with --source")
    .action(
      (
        fingerprint: string | undefined,
        opts: {
          agent?: string;
          stateDir?: string;
          source?: string;
          code?: string;
        },
      ) => {
        try {
          const stateDir = resolveStateDir(opts);
          let fp: string;
          if (opts.source && opts.code) {
            fp = computeFingerprint(opts.source, opts.code);
          } else if (fingerprint) {
            fp = fingerprint;
          } else {
            process.stderr.write(
              "issues resolve: need either <fingerprint> or --source + --code\n",
            );
            process.exit(2);
          }
          const flipped = resolveStore(stateDir, fp);
          process.stdout.write(`${flipped}\n`);
        } catch (err) {
          process.stderr.write(`issues resolve: ${(err as Error).message}\n`);
          process.exit(1);
        }
      },
    );

  issues
    .command("list")
    .description("List current issues from the sink")
    .option("--severity <level>", "Filter to >= this severity")
    .option("--include-resolved", "Include already-resolved entries", false)
    .option("--json", "Emit JSON instead of text", false)
    .option("--state-dir <path>", "Override TELEGRAM_STATE_DIR")
    .action(
      (opts: {
        severity?: string;
        includeResolved?: boolean;
        json?: boolean;
        stateDir?: string;
      }) => {
        try {
          const stateDir = resolveStateDir(opts);
          const events = listStore(stateDir, {
            minSeverity: opts.severity as IssueSeverity | undefined,
            unresolvedOnly: !opts.includeResolved,
          });
          if (opts.json) {
            process.stdout.write(JSON.stringify(events, null, 2) + "\n");
            return;
          }
          if (events.length === 0) {
            process.stdout.write("(no issues)\n");
            return;
          }
          // Sort: highest severity first, then most recent.
          events.sort((a, b) => {
            const ra = SEVERITY_RANK[a.severity];
            const rb = SEVERITY_RANK[b.severity];
            if (rb !== ra) return rb - ra;
            return b.last_seen - a.last_seen;
          });
          for (const e of events) {
            const ago = relTime(Date.now() - e.last_seen);
            const occ = e.occurrences > 1 ? ` (×${e.occurrences})` : "";
            const resolvedTag = e.resolved_at ? " [resolved]" : "";
            process.stdout.write(
              `[${e.severity.padEnd(8)}] ${e.source}::${e.code}  ${e.summary}${occ} — ${ago}${resolvedTag}\n`,
            );
            if (e.detail) {
              for (const line of e.detail.split("\n")) {
                process.stdout.write(`             | ${line}\n`);
              }
            }
          }
        } catch (err) {
          process.stderr.write(`issues list: ${(err as Error).message}\n`);
          process.exit(1);
        }
      },
    );

  issues
    .command("prune")
    .description("Drop entries per retention rules")
    .option(
      "--resolved-older-than-days <n>",
      "Drop resolved entries older than N days",
      "7",
    )
    .option(
      "--unresolved-older-than-days <n>",
      "Drop unresolved entries older than N days (default: never)",
    )
    .option("--state-dir <path>", "Override TELEGRAM_STATE_DIR")
    .action(
      (opts: {
        resolvedOlderThanDays?: string;
        unresolvedOlderThanDays?: string;
        stateDir?: string;
      }) => {
        try {
          const stateDir = resolveStateDir(opts);
          const dayMs = 86_400_000;
          const removed = pruneStore(stateDir, {
            resolvedOlderThanMs: opts.resolvedOlderThanDays
              ? parseFloat(opts.resolvedOlderThanDays) * dayMs
              : undefined,
            unresolvedOlderThanMs: opts.unresolvedOlderThanDays
              ? parseFloat(opts.unresolvedOlderThanDays) * dayMs
              : undefined,
          });
          process.stdout.write(`pruned ${removed}\n`);
        } catch (err) {
          process.stderr.write(`issues prune: ${(err as Error).message}\n`);
          process.exit(1);
        }
      },
    );
}

function relTime(deltaMs: number): string {
  if (deltaMs < 0) return "just now";
  const s = Math.round(deltaMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

// Marker so `state-dir` reach is consistent across subcommand option lookups
// in the test runner; commander coerces --state-dir to .stateDir already, so
// no runtime mapping needed here. Keeping helper imports tree-shakable.
void join;
