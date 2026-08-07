import type { Command } from "commander";
import chalk from "chalk";
import {
  getCollectionForAgent,
  isStrictIsolation,
  collectProfileBanks,
  addMemoryTag,
  DEMOTE_FROM_RECALL_TAG,
} from "../memory/hindsight.js";
import { searchMemory, getMemoryStats, reflectAcrossAgents } from "../memory/search.js";
import {
  planBankCleanup,
  formatCleanupPlan,
  type BankCleanupPlan,
} from "../memory/observation-scope-cleanup.js";
import { redactMemoryWriteBody } from "../memory/hindsight-write-redaction.js";
import { withConfigError, getConfig, getConfigPath } from "./helpers.js";
import {
  isDockerAvailable,
  isHindsightRunning,
  isHindsightContainerExists,
  startHindsight,
  hindsightConsumerMirrorDir,
  stopHindsight,
  getHindsightStatus,
  generateHindsightComposeSnippet,
  pickHindsightPorts,
  pullHindsightImage,
  getRunningHindsightPorts,
  getHindsightContainerEnv,
  getHindsightImageEnv,
  hindsightContainerEnvPairs,
  hindsightMemBudgetWarningFor,
  hindsightResolvedCapabilities,
  preflightHindsightPorts,
  getHindsightDeviceRequests,
  hindsightGpuDecision,
  resolveHindsightGpuOverride,
  resolveHindsightCpAccessKey,
  resolveHindsightLlmSecrets,
  diffDroppedHindsightLlmVaultKeys,
  hindsightLlmDroppedKeyWarning,
  HINDSIGHT_CP_NO_ACCESS_KEY_WARNING,
  HINDSIGHT_DEFAULT_API_PORT,
  HINDSIGHT_DEFAULT_MCP_URL,
  resolveHindsightLiteLlm,
  hindsightLiteLlmDroppedKeyWarning,
  type HindsightLiteLlmResolution,
  type HindsightLlmConfig,
} from "../setup/hindsight.js";
import { assessHindsightGpuDrop } from "../setup/hindsight-gpu-guard.js";
import {
  diffDroppedHindsightEnv,
  formatDroppedHindsightEnvReport,
} from "../setup/hindsight-env-drift.js";
import {
  buildRepairBankArgv,
  classifyRepairPreflight,
  fetchHindsightApiVersion,
  parseRepairSummary,
  classifyRepairOutcome,
  HINDSIGHT_CONTAINER_NAME,
  REPAIR_FAILED_EXIT,
} from "../memory/hindsight-repair.js";
import { isVaultReference } from "../vault/resolver.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { writeConfigFileSync } from "../util/atomic.js";
import { join } from "node:path";
import { resolveAgentsDir } from "../config/loader.js";
import YAML from "yaml";
import type { SwitchroomConfig } from "../config/schema.js";
import { normalizeHindsightVersionTag } from "../setup/hindsight.js";

/**
 * Read-modify-write switchroom.yaml to set `memory.config.url` (and
 * `provider` when absent) so agents pick up the freshly-started Hindsight
 * endpoint. Extracted from the `memory setup` action so the persistence —
 * and its atomicity contract — can be unit-tested without starting a
 * container.
 *
 * Atomic (tmp + fsync + rename, bind-mount-aware via writeConfigFileSync)
 * so a crash / ENOSPC mid-write can never truncate the operator's config —
 * the prior in-place writeFileSync could leave a torn / empty switchroom.yaml
 * (2026-07 review, F2). Preserves the file's existing mode.
 *
 * Returns true when the config was updated, false when `configPath` does
 * not exist (the caller treats a missing config as a soft skip). Any I/O
 * error propagates to the caller, which renders a manual-edit hint.
 */
export function persistMemoryConfigUrl(
  configPath: string,
  provider: string,
  url: string,
): boolean {
  if (!existsSync(configPath)) return false;
  const raw = readFileSync(configPath, "utf-8");
  const doc = YAML.parseDocument(raw);
  if (!doc.has("memory")) {
    doc.set("memory", { backend: "hindsight", shared_collection: "shared", config: { provider, url } });
  } else {
    const memNode = doc.get("memory") as YAML.YAMLMap;
    if (!memNode.has("config")) {
      memNode.set("config", { provider, url });
    } else {
      const configNode = memNode.get("config") as YAML.YAMLMap;
      configNode.set("url", url);
      if (!configNode.has("provider")) {
        configNode.set("provider", provider);
      }
    }
  }
  let mode = 0o644;
  try {
    mode = statSync(configPath).mode & 0o777;
  } catch {
    /* default 0o644 */
  }
  writeConfigFileSync(configPath, doc.toString(), mode);
  return true;
}

/**
 * Decide which hindsight image tag `memory setup` should pull + run, and
 * why. Pure so it can be unit-tested without touching Docker or config I/O.
 *
 * Resolution order:
 *   1. An explicit `--tag latest` force-floats to `:latest` (the operator
 *      explicitly asked to un-pin) → `{ tag: undefined, reason: "explicit-latest" }`.
 *   2. Any other explicit `--tag` always wins — but it MUST normalize to a
 *      canonical `vX.Y.Z` → `{ tag: <normalized>, reason: "explicit" }`.
 *      A non-normalizable explicit tag (sha-…, garbage) returns
 *      `reason: "invalid"` and the caller must fail loudly: hindsightImageRef
 *      floats anything it can't normalize to `:latest`, so silently passing
 *      garbage through would print one tag and run another — the exact
 *      silent-un-pin footgun #2857 exists to close.
 *   3. No `--tag`, but the fleet has a persisted `release.pin` that
 *      normalizes to `vX.Y.Z` → default to it so a manual recreate on a
 *      pinned fleet doesn't silently un-pin hindsight → `{ tag, reason: "pin" }`.
 *   4. Otherwise float to `:latest` (the standalone default) →
 *      `{ tag: undefined, reason: "latest" }`.
 */
export function resolveMemorySetupTag(input: {
  explicitTag?: string;
  releasePin?: string;
}): {
  tag: string | undefined;
  reason: "explicit" | "explicit-latest" | "pin" | "latest" | "invalid";
} {
  const explicit = input.explicitTag?.trim();
  if (explicit) {
    if (explicit.toLowerCase() === "latest") {
      return { tag: undefined, reason: "explicit-latest" };
    }
    const normalized = normalizeHindsightVersionTag(explicit);
    if (!normalized) return { tag: explicit, reason: "invalid" };
    return { tag: normalized, reason: "explicit" };
  }
  const pin = normalizeHindsightVersionTag(input.releasePin);
  if (pin) return { tag: pin, reason: "pin" };
  return { tag: undefined, reason: "latest" };
}

/**
 * Whether `memory docker-compose`'s unresolved-by-default snippet (#4487)
 * actually carries a `vault:` ref anywhere the emit path reads a secret from
 * — the global/per-op LLM `api_key` fields and `cp_access_key`. Used only to
 * decide whether the "these refs are unresolved" note is accurate; the
 * refs themselves are never touched here (that's `resolveHindsightLlmSecrets`
 * / `resolveHindsightCpAccessKey`, gated behind `--resolve-secrets`).
 */
function hasUnresolvedHindsightVaultRef(config: SwitchroomConfig): boolean {
  const hindsight = (config as { hindsight?: { cp_access_key?: string; llm?: HindsightLlmConfig } })
    .hindsight;
  const isRef = (v?: string) => typeof v === "string" && isVaultReference(v);
  if (isRef(hindsight?.cp_access_key)) return true;
  const llm = hindsight?.llm;
  if (!llm) return false;
  if (isRef(llm.api_key)) return true;
  for (const op of ["retain", "reflect", "consolidation"] as const) {
    if (isRef(llm[op]?.api_key)) return true;
  }
  return false;
}

/**
 * Resolve LiteLLM routing config for the hindsight container, plus the
 * `vault:` reference that was DROPPED when the key could not be resolved.
 *
 * A thin delegator to {@link resolveHindsightLiteLlm} (`src/setup/hindsight.ts`),
 * which owns the resolution, the capability-token forwarding (#1053) and the
 * fail-safe that never returns a literal `vault:…` string. The `litellm` half
 * is passed to `startHindsight()` to enable host-network mode and inject the
 * proxy env vars; the `droppedRef` half is what the launch site must TELL the
 * operator about instead of silently launching an unmetered container.
 */
async function resolveLiteLLMForHindsight(
  config: SwitchroomConfig,
): Promise<HindsightLiteLlmResolution> {
  return resolveHindsightLiteLlm(config);
}

