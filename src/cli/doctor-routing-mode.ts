/**
 * `switchroom doctor` probe for agents that booted OFF the LiteLLM proxy.
 *
 * ## Why this exists
 *
 * The operator invariant is that all agent traffic rides the LiteLLM proxy
 * (Claude Code keeps its own OAuth passthrough; LiteLLM is the metering and
 * guardrail layer). start.sh has exactly one path that breaks that invariant
 * on purpose: the MISSING-KEY fail-open. When the per-agent virtual key cannot
 * be fetched from the vault there is nothing to authenticate to the proxy
 * with, so start.sh strips `ANTHROPIC_BASE_URL` / `SWITCHROOM_LITELLM*` and
 * lets the session run direct against Anthropic — UNTRACKED — rather than
 * refusing to boot. Availability wins; that trade is deliberate.
 *
 * The trade is only safe if the operator finds out. Today two signals exist
 * and both are transient:
 *
 *   1. A `>&2` WARNING from start.sh (`profiles/_base/start.sh.hbs`, the
 *      "litellm FAIL-OPEN" banner and its outer-pass one-liner). It goes to
 *      the container log, which rotates, and nobody greps a healthy-looking
 *      agent's boot log.
 *   2. The `.session-model-alert` divergence line, which the gateway relays to
 *      the operator ONCE per (landed, declared) pair — by design, so a
 *      persistently degraded agent does not nag on every restart. The flip
 *      side is that a persistently degraded agent goes quiet after the first
 *      alert and stays quiet across every subsequent boot.
 *
 * So an agent can sit indefinitely on untracked direct OAuth with no standing
 * signal anywhere. `switchroom doctor` is the standing-signal surface, and it
 * had no check for this.
 *
 * ## Why `.routing-mode` and not the process environ
 *
 * start.sh writes `<agentDir>/.routing-mode` (0644, one line, overwritten)
 * immediately before `exec claude`, from the same variables the session is
 * about to launch on:
 *
 *   mode=<landed> base=<url|direct> model=<m> litellm_ok=<0|1> declared=<intent> ts=<iso>
 *
 * That is a deterministic, already-existing record of where the boot actually
 * landed. Scraping `/proc/<pid>/environ` inside each container would need
 * docker exec, would only work for RUNNING agents, and would re-derive by
 * inference what start.sh already states as fact. Reading the file is the
 * durable mechanism.
 *
 * ## Signal
 *
 * Narrow on purpose: only the untracked condition earns a row. `declared` is a
 * LiteLLM mode (`passthrough` / `router-root`) but the boot LANDED on
 * `direct-oauth` — i.e. routing was stripped. Other divergences (declared
 * `router-root`, landed `passthrough`) still ride the proxy and are still
 * metered, so they are the `.session-model-alert` relay's business, not a
 * standing doctor FAIL. `declared=direct-oauth` means LiteLLM was never
 * configured for that agent and there is no invariant to breach.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveAgentsDir } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";
import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/** Parsed `.routing-mode` line. Fields mirror start.sh's writer exactly. */
export interface RoutingModeRecord {
  /** Where the boot LANDED: direct-oauth | passthrough | router-root. */
  mode: string;
  /** ANTHROPIC_BASE_URL at exec, or the literal "direct" when unset. */
  base: string;
  /** The model the session launched on. */
  model: string;
  /** "1" when the boot-time liveliness probe succeeded, else "0". */
  litellmOk: string;
  /** Apply-time INTENT: direct-oauth | passthrough | router-root. */
  declared: string;
  /** ISO-8601 UTC stamp of the boot that wrote this record. */
  ts: string;
}

/** The `declared` values that assert "this agent must ride the proxy". */
const LITELLM_DECLARED_MODES = new Set(["passthrough", "router-root"]);

/** The `mode` value that means routing was stripped — no proxy in the path. */
const UNTRACKED_MODE = "direct-oauth";

export const ROUTING_MODE_FILENAME = ".routing-mode";

/** Absolute path to an agent's boot routing record. */
export function routingModePath(agentDir: string): string {
  return join(agentDir, ROUTING_MODE_FILENAME);
}

/**
 * Parse the single-line `key=value key=value …` record start.sh writes.
 *
 * Returns null when the load-bearing fields (`mode`, `declared`) are absent —
 * a truncated or foreign file must not be read as a healthy agent. Unknown
 * extra keys are ignored so adding a field to the writer does not break this.
 */
