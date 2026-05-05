/**
 * `switchroom auth account` + `switchroom auth enable/disable` verbs.
 *
 * The account-level CLI surface for the new auth model. See
 * `reference/share-auth-across-the-fleet.md` for the design.
 *
 *   switchroom auth account add <label> --from-agent <name>
 *   switchroom auth account add <label> --from-credentials <path>
 *   switchroom auth account list
 *   switchroom auth account rm <label>
 *   switchroom auth enable <label> <agent...>
 *   switchroom auth disable <label> <agent...>
 *   switchroom auth refresh-accounts
 */

import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveAgentsDir } from "../config/loader.js";
import {
  accountDir,
  accountExists,
  accountsRoot,
  getAccountInfos,
  listAccounts,
  patchAccountMeta,
  removeAccount,
  renameAccount,
  validateAccountLabel,
  writeAccountCredentials,
  type AccountCredentials,
} from "../auth/account-store.js";
import { readAccountQuota } from "../auth/account-quota-store.js";
import {
  fanoutAccountToAgents,
  refreshAllAccounts,
} from "../auth/account-refresh.js";
import {
  appendAccountToAgent,
  getAccountsForAgent,
  promoteAccountForAgent,
  removeAccountFromAgent,
  renameAccountInAllAgents,
} from "./auth-accounts-yaml.js";
import { withConfigError, getConfig, getConfigPath } from "./helpers.js";

/* ── Public registration ─────────────────────────────────────────────── */

export function registerAuthAccountSubcommands(
  program: Command,
  authParent: Command,
): void {
  const account = authParent
    .command("account")
    .description(
      "Manage Anthropic accounts shared across agents (see reference/share-auth-across-the-fleet.md)",
    );

  registerAccountAdd(account, program);
  registerAccountList(account, program);
  registerAccountRm(account, program);
  registerAccountRename(account, program);

  registerEnable(authParent, program);
  registerDisable(authParent, program);
  registerPromote(authParent, program);
  registerShare(authParent, program);
  registerRefreshAccounts(authParent, program);
}

/* ── helpers: per-agent primary-preserving fanout grouping ──────────── */

/**
 * Group a list of agents by the account label that should be fanned
 * out to each — namely the FIRST entry in each agent's
 * `auth.accounts:` list (the primary). Used by `auth enable` so a new
 * account added as a fallback doesn't overwrite the existing
 * primary's runtime fanout.
 *
 * Pure function: takes the post-mutation YAML text and the list of
 * agents being enabled, returns a Map<primaryLabel, agents[]>. Caller
 * iterates and calls `fanoutAccountToAgents(primaryLabel, agents)`
 * once per group.
 *
 * Defensive fallback: if an agent's account list is somehow empty
 * post-append (shouldn't happen — `appendAccountToAgent` always
 * leaves at least the just-added label), the agent gets grouped
 * under `defaultLabel` so the fanout still authenticates it.
 *
 * Exported for unit testing.
 */
export function groupAgentsByPrimaryAccount(
  yamlText: string,
  agents: ReadonlyArray<string>,
  defaultLabel: string,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const name of agents) {
    const list = getAccountsForAgent(yamlText, name);
    const primary = list[0] ?? defaultLabel;
    const arr = out.get(primary) ?? [];
    arr.push(name);
    out.set(primary, arr);
  }
  return out;
}

/* ── helpers: `all` agent expansion ──────────────────────────────────── */

/**
 * Expand the special `all` keyword into the list of every claude-enabled agent
 * declared in switchroom.yaml. If `agents` is anything other than the
 * single-element list `['all']`, returns it unchanged.
 *
 * Edge case: a literal agent named "all" in switchroom.yaml. The keyword
 * still wins (matches the parser's whitelisting of "all"); we log a warning
 * to stderr so the operator notices the collision.
 */
function expandAllAgents(
  agents: string[],
  config: ReturnType<typeof getConfig>,
): string[] {
  if (agents.length !== 1 || agents[0] !== "all") return agents;
  if (config.agents["all"]) {
    console.error(
      chalk.yellow(
        "  ⚠ An agent named 'all' is declared in switchroom.yaml — preferring " +
          "the `all` keyword (every agent). Rename the agent to disambiguate.",
      ),
    );
  }
  const expanded = Object.entries(config.agents)
    .filter(([, a]) => (a as { claude?: boolean }).claude !== false)
    .map(([n]) => n)
    .sort();
  if (expanded.length === 0) {
    throw new Error(
      "no agents configured (or all agents have claude disabled)",
    );
  }
  return expanded;
}

