/**
 * Deterministic + observable agent→LiteLLM routing (2026-07-17 boot-race
 * incident: a slow LiteLLM co-boot silently demoted a configured-fable agent
 * to opus on the passthrough, while another agent landed fable on the router
 * root — both divergences invisible to the operator).
 *
 * Contract under test, against the RENDERED start.sh (outcome tests — a
 * rendered script that would still demote unreachable-fable FAILS here):
 *
 *   1. Fable demotion is SPLIT BY CAUSE:
 *      - missing key (routing stripped, _LITELLM_UNREACHABLE empty) → still
 *        demotes to opus, loudly (.session-model-alert) — fable genuinely
 *        cannot work direct-to-Anthropic (retired codename, 4xxs).
 *      - proxy unreachable, key present (_LITELLM_UNREACHABLE=1, routing left
 *        in place) → NO demotion: boots the declared fable model pointed at
 *        the LiteLLM router root, loud-degraded (same policy as sr-*).
 *   2. `.routing-mode` state file: one overwrite-per-boot line
 *      (mode=… base=… model=… litellm_ok=… declared=… ts=…) written just
 *      before exec claude, plus a `routing:` stderr echo.
 *   3. Divergence alert (landed ≠ declared) appends to .session-model-alert
 *      but is DEDUPED against the previous boot's landed mode — a
 *      persistently degraded agent alerts once, not on every restart.
 *   4. Inner LiteLLM probe budget is 240s, env-tunable via
 *      SWITCHROOM_LITELLM_BOOT_BUDGET; the OUTER (gateway-pass) probe stays
 *      at 120s.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

function makeSwitchroomConfig(name: string, agentConfig: AgentConfig): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: telegramConfig,
    agents: { [name]: agentConfig },
  };
}

const PASSTHROUGH = "http://litellm:4010/anthropic";
const ROUTER_ROOT = "http://litellm:4010";
const BLOCK_HEADER = "# --- Session model resolution";

/** Slice the rendered start.sh from the session-model resolver through the
 *  routing-mode write (everything up to, excluding, the exec claude lines). */
