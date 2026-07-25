#!/usr/bin/env node
/**
 * I2 lint guard — LiteLLM `forward_client_headers_to_llm_api` OAuth-leak check.
 *
 * Why this script exists:
 *
 * The subscription OAuth `Authorization: Bearer` header is forwarded straight
 * through to Anthropic ONLY for subscription-Claude model groups, via
 * `forward_client_headers_to_llm_api: true` scoped to those groups (see
 * `docs/model-routing.md` I2). Setting that flag GLOBALLY under
 * `litellm_settings`, or on any non-Claude / `*-openrouter` group, forwards
 * the subscription token to a third party (OpenRouter/OpenAI) — a one-line
 * OAuth leak.
 *
 * KEN-125 — the config has a repo-managed source of truth
 * (`docker/litellm-proxy/litellm-config.yaml`), which this guard ALWAYS
 * checks (required: missing/unparseable/violating repo copy fails lint, so
 * the guard is no longer vacuous in CI). The LIVE host copy (path via the
 * `LITELLM_CONFIG_PATH` env var — deployment-specific, never hardcoded here)
 * is additionally checked when that env var is set and the file is present,
 * and skipped in CI/dev; on-host enforcement for the live file is the fleet-health
 * sensor (`src/fleet-health/litellm-config-sensor.ts`), which runs where the
 * file actually lives and escalates a violation into the priority ledger.
 *
 * The rule (fails lint when the file is present AND violated):
 *   - `forward_client_headers_to_llm_api: true` under `litellm_settings`
 *     (the global master switch), OR
 *   - the same flag on any `model_group_settings` group NOT in the Claude
 *     allowlist (`claude-*`, `sonnet`, `fable`; `*-openrouter` EXCLUDED).
 *
 * Also emits a NON-FATAL 4b advisory when a Claude group sets `num_retries > 1`
 * with no `fallbacks` chain (the broker owns failover — see model-routing.md
 * Known Gaps).
 *
 * The LIVE copy is resolved as: `LITELLM_CONFIG_PATH` env → discovery under the
 * Coolify services dir (`/data/coolify/services/<service>/litellm-config.yaml`).
 * Discovery keeps the on-host lint honest with zero operator setup WITHOUT
 * baking this deployment's Coolify service id into a public repo. Off-host
 * discovery finds nothing and the live check is skipped.
 *
 * Run: `npm run lint:litellm-config-guard` (also part of `npm run lint`).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const FLAG = "forward_client_headers_to_llm_api";

// KEN-125: the config now has a repo-managed source of truth. That copy is
// ALWAYS checked (so this guard is no longer vacuous off-host); the host/live
// copy is additionally checked when resolvable.
const REPO_LITELLM_CONFIG_PATH = fileURLToPath(
  new URL("../docker/litellm-proxy/litellm-config.yaml", import.meta.url),
);

// Mirrors src/litellm/header-passthrough-guard.ts (discoverLiveLitellmConfigPath).
// Duplicated because this is a plain .mjs lint script that cannot import the TS
// core; keep the two in sync — the TS copy is the reference implementation.
const COOLIFY_SERVICES_DIR = "/data/coolify/services";

function discoverLiveConfigPath() {
  let entries;
  try {
    entries = readdirSync(COOLIFY_SERVICES_DIR);
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of [...entries].sort()) {
    const candidate = `${COOLIFY_SERVICES_DIR}/${entry}/litellm-config.yaml`;
    if (existsSync(candidate)) candidates.push(candidate);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    console.log(
      `check-litellm-config-guard: SKIP (live) — ${candidates.length} candidate live configs under ` +
        `${COOLIFY_SERVICES_DIR}; set LITELLM_CONFIG_PATH to disambiguate.`,
    );
  }
  return null;
}

const path = process.env.LITELLM_CONFIG_PATH ?? discoverLiveConfigPath();

function isClaudeAllowlistedGroup(name) {
  if (name.endsWith("-openrouter")) return false;
  return name.startsWith("claude-") || name === "sonnet" || name === "fable";
}

function flagTruthy(v) {
  return v === true || v === "true";
}

function* iterGroups(mgs) {
  if (!mgs || typeof mgs !== "object") return;
  if (Array.isArray(mgs)) {
    for (const e of mgs) {
      if (!e || typeof e !== "object") continue;
      const name =
        (typeof e.model_group === "string" && e.model_group) ||
        (typeof e.group_name === "string" && e.group_name) ||
        (typeof e.model_name === "string" && e.model_name) ||
        null;
      if (name) yield [name, e];
    }
    return;
  }
  for (const [name, settings] of Object.entries(mgs)) {
    if (settings && typeof settings === "object") yield [name, settings];
  }
}

function fallbackGroups(root) {
  const out = new Set();
  const sources = [root.litellm_settings?.fallbacks, root.router_settings?.fallbacks];
  for (const fb of sources) {
    if (!Array.isArray(fb)) continue;
    for (const entry of fb) {
      if (!entry || typeof entry !== "object") continue;
      for (const [src, targets] of Object.entries(entry)) {
        out.add(src);
        if (Array.isArray(targets)) for (const t of targets) if (typeof t === "string") out.add(t);
      }
    }
  }
  return out;
}

/**
 * Check one config file. Returns true when the check passed (or was a
 * permitted skip). `required` — KEN-125: the repo-managed copy
 * (docker/litellm-proxy/litellm-config.yaml) must exist and parse; only the
 * host/live path may be absent (hermetic CI/dev).
 */