/* ── account add ─────────────────────────────────────────────────────── */

function registerAccountAdd(account: Command, program: Command): void {
  account
    .command("add <label>")
    .description(
      "Register an Anthropic account at ~/.switchroom/accounts/<label>/. " +
        "Use --from-agent to seed from an agent that's already authenticated, " +
        "or --from-credentials to import a credentials.json file.",
    )
    .option(
      "--from-agent <name>",
      "Seed credentials from an existing agent's .credentials.json",
    )
    .option(
      "--from-credentials <path>",
      "Seed credentials from a JSON file at the given path",
    )
    .action(
      withConfigError(
        async (
          label: string,
          opts: { fromAgent?: string; fromCredentials?: string },
        ) => {
          validateAccountLabel(label);

          if (accountExists(label)) {
            throw new Error(
              `Account "${label}" already exists at ${accountDir(label)}. ` +
                `Remove it first with 'switchroom auth account rm ${label}' or pick a different label.`,
            );
          }
          if (!opts.fromAgent && !opts.fromCredentials) {
            throw new Error(
              "Need a credentials source. Pass --from-agent <name> to copy from an " +
                "agent that's already authenticated, or --from-credentials <path> to " +
                "import from a credentials.json file. Interactive `claude setup-token` " +
                "support will follow in a later release.",
            );
          }
          if (opts.fromAgent && opts.fromCredentials) {
            throw new Error(
              "Pass only one of --from-agent or --from-credentials, not both.",
            );
          }

          let creds: AccountCredentials;
          let sourceDescription: string;

          if (opts.fromAgent) {
            const config = getConfig(program);
            const agentsDir = resolveAgentsDir(config);
            if (!config.agents[opts.fromAgent]) {
              throw new Error(
                `agent '${opts.fromAgent}' is not declared in switchroom.yaml`,
              );
            }
            const credPath = resolve(
              agentsDir,
              opts.fromAgent,
              ".claude",
              ".credentials.json",
            );
            if (!existsSync(credPath)) {
              throw new Error(
                `agent '${opts.fromAgent}' has no .credentials.json at ${credPath}. ` +
                  `Run 'switchroom auth login ${opts.fromAgent}' first.`,
              );
            }
            creds = parseCredentialsFile(credPath);
            sourceDescription = `agent '${opts.fromAgent}'`;
          } else {
            const credPath = resolve(opts.fromCredentials!);
            if (!existsSync(credPath)) {
              throw new Error(`credentials file not found: ${credPath}`);
            }
            creds = parseCredentialsFile(credPath);
            sourceDescription = credPath;
          }

          assertCredentialsHaveAccessToken(creds);

          writeAccountCredentials(label, creds);
          patchAccountMeta(label, {
            createdAt: Date.now(),
            subscriptionType: creds.claudeAiOauth?.subscriptionType,
          });

          console.log();
          console.log(
            `${chalk.green("✓")} Account ${chalk.bold(label)} created at ${accountDir(label)}`,
          );
          console.log(`  Seeded from: ${sourceDescription}`);
          if (creds.claudeAiOauth?.subscriptionType) {
            console.log(
              `  Subscription: ${creds.claudeAiOauth.subscriptionType}`,
            );
          }
          if (creds.claudeAiOauth?.expiresAt) {
            const remaining = creds.claudeAiOauth.expiresAt - Date.now();
            console.log(`  Token life:   ${formatDuration(remaining)}`);
          }
          // Real UX cliff: an access token without a refresh token works
          // until expiry, then dies silently. The broker's refresh tick
          // can't recover (skipped-no-refresh-token), and the operator
          // only learns at the next 401. Warn loudly at import time.
          const hasRefreshToken =
            typeof creds.claudeAiOauth?.refreshToken === "string" &&
            creds.claudeAiOauth.refreshToken.length > 0;
          if (!hasRefreshToken) {
            console.log();
            console.log(
              chalk.yellow(
                "  ⚠ No refreshToken in the imported credentials. The token will work " +
                  "until it expires, then this account will need a manual re-auth — " +
                  "the broker can't refresh without a refresh token.",
              ),
            );
          }
          console.log();
          console.log(
            `Next: enable on agents with 'switchroom auth enable ${label} <agent>'`,
          );
          console.log();
        },
      ),
    );
}

/* ── account list ────────────────────────────────────────────────────── */