export function parseRoutingModeRecord(text: string): RoutingModeRecord | null {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  if (!line) return null;

  const fields: Record<string, string> = {};
  for (const tok of line.trim().split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    fields[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  if (!fields.mode || !fields.declared) return null;

  return {
    mode: fields.mode,
    base: fields.base ?? "",
    model: fields.model ?? "",
    litellmOk: fields.litellm_ok ?? "",
    declared: fields.declared,
    ts: fields.ts ?? "",
  };
}

/**
 * Verdict for one boot record, or null when there is nothing to report.
 *
 * FAILs (non-zero exit) rather than warns: an agent metering nothing while the
 * operator believes the fleet is fully metered is a breached invariant with a
 * concrete remediation, not a thing to glance at.
 */
export function classifyRoutingMode(
  rec: RoutingModeRecord,
): { status: CheckStatus; detail: string } | null {
  if (!LITELLM_DECLARED_MODES.has(rec.declared)) return null;
  if (rec.mode !== UNTRACKED_MODE) return null;

  const when = rec.ts ? ` at its last boot (${rec.ts})` : "";
  return {
    status: "fail",
    detail:
      `landed on direct-oauth${when} but its declared routing is ` +
      `\`${rec.declared}\` — start.sh's missing-key fail-open stripped the ` +
      `LiteLLM routing env, so this agent runs UNTRACKED on direct Anthropic ` +
      `OAuth: no spend attribution, no guardrails` +
      (rec.model ? ` (model \`${rec.model}\`)` : "") +
      `.`,
  };
}

export interface RoutingModeDeps {
  /** Defaults to `resolveAgentsDir(config)`, resolved lazily + guarded. */
  agentsDir?: string;
  /** File read seam — injected in tests. Must throw on a missing file. */
  readFile?: (p: string) => string;
}

const FIX =
  "start.sh could not fetch this agent's `litellm/<agent>/api-key` from the " +
  "vault-broker. Re-run `switchroom apply` (it provisions the per-agent " +
  "virtual key idempotently and re-grants the agent's `secrets:` ACL), then " +
  "RESTART the agent — the strip is decided once at boot and is never " +
  "re-evaluated for the life of the session, so a fixed key does not take " +
  "effect until the next boot. Confirm from the agent's `.routing-mode` line " +
  "afterwards.";

/**
 * For each configured agent, report a boot that landed off the proxy.
 *
 * Silent for a healthy record, for an agent with no record (never booted since
 * the writer shipped), and for an agent whose declared routing genuinely is
 * direct-oauth. An unreadable or malformed record earns a WARN: "cannot see
 * the evidence" must never render identically to "verified healthy", which is
 * the exact failure mode this probe exists to end.
 */
export function runRoutingModeChecks(
  config: SwitchroomConfig,
  deps: RoutingModeDeps = {},
): CheckResult[] {
  const results: CheckResult[] = [];
  const agents = Object.keys(config.agents ?? {});
  if (agents.length === 0) return results;

  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));

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
        name: "litellm routing",
        status: "warn",
        detail:
          "could not resolve the agents directory (no switchroom block) — " +
          "skipped the boot routing-mode check",
      },
    ];
  }

  for (const name of agents) {
    const path = routingModePath(join(agentsDir, name));

    let text: string;
    try {
      text = readFile(path);
    } catch (err) {
      // ENOENT is the honest "this agent has not booted since the writer
      // shipped" case and stays silent. Anything else (EACCES on a
      // hardened agent dir, EISDIR, I/O error) is a blind spot worth a row.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      results.push({
        name: `litellm routing: ${name}`,
        status: "warn",
        detail:
          `could not read the boot routing record at ${path} ` +
          `(${code ?? (err as Error).message}) — an untracked boot would go ` +
          `unreported here.`,
        fix: `Check the file's ownership and mode (start.sh writes it 0644 before \`exec claude\`).`,
      });
      continue;
    }

    const rec = parseRoutingModeRecord(text);
    if (!rec) {
      results.push({
        name: `litellm routing: ${name}`,
        status: "warn",
        detail:
          `the boot routing record at ${path} is malformed (no \`mode=\`/` +
          `\`declared=\` fields) — an untracked boot would go unreported here.`,
        fix: `Delete it and restart the agent to have start.sh rewrite it: rm ${path}`,
      });
      continue;
    }

    const verdict = classifyRoutingMode(rec);
    if (!verdict) continue;

    results.push({
      name: `litellm routing: ${name}`,
      status: verdict.status,
      detail: verdict.detail,
      fix: FIX,
    });
  }

  return results;
}
