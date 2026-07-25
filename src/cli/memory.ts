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
  preflightHindsightPorts,
  HINDSIGHT_DEFAULT_API_PORT,
  HINDSIGHT_DEFAULT_MCP_URL,
  type LiteLLMHindsightConfig,
} from "../setup/hindsight.js";
import { getViaBrokerStructured } from "../vault/broker/client.js";
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
 * Resolve LiteLLM routing config for the hindsight container. Returns
 * undefined when LiteLLM is not globally enabled or the vault key is absent.
 * The returned config is passed to `startHindsight()` to enable host-network
 * mode and inject the proxy env vars.
 */
async function resolveLiteLLMForHindsight(
  config: SwitchroomConfig,
): Promise<LiteLLMHindsightConfig | undefined> {
  const topLiteLLM = (config as { litellm?: { enabled?: boolean; base_url?: string } }).litellm;
  if (!topLiteLLM?.enabled || !topLiteLLM.base_url) return undefined;
  const result = await getViaBrokerStructured("litellm/hindsight/api-key").catch(() => null);
  if (!result || result.kind !== "ok" || result.entry.kind !== "string") return undefined;
  return {
    baseUrl: topLiteLLM.base_url,
    apiKey: result.entry.value,
    model: config.memory?.config?.llm_model,
  };
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
  lines.push(
    chalk.gray(
      `  last ${total} turn${total === 1 ? "" : "s"}: ` +
      `avg=${avg ?? "—"} max=${max ?? "—"} ` +
      `cache_hits=${hits} capped=${cappedTurns}` +
      (omittedTurns > 0 ? ` directives_omitted_turns=${omittedTurns}` : ""),
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
    lines.push(
      `  ${chalk.gray(e.ts)} ${flag} ` +
      `n=${e.result_count ?? "—"}${e.pre_cap_count != null && e.pre_cap_count !== e.result_count ? `/${e.pre_cap_count}` : ""}` +
      `${dem}${omitted}${ids}`,
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
    .action(async (opts: { stop?: boolean; status?: boolean; recreate?: boolean; tag?: string; provider?: string }) => {
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
        const litellmCfg = await resolveLiteLLMForHindsight(hindsightConfig);
        startHindsight(
          ports,
          litellmCfg,
          effectiveTag,
          hindsightConfig.hindsight?.llm,
          hindsightConsumerMirrorDir(hindsightConfig),
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
    .action(() => {
      console.log(chalk.bold("\n# Add this to your docker-compose.yml:\n"));
      {
        const snippetConfig = getConfig(program);
        console.log(
          generateHindsightComposeSnippet(
            snippetConfig.hindsight?.llm,
            hindsightConsumerMirrorDir(snippetConfig),
          ),
        );
      }
      console.log();
    });

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

          if (result.ok) {
            console.log(
              chalk.green("✓ Tag applied."),
              chalk.gray(
                "Recall.py's filter excludes the memory on the next auto-recall (or after agent restart if a session cache is warm).",
              ),
            );
            return;
          }

          console.error(
            chalk.red("✗ Tag failed:"),
            chalk.gray(result.reason),
          );
          console.error(
            chalk.gray(
              "  The Hindsight MCP `update_memory` tool may not be exposed by your deployment, or the memory ID may be wrong. Try `switchroom memory recall-log " +
                agent +
                " --json` to confirm the ID surfaced recently.",
            ),
          );
          process.exit(1);
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
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                items: [{ content, tags: ["operator-authored", "profile"] }],
                async: false,
              }),
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
            console.log(chalk.gray(`  ${content}`));
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
