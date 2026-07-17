import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, chmodSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import { isValidModelArg } from "../telegram-plugin/gateway/model-command.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

// Session-scoped /model — the rendered start.sh boot resolver
// (reference/rfcs/session-model-stickiness.md §0.1, rev 4). Driven as
// sh-harness fixtures against the RENDERED block.
//
// Contract under test (BOUNDED-RETRY CONSUME, #3284): a `.session-model`
// carrier is APPLIED on the boot that reads it but NOT deleted by start.sh —
// the GATEWAY deletes it (+ the `.session-model-boot-attempts` counter) once it
// acquires the boot lock (boot.lock_acquired, the healthy-boot signal). So a
// boot that WEDGES before a healthy gateway leaves the carrier in place and the
// retry boot RE-APPLIES the intended model instead of silently reverting (the
// marko/klanker fable→opus revert). A persisted attempt counter BOUNDS the
// retries: a token that never reaches a healthy gateway is given up after
// _SM_MAX_ATTEMPTS boots (revert + alert), so a bad token can never crashloop.
// There is no `.relaunch-model-intent` and no kept-notified sentinel.
// Invalidation (corrupt / configured-default changed / sr-*+LiteLLM-down /
// attempts-exceeded) drops the carrier + counter and writes a
// `.session-model-alert` the gateway relays.

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

const DEFAULT_MODEL = "claude-sonnet-5";
const BLOCK_HEADER = "# --- Session model resolution";

function extractBlock(startSh: string): string {
  const start = startSh.indexOf(BLOCK_HEADER);
  // The block ends at the `.active-session-model` write (NOT the earlier
  // `.configured-default-model` write, which is also a printf of
  // $_EFFECTIVE_MODEL).
  const anchor = startSh.indexOf('.active-session-model"');
  const end = startSh.indexOf("\n", anchor);
  expect(start).toBeGreaterThan(-1);
  expect(anchor).toBeGreaterThan(start);
  return startSh.slice(start, end);
}

/** One-line carrier JSON, same shape the gateway writes. */
function sessionModelJson(model: string, cfg = DEFAULT_MODEL, ts = Date.now()): string {
  return `${JSON.stringify({ model, configuredDefaultAtWrite: cfg, ts })}\n`;
}