function registerAccountList(account: Command, program: Command): void {
  account
    .command("list")
    .description("List Anthropic accounts and which agents use each")
    .option(
      "--json",
      "Emit account inventory as JSON (used by the Telegram /auth dashboard to render account-level buttons)",
    )
    .action(
      withConfigError(async (opts: { json?: boolean }) => {
        const config = getConfig(program);
        const labels = listAccounts();
        const enabledMap = new Map<string, string[]>();
        // primaryForMap[label] = [agents whose auth.accounts:[0] === label].
        // Mirrors enabledMap but only counts agents where this label sits
        // at position 0 — the post-fanout active for that agent. Used by
        // the Telegram dashboard's `▶ Active` row.
        const primaryForMap = new Map<string, string[]>();
        for (const label of labels) {
          enabledMap.set(
            label,
            Object.entries(config.agents)
              .filter(([, a]) => (a.auth?.accounts ?? []).includes(label))
              .map(([n]) => n)
              .sort(),
          );
          primaryForMap.set(
            label,
            Object.entries(config.agents)
              .filter(([, a]) => (a.auth?.accounts ?? [])[0] === label)
              .map(([n]) => n)
              .sort(),
          );
        }

        if (opts.json) {
          // Stable, sorted-by-label JSON for the Telegram dashboard.
          // Empty array (not null) when no accounts exist — keeps the
          // gateway's null-check shape consistent with "old CLI without
          // --json" vs "new CLI, zero accounts."
          const infos = labels.length === 0 ? [] : getAccountInfos();
          const payload = infos
            .slice()
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((info) => {
              // Surface the most-recent persisted quota snapshot
              // (issue #708) so consumers without access to the live
              // gateway in-memory cache (e.g. CLI scripts, the boot
              // card hydration step on a fresh gateway lifetime) see
              // the same numbers /auth shows.
              const snap = readAccountQuota(info.label);
              return {
                label: info.label,
                health: info.health,
                ...(info.subscriptionType
                  ? { subscriptionType: info.subscriptionType }
                  : {}),
                ...(info.expiresAt != null ? { expiresAt: info.expiresAt } : {}),
                ...(info.quotaExhaustedUntil != null
                  ? { quotaExhaustedUntil: info.quotaExhaustedUntil }
                  : {}),
                ...(info.email ? { email: info.email } : {}),
                agents: enabledMap.get(info.label) ?? [],
                primaryForAgents: primaryForMap.get(info.label) ?? [],
                ...(snap
                  ? {
                      quota: {
                        capturedAt: snap.capturedAt,
                        fiveHourPct: snap.fiveHourPct,
                        sevenDayPct: snap.sevenDayPct,
                        fiveHourResetAt: snap.fiveHourResetAt,
                        sevenDayResetAt: snap.sevenDayResetAt,
                      },
                    }
                  : {}),
              };
            });
          console.log(JSON.stringify(payload));
          return;
        }

        if (labels.length === 0) {
          console.log();
          console.log(
            "No accounts yet. Add one with 'switchroom auth account add <label>'.",
          );
          console.log(`  Storage: ${accountsRoot()}`);
          console.log();
          return;
        }

        const infos = getAccountInfos();
        console.log();
        for (const info of infos) {
          const agents = enabledMap.get(info.label) ?? [];
          const agentsText =
            agents.length === 0
              ? chalk.dim("(no agents enabled)")
              : agents.join(", ");
          const healthBadge = healthBadgeFor(info.health);
          const subText = info.subscriptionType
            ? `${info.subscriptionType} · `
            : "";
          const expiryText = info.expiresAt
            ? `expires in ${formatDuration(info.expiresAt - Date.now())}`
            : "no expiry recorded";
          console.log(
            `${healthBadge} ${chalk.bold(info.label)}  ${chalk.dim(`${subText}${expiryText}`)}`,
          );
          console.log(`   agents: ${agentsText}`);
          if (info.email) console.log(`   email:  ${info.email}`);
          console.log();
        }
      }),
    );
}

/* ── account rm ──────────────────────────────────────────────────────── */

function registerAccountRm(account: Command, program: Command): void {
  account
    .command("rm <label>")
    .description(
      "Remove an Anthropic account from ~/.switchroom/accounts/. Refused while any agent is enabled.",
    )
    .action(
      withConfigError(async (label: string) => {
        validateAccountLabel(label);
        if (!accountExists(label)) {
          throw new Error(`Account "${label}" does not exist`);
        }
        const config = getConfig(program);
        const enabled = Object.entries(config.agents)
          .filter(([, a]) => (a.auth?.accounts ?? []).includes(label))
          .map(([n]) => n)
          .sort();
        if (enabled.length > 0) {
          throw new Error(
            `Refusing to remove account "${label}" — still enabled on: ${enabled.join(", ")}. ` +
              `Disable each first with 'switchroom auth disable ${label} <agent>'.`,
          );
        }
        removeAccount(label);
        console.log();
        console.log(`${chalk.green("✓")} Account ${chalk.bold(label)} removed.`);
        console.log();
      }),
    );
}