function checkConfig(path, { required }) {
  if (!existsSync(path)) {
    if (required) {
      console.error(
        `check-litellm-config-guard: FAIL — repo-managed config MISSING at ${path}\n` +
          `  (docker/litellm-proxy/litellm-config.yaml is the source of truth — KEN-125)`,
      );
      return false;
    }
    console.log(
      `check-litellm-config-guard: SKIP — live config absent at ${path}\n` +
        `  (hermetic CI/dev expected to skip the LIVE copy; the repo copy was\n` +
        `   still checked. On-host enforcement for the live file is the\n` +
        `   fleet-health litellm-config sensor. Set LITELLM_CONFIG_PATH to\n` +
        `   point at the live config.)`,
    );
    return true;
  }

  let root;
  try {
    root = parseYaml(readFileSync(path, "utf-8"));
  } catch (e) {
    console.error(`check-litellm-config-guard: FAIL — ${path} is unparseable YAML: ${String(e)}`);
    return false;
  }

  if (!root || typeof root !== "object") {
    if (required) {
      console.error(
        `check-litellm-config-guard: FAIL — repo-managed config at ${path} parsed to an empty/non-object config`,
      );
      return false;
    }
    console.log(`check-litellm-config-guard: SKIP — ${path} parsed to an empty/non-object config`);
    return true;
  }

  const violations = [];
  const ls = root.litellm_settings;
  if (ls && typeof ls === "object" && flagTruthy(ls[FLAG])) {
    violations.push(
      `${FLAG}: true under litellm_settings (GLOBAL master switch — forwards the ` +
        `subscription OAuth header to EVERY upstream, OpenRouter included)`,
    );
  }
  for (const [group, settings] of iterGroups(root.model_group_settings)) {
    if (flagTruthy(settings[FLAG]) && !isClaudeAllowlistedGroup(group)) {
      violations.push(
        `${FLAG}: true on non-Claude group '${group}' (forwards the subscription ` +
          `OAuth header to a non-subscription upstream)`,
      );
    }
  }

  // 4b advisory (non-fatal).
  const hasFallbackFor = fallbackGroups(root);
  for (const [group, settings] of iterGroups(root.model_group_settings)) {
    if (!isClaudeAllowlistedGroup(group)) continue;
    const nr = Number(settings.num_retries);
    if (Number.isFinite(nr) && nr > 1 && !hasFallbackFor.has(group)) {
      console.warn(
        `check-litellm-config-guard: WARN — Claude group '${group}' sets ` +
          `num_retries: ${nr} with no fallbacks chain. The auth broker owns ` +
          `failover; prefer num_retries: 1 + a fallbacks chain ` +
          `(see docs/model-routing.md Known Gaps).`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(`check-litellm-config-guard: FAIL — OAuth-leak header scoping in ${path}:`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      `\n  Fix: scope ${FLAG} to Claude model groups only (claude-*, sonnet, fable);\n` +
        `  never global under litellm_settings, never on a non-Claude/*-openrouter group.`,
    );
    return false;
  }

  console.log(`check-litellm-config-guard: OK — header passthrough correctly scoped (${path})`);
  return true;
}

// The repo-managed copy is ALWAYS checked (required — the guard is no longer
// vacuous in CI). The live/host copy (LITELLM_CONFIG_PATH env var) is
// additionally checked when the env var is set.
let ok = checkConfig(REPO_LITELLM_CONFIG_PATH, { required: true });
if (path && path !== REPO_LITELLM_CONFIG_PATH) {
  ok = checkConfig(path, { required: false }) && ok;
}
process.exit(ok ? 0 : 1);