interface RecallLogEntry {
  ts: string;
  session_id?: string;
  bank_id?: string;
  additional_banks?: string[];
  query_chars?: number;
  result_count?: number | null;
  directive_count?: number | null;
  /**
   * Directives the cap silently dropped before the prompt was assembled
   * (`count_omitted_directives`, vendor/hindsight-memory/scripts/lib/directives.py).
   * recall.py writes it on every row; it is surfaced here and in the human
   * view because a dropped directive is invisible to the agent by
   * construction — this is how an operator learns a rule stopped being
   * enforced (2026-07-25 re-review M2; `switchroom doctor` carries the same
   * signal).
   */
  directives_omitted?: number | null;
  demoted_count?: number;
  capped?: boolean;
  pre_cap_count?: number;
  memory_ids?: string[];
  /**
   * Recall QUALITY telemetry (#3541): min/median/max of the engine's
   * `scores.final` across the memories actually INJECTED (post-head-slice).
   * Every other field on this row measures VOLUME, and volume alone cannot
   * distinguish "the reranker is working" from "the agent is being fed
   * `max_memories` mediocre memories every turn" — a distinction that
   * matters now that the overlap gate is a near-passthrough floor at 0.10
   * and precision rests entirely on `scores.final` plus the head-slice.
   * `null` on cache-hit rows (no result set) and when no result carried a
   * usable score. Written by `_injected_score_stats` in recall.py.
   */
  injected_score_min?: number | null;
  injected_score_median?: number | null;
  injected_score_max?: number | null;
  /**
   * Bank-composition telemetry (#3775): how the injected result set split
   * between the agent's OWN bank and any additional (shared/peer) banks.
   * `injected_own_bank_count + injected_additional_bank_count` sums to
   * `result_count`; an unstamped memory counts as ADDITIONAL, so `own` is
   * never optimistic (`_injected_bank_composition`, recall.py). The
   * `reserved_*_slots` pair is the reservation FLOOR each side was granted
   * before the head-slice cap applied (recall.py). These are the regression
   * detectors the scaffold/schema docs tell operators to watch: when own-bank
   * recall collapses to 0 while additional stays high, the agent has quietly
   * stopped seeing its own memory even though `result_count` still looks full.
   * Before this they were reachable only under `--json`, so the documented
   * remedy ("observe `injected_own_bank_count` via `memory recall-log`") did
   * not actually work.
   */
  injected_own_bank_count?: number | null;
  injected_additional_bank_count?: number | null;
  reserved_own_slots?: number | null;
  reserved_additional_slots?: number | null;
  cache_hit?: boolean;
}

/**
 * Read the most recent N entries from an agent's recall_log.jsonl.
 *
 * Path: <agentsDir>/<agent>/.claude/plugins/data/hindsight-memory-inline/state/recall_log.jsonl
 * Returns [] if the file is missing (e.g. agent hasn't fired a recall
 * since #432 phase 4.3 was deployed) or unreadable.
 *
 * Exported for tests.
 */
export function readRecallLog(
  agentDir: string,
  limit: number,
): RecallLogEntry[] {
  const path = join(
    agentDir,
    ".claude",
    "plugins",
    "data",
    "hindsight-memory-inline",
    "state",
    "recall_log.jsonl",
  );
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const tail = lines.slice(-limit);
  const out: RecallLogEntry[] = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line) as RecallLogEntry);
    } catch {
      // Skip malformed lines silently — telemetry is best-effort.
    }
  }
  return out;
}

/**
 * Render the human (non-`--json`) view of `switchroom memory recall-log` for
 * one agent: a bold header, an aggregate summary line, then one line per turn.
 *
 * Extracted from the command action so the rendering is testable as an
 * outcome. Assumes `entries` is non-empty (the caller handles the empty case).
 */
export function formatRecallLogView(
  name: string,
  entries: RecallLogEntry[],
): string[] {
  const lines: string[] = [chalk.bold(`\n${name}:`)];

  // Aggregate at the top — one-line summary so scanning is fast.
  const total = entries.length;
  const hits = entries.filter((e) => e.cache_hit).length;
  const cappedTurns = entries.filter((e) => e.capped).length;
  // M2: a directive dropped by the cap never reaches the agent, so the recall
  // log is the only place it is observable. Roll it into the summary AND flag
  // it per-row — before this it was visible only under `--json`, while doctor
  // and the vendored plugin both described it as operator-visible.
  const omittedTurns = entries.filter(
    (e) => typeof e.directives_omitted === "number" && e.directives_omitted > 0,
  ).length;
  const memCounts = entries
    .map((e) => e.result_count)
    .filter((n): n is number => typeof n === "number");
  const avg =
    memCounts.length > 0
      ? Math.round((memCounts.reduce((s, n) => s + n, 0) / memCounts.length) * 10) / 10
      : null;
  const max = memCounts.length > 0 ? Math.max(...memCounts) : null;
  // #3541 — mean of the per-turn MEDIAN injected relevance score. The volume
  // stats above (`avg`/`max`) rise identically whether recall got better or
  // just fuller, so a summary without a quality number is exactly the blind
  // spot that let the overlap-gate regression read as healthy.
  const medians = entries
    .map((e) => e.injected_score_median)
    .filter((n): n is number => typeof n === "number");
  const avgScore =
    medians.length > 0
      ? Math.round((medians.reduce((s, n) => s + n, 0) / medians.length) * 100) / 100
      : null;
  // #3775 — own-bank collapse detector. Count the turns where the agent got a
  // non-empty result set but NONE of it came from its own bank (own=0 while
  // additional>0). That is the exact regression the composition telemetry
  // exists to catch: `result_count` still looks full, so every volume stat
  // above reads healthy, while the agent has silently stopped seeing its own
  // memory. A turn with no composition stamp (own/additional both absent) is
  // not counted — absence of data is not a collapse.
  const collapseTurns = entries.filter(
    (e) =>
      typeof e.injected_own_bank_count === "number" &&
      e.injected_own_bank_count === 0 &&
      typeof e.injected_additional_bank_count === "number" &&
      e.injected_additional_bank_count > 0,
  ).length;
  lines.push(
    chalk.gray(
      `  last ${total} turn${total === 1 ? "" : "s"}: ` +
      `avg=${avg ?? "—"} max=${max ?? "—"} ` +
      `avg_score=${avgScore ?? "—"} ` +
      `cache_hits=${hits} capped=${cappedTurns}` +
      (omittedTurns > 0 ? ` directives_omitted_turns=${omittedTurns}` : "") +
      (collapseTurns > 0 ? chalk.red(` own_bank_collapse_turns=${collapseTurns}`) : ""),
    ),
  );

  for (const e of entries) {
    const flag = e.cache_hit
      ? chalk.cyan("CACHE")
      : e.capped
        ? chalk.yellow("CAP")
        : chalk.green("OK");
    const dem = e.demoted_count && e.demoted_count > 0
      ? chalk.dim(` -${e.demoted_count}d`)
      : "";
    const omitted =
      typeof e.directives_omitted === "number" && e.directives_omitted > 0
        ? chalk.yellow(` +${e.directives_omitted}omitted`)
        : "";
    const ids = e.memory_ids && e.memory_ids.length > 0
      ? chalk.dim(` ids=${e.memory_ids.slice(0, 3).join(",")}${e.memory_ids.length > 3 ? `…+${e.memory_ids.length - 3}` : ""}`)
      : "";
    // #3775 — the own/additional split. Shown whenever either side carries a
    // count. `own=0` while additional>0 is the collapse the summary flags, so
    // paint that row's split red; otherwise it's dim like the other detail.
    const own = e.injected_own_bank_count;
    const additional = e.injected_additional_bank_count;
    const composition =
      typeof own === "number" || typeof additional === "number"
        ? (() => {
            const text = ` own/add=${own ?? "—"}/${additional ?? "—"}`;
            return own === 0 && typeof additional === "number" && additional > 0
              ? chalk.red(text)
              : chalk.dim(text);
          })()
        : "";
    // #3541 — the quality half of the row. Volume without score range reads
    // as success whether the injected memories are relevant or not.
    const score =
      typeof e.injected_score_min === "number" &&
      typeof e.injected_score_median === "number" &&
      typeof e.injected_score_max === "number"
        ? chalk.dim(
            ` score=${e.injected_score_min.toFixed(2)}/` +
            `${e.injected_score_median.toFixed(2)}/` +
            `${e.injected_score_max.toFixed(2)}`,
          )
        : "";
    lines.push(
      `  ${chalk.gray(e.ts)} ${flag} ` +
      `n=${e.result_count ?? "—"}${e.pre_cap_count != null && e.pre_cap_count !== e.result_count ? `/${e.pre_cap_count}` : ""}` +
      `${dem}${omitted}${score}${composition}${ids}`,
    );
  }

  return lines;
}