/* ── account rename ──────────────────────────────────────────────────── */

function registerAccountRename(account: Command, program: Command): void {
  account
    .command("rename <oldLabel> <newLabel>")
    .description(
      "Rename an Anthropic account on disk + update every agent's auth.accounts list in switchroom.yaml. " +
        "No agent restart required — per-agent credentials.json mirrors are content-equivalent under the new label.",
    )
    .action(
      withConfigError(async (oldLabel: string, newLabel: string) => {
        validateAccountLabel(oldLabel);
        validateAccountLabel(newLabel);
        if (oldLabel === newLabel) {
          throw new Error(
            `Account "${oldLabel}" already has that name — nothing to do.`,
          );
        }
        if (!accountExists(oldLabel)) {
          throw new Error(`Account "${oldLabel}" does not exist`);
        }
        if (accountExists(newLabel)) {
          throw new Error(
            `Cannot rename to "${newLabel}" — an account with that label already exists.`,
          );
        }

        // 1. Rename the global account directory.
        renameAccount(oldLabel, newLabel);

        // 2. Rewrite agents.<name>.auth.accounts lists in switchroom.yaml.
        const yamlPath = getConfigPath(program);
        const before = readFileSync(yamlPath, "utf-8");
        const { yaml: after, touched } = renameAccountInAllAgents(
          before,
          oldLabel,
          newLabel,
        );
        if (after !== before) {
          writeFileSync(yamlPath, after);
        }

        // 3. Re-fanout under the new label so the broker's view is
        //    consistent. Per-agent credentials.json content is identical
        //    (the file was untouched by the directory rename), but we
        //    re-mirror to update the legacy .oauth-token meta `source`
        //    field from "account:<old>" to "account:<new>".
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        const targets = touched.map((name) => ({
          name,
          agentDir: resolve(agentsDir, name),
        }));
        const outcomes =
          targets.length > 0
            ? fanoutAccountToAgents(newLabel, targets)
            : [];

        console.log();
        console.log(
          `${chalk.green("✓")} Renamed account ${chalk.bold(oldLabel)} → ${chalk.bold(newLabel)}.`,
        );
        if (touched.length > 0) {
          console.log(
            `  Updated ${touched.length} agent${touched.length === 1 ? "" : "s"} in switchroom.yaml: ${touched.join(", ")}`,
          );
        } else {
          console.log(
            `  No agents had ${chalk.bold(oldLabel)} in their auth.accounts list — only the global directory was renamed.`,
          );
        }
        const fanned = outcomes.filter((o) => o.kind === "fanned-out").length;
        if (fanned > 0) {
          console.log(`  Re-fanned credentials to ${fanned} agent${fanned === 1 ? "" : "s"} (no restart required).`);
        }
        console.log();
      }),
    );
}

/* ── enable / disable ────────────────────────────────────────────────── */

