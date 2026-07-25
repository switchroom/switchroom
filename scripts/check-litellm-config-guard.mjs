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
 * the guard is no longer vacuous in CI). The LIVE host copy (path resolved by
 * discovery, or the `LITELLM_CONFIG_PATH` env var — deployment-specific, never
 * hardcoded here) is additionally checked when it resolves and the file is
 * present, and skipped VISIBLY otherwise (never a silent pass — an unresolved
 * live copy must be distinguishable from an approved one). CI/dev always skips;
 * on-host enforcement for the live file is the fleet-health
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
 * baking this deployment's Coolify service id into a public repo. Zero matches
 * (off-host) and >1 match (ambiguous host) both resolve to null and print a
 * SKIP notice naming the reason.
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

// Mirrors src/litellm/header-passthrough-guard.ts (discoverLiveLitellmConfigPath),
// including its `{ path, reason, candidates }` result shape. Duplicated because
// this is a plain .mjs lint script that cannot import the TS core; keep the two
// in sync — the TS copy is the reference implementation.
//
// `SWITCHROOM_COOLIFY_SERVICES_DIR` is the seam that stands in for the TS
// copy's injectable `servicesDir` option (a .mjs script run as a subprocess has
// no other injection point). It only redirects DISCOVERY of the live copy; the
// repo-managed config is always checked from its fixed in-repo path.
const COOLIFY_SERVICES_DIR =
  process.env.SWITCHROOM_COOLIFY_SERVICES_DIR || "/data/coolify/services";

/** @returns {{ path: string|null, reason: "found"|"no-services-dir"|"not-found"|"ambiguous", candidates: string[] }} */
function discoverLiveConfigPath() {
  let entries;
  try {
    entries = readdirSync(COOLIFY_SERVICES_DIR);
  } catch {
    return { path: null, reason: "no-services-dir", candidates: [] };
  }
  const candidates = [];
  for (const entry of [...entries].sort()) {
    const candidate = `${COOLIFY_SERVICES_DIR}/${entry}/litellm-config.yaml`;
    if (existsSync(candidate)) candidates.push(candidate);
  }
  if (candidates.length === 1) return { path: candidates[0], reason: "found", candidates };
  if (candidates.length === 0) return { path: null, reason: "not-found", candidates };
  return { path: null, reason: "ambiguous", candidates };
}

/**
 * Resolve the live config path, announcing EVERY unresolved outcome. An
 * unresolvable live copy is a visible SKIP, never a silent pass: a lint run
 * that quietly checked nothing live is indistinguishable from one that checked
 * and approved, which is precisely the failure this guard exists to prevent.
 *
 * @returns {string|null}
 */
function resolveLivePath() {
  const fromEnv = process.env.LITELLM_CONFIG_PATH;
  if (fromEnv) return fromEnv;

  const { path: discovered, reason, candidates } = discoverLiveConfigPath();
  if (reason === "found") return discovered;

  const why =
    reason === "ambiguous"
      ? `${candidates.length} candidate live configs under ${COOLIFY_SERVICES_DIR} ` +
        `(${candidates.join(", ")}) — refusing to guess which proxy is authoritative`
      : reason === "no-services-dir"
        ? `no Coolify services dir at ${COOLIFY_SERVICES_DIR} (hermetic CI/dev expected to skip)`
        : `no service under ${COOLIFY_SERVICES_DIR} owns a litellm-config.yaml`;
  console.log(
    `check-litellm-config-guard: SKIP (live) — ${why}.\n` +
      `  The repo-managed copy was still checked. Set LITELLM_CONFIG_PATH to point at\n` +
      `  the live config; on-host enforcement is the fleet-health litellm-config sensor.`,
  );
  return null;
}

const path = resolveLivePath();

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
// vacuous in CI). The live/host copy is additionally checked when it resolves
// (LITELLM_CONFIG_PATH env var → discovery); an unresolved live copy already
// printed a visible SKIP in resolveLivePath().
let ok = checkConfig(REPO_LITELLM_CONFIG_PATH, { required: true });
if (path && path !== REPO_LITELLM_CONFIG_PATH) {
  ok = checkConfig(path, { required: false }) && ok;
}
process.exit(ok ? 0 : 1);