export function registerMemoryCommand(program: Command): void {
  const memory = program
    .command("memory")
    .description("Hindsight memory operations");

  // switchroom memory search <query>
  memory
    .command("search <query>")
    .description("Search agent memories via Hindsight")
    .option("-a, --agent <name>", "Search a specific agent's collection")
    .action(
      withConfigError(async (query: string, opts: { agent?: string }) => {
        const config = getConfig(program);

        if (opts.agent) {
          if (!config.agents[opts.agent]) {
            console.error(chalk.red(`Agent "${opts.agent}" is not defined in switchroom.yaml`));
            process.exit(1);
          }
          const collection = getCollectionForAgent(opts.agent, config);
          console.log(chalk.bold(`\nSearch: ${opts.agent} (collection: ${collection})\n`));
          console.log(chalk.gray(`  $ ${searchMemory(query, collection)}`));
          console.log();
          return;
        }

        // Search all non-strict collections
        const agentNames = Object.keys(config.agents);
        console.log(chalk.bold(`\nSearching all eligible collections:\n`));

        for (const name of agentNames) {
          const collection = getCollectionForAgent(name, config);
          if (isStrictIsolation(name, config)) {
            console.log(chalk.gray(`  ${name} (${collection}) — skipped (strict isolation)`));
            continue;
          }
          console.log(chalk.cyan(`  ${name} (${collection}):`));
          console.log(chalk.gray(`    $ ${searchMemory(query, collection)}`));
        }
        console.log();
      }),
    );

  // switchroom memory stats
  memory
    .command("stats")
    .description("List agents with their collection names and isolation mode")
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const agentNames = Object.keys(config.agents);

        if (agentNames.length === 0) {
          console.log(chalk.yellow("No agents defined in switchroom.yaml"));
          return;
        }

        const headers = ["Agent", "Collection", "Isolation", "Auto-recall"];
        const widths = [20, 20, 12, 12];

        const headerLine = headers
          .map((h, i) => chalk.bold(h.padEnd(widths[i])))
          .join("  ");
        console.log(`\n  ${headerLine}`);

        for (const name of agentNames) {
          const collection = getCollectionForAgent(name, config);
          const isolation = isStrictIsolation(name, config) ? "strict" : "default";
          const autoRecall = config.agents[name].memory?.auto_recall ?? true;

          const row = [
            name.padEnd(widths[0]),
            collection.padEnd(widths[1]),
            isolation.padEnd(widths[2]),
            (autoRecall ? "yes" : "no").padEnd(widths[3]),
          ].join("  ");
          console.log(`  ${row}`);
        }

        console.log();

        // Profile banks (per-user / shared) — recall routes to them but no
        // agent owns them, so they don't appear in the agent table above.
        const profileBanks = collectProfileBanks(config);
        if (profileBanks.size > 0) {
          const owners = new Map<string, string[]>();
          for (const [uname, u] of Object.entries(config.users ?? {})) {
            if (u.profile_bank) {
              owners.set(u.profile_bank, [
                ...(owners.get(u.profile_bank) ?? []),
                uname,
              ]);
            }
          }
          console.log(chalk.bold("  Profile banks (per-user / shared):\n"));
          for (const bank of [...profileBanks].sort()) {
            const who = owners.get(bank);
            const label = who ? `user: ${who.join(", ")}` : "shared";
            console.log(`  ${bank.padEnd(widths[1])}  ${chalk.gray(label)}`);
          }
          console.log();
        }

        // Print stats commands
        console.log(chalk.bold("  Hindsight CLI commands:\n"));
        for (const name of agentNames) {
          const collection = getCollectionForAgent(name, config);
          console.log(chalk.gray(`    $ ${getMemoryStats(collection)}`));
        }
        console.log();
      }),
    );

  // switchroom memory reflect
  memory
    .command("reflect")
    .description("Show cross-agent reflection plan")
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const { eligible, excluded, commands } = reflectAcrossAgents(config);

        console.log(chalk.bold("\nCross-agent reflection plan\n"));

        if (eligible.length > 0) {
          console.log(chalk.green("  Eligible collections:"));
          for (const { agent, collection } of eligible) {
            console.log(chalk.white(`    ${agent} -> ${collection}`));
          }
        }

        if (excluded.length > 0) {
          console.log(chalk.red("\n  Excluded (strict isolation):"));
          for (const { agent, collection } of excluded) {
            console.log(chalk.gray(`    ${agent} -> ${collection}`));
          }
        }

        if (commands.length > 0) {
          console.log(chalk.bold("\n  Hindsight CLI commands:\n"));
          for (const cmd of commands) {
            console.log(chalk.gray(`    $ ${cmd}`));
          }
        } else {
          console.log(chalk.yellow("\n  No eligible collections for reflection."));
        }
        console.log();
      }),
    );

  // switchroom memory setup
  memory
    .command("setup")
    .description("Manage the Hindsight Docker container")
    .option("--stop", "Stop and remove the Hindsight container")
    .option("--status", "Show Hindsight container status")
    .option(
      "--recreate",
      "Pull the latest image and recreate the container (reusing its current port). Used by `switchroom update` to keep the hindsight singleton current. Also required after any `hindsight.llm` model/provider config change — env is only re-derived on recreate, a plain docker restart is not enough (see docs/operators/hindsight-model-change.md).",
    )
    .option(
      "--tag <version>",
      "Pin the hindsight image tag to pull + run (e.g. v0.15.18), overriding the " +
        "default floating `:latest`. Threaded through by `switchroom rollout` so a " +
        "version-pinned roll recreates hindsight on the SAME tag as the rest of the " +
        "fleet. Omit for `:latest` (the standalone default).",
    )
    .option("--provider <provider>", "LLM provider (ollama, openai, anthropic)")
    .option(
      "--strict-env",
      "Refuse the recreate (before the running container is touched) if it would drop " +
        "env vars that are live on the container but declared in neither `hindsight.env` " +
        "nor switchroom's managed defaults. Default is to warn loudly and proceed, so a " +
        "rollout is never wedged half-way with memory down.",
    )
    // `--gpu` MUST be declared before `--no-gpu`: commander only leaves the
    // pair's default `undefined` (i.e. "operator said nothing") when the
    // positive form is defined first. Declared alone, `--no-gpu` would default
    // `opts.gpu` to `true` and silently force GPU on every host.
    .option(
      "--gpu",
      "Force GPU passthrough on for this launch, overriding host autodetection. " +
        "Use when `~/.switchroom/host-capabilities.json` is wrong or unreadable and " +
        "you know the host has a working nvidia container toolkit (`docker run --gpus " +
        "all` hard-fails container create without one). Beats `hindsight.gpu`.",
    )
    .option(
      "--no-gpu",
      "Force GPU passthrough off for this launch, overriding host autodetection. " +
        "Also the explicit opt-out for the recreate GPU drop guard.",
    )
    .option(
      "--allow-gpu-drop",
      "Proceed with a --recreate that would take GPU passthrough away from the " +
        "running container. Without this the recreate refuses, because that drop " +
        "moves the embedding model and cross-encoder reranker to CPU on the " +
        "interactive recall path with no other signal.",
    )
    .action(async (opts: { stop?: boolean; status?: boolean; recreate?: boolean; tag?: string; provider?: string; strictEnv?: boolean; gpu?: boolean; allowGpuDrop?: boolean }) => {
      if (opts.status) {
        if (!isDockerAvailable()) {
          console.log(chalk.red("  Docker is not available."));
          process.exit(1);
        }
        const status = getHindsightStatus();
        if (status) {
          console.log(chalk.bold("\n  Hindsight container status:"));
          console.log(`  ${chalk.cyan("switchroom-hindsight")}: ${status}\n`);
        } else {
          console.log(chalk.yellow("\n  Hindsight container not found.\n"));
          console.log(chalk.gray("  Run 'switchroom memory setup' to start it."));
        }
        return;
      }

      if (opts.stop) {
        if (!isDockerAvailable()) {
          console.log(chalk.red("  Docker is not available."));
          process.exit(1);
        }
        if (!isHindsightContainerExists()) {
          console.log(chalk.yellow("  No switchroom-hindsight container found."));
          return;
        }
        console.log(chalk.gray("  Stopping switchroom-hindsight..."));
        stopHindsight();
        console.log(chalk.green("  Hindsight container stopped and removed."));
        return;
      }

      // Default: start the container (or, with --recreate, pull the
      // latest image and recreate it — used by `switchroom update`).
      if (!isDockerAvailable()) {
        console.log(chalk.red("\n  Docker is not available."));
        console.log(chalk.gray("  Install Docker: https://docs.docker.com/get-docker/\n"));
        process.exit(1);
      }

      const recreate = opts.recreate === true;

      // Resolve the hindsight LLM config's `vault:` api_key refs ONCE for this
      // invocation, memoized, so both the env-drift compare and the launch
      // below reuse the SAME resolved value instead of each firing its own
      // (up to 4) broker round-trips. Resolution happens through the broker —
      // apply's passphrase resolver never runs on the recreate path, so an
      // unresolved literal `vault:…` would bake into the container env and fail
      // every retain (2026-08-06 outage).
      let resolvedLlmPromise: ReturnType<typeof resolveHindsightLlmSecrets> | undefined;
      const getResolvedLlm = () => {
        if (!resolvedLlmPromise) {
          resolvedLlmPromise = resolveHindsightLlmSecrets(getConfig(program).hindsight?.llm);
        }
        return resolvedLlmPromise;
      };

      // Resolve which image tag to pull + run. Without an explicit --tag,
      // default to the persisted release.pin when the fleet is pinned, so a
      // manual `memory setup --recreate` on a pinned fleet doesn't silently
      // un-pin the hindsight singleton to floating :latest. Explicit --tag
      // always wins; `--tag latest` force-floats. Best-effort config read
      // (mirrors resolveHindsightPinTag): fall back to :latest rather than
      // fail the whole setup if config can't be loaded.
      let releasePin: string | undefined;
      try {
        releasePin = getConfig(program).release?.pin ?? undefined;
      } catch {
        releasePin = undefined;
      }
      const { tag: effectiveTag, reason: tagReason } = resolveMemorySetupTag({
        explicitTag: opts.tag,
        releasePin,
      });
      switch (tagReason) {
        case "invalid":
          // Fail loudly: hindsightImageRef floats anything it can't
          // normalize to :latest, so proceeding would print one tag and
          // run another — a silent un-pin (#2857).
          console.error(
            chalk.red(
              `\n  Invalid hindsight image tag: ${effectiveTag}\n` +
                `  The release workflow only publishes per-version tags. Valid forms:\n` +
                `    vX.Y.Z  (e.g. v0.17.5)\n` +
                `    X.Y.Z   (normalized to vX.Y.Z)\n` +
                `    latest  (explicitly float to :latest)\n`,
            ),
          );
          process.exit(1);
          break;
        case "explicit":
          console.log(chalk.gray(`  Using hindsight image tag ${effectiveTag} (explicit --tag).`));
          break;
        case "explicit-latest":
          console.log(chalk.gray("  Using floating hindsight image :latest (explicit --tag latest)."));
          break;
        case "pin":
          console.log(
            chalk.gray(`  Using hindsight image tag ${effectiveTag} (from persisted release.pin).`),
          );
          break;
        case "latest":
          console.log(chalk.gray("  Using floating hindsight image :latest (standalone default; no pin)."));
          break;
      }

      // --recreate rebinds the SAME host ports the running container
      // currently publishes, so memory.config.url never changes under the
      // fleet. Read them before we stop the container. (null → fall back
      // to pickHindsightPorts, e.g. when nothing is running yet.)
      const reusePorts = recreate ? getRunningHindsightPorts() : null;

      // A plain `setup` on a running container is a no-op; --recreate
      // proceeds (pull + recreate) even when it's up.
      if (isHindsightRunning() && !recreate) {
        console.log(chalk.green("\n  Hindsight container is already running (switchroom-hindsight).\n"));
        return;
      }

      // ── GPU passthrough: decide, report, and guard the drop ──────────────
      //
      // FIRST, because the env-drift guard below needs the same answer: the
      // GPU-gated perf defaults (HINDSIGHT_API_RERANKER_LOCAL_FP16, ..._BATCH_SIZE)
      // are emitted only when this is true, so re-deriving it there would let
      // the drift report disagree with the launch it is predicting.
      //
      // The 2026-07-28 regression: this decision silently evaluated false (the
      // host-capabilities verdict file was root:root 0600 under a uid-1000
      // home, the EACCES was swallowed, and an unreadable file was
      // indistinguishable from "no GPU"). The container came back on CPU with
      // no output at all. Every part of that is now visible here.
      let gpuConfigured: boolean | undefined;
      try {
        gpuConfigured = getConfig(program).hindsight?.gpu;
      } catch {
        gpuConfigured = undefined;
      }
      const gpuDecision = hindsightGpuDecision(
        resolveHindsightGpuOverride({ flag: opts.gpu, config: gpuConfigured }),
      );
      console.log(
        (gpuDecision.enabled ? chalk.green : chalk.gray)(
          `  GPU passthrough: ${gpuDecision.enabled ? "ON" : "off"} — ${gpuDecision.reason}`,
        ),
      );
      if (gpuDecision.degraded) {
        // Loud on the command's OWN output, not only on the library's stderr:
        // this is the path whose behaviour the degraded read actually changes.
        console.log(
          chalk.yellow(
            `\n  ⚠  Cannot read the host-capabilities verdict (${gpuDecision.capabilities.path}).\n` +
            `     ${gpuDecision.capabilities.detail}\n` +
            "     GPU is being treated as unproven because switchroom could not tell,\n" +
            "     NOT because this host lacks one. Fix the file, or set `hindsight.gpu`\n" +
            "     in switchroom.yaml / pass --gpu to state the answer explicitly.\n",
          ),
        );
      }

      // Does this recreate take GPU away from the container that is running?
      // Positive evidence only: getHindsightDeviceRequests() returns null for
      // "could not inspect", and the guard must never manufacture a refusal
      // out of not knowing. Assessed here, REPORTED with the env-drift report
      // below, and refused after both have been printed — an operator should
      // see everything this recreate would change in one run, not one reason
      // per invocation.
      const gpuDrop = recreate
        ? assessHindsightGpuDrop({
            existing: getHindsightDeviceRequests(),
            decision: gpuDecision,
            allowDrop: opts.allowGpuDrop === true,
          })
        : { drops: false, blocks: false, message: "" };

      // ── Env-drift guard ────────────────────────────────────────────────
      // A recreate rebuilds the container env FROM SCRATCH out of
      // `hindsight.env` + switchroom's managed defaults, so anything set
      // imperatively on the live container and declared in neither source is
      // dropped. That drop used to be completely silent; it has bitten three
      // times, most recently taking HINDSIGHT_API_RERANKER_LOCAL_FP16 off the
      // reranker (fp32 ⇒ ~2x per-candidate time on the interactive recall
      // path). Compare live env against the env we are ABOUT to launch with,
      // before the container is removed, and say exactly what is going.
      //
      // Deliberately not auto-carried over: see hindsight-env-drift.ts. And
      // deliberately non-fatal by default — `switchroom update` drives this
      // path, and hard-failing mid-rollout would trade a perf regression for
      // fleet memory being down. `--strict-env` opts into the refusal, and it
      // fires here, before the pull and before stopHindsight(), so a refusal
      // leaves the running container completely untouched.
      let envDriftLines: string[] = [];
      if (recreate && isHindsightContainerExists()) {
        try {
          const liveEnv = getHindsightContainerEnv();
          if (liveEnv) {
            const driftConfig = getConfig(program);
            const driftLitellm = (await resolveLiteLLMForHindsight(driftConfig)).litellm;
            const driftPerf = { env: driftConfig.hindsight?.env };
            // Resolve `vault:` api_key refs the SAME way the launch below does,
            // so the drift compare is against the env we will ACTUALLY bake —
            // otherwise a resolved live key vs a literal `vault:…` next value
            // reads as spurious drift on every recreate. Shared (memoized) with
            // the launch so the broker is hit once per invocation.
            const driftLlm = await getResolvedLlm();
            const nextEnv = hindsightContainerEnvPairs({
              // The recreate rebinds the port it is already on (reusePorts);
              // fall back to the default only when it could not be read.
              apiPort: reusePorts?.apiPort ?? HINDSIGHT_DEFAULT_API_PORT,
              litellm: driftLitellm,
              llm: driftLlm,
              // The SAME GPU answer the launch will use, passed as a value.
              gpu: gpuDecision.enabled,
              perf: driftPerf,
              // The SAME CP access key the launch below resolves — otherwise
              // the drift report reads HINDSIGHT_CP_ACCESS_KEY as "about to be
              // dropped" on every recreate of a protected dashboard.
              cpAccessKey: await resolveHindsightCpAccessKey(driftConfig),
            });
            const dropped = diffDroppedHindsightEnv(
              liveEnv,
              nextEnv,
              getHindsightImageEnv() ?? [],
            );
            envDriftLines = formatDroppedHindsightEnvReport(
              dropped,
              hindsightResolvedCapabilities(
                driftLlm,
                driftLitellm,
                gpuDecision.enabled,
                driftPerf,
              ),
            );
          }
        } catch (err) {
          // The guard must never be the reason a recreate fails. Say it was
          // skipped rather than pretending the env matched.
          console.log(
            chalk.gray(`  (env-drift check skipped: ${(err as Error).message})`),
          );
        }
      }
      if (envDriftLines.length > 0) {
        console.log("");
        for (const line of envDriftLines) console.log(chalk.yellow(line));
        console.log("");
      }
      if (gpuDrop.drops) {
        console.log(chalk[gpuDrop.blocks ? "red" : "yellow"](`\n  ${gpuDrop.message}\n`));
      }

      // Both refusals fire here — after everything has been printed, and still
      // before the image pull and before stopHindsight(), so a refusal leaves
      // the running container completely untouched.
      if (gpuDrop.blocks) {
        console.error(
          chalk.red("  Refusing to recreate. The running container was NOT touched.\n"),
        );
        process.exit(1);
      }
      if (envDriftLines.length > 0 && opts.strictEnv) {
        console.error(
          chalk.red(
            "  Refusing to recreate (--strict-env). The running container was NOT touched.\n",
          ),
        );
        process.exit(1);
      }

      if (recreate) {
        console.log(
          chalk.gray(
            `  Pulling ${effectiveTag ? `Hindsight image ${effectiveTag}` : "latest Hindsight image"}...`,
          ),
        );
        try {
          pullHindsightImage(effectiveTag);
        } catch (err) {
          console.error(chalk.red(`\n  Failed to pull Hindsight image: ${(err as Error).message}\n`));
          process.exit(1);
        }
      }

      if (isHindsightContainerExists()) {
        console.log(chalk.gray("  Removing existing switchroom-hindsight container..."));
        stopHindsight();
      }

      // Reuse the prior ports on --recreate; otherwise pick host ports —
      // upstream defaults first, fall back to 18888/19999 if 8888/9999 are
      // already bound.
      let ports: { apiPort: number; uiPort: number };
      if (reusePorts) {
        ports = reusePorts;
        // Migration hazard: --recreate pins the container to the SAME host
        // port it currently publishes, but fresh scaffolding now defaults
        // memory.config.url to HINDSIGHT_DEFAULT_API_PORT (18888). If the
        // reused port diverges AND no agent has an explicit memory.config.url,
        // agents may be repointed to a dead URL. Warn loudly; do NOT
        // auto-migrate (too risky mid-recreate).
        if (reusePorts.apiPort !== HINDSIGHT_DEFAULT_API_PORT) {
          let explicitUrl: string | undefined;
          try {
            explicitUrl = getConfig(program).memory?.config?.url;
          } catch {
            explicitUrl = undefined;
          }
          if (!explicitUrl) {
            console.log(
              chalk.yellow(
                `\n  ⚠  MIGRATION HAZARD: reusing stale host port ${reusePorts.apiPort} ` +
                `for switchroom-hindsight, but scaffolding now defaults to ` +
                `${HINDSIGHT_DEFAULT_API_PORT} and no explicit memory.config.url is set.`,
              ),
            );
            console.log(
              chalk.yellow(
                `  Agents may be repointed to a dead URL (http://127.0.0.1:${HINDSIGHT_DEFAULT_API_PORT}/mcp/) ` +
                `while the container listens on ${reusePorts.apiPort}.`,
              ),
            );
            console.log(
              chalk.yellow(
                `  Fix: set memory.config.url: http://127.0.0.1:${reusePorts.apiPort}/mcp/ explicitly, ` +
                `or migrate the container to port ${HINDSIGHT_DEFAULT_API_PORT}.\n`,
              ),
            );
          }
        }
      } else {
        try {
          ports = await pickHindsightPorts();
        } catch (err) {
          console.error(chalk.red(`\n  ${(err as Error).message}\n`));
          process.exit(1);
        }
      }
      if (ports.apiPort !== HINDSIGHT_DEFAULT_API_PORT) {
        console.log(
          chalk.yellow(
            `  Port ${HINDSIGHT_DEFAULT_API_PORT} is already in use; ` +
            `using ${ports.apiPort}/${ports.uiPort} instead.`
          )
        );
      }

      // Preflight: NEVER hand an occupied host port to `docker run` — that's
      // the 2026-07 outage (the --recreate path reused the previously-bound
      // port with no free-check, so hindsight crash-looped on `[Errno 98]
      // address already in use` while fleet memory was silently down). The
      // reuse path (getRunningHindsightPorts) especially bypasses
      // pickHindsightPorts entirely, so re-validate here for BOTH paths.
      let conflict = await preflightHindsightPorts(ports);
      if (conflict) {
        const heldBy = conflict.holder ? ` (held by ${conflict.holder})` : "";
        console.log(
          chalk.yellow(
            `\n  Chosen Hindsight port ${conflict.port} is occupied${heldBy}; ` +
            `selecting a free port instead of crash-looping.`,
          ),
        );
        // Re-pick from scratch (skips the occupied port via findFreePort).
        try {
          ports = await pickHindsightPorts();
        } catch (err) {
          console.error(chalk.red(`\n  ${(err as Error).message}\n`));
          process.exit(1);
        }
        conflict = await preflightHindsightPorts(ports);
        if (conflict) {
          const stillHeldBy = conflict.holder ? ` (held by ${conflict.holder})` : "";
          console.error(
            chalk.red(
              `\n  Refusing to start Hindsight: port ${conflict.port} is still ` +
              `occupied${stillHeldBy} after reassignment. Free it and retry ` +
              `\`switchroom memory --start\`.\n`,
            ),
          );
          process.exit(1);
        }
        console.log(
          chalk.green(`  Reassigned Hindsight to port ${ports.apiPort}/${ports.uiPort}.`),
        );
      }

      // RFC H §4.8 — hindsight runs in broker-fed mode against the
      // upstream `claude-code` LLM provider. No API key is needed; the
      // entrypoint shim fetches OAuth credentials from the auth-broker
      // over UDS at boot. The `--provider` flag remains for back-compat
      // with operator habit but is informational only (the image is
      // pinned to `claude-code`).
      if (opts.provider && opts.provider !== "claude-code") {
        console.log(
          chalk.gray(
            `  Note: --provider=${opts.provider} ignored. switchroom-hindsight is pinned to the ` +
              "`claude-code` provider (subscription-honest). The flag is kept for back-compat.",
          ),
        );
      }
      const provider = "claude-code";

      console.log(chalk.gray("  Starting Hindsight Docker container..."));
      try {
        const hindsightConfig = getConfig(program);
        const { litellm: litellmCfg, droppedRef: litellmDroppedRef } =
          await resolveLiteLLMForHindsight(hindsightConfig);
        // LiteLLM is enabled for this fleet but its key did not resolve: the
        // container is about to launch WITHOUT proxy routing and its spend will
        // not be metered. Say so — on a recreate the env-drift report printed
        // above has ALREADY listed the two ANTHROPIC_* vars as dropped, which
        // reads as operator drift and has been misdiagnosed as exactly that.
        // This names the real cause (a broker grant), which the drift report
        // structurally cannot know.
        if (litellmDroppedRef) {
          console.log(
            chalk.yellow(`  ! ${hindsightLiteLlmDroppedKeyWarning(litellmDroppedRef)}`),
          );
        }
        const cpAccessKey = await resolveHindsightCpAccessKey(hindsightConfig);
        if (!cpAccessKey) console.log(chalk.yellow(`  ! ${HINDSIGHT_CP_NO_ACCESS_KEY_WARNING}`));
        // Resolve any `vault:` refs in the LLM api_key fields through the
        // broker BEFORE the container is launched. Without this the literal
        // `vault:…` string is baked into HINDSIGHT_API_*_LLM_API_KEY and every
        // retain fails auth (2026-08-06 fleet outage) — `switchroom apply`'s
        // passphrase resolver never runs on the recreate / refresh-hindsight
        // path. Memoized (getResolvedLlm) so this reuses the env-drift compare's
        // resolution rather than firing the broker round-trips a second time.
        const resolvedLlm = await getResolvedLlm();
        // Symmetric to the cp_access_key warning above and to the first-run
        // path in `switchroom setup`: a dropped `vault:` LLM api_key ref is
        // otherwise silent here. The env-drift report only fires when the key
        // was previously baked and only names the env var; this names the lane
        // and the unresolved reference so the operator can fix the grant.
        for (const drop of await diffDroppedHindsightLlmVaultKeys(
          hindsightConfig.hindsight?.llm,
          resolvedLlm,
        )) {
          console.log(chalk.yellow(`  ! ${hindsightLlmDroppedKeyWarning(drop)}`));
        }
        startHindsight(
          ports,
          litellmCfg,
          effectiveTag,
          resolvedLlm,
          hindsightConsumerMirrorDir(hindsightConfig),
          // The SAME answer that was printed and drop-guarded above, passed as
          // a value rather than re-derived. Re-deriving would let the launch
          // disagree with the guard that just cleared it — the exact class of
          // silent divergence this PR exists to close.
          gpuDecision.enabled,
          // Operator overrides for the capability-gated performance defaults,
          // plus the container's memory cap (`hindsight.mem_limit`). Without
          // that last one every `--recreate` silently reset the cap to the
          // hard-coded default while leaving the operator's `shared_buffers`
          // standing — see resolveHindsightMemLimit.
          {
            env: hindsightConfig.hindsight?.env,
            memLimit: hindsightConfig.hindsight?.mem_limit,
          },
          // Resolved `hindsight.cp_access_key`. Absent ⇒ the CP dashboard has
          // no login, so hindsightCpAuthEnvPairs pins it to loopback.
          cpAccessKey,
        );
        if (litellmCfg) {
          console.log(chalk.gray("  LiteLLM routing enabled for hindsight (--network host)."));
        }
        console.log(chalk.green(`\n  Hindsight container started (switchroom-hindsight) on port ${ports.apiPort}.\n`));
      } catch (err) {
        console.error(chalk.red(`\n  Failed to start Hindsight: ${(err as Error).message}\n`));
        process.exit(1);
      }

      // Update switchroom.yaml with the chosen URL so agents pick it up
      const url = `http://127.0.0.1:${ports.apiPort}/mcp/`;
      const configPath = getConfigPath(program);
      try {
        if (persistMemoryConfigUrl(configPath, provider, url)) {
          console.log(chalk.gray(`  Updated ${configPath} with memory.config.url = ${url}`));
          console.log(
            chalk.gray(
              "  Run `switchroom agent reconcile all --restart` to apply this to existing agents."
            )
          );
        }
      } catch (err) {
        console.error(
          chalk.yellow(
            `  Note: could not auto-update switchroom.yaml: ${(err as Error).message}\n` +
            `  Add memory.config.url: ${url} manually.`
          )
        );
      }
    });

  // switchroom memory docker-compose
  memory
    .command("docker-compose")
    .description("Output a docker-compose snippet for Hindsight (broker-fed mode)")
    .option(
      "--resolve-secrets",
      "Resolve `vault:` refs (the LLM api_key fields and cp_access_key) to their " +
        "live secret values before printing the snippet. Without this flag (the " +
        "default) the `vault:` refs are printed literally — this is an " +
        "operator-invoked command whose stdout routinely ends up pasted into " +
        "terminals, files, and chat, and a live `sk-…` key has no business " +
        "landing there by accident (#4487). Pass this when you genuinely want a " +
        "runnable compose file, and treat the output as a secret once you do.",
    )
    // Async now that the CP access key is resolved through the vault broker;
    // withConfigError keeps a bad switchroom.yaml a friendly message rather
    // than an unhandled rejection (the sibling `memory` subcommands' shape).
    .action(withConfigError(async (opts: { resolveSecrets?: boolean }) => {
      console.log(chalk.bold("\n# Add this to your docker-compose.yml:\n"));
      {
        const snippetConfig = getConfig(program);
        const resolveSecrets = opts.resolveSecrets === true;
        let cpAccessKey: string | undefined;
        let snippetLlm: HindsightLlmConfig | undefined;
        if (resolveSecrets) {
          // Same resolve + same warning as the docker-run path: a compose
          // deployment must not be the one that quietly serves an open dashboard.
          cpAccessKey = await resolveHindsightCpAccessKey(snippetConfig);
          if (!cpAccessKey) {
            console.error(chalk.yellow(`# ! ${HINDSIGHT_CP_NO_ACCESS_KEY_WARNING}`));
          }
          // Resolve `vault:` api_key refs so the emitted compose file carries the
          // real credential — the same reason the docker-run path resolves them,
          // and the same shape the cp_access_key above already takes. An emitted
          // literal `vault:…` would break every retain exactly like the recreate bug.
          snippetLlm = await resolveHindsightLlmSecrets(snippetConfig.hindsight?.llm);
        } else {
          // DEFAULT: emit the `vault:` refs unresolved. This snippet is not
          // runnable as-is when it carries one — that's the point (#4487).
          // Pass --resolve-secrets for a runnable file with live secret values.
          cpAccessKey = snippetConfig.hindsight?.cp_access_key;
          snippetLlm = snippetConfig.hindsight?.llm;
          if (hasUnresolvedHindsightVaultRef(snippetConfig)) {
            console.log(
              chalk.yellow(
                "# NOTE: `vault:` references below are left UNRESOLVED (default) — this\n" +
                  "#       snippet is not runnable as-is. Resolve them yourself before use, or\n" +
                  "#       re-run with --resolve-secrets to print the live secret values\n" +
                  "#       instead. If you do, treat this command's output as a secret: don't\n" +
                  "#       paste it into chat, logs, or an unencrypted file.\n",
              ),
            );
          }
        }
        // The docker-run path warns from inside startHindsight(); the compose
        // generator is a pure string builder, so its wrapper carries the same
        // check. To stderr with a `#` prefix so a redirected stdout stays a
        // valid compose file even under `2>&1`. Independent of
        // --resolve-secrets: the memory budget is a property of the config,
        // not of whether secrets got resolved.
        {
          const memWarning = hindsightMemBudgetWarningFor({
            env: snippetConfig.hindsight?.env,
            memLimit: snippetConfig.hindsight?.mem_limit,
          });
          if (memWarning) console.error(chalk.yellow(`# ! ${memWarning}`));
        }
        console.log(
          generateHindsightComposeSnippet(
            snippetLlm,
            hindsightConsumerMirrorDir(snippetConfig),
            // litellm: omitted ⇒ same default the docker-run path uses.
            undefined,
            // gpu: the `hindsight.gpu` override still applies here, so the
            // emitted compose file agrees with what `memory setup` would launch.
            hindsightGpuDecision(
              resolveHindsightGpuOverride({ config: snippetConfig.hindsight?.gpu }),
            ).enabled,
            // Same options object the docker-run path builds, so the emitted
            // compose file caps the container exactly as `memory setup` would.
            {
              env: snippetConfig.hindsight?.env,
              memLimit: snippetConfig.hindsight?.mem_limit,
            },
            cpAccessKey,
          ),
        );
      }
      console.log();
    }));

  // switchroom memory repair — reachability for hindsight 0.8.5's
  // `hindsight-admin repair-bank`. A bank that arrived already populated
  // (logical restore, cross-version upgrade, vector-extension switch) never
  // got its per-(bank, fact_type) partial vector indexes, so recall falls back
  // to a global index + post-filter and silently under-returns. Seven fleet
  // banks returned 0-4 candidates out of 100 for ~three months that way. See
  // src/memory/hindsight-repair.ts for why this is a verb and not a
  // passthrough or a doctor auto-fix.
  memory
    .command("repair")
    .description(
      "Verify and rebuild a bank's per-(bank, fact_type) vector index coverage (hindsight >= 0.8.5) — the fix for a restored/upgraded bank whose recall silently under-returns",
    )
    .option("--bank <id>", "Bank id to repair (mutually exclusive with --all)")
    .option("--agent <name>", "Repair the bank belonging to this agent (resolves the bank id for you)")
    .option("--all", "Repair every bank in the base schema and all discovered tenant schemas")
    .option("--schema <name>", "Limit to a single schema (default: base + discovered tenant schemas)")
    .option("--dry-run", "Report what would be repaired without creating or dropping any index")
    .option("--container <name>", `Hindsight container name (default: ${HINDSIGHT_CONTAINER_NAME})`)
    .action(
      withConfigError(
        async (opts: {
          bank?: string;
          agent?: string;
          all?: boolean;
          schema?: string;
          dryRun?: boolean;
          container?: string;
        }) => {
          const config = getConfig(program);

          if (opts.agent && opts.bank) {
            console.error(chalk.red("Pass either --agent or --bank, not both."));
            process.exit(1);
          }
          let bank = opts.bank;
          if (opts.agent) {
            if (!config.agents[opts.agent]) {
              console.error(
                chalk.red(`Agent "${opts.agent}" is not defined in switchroom.yaml`),
              );
              process.exit(1);
            }
            bank = getCollectionForAgent(opts.agent, config);
            console.log(chalk.gray(`  --agent ${opts.agent} → bank ${bank}`));
          }

          let argv: string[];
          try {
            argv = buildRepairBankArgv({
              bank,
              all: opts.all,
              schema: opts.schema,
              dryRun: opts.dryRun,
              container: opts.container,
            });
          } catch (err) {
            console.error(chalk.red(`✗ ${(err as Error).message}`));
            process.exit(1);
          }

          if (!isDockerAvailable()) {
            console.error(
              chalk.red("✗ Docker is not available — `memory repair` runs the admin CLI inside the hindsight container."),
            );
            process.exit(REPAIR_FAILED_EXIT);
          }

          // Version preflight: against a pre-0.8.5 server the admin CLI answers
          // `No such command 'repair-bank'`, which reads like a typo rather
          // than "your image predates the fix". Say the real thing.
          const apiUrl =
            (config.memory?.config?.url as string | undefined) ?? HINDSIGHT_DEFAULT_MCP_URL;
          const preflight = classifyRepairPreflight(await fetchHindsightApiVersion(apiUrl));
          if (!preflight.ok) {
            console.error(chalk.red(`✗ ${preflight.reason}`));
            process.exit(REPAIR_FAILED_EXIT);
          }

          const target = bank ? `bank ${chalk.cyan(bank)}` : chalk.cyan("all banks");
          console.log(
            chalk.bold(
              `\nRepairing vector index coverage for ${target}${opts.dryRun ? chalk.yellow(" (dry run)") : ""}`,
            ),
          );
          console.log(
            chalk.gray(
              "  Rebuilds are CREATE INDEX CONCURRENTLY — safe on a live fleet, but not instant on a large bank.\n",
            ),
          );

          // Tee rather than inherit: the operator still sees repair-bank's
          // output live (a large bank is not instant), and we keep a copy so
          // the summary can drive a machine-readable exit code. A dry run that
          // found missing coverage must NOT exit 0 — otherwise the only way to
          // know is to read the prose, which is how this went unnoticed for
          // three months.
          const child = spawn("docker", argv, { stdio: ["ignore", "pipe", "inherit"] });
          let captured = "";
          child.stdout?.on("data", (chunk: Buffer) => {
            captured += chunk.toString();
            process.stdout.write(chunk);
          });
          const childExit: number = await new Promise((resolve) => {
            child.on("error", () => resolve(127));
            child.on("close", (c) => resolve(c ?? 1));
          });

          // Every verdict — including "I could not tell" — comes from one pure
          // function so it is testable and so no branch can quietly reach a
          // green exit. The child's own code is NEVER re-emitted: repair-bank
          // is a typer app whose usage error is exit 2, and re-emitting it
          // would collide with this command's own coverage codes.
          const outcome = classifyRepairOutcome({
            childExit,
            summary: parseRepairSummary(captured),
            dryRun: Boolean(opts.dryRun),
          });
          if (outcome.level === "ok") {
            console.log(chalk.green(`\n✓ ${outcome.headline}`), chalk.gray(outcome.detail));
            return;
          }
          console.error(chalk.red(`\n✗ ${outcome.headline}`), chalk.gray(outcome.detail));
          process.exit(outcome.exit);
        },
      ),
    );

  // switchroom memory recall-log [agent]
  memory
    .command("recall-log [agent]")
    .description(
      "Show recent auto-recall events (per-turn JSONL log) — see what was injected, when the cap fired, hit rate hints",
    )
    .option("-n, --limit <n>", "Tail the last N events per agent (default 20)", "20")
    .option("--json", "Emit raw JSONL (one entry per line)")
    .action(
      withConfigError(async (
        agent: string | undefined,
        opts: { limit: string; json?: boolean },
      ) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        const limit = Math.max(1, parseInt(opts.limit, 10) || 20);

        const targets = agent
          ? config.agents[agent]
            ? [agent]
            : (() => {
              console.error(chalk.red(`Agent "${agent}" is not defined in switchroom.yaml`));
              process.exit(1);
            })()
          : Object.keys(config.agents);

        for (const name of targets as string[]) {
          const agentDir = join(agentsDir, name);
          const entries = readRecallLog(agentDir, limit);

          if (opts.json) {
            for (const e of entries) {
              console.log(JSON.stringify({ agent: name, ...e }));
            }
            continue;
          }

          if (entries.length === 0) {
            console.log(
              chalk.gray(`${name}: no recall events recorded yet (agent hasn't fired UserPromptSubmit since #432.4.3 deployed)`),
            );
            continue;
          }

          for (const line of formatRecallLogView(name, entries)) console.log(line);
        }
        console.log();
      }),
    );

  // switchroom memory demote <agent> <memory-id> [--tag <tag>]
  //
  // Closes the operator loop opened by #432 4.3 (recall_log shows
  // memory IDs that surfaced) + #432 4.4 (demote tag is honoured by
  // recall.py) + #475 (overlap gate). When the operator spots a noisy
  // memory in `switchroom memory recall-log <agent>`, this verb adds
  // the `[demote-from-recall]` tag without leaving the terminal.
  // After the next agent restart (or naturally on the next cache
  // miss), the demoted memory stops surfacing in auto-recall while
  // remaining queryable via `mcp__hindsight__recall` and `reflect`.
  memory
    .command("demote <agent> <memory-id>")
    .description(
      "Tag a memory in the agent's bank to exclude it from auto-recall (closes the recall-log → demote loop, #475 follow-up)",
    )
    .option(
      "--tag <tag>",
      `Override the demote tag (default: ${DEMOTE_FROM_RECALL_TAG})`,
      DEMOTE_FROM_RECALL_TAG,
    )
    .option(
      "--timeout <ms>",
      "Timeout for each Hindsight API call in milliseconds (default: 5000)",
      "5000",
    )
    .action(
      withConfigError(
        async (
          agent: string,
          memoryId: string,
          opts: { tag: string; timeout: string },
        ) => {
          const config = getConfig(program);

          if (!config.agents[agent]) {
            console.error(
              chalk.red(`Agent "${agent}" is not defined in switchroom.yaml`),
            );
            process.exit(1);
          }
          if (!memoryId || memoryId.trim().length === 0) {
            console.error(chalk.red("Memory ID is required"));
            process.exit(1);
          }

          const collection = getCollectionForAgent(agent, config);
          const apiUrl =
            (config.memory?.config?.url as string | undefined) ??
            HINDSIGHT_DEFAULT_MCP_URL;
          const timeoutMs = Math.max(500, parseInt(opts.timeout, 10) || 5000);

          console.log(
            chalk.bold(`\nDemoting memory ${chalk.cyan(memoryId)}`),
          );
          console.log(
            chalk.gray(
              `  agent=${agent}  bank=${collection}  tag=${opts.tag}`,
            ),
          );
          console.log(chalk.gray(`  api=${apiUrl}\n`));

          const result = await addMemoryTag(
            apiUrl,
            collection,
            memoryId,
            opts.tag,
            { timeoutMs },
          );

          // `result.ok` now means the tag was READ BACK out of the memory unit
          // the server returned, not merely that the call returned HTTP 200
          // with isError:false — which it does even when the `add_tags`
          // argument is silently dropped and nothing is written.
          if (result.ok) {
            console.log(
              chalk.green("✓ Tag applied"),
              chalk.gray(
                "(confirmed: the tag is present on the memory the server returned).\n" +
                  "  Recall.py's filter excludes the memory on the next auto-recall (or after agent restart if a session cache is warm).",
              ),
            );
            return;
          }

          console.error(
            chalk.red("✗ Tag NOT applied:"),
            chalk.gray(result.reason),
          );
          console.error(
            chalk.gray(
              "  Hindsight has no per-memory tag-write path (checked against 0.8.4 live\n" +
                "  and the 0.8.5 wheel): `update_memory` and `PATCH .../memories/{id}`\n" +
                "  both accept only text / context / occurred_start / occurred_end /\n" +
                "  fact_type / entities — no `add_tags`, no `tags`. An unknown argument is\n" +
                "  SILENTLY DROPPED (the call still returns isError:false), so this command\n" +
                "  verifies by reading the tag back off the memory the server returns.\n" +
                "  Tags can otherwise only be attached at retain time, so this verb cannot\n" +
                "  succeed until upstream grows a per-memory tag-write argument (#3772).\n" +
                "  To stop a memory surfacing right now, retire it instead:\n" +
                "  `mcp__hindsight__invalidate_memory(memory_id=…, reason=…)` — reversible\n" +
                "  via `restore: true`, but it also hides the memory from reflect and\n" +
                "  manual recall, not just auto-recall.\n" +
                "  If the ID itself is suspect: `switchroom memory recall-log " +
                agent +
                " --json`.",
            ),
          );
          process.exit(1);
        },
      ),
    );

  // switchroom memory cleanup-scopes — AUDIT + DRY-RUN for legacy
  // observation-scope fragmentation left by banks that retained before #4035
  // (curated scopes by default). It only READS `/observations/scopes` and
  // prints what a curated re-home WOULD change; it never writes. Live execution
  // is not wired: Hindsight has no per-memory tag-write (#3772) and no per-scope
  // delete, so healing is not mechanizable through the REST surface today —
  // `--execute` refuses and explains, keeping this a diagnostic only.
  memory
    .command("cleanup-scopes [agent]")
    .description(
      "Dry-run audit of legacy pre-#4035 observation-scope fragmentation " +
        "(per-session UUID islands, stale agent-<hex> scopes). Reads only; " +
        "prints the blast radius of a curated re-home. Pass an agent, or --all.",
    )
    .option("--all", "Audit every agent bank and profile bank")
    .option(
      "--retire-stale",
      "Also fold stale agent-<hex> producer scopes into shared (opt-in; not part of the #4035 heal)",
    )
    .option("--execute", "(refused) live mutation is not supported — see the printed reason")
    .option("--json", "Emit the plans as JSON")
    .action(
      withConfigError(
        async (
          agent: string | undefined,
          opts: { all?: boolean; retireStale?: boolean; execute?: boolean; json?: boolean },
        ) => {
          const config = getConfig(program);
          const apiUrl =
            (config.memory?.config?.url as string | undefined) ?? HINDSIGHT_DEFAULT_MCP_URL;

          if (opts.execute) {
            console.error(
              chalk.red("✗ --execute is not supported: legacy-scope healing is not mechanizable"),
            );
            console.error(
              chalk.gray(
                "  Hindsight exposes no per-memory tag-write (update_memory / PATCH memories/{id}\n" +
                  "  silently drop a `tags` argument, #3772) and no per-scope delete (DELETE\n" +
                  "  .../observations clears the WHOLE bank). So an observation's scope cannot be\n" +
                  "  edited in place, and this tool stays a read-only audit. A live heal needs an\n" +
                  "  upstream tag-write path or a deliberate, operator-approved enumerate-and-\n" +
                  "  invalidate pass — neither is run from here.",
              ),
            );
            process.exit(1);
          }

          // Resolve the bank set. One agent, or the whole fleet + profile banks.
          const banks = new Set<string>();
          if (agent) {
            if (!config.agents[agent]) {
              console.error(chalk.red(`Agent "${agent}" is not defined in switchroom.yaml`));
              process.exit(1);
            }
            banks.add(getCollectionForAgent(agent, config));
          } else if (opts.all) {
            for (const name of Object.keys(config.agents)) {
              banks.add(getCollectionForAgent(name, config));
            }
            for (const bank of collectProfileBanks(config)) banks.add(bank);
          } else {
            console.error(chalk.red("Pass an agent name, or --all to audit every bank."));
            process.exit(1);
          }

          const plans: BankCleanupPlan[] = await Promise.all(
            [...banks].map((bankId) =>
              planBankCleanup(apiUrl, bankId, { retireStale: opts.retireStale }),
            ),
          );
          plans.sort((a, b) => b.affectedObservations - a.affectedObservations);

          if (opts.json) {
            console.log(JSON.stringify(plans, null, 2));
            return;
          }

          console.log(chalk.bold("\nObservation-scope cleanup — DRY RUN (no writes)\n"));
          console.log(chalk.gray(`  api=${apiUrl}  retireStale=${Boolean(opts.retireStale)}\n`));
          for (const plan of plans) {
            console.log(formatCleanupPlan(plan));
            console.log();
          }
          const totalObs = plans.reduce((n, p) => n + p.affectedObservations, 0);
          const totalScopes = plans.reduce((n, p) => n + p.scopeReduction, 0);
          console.log(
            chalk.cyan(
              `Fleet total (would change): ${totalObs.toLocaleString()} observations re-homed, ` +
                `${totalScopes.toLocaleString()} scopes removed.`,
            ),
          );
          console.log(
            chalk.gray(
              "Nothing was written. Live execution is not supported from this tool " +
                "(--execute prints why).",
            ),
          );
        },
      ),
    );

  // switchroom memory profile — author + inspect operator "profile" banks.
  // The static shared-bank foundation for per-user memory (RFC
  // reference/rfcs/per-speaker-memory-routing.md, ship-B): operator-authored
  // facts live in their own Hindsight bank, wired into agents via
  // memory.recall.additional_banks. Single-tenant — the operator's own data
  // in the operator's Hindsight instance.
  const restBase = (url: string | undefined): string =>
    (url ?? HINDSIGHT_DEFAULT_MCP_URL)
      .replace(/\/mcp\/?$/, "")
      .replace(/\/$/, "");
  const VALID_BANK = /^[a-zA-Z0-9_.-]+$/;

  const profile = memory
    .command("profile")
    .description(
      "Author + inspect operator profile banks (shared/per-user memory; wire via memory.recall.additional_banks)",
    );

  profile
    .command("add <bank> <fact...>")
    .description(
      "Add an operator-authored fact to a profile bank (creates the bank on first write)",
    )
    .option(
      "--timeout <ms>",
      "HTTP timeout in milliseconds (retain runs synchronously; default: 60000)",
      "60000",
    )
    .action(
      withConfigError(
        async (bank: string, factWords: string[], opts: { timeout: string }) => {
          const config = getConfig(program);
          if (!bank || !VALID_BANK.test(bank)) {
            console.error(
              chalk.red(
                "Bank name must be non-empty and contain only letters, digits, '.', '_', or '-'.",
              ),
            );
            process.exit(1);
          }
          const content = factWords.join(" ").trim();
          if (content.length === 0) {
            console.error(chalk.red("A non-empty fact is required."));
            process.exit(1);
          }
          const base = restBase(config.memory?.config?.url as string | undefined);
          const url = `${base}/v1/default/banks/${encodeURIComponent(bank)}/memories`;
          const timeoutMs = Math.max(1000, parseInt(opts.timeout, 10) || 60000);
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), timeoutMs);
          // Operator-authored, but a profile bank is recalled into every
          // agent that lists it — a credential pasted here spreads further
          // than anywhere else. Mask it, and SAY SO rather than silently
          // rewriting what the operator typed.
          const payload = redactMemoryWriteBody({
            items: [{ content, tags: ["operator-authored", "profile"] }],
            async: false,
          });
          const stored = payload.items[0].content as string;
          if (stored !== content) {
            console.error(
              chalk.yellow(
                "⚠ Credential-shaped text in this fact was replaced with a\n" +
                  "  [REDACTED] marker before it was stored. Put secrets in the\n" +
                  "  vault (`switchroom vault set <key>`) and reference them as\n" +
                  "  `vault:<key>` instead.",
              ),
            );
          }
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              signal: ctrl.signal,
            });
            if (!res.ok) {
              console.error(
                chalk.red(`✗ Retain failed: HTTP ${res.status}`),
                chalk.gray(await res.text().catch(() => "")),
              );
              process.exit(1);
            }
            console.log(chalk.green(`✓ Added to profile bank "${bank}"`));
            // Echo what was STORED, not what was typed — the confirmation
            // line would otherwise reprint the credential into the operator's
            // scrollback and shell history.
            console.log(chalk.gray(`  ${stored}`));
            console.log(
              chalk.gray(
                "  (fact extraction runs in the background — `profile list` may lag a few seconds)",
              ),
            );
            console.log(
              chalk.gray(
                `\n  Wire it into agents via memory.recall.additional_banks: ["${bank}"] in switchroom.yaml,\n  then \`switchroom apply\` + restart the agent(s).`,
              ),
            );
          } catch (e) {
            console.error(
              chalk.red("✗ Retain failed:"),
              chalk.gray(e instanceof Error ? e.message : String(e)),
            );
            process.exit(1);
          } finally {
            clearTimeout(t);
          }
        },
      ),
    );

  profile
    .command("list <bank>")
    .description("List the memory units in a profile bank")
    .option("--limit <n>", "Max units to show (default: 50)", "50")
    .option("--timeout <ms>", "HTTP timeout in milliseconds (default: 10000)", "10000")
    .action(
      withConfigError(
        async (bank: string, opts: { limit: string; timeout: string }) => {
          const config = getConfig(program);
          if (!bank || !VALID_BANK.test(bank)) {
            console.error(chalk.red("Bank name must contain only letters, digits, '.', '_', or '-'."));
            process.exit(1);
          }
          const base = restBase(config.memory?.config?.url as string | undefined);
          const limit = Math.max(1, parseInt(opts.limit, 10) || 50);
          const url = `${base}/v1/default/banks/${encodeURIComponent(bank)}/memories/list?limit=${limit}`;
          const timeoutMs = Math.max(1000, parseInt(opts.timeout, 10) || 10000);
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), timeoutMs);
          try {
            const res = await fetch(url, { signal: ctrl.signal });
            if (!res.ok) {
              console.error(
                chalk.red(`✗ List failed: HTTP ${res.status}`),
                chalk.gray(await res.text().catch(() => "")),
              );
              process.exit(1);
            }
            const data = (await res.json()) as {
              results?: unknown[];
              memories?: unknown[];
              units?: unknown[];
            };
            const units = (data.results ?? data.memories ?? data.units ?? []) as Array<
              Record<string, unknown>
            >;
            console.log(chalk.bold(`\n  Profile bank "${bank}" — ${units.length} unit(s)\n`));
            for (const u of units) {
              const ft = ((u.fact_type as string) ?? "?").padEnd(11);
              const text = String(u.content ?? u.text ?? "")
                .replace(/\s+/g, " ")
                .slice(0, 100);
              console.log(`  ${chalk.gray(ft)} ${text}`);
            }
            console.log();
          } catch (e) {
            console.error(
              chalk.red("✗ List failed:"),
              chalk.gray(e instanceof Error ? e.message : String(e)),
            );
            process.exit(1);
          } finally {
            clearTimeout(t);
          }
        },
      ),
    );
}