function registerEnable(authParent: Command, program: Command): void {
  authParent
    .command("enable <label> <agents...>")
    .description(
      "Enable an Anthropic account on one or more agents (appends to switchroom.yaml + immediate fanout)",
    )
    .action(
      withConfigError(async (label: string, agents: string[]) => {
        validateAccountLabel(label);
        if (!accountExists(label)) {
          throw new Error(
            `Account "${label}" does not exist. Add it first with 'switchroom auth account add ${label}'.`,
          );
        }
        const config = getConfig(program);
        // Expand `all` BEFORE the per-agent guard so the friendly empty-config
        // error fires correctly and unknown-agent checks run on real names.
        agents = expandAllAgents(agents, config);
        const agentsDir = resolveAgentsDir(config);
        for (const name of agents) {
          if (!config.agents[name]) {
            throw new Error(
              `agent '${name}' is not declared in switchroom.yaml`,
            );
          }
        }

        const yamlPath = getConfigPath(program);
        const before = readFileSync(yamlPath, "utf-8");
        let after = before;
        const changed: string[] = [];
        for (const name of agents) {
          const next = appendAccountToAgent(after, name, label);
          if (next !== after) changed.push(name);
          after = next;
        }
        if (after !== before) {
          writeFileSync(yamlPath, after);
        }

        // Per-agent immediate fanout — preserve the YAML-list primary
        // as the active fanout. The first entry in `auth.accounts:` is
        // the agent's preferred (primary) account; subsequent entries
        // are failover targets. `appendAccountToAgent` always appends,
        // so the existing primary stays first when this enable adds a
        // fallback. We therefore fan whatever the post-mutation first
        // entry is on each agent — which is:
        //   - the existing primary (when this enable adds a fallback)
        //   - the just-enabled account (when this is the agent's first
        //     account, i.e. fresh-fleet bootstrap)
        // Result: enabling a fallback no longer hot-swaps the runtime
        // active credentials. Fixes the polish gap discovered while
        // wiring `me@kenthompson.com.au` and `ken.thompson@outlook.com.au`
        // alongside `pixsoul@gmail.com` — `enable` of either fallback
        // was overwriting the active fanout with the new account's
        // creds, leaking primary→fallback under the operator's feet.
        //
        // Group agents by the label that should be fanned to them so
        // we still call `fanoutAccountToAgents` once per label rather
        // than once per agent. See `groupAgentsByPrimaryAccount` for
        // the pure-function explanation.
        const groups = groupAgentsByPrimaryAccount(after, agents, label);
        type FanTarget = { name: string; agentDir: string };
        const fanoutByLabel = new Map<string, FanTarget[]>();
        for (const [primary, names] of groups) {
          fanoutByLabel.set(
            primary,
            names.map((name) => ({
              name,
              agentDir: resolve(agentsDir, name),
            })),
          );
        }
        const allOutcomes: Array<{
          kind: string;
          agent: string;
          fannedLabel: string;
          error?: string;
        }> = [];
        for (const [fanLabel, fanTargets] of fanoutByLabel) {
          const out = fanoutAccountToAgents(fanLabel, fanTargets);
          for (const o of out) {
            allOutcomes.push({
              kind: o.kind,
              agent: o.agent,
              fannedLabel: fanLabel,
              ...((o as { error?: string }).error
                ? { error: (o as { error?: string }).error }
                : {}),
            });
          }
        }

        console.log();
        if (changed.length === 0) {
          console.log(
            `No change — ${chalk.bold(label)} already enabled on: ${agents.join(", ")}`,
          );
        } else {
          console.log(
            `${chalk.green("✓")} Enabled ${chalk.bold(label)} on: ${changed.join(", ")}`,
          );
        }
        // Distinguish "now active" (just-enabled label became the
        // agent's primary because there was nothing earlier in the
        // list) from "added as fallback" (existing primary preserved,
        // no runtime change). The two paths have different restart
        // semantics — a fallback add doesn't need a restart at all.
        const fannedAsPrimary = allOutcomes
          .filter((o) => o.kind === "fanned-out" && o.fannedLabel === label)
          .map((o) => o.agent);
        const fannedPreservingPrimary = allOutcomes
          .filter((o) => o.kind === "fanned-out" && o.fannedLabel !== label)
          .map((o) => ({ agent: o.agent, primary: o.fannedLabel }));
        const fanFails = allOutcomes.filter((o) => o.kind === "fanout-failed");
        if (fannedAsPrimary.length > 0) {
          console.log(
            `  Credentials fanned out (now active) to: ${fannedAsPrimary.join(", ")}`,
          );
        }
        if (fannedPreservingPrimary.length > 0) {
          const byPrimary = new Map<string, string[]>();
          for (const { agent, primary } of fannedPreservingPrimary) {
            const arr = byPrimary.get(primary) ?? [];
            arr.push(agent);
            byPrimary.set(primary, arr);
          }
          for (const [primary, ags] of byPrimary) {
            console.log(
              `  Added as fallback (active stays ${chalk.bold(primary)}) on: ${ags.join(", ")}`,
            );
          }
        }
        for (const f of fanFails) {
          console.log(
            chalk.yellow(`  ⚠ Fanout failed for ${f.agent}${f.error ? ": " + f.error : ""}`),
          );
        }
        console.log();
        // Restart hint only meaningful when runtime creds actually
        // changed. Pure-fallback adds don't need a restart.
        if (fannedAsPrimary.length > 0) {
          console.log(
            `Next: 'switchroom agent restart ${fannedAsPrimary.join(" ")}' to load the new credentials.`,
          );
        } else if (changed.length > 0) {
          console.log(
            `No restart needed — ${chalk.bold(label)} is wired as a fallback; runtime active stays the same.`,
          );
        }
        console.log();
      }),
    );
}

