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
 * OAuth leak. switchroom emits no LiteLLM config (it is operator-maintained in
 * Coolify), so this scoping had zero code enforcement.
 *
 * IMPORTANT — this lint step is a cheap belt, NOT the load-bearing check. The
 * config file lives on the switchroom host (e.g.
 * `/data/coolify/services/<litellm-service-id>/litellm-config.yaml`) and is
 * absent in CI/dev, where this guard SKIPS with a visible notice. The
 * load-bearing enforcement is the fleet-health sensor
 * (`src/fleet-health/litellm-config-sensor.ts`), which runs where the file
 * actually lives and escalates a violation into the priority ledger.
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
 * The path comes from `LITELLM_CONFIG_PATH` (no hard-coded default — the real
 * path embeds a deployment-identifying Coolify service id); unset → SKIP.
 *
 * Run: `npm run lint:litellm-config-guard` (also part of `npm run lint`).
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const FLAG = "forward_client_headers_to_llm_api";

const path = process.env.LITELLM_CONFIG_PATH;

if (!path) {
  console.log(
    `check-litellm-config-guard: SKIP — LITELLM_CONFIG_PATH unset\n` +
      `  (no hard-coded default: the real path embeds a deployment-identifying\n` +
      `   Coolify service id. Set LITELLM_CONFIG_PATH to point at the live\n` +
      `   config; the load-bearing check is the fleet-health litellm-config\n` +
      `   sensor that runs on the host.)`,
  );
  process.exit(0);
}

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

if (!existsSync(path)) {
  console.log(
    `check-litellm-config-guard: SKIP — config file absent at ${path}\n` +
      `  (hermetic CI/dev expected to skip; the load-bearing check is the\n` +
      `   fleet-health litellm-config sensor that runs on the host. Set\n` +
      `   LITELLM_CONFIG_PATH to point at the live config.)`,
  );
  process.exit(0);
}

let root;
try {
  root = parseYaml(readFileSync(path, "utf-8"));
} catch (e) {
  console.error(`check-litellm-config-guard: FAIL — ${path} is unparseable YAML: ${String(e)}`);
  process.exit(1);
}

if (!root || typeof root !== "object") {
  console.log(`check-litellm-config-guard: SKIP — ${path} parsed to an empty/non-object config`);
  process.exit(0);
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
  process.exit(1);
}

console.log(`check-litellm-config-guard: OK — header passthrough correctly scoped (${path})`);
process.exit(0);