function extractResolverThroughRouting(startSh: string): string {
  const start = startSh.indexOf(BLOCK_HEADER);
  const end = startSh.indexOf('if [ -n "$APPEND_PROMPT" ]', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return startSh.slice(start, end);
}

interface RunOpts {
  litellmOk?: string;
  litellmUnreachable?: string;
  /** Value of SWITCHROOM_LITELLM_DECLARED (captured-before-strip flag). */
  litellmDeclared?: string;
  baseUrl?: string;
  routerRoot?: string;
}

describe("rendered start.sh: routing-mode observability + fable cause split", () => {
  let tmpDir: string;
  let agentDir: string;
  let startSh: string;
  let block: string;

  function scaffold(model: string): void {
    const name = "routing-agent";
    const config = makeAgentConfig({ model } as Partial<AgentConfig>);
    const res = scaffoldAgent(name, config, tmpDir, telegramConfig, makeSwitchroomConfig(name, config));
    agentDir = res.agentDir;
    startSh = readFileSync(join(agentDir, "start.sh"), "utf-8");
    block = extractResolverThroughRouting(startSh);
  }

  function runBlock(opts: RunOpts = {}): { out: string; stderr: string } {
    const script = [
      "set -e",
      "unset SWITCHROOM_CONFIG",
      `export ANTHROPIC_BASE_URL=${JSON.stringify(opts.baseUrl ?? PASSTHROUGH)}`,
      `export SWITCHROOM_LITELLM_BASE=${JSON.stringify(opts.routerRoot ?? ROUTER_ROOT)}`,
      `export SWITCHROOM_LITELLM_DECLARED=${JSON.stringify(opts.litellmDeclared ?? "1")}`,
      `_LITELLM_OK=${JSON.stringify(opts.litellmOk ?? "")}`,
      `_LITELLM_UNREACHABLE=${JSON.stringify(opts.litellmUnreachable ?? "")}`,
      block,
      'echo "EFFECTIVE=$_EFFECTIVE_MODEL"',
      'echo "BASEURL=$ANTHROPIC_BASE_URL"',
    ].join("\n");
    // Single run (side effects — .routing-mode / alert appends — must happen
    // exactly once per simulated boot); stderr merged into the output.
    const both = execFileSync("bash", ["-c", `{ ${script}\n} 2>&1`], { encoding: "utf-8" });
    return { out: both, stderr: both };
  }

  function routingFile(): string {
    const p = join(agentDir, ".routing-mode");
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  function alertText(): string {
    const p = join(agentDir, ".session-model-alert");
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-routing-mode-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Fable demotion split by cause ────────────────────────────────────

  it("unreachable fable (key present, probe failed) does NOT demote: boots fable on the router root", () => {
    scaffold("fable");
    const { out } = runBlock({ litellmOk: "", litellmUnreachable: "1" });
    // The load-bearing assertion: the old behavior rewrote fable→opus here.
    expect(out).toContain("EFFECTIVE=fable");
    expect(out).not.toContain("EFFECTIVE=opus");
    // Loud-degraded lands on the ROUTER ROOT (self-heals per request when the
    // proxy returns) — not the model-agnostic passthrough where fable 4xxs.
    expect(out).toContain(`BASEURL=${ROUTER_ROOT}`);
    // No opus-demotion operator alert (divergence alert is separate).
    expect(alertText()).not.toContain("booted on `opus`");
  });

  it("missing-key fable (routing stripped) still demotes to opus with an operator alert", () => {
    scaffold("fable");
    const { out } = runBlock({ litellmOk: "", litellmUnreachable: "" });
    expect(out).toContain("EFFECTIVE=opus");
    expect(alertText()).toContain("`opus`");
    expect(alertText()).toContain("fable");
    expect(alertText()).toContain("virtual key");
  });

  it("fable + LiteLLM up boots fable via the router root (unchanged healthy path)", () => {
    scaffold("fable");
    const { out } = runBlock({ litellmOk: "1" });
    expect(out).toContain("EFFECTIVE=fable");
    expect(out).toContain(`BASEURL=${ROUTER_ROOT}`);
  });

  it("healthy fable declares router-root and fires NO divergence alert (CRITICAL-1 regression)", () => {
    // A configured-fable agent rides compose's /anthropic passthrough env but
    // start.sh repoints it onto the router root — so its DECLARED intent must
    // be router-root, matching the landed mode. A regression to the raw
    // isClaudeModel split (declared=passthrough) makes every healthy fable boot
    // cry wolf with a permanent "Routing divergence" alert.
    scaffold("fable");
    const { out } = runBlock({ litellmOk: "1" });
    expect(out).toContain(`BASEURL=${ROUTER_ROOT}`);
    expect(routingFile()).toContain("mode=router-root");
    expect(routingFile()).toContain("declared=router-root");
    expect(alertText()).not.toContain("Routing divergence");
  });

  it("re-alerts when the declared class flips while the landed mode stays stuck (LOW-2 dedup pair)", () => {
    // Boot 1: sonnet declares passthrough but lands router-root → divergence.
    scaffold("claude-sonnet-5");
    runBlock({ litellmOk: "1", baseUrl: ROUTER_ROOT });
    const first = alertText();
    expect(first).toContain("Routing divergence");
    // Boot 2: same landed router-root, but now declared flips to direct-oauth
    // (operator un-configured LiteLLM). Landed mode is unchanged, yet the
    // (landed, declared) PAIR changed → a NEW divergence alert must fire.
    runBlock({ litellmOk: "1", baseUrl: ROUTER_ROOT, litellmDeclared: "" });
    expect(alertText().length).toBeGreaterThan(first.length);
  });

  // ── 2. .routing-mode state file + stderr line ───────────────────────────

  it("writes one .routing-mode line with mode/base/model/litellm_ok/declared/ts and echoes routing: to stderr", () => {
    scaffold("fable");
    const { stderr } = runBlock({ litellmOk: "1" });
    const line = routingFile().trim();
    expect(line).toMatch(/^mode=router-root /);
    expect(line).toContain(`base=${ROUTER_ROOT}`);
    expect(line).toContain("model=fable");
    expect(line).toContain("litellm_ok=1");
    expect(line).toMatch(/declared=[a-z-]+/);
    expect(line).toMatch(/ts=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(routingFile().trim().split("\n")).toHaveLength(1);
    expect(stderr).toContain("routing: mode=router-root ");
  });

  it("Claude default on the passthrough records mode=passthrough", () => {
    scaffold("claude-sonnet-5");
    runBlock({ litellmOk: "1" });
    expect(routingFile()).toContain("mode=passthrough");
    expect(routingFile()).toContain("declared=passthrough");
  });

  it("no ANTHROPIC_BASE_URL records mode=direct-oauth (litellm never configured → declared direct-oauth, no divergence)", () => {
    scaffold("claude-sonnet-5");
    const script = [
      "set -e",
      "unset SWITCHROOM_CONFIG ANTHROPIC_BASE_URL SWITCHROOM_LITELLM_BASE SWITCHROOM_LITELLM_DECLARED",
      '_LITELLM_OK=""',
      '_LITELLM_UNREACHABLE=""',
      block,
    ].join("\n");
    execFileSync("bash", ["-c", script], { encoding: "utf-8" });
    expect(routingFile()).toContain("mode=direct-oauth");
    expect(routingFile()).toContain("declared=direct-oauth");
    expect(alertText()).not.toContain("Routing divergence");
  });

  // ── 3. Divergence alert, deduped against the previous boot ─────────────

  it("landed≠declared appends a divergence alert on the FIRST such boot only (dedupe on persistent degradation)", () => {
    scaffold("claude-sonnet-5"); // declared=passthrough
    // Force a router-root landing (e.g. stripped /anthropic suffix upstream).
    runBlock({ litellmOk: "1", baseUrl: ROUTER_ROOT });
    expect(routingFile()).toContain("mode=router-root");
    expect(alertText()).toContain("Routing divergence");
    const alerts1 = alertText();
    // Second boot, same landed mode: NO new divergence line.
    runBlock({ litellmOk: "1", baseUrl: ROUTER_ROOT });
    expect(alertText()).toBe(alerts1);
    // Mode changes again (back to passthrough≠…, i.e. a NEW landed mode that
    // again diverges) → alerts again.
  });

  it("alerts again when the landed mode CHANGES to a new divergent mode", () => {
    scaffold("claude-sonnet-5"); // declared=passthrough
    runBlock({ litellmOk: "1", baseUrl: ROUTER_ROOT });
    const first = alertText();
    expect(first).toContain("Routing divergence");
    // Next boot lands direct-oauth (routing stripped) — different landed mode.
    const script = [
      "set -e",
      "unset SWITCHROOM_CONFIG ANTHROPIC_BASE_URL SWITCHROOM_LITELLM_BASE",
      'export SWITCHROOM_LITELLM_DECLARED="1"',
      '_LITELLM_OK=""',
      '_LITELLM_UNREACHABLE=""',
      block,
    ].join("\n");
    execFileSync("bash", ["-c", script], { encoding: "utf-8" });
    expect(alertText().length).toBeGreaterThan(first.length);
    expect(alertText()).toContain("direct-oauth");
  });

  it("converged boot (landed == declared) never writes a divergence alert", () => {
    scaffold("sr-glm-5"); // declared=router-root
    runBlock({ litellmOk: "1", baseUrl: ROUTER_ROOT });
    expect(routingFile()).toContain("mode=router-root");
    expect(routingFile()).toContain("declared=router-root");
    expect(alertText()).not.toContain("Routing divergence");
  });

  // ── 4. Rendered-script static assertions ────────────────────────────────

  it("renders the .routing-mode write and the 240s env-tunable INNER probe budget (outer stays 120s)", () => {
    scaffold("fable");
    expect(startSh).toContain('.routing-mode"');
    expect(startSh).toContain('echo "routing: $_routing_line"');
    // Inner budget: env-tunable, default 240.
    expect(startSh).toContain('sr_ll_budget="${SWITCHROOM_LITELLM_BOOT_BUDGET:-240}"');
    expect(startSh).toContain("sr_ll_deadline=$(( $(date +%s) + sr_ll_budget ))");
    // Outer (gateway-pass) probe keeps the 120s hard budget — extending it
    // would double gateway boot delay.
    expect(startSh).toContain("sr_ll_deadline=$(( $(date +%s) + 120 ))");
    // The rendered script must NOT contain the old unconditional demotion.
    expect(startSh).not.toContain("LiteLLM was unreachable at boot, so the configured model");
  });

  it("derives declared= from the POST-REPOINT mode (passthrough only for non-fable Claude; router-root for fable + sr-*)", () => {
    // _DECLARED_ROUTING is computed at runtime from $_DECLARED_MODEL (the
    // resolved model snapshotted before any missing-key demotion), not baked
    // into the script at render time — so assert on the actual written
    // .routing-mode record for each model class, healthy-boot per class.
    scaffold("claude-sonnet-5");
    runBlock({ litellmOk: "1" });
    expect(routingFile()).toContain("declared=passthrough");

    scaffold("sr-glm-5");
    runBlock({ litellmOk: "1", baseUrl: ROUTER_ROOT });
    expect(routingFile()).toContain("declared=router-root");

    // fable is a Claude-class model but start.sh repoints it to the router
    // root, so its DECLARED intent must be router-root, not passthrough.
    scaffold("fable");
    runBlock({ litellmOk: "1" });
    expect(routingFile()).toContain("declared=router-root");
  });

  it("missing-key fable demotion (opus) still declares router-root — the divergence stays visible", () => {
    // Regression guard for the bug this fix closes: computing _DECLARED_
    // ROUTING from the POST-demotion $_EFFECTIVE_MODEL would read "opus" and
    // conclude declared=passthrough, masking the exact divergence
    // (fable -> opus on a missing key) this file exists to catch.
    scaffold("fable");
    const { out } = runBlock({ litellmOk: "", litellmUnreachable: "" });
    expect(out).toContain("EFFECTIVE=opus");
    expect(routingFile()).toContain("declared=router-root");
  });
});