function registerDisable(authParent: Command, program: Command): void {
  authParent
    .command("disable <label> <agents...>")
    .description(
      "Disable an Anthropic account on one or more agents (removes from switchroom.yaml). Refuses to leave an agent with no accounts.",
    )
    .action(
      withConfigError(async (label: string, agents: string[]) => {
        validateAccountLabel(label);
        const config = getConfig(program);
        agents = expandAllAgents(agents, config);
        const yamlPath = getConfigPath(program);
        const before = readFileSync(yamlPath, "utf-8");

        // Refuse if it would empty any agent's account list.
        for (const name of agents) {
          const current = getAccountsForAgent(before, name);
          if (current.length === 1 && current[0] === label) {
            throw new Error(
              `Refusing to disable "${label}" on agent '${name}' — it's the only account. ` +
                `Enable another account first with 'switchroom auth enable <other> ${name}'.`,
            );
          }
        }

        let after = before;
        const changed: string[] = [];
        for (const name of agents) {
          const next = removeAccountFromAgent(after, name, label);
          if (next !== after) changed.push(name);
          after = next;
        }
        if (after !== before) {
          writeFileSync(yamlPath, after);
        }

        console.log();
        if (changed.length === 0) {
          console.log(
            `No change — ${chalk.bold(label)} was not enabled on: ${agents.join(", ")}`,
          );
        } else {
          console.log(
            `${chalk.green("✓")} Disabled ${chalk.bold(label)} on: ${changed.join(", ")}`,
          );
          console.log(
            `  Run 'switchroom agent restart ${changed.join(" ")}' to drop the now-stale credentials cache.`,
          );
        }
        console.log();
      }),
    );
}

/* ── promote (move an enabled account to position 0 → new primary) ─── */

/**
 * `switchroom auth promote <label> <agents...>` — move an already-enabled
 * label to position 0 of each agent's `auth.accounts:` list, making it
 * the agent's new primary, and immediately fan out fresh credentials.
 *
 * Why this verb exists separately from `enable`:
 *   - `enable` of an already-enabled label is a no-op (idempotent
 *     append). Operators have no way to say "I want this one to be
 *     active now" without manually editing YAML.
 *   - The Telegram dashboard's `⤴ Promote` button maps 1:1 to this
 *     verb. Single source of truth for the YAML mutation + fanout.
 *
 * Refuses (throws) when the label isn't already enabled on the agent —
 * promotion only reorders; it doesn't enable. This avoids "promote
 * silently enabled it" confusion.
 *
 * Idempotent at the `already-primary` boundary: if the label is
 * already at position 0, the YAML stays byte-identical and we skip
 * the fanout (no point rewriting unchanged credentials).
 */
function registerPromote(authParent: Command, program: Command): void {
  authParent
    .command("promote <label> <agents...>")
    .description(
      "Move an already-enabled account to position 0 (primary) on the listed agents — re-fans credentials and tells you what to restart.",
    )
    .action(
      withConfigError(async (label: string, agents: string[]) => {
        validateAccountLabel(label);
        if (!accountExists(label)) {
          throw new Error(
            `Account "${label}" does not exist. Add it first with 'switchroom auth account add ${label}'.`,
          );
        }
        const config = getConfig(program);
        agents = expandAllAgents(agents, config);
        const agentsDir = resolveAgentsDir(config);
        for (const name of agents) {
          if (!config.agents[name]) {
            throw new Error(
              `agent '${name}' is not declared in switchroom.yaml`,
            );
          }
        }

        const yamlPath = getConfigPath(program);
        const before = readFileSync(yamlPath, "utf-8");
        // Pre-validate every agent has the label in its list. Fail
        // before mutating so we don't half-promote across the fleet.
        for (const name of agents) {
          const current = getAccountsForAgent(before, name);
          if (!current.includes(label)) {
            throw new Error(
              `account '${label}' is not enabled on agent '${name}' — enable it first with 'switchroom auth enable ${label} ${name}'.`,
            );
          }
        }

        let after = before;
        const promoted: string[] = [];
        const alreadyPrimary: string[] = [];
        for (const name of agents) {
          const current = getAccountsForAgent(after, name);
          if (current[0] === label) {
            alreadyPrimary.push(name);
            continue;
          }
          after = promoteAccountForAgent(after, name, label);
          promoted.push(name);
        }
        if (after !== before) {
          writeFileSync(yamlPath, after);
        }

        // Fan the (now-primary) label only to the agents we moved. The
        // already-primary set is a no-op — their on-disk credentials
        // already match the YAML head.
        const fanTargets = promoted.map((name) => ({
          name,
          agentDir: resolve(agentsDir, name),
        }));
        const outcomes =
          fanTargets.length > 0
            ? fanoutAccountToAgents(label, fanTargets)
            : [];
        const fanned = outcomes
          .filter((o) => o.kind === "fanned-out")
          .map((o) => o.agent);
        const fanFails = outcomes.filter((o) => o.kind === "fanout-failed");

        console.log();
        if (promoted.length === 0) {
          console.log(
            `No change — ${chalk.bold(label)} is already primary on: ${alreadyPrimary.join(", ")}`,
          );
        } else {
          console.log(
            `${chalk.green("✓")} Promoted ${chalk.bold(label)} to primary on: ${promoted.join(", ")}`,
          );
          if (alreadyPrimary.length > 0) {
            console.log(
              `  Already primary on: ${alreadyPrimary.join(", ")}`,
            );
          }
        }
        if (fanned.length > 0) {
          console.log(`  Credentials fanned out to: ${fanned.join(", ")}`);
        }
        for (const f of fanFails) {
          if (f.kind === "fanout-failed") {
            console.log(
              chalk.yellow(`  ⚠ Fanout failed for ${f.agent}: ${f.error}`),
            );
          }
        }
        console.log();
        if (promoted.length > 0) {
          console.log(
            `Next: 'switchroom agent restart ${promoted.join(" ")}' to load the new active credentials.`,
          );
          console.log();
        }
      }),
    );
}