describe("scaffoldAgent: session-model consume-once boot resolver (start.sh)", () => {
  let tmpDir: string;
  let agentDir: string;
  let block: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-session-model-"));
    const name = "sm-agent";
    const config = makeAgentConfig();
    const res = scaffoldAgent(name, config, tmpDir, telegramConfig, makeSwitchroomConfig(name, config));
    agentDir = res.agentDir;
    block = extractBlock(readFileSync(join(agentDir, "start.sh"), "utf-8"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Run the extracted block with a given _LITELLM_OK, echo the effective
   * model. SWITCHROOM_CONFIG is unset so the live-config resolution branch
   * is skipped and the bake seeds $_EFFECTIVE_MODEL — the carrier contract
   * under test here is independent of where the configured default came
   * from. The live-read branch has its own suite below.
   */
  function runBlock(litellmOk: string): string {
    const script = `set -e\nunset SWITCHROOM_CONFIG\n_LITELLM_OK=${JSON.stringify(litellmOk)}\n${block}\necho "EFFECTIVE=$_EFFECTIVE_MODEL"`;
    const out = execFileSync("bash", ["-c", script], { encoding: "utf-8" });
    const m = out.match(/EFFECTIVE=(.*)/);
    return m ? m[1].trim() : "";
  }

  const PASSTHROUGH = "http://litellm:4010/anthropic";
  const ROUTER_ROOT = "http://litellm:4010";
  function runBlockRouting(litellmOk: string): { effective: string; baseUrl: string } {
    const script = [
      "set -e",
      "unset SWITCHROOM_CONFIG",
      `export ANTHROPIC_BASE_URL=${JSON.stringify(PASSTHROUGH)}`,
      `export SWITCHROOM_LITELLM_BASE=${JSON.stringify(ROUTER_ROOT)}`,
      `_LITELLM_OK=${JSON.stringify(litellmOk)}`,
      block,
      'echo "EFFECTIVE=$_EFFECTIVE_MODEL"',
      'echo "BASEURL=$ANTHROPIC_BASE_URL"',
    ].join("\n");
    const out = execFileSync("bash", ["-c", script], { encoding: "utf-8" });
    const eff = out.match(/EFFECTIVE=(.*)/);
    const base = out.match(/BASEURL=(.*)/);
    return { effective: eff ? eff[1].trim() : "", baseUrl: base ? base[1].trim() : "" };
  }

  function alertText(): string {
    return readFileSync(join(agentDir, ".session-model-alert"), "utf-8");
  }

  // #3284: start.sh no longer consumes the carrier on apply — the GATEWAY does,
  // once it acquires the boot lock (boot.lock_acquired). These helpers simulate
  // that healthy-boot consume and inspect the bounded-retry attempt counter so
  // the sh-harness can model both a healthy boot and a wedge (no consume).
  function healthyBootConsume(): void {
    rmSync(join(agentDir, ".session-model"), { force: true });
    rmSync(join(agentDir, ".session-model-boot-attempts"), { force: true });
  }
  function carrierExists(): boolean {
    return existsSync(join(agentDir, ".session-model"));
  }
  function attemptCount(): string {
    return existsSync(join(agentDir, ".session-model-boot-attempts"))
      ? readFileSync(join(agentDir, ".session-model-boot-attempts"), "utf-8").trim()
      : "";
  }

  it("renders the consume-once carrier wiring in start.sh (no intent resolution)", () => {
    expect(block).toContain(".session-model");
    expect(block).toContain(".configured-default-model");
    expect(block).toContain(".session-model-alert");
    // Migration shim still consumes the legacy one-shot carrier.
    expect(block).toContain(".session-model-override");
    // The retired keep/revert intent + kept-notified machinery is no longer
    // RESOLVED — those retired filenames appear only in the one-line hygiene
    // `rm -f` (#3184 LOW-2), never in a read/parse/stamp.
    expect(block).not.toContain('"intent"');
    expect(block).not.toContain("_sm_revert");
    expect(block).not.toMatch(/(cat|read -r|<)[^\n]*\.relaunch-model-intent/);
    expect(block).not.toMatch(/(cat|read -r|<)[^\n]*\.session-model-kept-notified/);
    // #3284: `.session-model-boot-attempts` is REVIVED as the live bounded-retry
    // counter — the block now READS it (cat|tr) and PERSISTS it, and the gateway
    // clears it on a healthy boot.
    expect(block).toMatch(/cat[^\n]*\.session-model-boot-attempts/);
    expect(block).toContain("_SM_MAX_ATTEMPTS");
    // modelQ is assigned BARE (already shell-quoted by the scaffold), as the
    // last-ditch fallback seed for the live-config resolution.
    expect(block).toContain("_BAKED_MODEL='claude-sonnet-5'");
    const startSh = readFileSync(join(agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain('--model "$_EFFECTIVE_MODEL"');
    expect(startSh).not.toContain("--model {{{modelQ}}}");
  });

  it("cleans up the retired rev-3 files on boot (#3184 LOW-2 hygiene)", () => {
    // Simulate a fleet rollout onto an agent dir that still carries the
    // retired intent/crashloop/dedup files from the keep-by-default era.
    writeFileSync(join(agentDir, ".relaunch-model-intent"), `${JSON.stringify({ intent: "keep", reason: "old", ts: Date.now() })}\n`);
    writeFileSync(join(agentDir, ".session-model-boot-attempts"), "2 12345\n");
    writeFileSync(join(agentDir, ".session-model-kept-notified"), "claude-opus-4-8\n");
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".relaunch-model-intent"))).toBe(false);
    expect(existsSync(join(agentDir, ".session-model-boot-attempts"))).toBe(false);
    expect(existsSync(join(agentDir, ".session-model-kept-notified"))).toBe(false);
    // A stale intent file has NO effect on carrier resolution: a carrier still
    // applies regardless of any leftover intent content. (#3284: the carrier is
    // now consumed by the gateway on a healthy boot, not by start.sh, so it
    // survives the apply boot; the retired intent file is still swept.)
    writeFileSync(join(agentDir, ".relaunch-model-intent"), `${JSON.stringify({ intent: "revert", reason: "old", ts: Date.now() })}\n`);
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    expect(runBlock("1")).toBe("claude-opus-4-8");
    expect(carrierExists()).toBe(true); // kept for the gateway to consume
    expect(existsSync(join(agentDir, ".relaunch-model-intent"))).toBe(false);
  });

  // ── MODEL_ARG_RE byte-parity against the RENDERED start.sh ────────────────
  it("shape gate is byte-parity with MODEL_ARG_RE (rendered start.sh vs gateway)", () => {
    const startSh = readFileSync(join(agentDir, "start.sh"), "utf-8");
    const patterns = [...startSh.matchAll(/grep -Eq '([^']+)'/g)].map((m) => m[1]);
    const shapePatterns = patterns.filter((p) => p.includes("{0,99}"));
    expect(shapePatterns.length).toBeGreaterThanOrEqual(2); // carrier gate + migration gate
    for (const p of shapePatterns) expect(p).toBe(shapePatterns[0]);
    const shPattern = shapePatterns[0];
    const fixtures: Array<[string, boolean]> = [
      ["claude-opus-4-8", true],
      ["sr-glm-5", true],
      ["sr-x-ai/grok-4", true],
      ["opus", true],
      ["claude-sonnet-4-5[1m]", true],
      ["Opus 4.8", false], // display label — spaces rejected
      ["bad name; rm -rf /", false],
      ["-leading-dash", false],
      ["", false],
      ["a".repeat(101), false],
    ];
    for (const [token, expected] of fixtures) {
      expect(isValidModelArg(token), `TS gate: ${token}`).toBe(expected);
      const shOk =
        execFileSync(
          "bash",
          ["-c", `printf '%s' "$1" | grep -Eq '${shPattern}' && echo yes || echo no`, "sh", token],
          { encoding: "utf-8" },
        ).trim() === "yes";
      expect(shOk, `sh gate: ${token}`).toBe(expected);
    }
  });

  it("no carrier → boots default, records .configured-default-model + no alert", () => {
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(readFileSync(join(agentDir, ".configured-default-model"), "utf-8").trim()).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model-alert"))).toBe(false);
  });

  // ── requirement (a): the apply-relaunch picks up the carrier ─────────────
  it("valid carrier → APPLIES the override this boot and KEEPS the carrier for the gateway (no boot alert)", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    expect(runBlock("1")).toBe("claude-opus-4-8");
    // #3284: start.sh no longer consumes — it applies and leaves the carrier +
    // an attempt counter for the gateway to clear on a healthy boot.
    expect(carrierExists()).toBe(true);
    expect(attemptCount()).toBe("1");
    // The gateway already acked the /model in chat — no boot alert on apply.
    expect(existsSync(join(agentDir, ".session-model-alert"))).toBe(false);
  });

  // ── requirement (b): after the gateway consumes, the next restart reverts ──
  it("SUBSEQUENT restart (after the gateway's healthy-boot consume) → reverts to the configured default", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    expect(runBlock("1")).toBe("claude-opus-4-8"); // apply-relaunch
    healthyBootConsume(); // the gateway acquired the boot lock and cleared the carrier
    expect(runBlock("1")).toBe(DEFAULT_MODEL); // any later restart
    expect(runBlock("1")).toBe(DEFAULT_MODEL); // and every one after
    expect(carrierExists()).toBe(false);
    expect(attemptCount()).toBe(""); // counter swept once the carrier is gone
  });

  // ── #3284 requirement (a): a GOOD token survives a boot-lock wedge ───────
  // A boot that reads the carrier but WEDGES before its gateway acquires the
  // boot lock (boot.lock_stale_recovered_boot_mismatch) never calls
  // healthyBootConsume(); the carrier + counter survive, so the retry boot
  // RE-APPLIES the intended model instead of silently reverting. This is the
  // marko/klanker `fable → opus` revert the pre-fix start.sh produced.
  it("good token + wedge before healthy boot → RE-APPLIES on the retry boot (no silent revert)", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("fable"));
    // Apply-boot 1 wedges (proxy up so `fable` is applied; gateway never reaches
    // boot.lock_acquired, so NO healthyBootConsume()).
    expect(runBlockRouting("1").effective).toBe("fable");
    expect(carrierExists()).toBe(true);
    expect(attemptCount()).toBe("1");
    // Retry boot re-applies `fable` — the pre-fix behavior reverted to default
    // here because the carrier had already been consumed by the wedged boot.
    expect(runBlockRouting("1").effective).toBe("fable");
    expect(attemptCount()).toBe("2");
    // Now the gateway finally acquires the lock and consumes the carrier.
    healthyBootConsume();
    expect(runBlock("1")).toBe(DEFAULT_MODEL); // next ordinary restart reverts
  });

  // ── #3284 CRASHLOOP BOUND: a BAD token gives up after N attempts ─────────
  // A token that NEVER reaches a healthy gateway (claude crashes before
  // boot.lock_acquire on every boot, so healthyBootConsume() is never called)
  // must not wedge→retry→wedge forever. After _SM_MAX_ATTEMPTS (3) apply boots
  // the carrier is dropped, the default is booted, and the operator is alerted.
  it("bad token that keeps wedging → gives up after the bounded attempts, reverts + alerts (no crashloop)", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    // Attempts 1..3 apply the override and KEEP the carrier (each boot wedges).
    expect(runBlock("1")).toBe("claude-opus-4-8");
    expect(attemptCount()).toBe("1");
    expect(runBlock("1")).toBe("claude-opus-4-8");
    expect(attemptCount()).toBe("2");
    expect(runBlock("1")).toBe("claude-opus-4-8");
    expect(attemptCount()).toBe("3");
    // Attempt 4 exceeds the bound → give up: revert to default, drop the
    // carrier + counter, and alert. This is the hard crashloop bound.
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(carrierExists()).toBe(false);
    expect(attemptCount()).toBe("");
    const alert = alertText();
    expect(alert).toContain("claude-opus-4-8");
    expect(alert).toContain("after 3 attempts");
    expect(alert).toContain("reverted");
    // And it STAYS reverted — no resurrection, no loop.
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
  });

  // ── invalidation branches (all consume + alert) ──────────────────────────
  it("corrupt .session-model → deletes it, boots default, notifies (never a silent drop)", () => {
    writeFileSync(join(agentDir, ".session-model"), "{broken\n");
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
    const alert = alertText();
    expect(alert).toContain("could not be read");
    expect(alert).toContain("configured default");
  });

  it("shape-gate-failing model → deletes it, boots default (injection surface closed)", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("bad name; rm -rf /"));
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
  });

  it("MULTILINE .session-model (two model fields on two lines) → rejected, boots default", () => {
    writeFileSync(
      join(agentDir, ".session-model"),
      `${sessionModelJson("sr-glm-5")}${sessionModelJson("sr-evil-2")}`,
    );
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
  });

  it("configuredDefaultAtWrite mismatch (yaml model changed) → NOT applied + announces + consumed", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8", "claude-old-model"));
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
    const alert = alertText();
    expect(alert).toContain("configured default model changed");
    expect(alert).toContain("`claude-old-model` → `claude-sonnet-5`");
    expect(alert).toContain("override to `claude-opus-4-8` was not applied");
  });

  // ── sr-* + LiteLLM guard ─────────────────────────────────────────────────
  it("sr-* carrier + LiteLLM DOWN → boots default, CONSUMES the carrier, tells the operator to re-issue", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("sr-glm-5"));
    expect(runBlock("")).toBe(DEFAULT_MODEL);
    // Consume-once forbids retaining it for a later relaunch.
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
    const alert = alertText();
    expect(alert).toContain("sr-glm-5");
    expect(alert).toContain("LiteLLM");
    expect(alert).toContain("Re-issue /model");
  });

  it("Claude carrier does NOT require LiteLLM (applies with proxy down, carrier kept for the gateway)", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    expect(runBlock("")).toBe("claude-opus-4-8");
    expect(carrierExists()).toBe(true); // #3284: kept for the gateway's healthy-boot consume
  });

  it("sr-* carrier + LiteLLM up → applies once + repoints ANTHROPIC_BASE_URL + carrier kept for the gateway", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("sr-glm-5"));
    const { effective, baseUrl } = runBlockRouting("1");
    expect(effective).toBe("sr-glm-5");
    expect(baseUrl).toBe(ROUTER_ROOT);
    expect(baseUrl.endsWith("/anthropic")).toBe(false);
    expect(carrierExists()).toBe(true);
  });

  it("no carrier (Claude default) → KEEPS the /anthropic passthrough (guards the Opus SSE fix)", () => {
    const { effective, baseUrl } = runBlockRouting("1");
    expect(effective).toBe(DEFAULT_MODEL);
    expect(baseUrl).toBe(PASSTHROUGH);
  });

  it("claude-* carrier → KEEPS the /anthropic passthrough (only sr-*/fable repoint)", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    const { effective, baseUrl } = runBlockRouting("1");
    expect(effective).toBe("claude-opus-4-8");
    expect(baseUrl).toBe(PASSTHROUGH);
  });

  // ── Fable (F2): proxy-only Claude alias — repoints like sr-*, guards like sr-* ──
  it("fable carrier + LiteLLM up → applies + REPOINTS ANTHROPIC_BASE_URL to the router root", () => {
    // FAILS on old start.sh: the repoint `case` matched sr-* ONLY, so a fable
    // carrier kept the /anthropic passthrough and 4xx'd (claude-fable-5 is a
    // retired codename direct-to-Anthropic; it only resolves via the router).
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("fable"));
    const { effective, baseUrl } = runBlockRouting("1");
    expect(effective).toBe("fable");
    expect(baseUrl).toBe(ROUTER_ROOT);
    expect(baseUrl.endsWith("/anthropic")).toBe(false);
    expect(carrierExists()).toBe(true); // #3284: kept for the gateway's healthy-boot consume
  });

  it("claude-fable-5 carrier + LiteLLM up → also repoints to the router root", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-fable-5"));
    const { effective, baseUrl } = runBlockRouting("1");
    expect(effective).toBe("claude-fable-5");
    expect(baseUrl).toBe(ROUTER_ROOT);
  });

  it("fable carrier + LiteLLM DOWN → boots default, CONSUMES the carrier, tells the operator to re-issue", () => {
    // FAILS on old start.sh: the down-guard was sr-* only, so a fable carrier
    // would APPLY with the proxy down and then 4xx at runtime.
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("fable"));
    expect(runBlock("")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
    const alert = alertText();
    expect(alert).toContain("fable");
    expect(alert).toContain("LiteLLM");
  });

  // ── migration from the one-shot carrier ──────────────────────────────────
  it("legacy .session-model-override carrier → converted + applied THIS boot (carrier kept for the gateway)", () => {
    writeFileSync(join(agentDir, ".session-model-override"), "sr-glm-5\n");
    expect(runBlock("1")).toBe("sr-glm-5");
    expect(existsSync(join(agentDir, ".session-model-override"))).toBe(false);
    // #3284: the converted carrier is APPLIED then kept for the gateway's
    // healthy-boot consume (not deleted by start.sh).
    expect(carrierExists()).toBe(true);
    expect(attemptCount()).toBe("1");
  });

  it("legacy carrier WINS over an existing .session-model (newer intent)", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    writeFileSync(join(agentDir, ".session-model-override"), "sr-glm-5\n");
    expect(runBlock("1")).toBe("sr-glm-5");
  });

  it("malformed legacy carrier → ignored (no conversion), reverts to default", () => {
    writeFileSync(join(agentDir, ".session-model-override"), "bad name; rm -rf /\n");
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model-override"))).toBe(false);
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
  });

  // ── session-effort resolver (#3186 — consume-once, session-scoped) ────────
  function effortJson(level: string, cfg = "low", ts = Date.now()): string {
    return `${JSON.stringify({ level, configuredDefaultAtWrite: cfg, ts })}\n`;
  }
  function runBlockEffort(): { model: string; effortArg: string } {
    const script = `set -e\nunset SWITCHROOM_CONFIG\n_LITELLM_OK=1\n${block}\necho "EFFECTIVE=$_EFFECTIVE_MODEL"\necho "EFFORTARG=$_EFFORT_ARG"`;
    const out = execFileSync("bash", ["-c", script], { encoding: "utf-8" });
    return {
      model: out.match(/EFFECTIVE=(.*)/)?.[1].trim() ?? "",
      effortArg: out.match(/EFFORTARG=(.*)/)?.[1].trim() ?? "",
    };
  }

  it("no .session-effort → --effort uses the configured default; effective effort recorded", () => {
    expect(runBlockEffort().effortArg).toBe("--effort low");
    // The configured-default resolution itself is untouched (#3186 constraint)
    // and the effective launched effort is recorded for gateway re-hydration.
    expect(readFileSync(join(agentDir, ".active-session-effort"), "utf-8").trim()).toBe("low");
  });

  it("effort carrier → APPLIES this boot and is CONSUMED; the next boot reverts to configured (a/b)", () => {
    writeFileSync(join(agentDir, ".session-effort"), effortJson("xhigh"));
    expect(runBlockEffort().effortArg).toBe("--effort xhigh"); // apply-boot
    expect(existsSync(join(agentDir, ".session-effort"))).toBe(false); // consume-once
    expect(readFileSync(join(agentDir, ".active-session-effort"), "utf-8").trim()).toBe("xhigh");
    // No boot alert on a clean apply — the gateway already acked the /effort.
    expect(existsSync(join(agentDir, ".session-model-alert"))).toBe(false);
    // Any SUBSEQUENT restart reverts to the configured default.
    expect(runBlockEffort().effortArg).toBe("--effort low");
    expect(readFileSync(join(agentDir, ".active-session-effort"), "utf-8").trim()).toBe("low");
  });

  it("corrupt/non-allowlisted .session-effort → falls back to configured default AND notifies", () => {
    writeFileSync(join(agentDir, ".session-effort"), `${JSON.stringify({ level: "mega", configuredDefaultAtWrite: "low", ts: Date.now() })}\n`);
    expect(runBlockEffort().effortArg).toBe("--effort low");
    expect(existsSync(join(agentDir, ".session-effort"))).toBe(false);
    expect(alertText()).toContain("effort override could not be read");
  });

  it("configured thinking_effort changed since the effort switch → NOT applied + notifies + consumed", () => {
    writeFileSync(join(agentDir, ".session-effort"), effortJson("xhigh", "medium"));
    expect(runBlockEffort().effortArg).toBe("--effort low");
    expect(existsSync(join(agentDir, ".session-effort"))).toBe(false);
    expect(alertText()).toContain("configured default effort changed");
  });

  // ── MODEL-TIER downgrade failover — start.sh outcomes ─────────────────────
  // The gateway's downgrade writes a consume-once `.session-model` carrier whose
  // model IS the configured default (see maybeTierDowngrade). These assert the
  // two native guarantees the downgrade relies on at the boot layer: revert is
  // free (consume-once) and the downgraded default resolves the CONFIGURED
  // (low) effort because the downgrade writes NO `.session-effort` carrier.
  it("tier-downgrade carrier (model == configured default) → applies the default, gateway consumes, reverts on next restart", () => {
    // The gateway writes {model: <configured default>, configuredDefaultAtWrite:
    // <same>} immediately before the resume restart.
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson(DEFAULT_MODEL, DEFAULT_MODEL));
    expect(runBlock("1")).toBe(DEFAULT_MODEL); // resume boot runs the default
    expect(carrierExists()).toBe(true); // #3284: kept for the gateway's healthy-boot consume
    expect(existsSync(join(agentDir, ".session-model-alert"))).toBe(false); // silent apply
    healthyBootConsume(); // gateway acquired the boot lock and cleared the carrier
    // Native revert: every subsequent restart is already the default (the
    // premium override was session-scoped and never wrote a surviving carrier).
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
  });

  it("tier-downgrade boot sheds a prior live /effort → downgraded default resolves configured (low) effort", () => {
    // A live `/effort high` records in gateway memory only (NO `.session-effort`
    // carrier, rev 4), so the downgrade self-restart sheds it: the boot has no
    // effort carrier and the downgraded default lands at the configured low pin
    // (#1978). Model carrier present (the downgrade); effort carrier absent.
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson(DEFAULT_MODEL, DEFAULT_MODEL));
    expect(existsSync(join(agentDir, ".session-effort"))).toBe(false);
    const { model, effortArg } = runBlockEffort();
    expect(model).toBe(DEFAULT_MODEL);
    expect(effortArg).toBe("--effort low");
  });
});