/* ── share (one-shot: account add + enable on every agent) ──────────── */

function registerShare(authParent: Command, program: Command): void {
  authParent
    .command("share <label>")
    .description(
      "One-shot: register an Anthropic account from an authenticated agent and " +
        "enable it on every claude-enabled agent in switchroom.yaml. Equivalent " +
        "to `auth account add` + `auth enable <label> all` but with a single " +
        "merged YAML write.",
    )
    .option(
      "--from-agent <name>",
      "Seed credentials from an existing agent's .credentials.json (defaults " +
        "to the only agent if there is exactly one)",
    )
    .action(
      withConfigError(
        async (label: string, opts: { fromAgent?: string }) => {
          validateAccountLabel(label);

          if (accountExists(label)) {
            throw new Error(
              `account ${label} already exists — use 'switchroom auth enable ${label} all' instead`,
            );
          }

          const config = getConfig(program);
          const agentNames = Object.keys(config.agents);

          let fromAgent = opts.fromAgent;
          if (!fromAgent) {
            if (agentNames.length === 1) {
              fromAgent = agentNames[0];
            } else {
              throw new Error(
                "--from-agent is required when more than one agent is configured. " +
                  `Pick one of: ${agentNames.sort().join(", ")}`,
              );
            }
          }
          if (!config.agents[fromAgent]) {
            throw new Error(
              `agent '${fromAgent}' is not declared in switchroom.yaml`,
            );
          }

          // Load credentials from the source agent (mirrors `account add`).
          const agentsDir = resolveAgentsDir(config);
          const credPath = resolve(
            agentsDir,
            fromAgent,
            ".claude",
            ".credentials.json",
          );
          if (!existsSync(credPath)) {
            throw new Error(
              `agent '${fromAgent}' has no .credentials.json at ${credPath}. ` +
                `Run 'switchroom auth login ${fromAgent}' first.`,
            );
          }
          const creds = parseCredentialsFile(credPath);
          assertCredentialsHaveAccessToken(creds);

          // Expand "all" target list (claude-enabled agents only).
          const targets = expandAllAgents(["all"], config);

          // Write account artefacts first (account dir is its own write).
          writeAccountCredentials(label, creds);
          patchAccountMeta(label, {
            createdAt: Date.now(),
            subscriptionType: creds.claudeAiOauth?.subscriptionType,
          });

          // ONE merged YAML write: append the new label to every target agent
          // in-memory, then a single writeFileSync.
          const yamlPath = getConfigPath(program);
          const before = readFileSync(yamlPath, "utf-8");
          let after = before;
          const changed: string[] = [];
          for (const name of targets) {
            const next = appendAccountToAgent(after, name, label);
            if (next !== after) changed.push(name);
            after = next;
          }
          if (after !== before) {
            writeFileSync(yamlPath, after);
          }

          // Immediate fanout to every target.
          const fanTargets = targets.map((name) => ({
            name,
            agentDir: resolve(agentsDir, name),
          }));
          const outcomes = fanoutAccountToAgents(label, fanTargets);

          // Log expanded agent list (also visible to the gateway-stderr path
          // when invoked via Telegram).
          console.error(
            `share: expanded 'all' to ${targets.length} agent(s): ${targets.join(", ")}`,
          );

          console.log();
          console.log(
            `${chalk.green("✓")} Account ${chalk.bold(label)} created at ${accountDir(label)}`,
          );
          console.log(`  Seeded from: agent '${fromAgent}'`);
          if (creds.claudeAiOauth?.subscriptionType) {
            console.log(
              `  Subscription: ${creds.claudeAiOauth.subscriptionType}`,
            );
          }
          if (creds.claudeAiOauth?.expiresAt) {
            const remaining = creds.claudeAiOauth.expiresAt - Date.now();
            console.log(`  Token life:   ${formatDuration(remaining)}`);
          }
          const hasRefreshToken =
            typeof creds.claudeAiOauth?.refreshToken === "string" &&
            creds.claudeAiOauth.refreshToken.length > 0;
          if (!hasRefreshToken) {
            console.log();
            console.log(
              chalk.yellow(
                "  ⚠ No refreshToken in the imported credentials. The token " +
                  "will work until it expires, then this account will need a " +
                  "manual re-auth — the broker can't refresh without a refresh token.",
              ),
            );
          }
          console.log();
          if (changed.length === 0) {
            console.log(
              `No yaml change — ${chalk.bold(label)} already enabled on: ${targets.join(", ")}`,
            );
          } else {
            console.log(
              `${chalk.green("✓")} Enabled ${chalk.bold(label)} on: ${changed.join(", ")}`,
            );
          }
          const fanned = outcomes
            .filter((o) => o.kind === "fanned-out")
            .map((o) => o.agent);
          const fanFails = outcomes.filter((o) => o.kind === "fanout-failed");
          if (fanned.length > 0) {
            console.log(`  Credentials fanned out to: ${fanned.join(", ")}`);
          }
          for (const f of fanFails) {
            if (f.kind === "fanout-failed") {
              console.log(
                chalk.yellow(`  ⚠ Fanout failed for ${f.agent}: ${f.error}`),
              );
            }
          }
          console.log();
          console.log(
            `Next: 'switchroom agent restart ${targets.join(" ")}' to load the new credentials.`,
          );
          console.log();
        },
      ),
    );
}

/* ── refresh-accounts ────────────────────────────────────────────────── */

function registerRefreshAccounts(authParent: Command, program: Command): void {
  authParent
    .command("refresh-accounts")
    .description(
      "Run a single account-refresh tick: refresh expiring tokens, fan out to enabled agents",
    )
    .option(
      "--json",
      "Emit a single JSON line instead of human-readable text (for cron logging)",
    )
    .action(
      withConfigError(async (opts: { json?: boolean }) => {
        const config = getConfig(program);
        const summary = await refreshAllAccounts(config);

        if (opts.json) {
          console.log(JSON.stringify(summary));
          return;
        }

        const c = summary.counts;
        const took = summary.finishedAt - summary.startedAt;
        console.log(
          `account refresh tick: ${c.refreshed} refreshed, ${c.skippedFresh} fresh, ` +
            `${c.skippedNoRefreshToken} need re-auth, ${c.failedRefresh} failed; ` +
            `${c.fannedOut} fanouts, ${c.failedFanout} fanout failures (${took}ms)`,
        );
        for (const o of summary.refreshes) {
          if (o.kind === "failed") {
            console.log(chalk.red(`  ✗ ${o.account}: ${o.error}`));
          } else if (o.kind === "skipped-no-refresh-token") {
            console.log(
              chalk.yellow(
                `  ⚠ ${o.account}: needs re-auth (no refresh token)`,
              ),
            );
          }
        }
        for (const o of summary.fanouts) {
          if (o.kind === "fanout-failed") {
            console.log(
              chalk.red(`  ✗ fanout ${o.account}→${o.agent}: ${o.error}`),
            );
          }
        }
      }),
    );
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function parseCredentialsFile(path: string): AccountCredentials {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`failed to read ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw) as AccountCredentials;
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

function assertCredentialsHaveAccessToken(creds: AccountCredentials): void {
  const tok = creds.claudeAiOauth?.accessToken;
  if (typeof tok !== "string" || tok.length === 0) {
    throw new Error(
      "credentials are missing claudeAiOauth.accessToken — this doesn't look like a " +
        "Claude Code credentials.json file produced by `claude setup-token`.",
    );
  }
}

function healthBadgeFor(h: string): string {
  switch (h) {
    case "healthy":
      return chalk.green("✓");
    case "quota-exhausted":
      return chalk.yellow("⊘");
    case "expired":
      return chalk.yellow("↻");
    case "missing-refresh-token":
      return chalk.red("✗");
    case "missing-credentials":
      return chalk.red("?");
    default:
      return "·";
  }
}

function formatDuration(ms: number): string {
  if (ms < 0) return "expired";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h`;
}