// ── configured-default sr-* (persistent, NO override) — carried over ─────────
describe("scaffoldAgent: configured-default sr-* model (no override)", () => {
  const PASSTHROUGH = "http://litellm:4010/anthropic";
  const ROUTER_ROOT = "http://litellm:4010";

  function scaffoldSrDefault(prefix: string): { tmp: string; block: string } {
    const tmp = mkdtempSync(join(tmpdir(), prefix));
    const name = "sr-default-agent";
    const cfg = makeAgentConfig({ model: "sr-glm-5" } as Partial<AgentConfig>);
    const res = scaffoldAgent(name, cfg, tmp, telegramConfig, makeSwitchroomConfig(name, cfg));
    const startSh = readFileSync(join(res.agentDir, "start.sh"), "utf-8");
    return { tmp, block: extractBlock(startSh) };
  }

  it("LiteLLM up → repoints to router root", () => {
    const { tmp, block } = scaffoldSrDefault("switchroom-session-model-srdef-");
    try {
      expect(block).toContain("_BAKED_MODEL='sr-glm-5'");
      const script = [
        "set -e",
        "unset SWITCHROOM_CONFIG",
        `export ANTHROPIC_BASE_URL=${JSON.stringify(PASSTHROUGH)}`,
        `export SWITCHROOM_LITELLM_BASE=${JSON.stringify(ROUTER_ROOT)}`,
        "_LITELLM_OK=1",
        block,
        'echo "EFFECTIVE=$_EFFECTIVE_MODEL"',
        'echo "BASEURL=$ANTHROPIC_BASE_URL"',
      ].join("\n");
      const out = execFileSync("bash", ["-c", script], { encoding: "utf-8" });
      expect(out).toContain("EFFECTIVE=sr-glm-5");
      expect(out).toContain(`BASEURL=${ROUTER_ROOT}`);
      expect(out).not.toContain(`BASEURL=${PASSTHROUGH}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("LiteLLM DOWN → non-fatal, no crash, no Claude fallback (runs degraded)", () => {
    const { tmp, block } = scaffoldSrDefault("switchroom-session-model-srdown-");
    try {
      const script = [
        "set -e",
        "unset SWITCHROOM_CONFIG",
        `export ANTHROPIC_BASE_URL=${JSON.stringify(ROUTER_ROOT)}`,
        `export SWITCHROOM_LITELLM_BASE=${JSON.stringify(ROUTER_ROOT)}`,
        '_LITELLM_OK=""',
        block,
        'echo "EFFECTIVE=$_EFFECTIVE_MODEL"',
        'echo "BASEURL=$ANTHROPIC_BASE_URL"',
      ].join("\n");
      const out = execFileSync("bash", ["-c", script], { encoding: "utf-8" });
      expect(out).toContain("EFFECTIVE=sr-glm-5");
      expect(out).toContain(`BASEURL=${ROUTER_ROOT}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Live configured-default resolution (Defect B / drift fix) ────────────────
//
// The launcher no longer trusts the apply-time bake: at boot it resolves the
// agent's configured model from the LIVE mounted switchroom.yaml via
// `switchroom agent effective-model` (the same resolver the gateway's /status
// uses), falling back live → last-known-good (.configured-default-model) →
// bake, never silently past the live read. These are outcome tests against
// the RENDERED block, with a fake `switchroom` on PATH standing in for the
// CLI so each failure mode is actually exercised (a test that wouldn't fail
// on the drift is not a test).
describe("scaffoldAgent: live configured-default resolution (start.sh)", () => {
  let tmpDir: string;
  let agentDir: string;
  let block: string;
  let fakeBin: string;
  let cfgPath: string;

  function scaffold(model?: string): void {
    const name = "live-agent";
    const config = makeAgentConfig(model ? ({ model } as Partial<AgentConfig>) : {});
    const res = scaffoldAgent(name, config, tmpDir, telegramConfig, makeSwitchroomConfig(name, config));
    agentDir = res.agentDir;
    block = extractBlock(readFileSync(join(agentDir, "start.sh"), "utf-8"));
  }

  /** Install a fake `switchroom` CLI; its stdout/exit code drive the live read. */
  function fakeSwitchroom(body: string): void {
    writeFileSync(join(fakeBin, "switchroom"), `#!/bin/bash\necho "$@" >> ${JSON.stringify(join(fakeBin, "args.log"))}\n${body}\n`);
    chmodSync(join(fakeBin, "switchroom"), 0o755);
  }

  function fakeArgs(): string {
    const p = join(fakeBin, "args.log");
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  function runLive(litellmOk = "1"): string {
    const script = [
      "set -e",
      `export PATH=${JSON.stringify(fakeBin)}:"$PATH"`,
      `export SWITCHROOM_CONFIG=${JSON.stringify(cfgPath)}`,
      `_LITELLM_OK=${JSON.stringify(litellmOk)}`,
      block,
      'echo "EFFECTIVE=$_EFFECTIVE_MODEL"',
    ].join("\n");
    const out = execFileSync("bash", ["-c", script], { encoding: "utf-8" });
    const m = out.match(/EFFECTIVE=(.*)/);
    return m ? m[1].trim() : "";
  }

  function alertText(): string {
    const p = join(agentDir, ".session-model-alert");
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  function recordedDefault(): string {
    return readFileSync(join(agentDir, ".configured-default-model"), "utf-8").trim();
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-live-model-"));
    fakeBin = join(tmpDir, "fakebin");
    mkdirSync(fakeBin, { recursive: true });
    cfgPath = join(tmpDir, "switchroom.yaml");
    writeFileSync(cfgPath, "agents: {}\n");
    scaffold();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // THE regression test the fable launch bug was missing: yaml edited to
  // fable after apply (bake still sonnet) + plain restart → boots fable.
  it("boots the LIVE yaml model when it differs from the apply-time bake (Defect B)", () => {
    fakeSwitchroom('echo fable');
    expect(runLive("1")).toBe("fable");
    // The recorded configured default is the live value (next boot's LKG)…
    expect(recordedDefault()).toBe("fable");
    // …and the resolver was asked with the live config and the agent's name.
    expect(fakeArgs()).toContain("--config");
    expect(fakeArgs()).toContain("agent effective-model live-agent");
    // Normal path: no operator alert.
    expect(alertText()).toBe("");
  });

  it("retries once on a torn/failed first read, then uses the live value", () => {
    fakeSwitchroom(`marker=${JSON.stringify(join(fakeBin, "second-call"))}
if [ -f "$marker" ]; then echo claude-opus-4-8; else touch "$marker"; echo "mangled: [truncated ya" ; fi`);
    expect(runLive("1")).toBe("claude-opus-4-8");
    expect(alertText()).toBe("");
  });

  it("live read fails → falls back to last-known-good with an operator alert", () => {
    writeFileSync(join(agentDir, ".configured-default-model"), "claude-opus-4-8\n");
    fakeSwitchroom("exit 1");
    expect(runLive("1")).toBe("claude-opus-4-8");
    expect(alertText()).toContain("last-known-good");
    expect(alertText()).toContain("claude-opus-4-8");
  });

  it("live read fails with no last-known-good → falls back to the bake with an operator alert", () => {
    fakeSwitchroom("exit 1");
    expect(runLive("1")).toBe(DEFAULT_MODEL);
    expect(alertText()).toContain("apply-time default");
    expect(alertText()).toContain(DEFAULT_MODEL);
  });

  it("garbage CLI output fails the shape gate and falls back (never reaches --model)", () => {
    fakeSwitchroom('echo "not a!! model;; rm -rf"');
    expect(runLive("1")).toBe(DEFAULT_MODEL);
    expect(alertText()).not.toBe("");
  });

  it("Claude→sr-* class flip is NOT half-applied: keeps the bake and tells the operator to run apply", () => {
    fakeSwitchroom("echo sr-glm-5");
    expect(runLive("1")).toBe(DEFAULT_MODEL);
    expect(alertText()).toContain("switchroom apply");
    // The recorded default must be what actually booted, not the unapplied flip.
    expect(recordedDefault()).toBe(DEFAULT_MODEL);
  });

  it("sr-*→Claude class flip is symmetric: keeps the sr-* bake and alerts", () => {
    scaffold("sr-glm-5");
    fakeSwitchroom("echo claude-opus-4-8");
    expect(runLive("1")).toBe("sr-glm-5");
    expect(alertText()).toContain("switchroom apply");
  });

  it("no SWITCHROOM_CONFIG mount → bake, silently (nothing live to read, nothing actionable)", () => {
    fakeSwitchroom("echo fable");
    const script = [
      "set -e",
      `export PATH=${JSON.stringify(fakeBin)}:"$PATH"`,
      "unset SWITCHROOM_CONFIG",
      '_LITELLM_OK="1"',
      block,
      'echo "EFFECTIVE=$_EFFECTIVE_MODEL"',
    ].join("\n");
    const out = execFileSync("bash", ["-c", script], { encoding: "utf-8" });
    expect(out).toContain(`EFFECTIVE=${DEFAULT_MODEL}`);
    expect(alertText()).toBe("");
    expect(fakeArgs()).toBe(""); // CLI never invoked
  });

  // SE-3 ordering: the live value must land before the carrier compare, so a
  // session override written against the current live default still applies.
  it("resolves live BEFORE the carrier compare: override against the live default applies", () => {
    fakeSwitchroom(`echo ${DEFAULT_MODEL}`);
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    expect(runLive("1")).toBe("claude-opus-4-8");
  });

  it("carrier written against a SUPERSEDED live default is dropped (compare uses the live value)", () => {
    fakeSwitchroom("echo claude-opus-4-8");
    // Carrier recorded when the configured default was still sonnet.
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-haiku-4-5", DEFAULT_MODEL));
    expect(runLive("1")).toBe("claude-opus-4-8");
    expect(alertText()).toContain("configured default model changed");
  });

  // SE-4: a proxy-only CONFIGURED default with LiteLLM down must not 4xx
  // every call — Claude agents degrade to opus, loudly.
  it("configured fable + LiteLLM down → boots opus with an operator alert", () => {
    fakeSwitchroom("echo fable");
    expect(runLive("")).toBe("opus");
    expect(alertText()).toContain("LiteLLM");
    expect(alertText()).toContain("fable");
  });

  it("configured fable + LiteLLM up → boots fable (guard is down-only)", () => {
    fakeSwitchroom("echo fable");
    expect(runLive("1")).toBe("fable");
    expect(alertText()).toBe("");
  });

  // SE-3 rendered-script ordering lock: live resolution → recorded default →
  // carrier block → configured-default litellm guard → repoint → active-model
  // write → exec. If any of these move, the override/invalidate logic misfires.
  it("locks the resolution ordering in the rendered start.sh", () => {
    const startSh = readFileSync(join(agentDir, "start.sh"), "utf-8");
    const idxLive = startSh.indexOf("# --- Live configured-default resolution");
    const idxRecord = startSh.indexOf('.configured-default-model" 2>/dev/null || true');
    const idxCarrier = startSh.indexOf('if [ -f "' + agentDir + '/.session-model" ]');
    const idxGuard = startSh.indexOf("# Configured-default LiteLLM guard");
    const idxRepoint = startSh.indexOf("sr-* passthrough→router repoint");
    const idxActive = startSh.indexOf('.active-session-model"');
    const idxExec = startSh.lastIndexOf('--model "$_EFFECTIVE_MODEL"');
    expect(idxLive).toBeGreaterThan(-1);
    expect(idxRecord).toBeGreaterThan(idxLive);
    expect(idxCarrier).toBeGreaterThan(idxRecord);
    expect(idxGuard).toBeGreaterThan(idxCarrier);
    expect(idxRepoint).toBeGreaterThan(idxGuard);
    expect(idxActive).toBeGreaterThan(idxRepoint);
    expect(idxExec).toBeGreaterThan(idxActive);
    // And the LKG read happens BEFORE the recorded-default overwrite.
    const idxLkg = startSh.indexOf('_LKG_MODEL="$(cat');
    expect(idxLkg).toBeGreaterThan(-1);
    expect(idxLkg).toBeLessThan(idxRecord);
  });
});
