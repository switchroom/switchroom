import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import { isValidModelArg } from "../telegram-plugin/gateway/model-command.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

// Session-scoped /model stickiness — the rendered start.sh boot resolver
// (reference/rfcs/session-model-stickiness.md). Successor to
// scaffold.session-model-override.test.ts (one-shot carrier, retired).
//
// Contract under test (#3039 rev 3, keep-by-default), driven as sh-harness
// fixtures against the RENDERED block: the durable `.session-model` override
// is applied on EVERY boot — crash, deploy, raw `docker restart`, stale or
// corrupt intent all KEEP it. Only a FRESH (<10 min, embedded ts) explicit
// "revert" `.relaunch-model-intent`, corruption, or a configured-default
// change clears it — and every clearing path writes a `.session-model-alert`
// notice the gateway relays to chat.

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

/** One-line durable override JSON, same shape the gateway writes. */
function sessionModelJson(model: string, cfg = DEFAULT_MODEL, ts = Date.now()): string {
  return `${JSON.stringify({ model, configuredDefaultAtWrite: cfg, ts })}\n`;
}

/** One-line intent JSON, same shape the gateway writes. */
function intentJson(intent: string, ts = Date.now(), reason = "test"): string {
  return `${JSON.stringify({ intent, reason, ts })}\n`;
}

describe("scaffoldAgent: session-model stickiness boot resolver (start.sh)", () => {
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

  /** Run the extracted block with a given _LITELLM_OK, echo the effective model. */
  function runBlock(litellmOk: string): string {
    const script = `set -e\n_LITELLM_OK=${JSON.stringify(litellmOk)}\n${block}\necho "EFFECTIVE=$_EFFECTIVE_MODEL"`;
    const out = execFileSync("bash", ["-c", script], { encoding: "utf-8" });
    const m = out.match(/EFFECTIVE=(.*)/);
    return m ? m[1].trim() : "";
  }

  const PASSTHROUGH = "http://litellm:4010/anthropic";
  const ROUTER_ROOT = "http://litellm:4010";
  function runBlockRouting(litellmOk: string): { effective: string; baseUrl: string } {
    const script = [
      "set -e",
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

  it("renders the durable-override + intent wiring in start.sh", () => {
    expect(block).toContain(".session-model");
    expect(block).toContain(".relaunch-model-intent");
    expect(block).toContain(".configured-default-model");
    expect(block).toContain(".session-model-alert");
    // Migration shim still consumes the legacy one-shot carrier.
    expect(block).toContain(".session-model-override");
    // modelQ is assigned BARE (already shell-quoted by the scaffold).
    expect(block).toContain("_EFFECTIVE_MODEL='claude-sonnet-5'");
    const startSh = readFileSync(join(agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain('--model "$_EFFECTIVE_MODEL"');
    expect(startSh).not.toContain("--model {{{modelQ}}}");
  });

  // ── MODEL_ARG_RE byte-parity against the RENDERED start.sh ────────────────
  // The sh shape gate and the gateway's MODEL_ARG_RE must accept/reject the
  // same tokens, or a gateway-persisted override could be dropped (or worse,
  // an sh-accepted string the gateway never validated could launch). Extract
  // the grep -Eq pattern from the RENDERED script and drive BOTH gates over
  // one fixture list.
  it("shape gate is byte-parity with MODEL_ARG_RE (rendered start.sh vs gateway)", () => {
    const startSh = readFileSync(join(agentDir, "start.sh"), "utf-8");
    const patterns = [...startSh.matchAll(/grep -Eq '([^']+)'/g)].map((m) => m[1]);
    const shapePatterns = patterns.filter((p) => p.includes("{0,99}"));
    expect(shapePatterns.length).toBeGreaterThanOrEqual(2); // durable gate + migration gate
    // All rendered shape gates are the same bytes.
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

  it("no override, no intent → boots default, records .configured-default-model + .active-session-model", () => {
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(readFileSync(join(agentDir, ".configured-default-model"), "utf-8").trim()).toBe(DEFAULT_MODEL);
    expect(readFileSync(join(agentDir, ".active-session-model"), "utf-8").trim()).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model-alert"))).toBe(false);
  });

  // ── keep path (row 11: watchdog / recovery bounce) ────────────────────────
  it("override + fresh keep intent → applies the override, RETAINS the file, consumes the intent, announces", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    writeFileSync(join(agentDir, ".relaunch-model-intent"), intentJson("keep", Date.now(), "schedule-restart-immediate"));
    expect(runBlock("1")).toBe("claude-opus-4-8");
    // Durable: NOT consumed on a keep boot.
    expect(existsSync(join(agentDir, ".session-model"))).toBe(true);
    // Intent is one-shot.
    expect(existsSync(join(agentDir, ".relaunch-model-intent"))).toBe(false);
    // Rendered notice: an involuntary bounce never SILENTLY continues on a
    // non-default model.
    expect(alertText()).toContain("`claude-opus-4-8` kept across this relaunch");
    expect(alertText()).toContain("/model default");
  });

  // ── keep-by-default paths (#3039) ────────────────────────────────────────
  it("override + NO intent (crash / raw docker restart / deploy) → KEEPS the override and announces", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    expect(runBlock("1")).toBe("claude-opus-4-8");
    expect(existsSync(join(agentDir, ".session-model"))).toBe(true);
    const alert = alertText();
    expect(alert).toContain("`claude-opus-4-8` kept across this relaunch");
    expect(alert).toContain("/model default");
  });

  it("override + revert intent → reverts and the notice carries the intent's reason", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("sr-glm-5"));
    writeFileSync(join(agentDir, ".relaunch-model-intent"), intentJson("revert", Date.now(), "user: /restart from chat"));
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
    expect(existsSync(join(agentDir, ".relaunch-model-intent"))).toBe(false);
    expect(alertText()).toContain("user: /restart from chat");
  });

  it("override + STALE revert intent (>10 min by embedded ts) → treated as no intent, KEEPS", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    writeFileSync(join(agentDir, ".relaunch-model-intent"), intentJson("revert", Date.now() - 11 * 60_000));
    expect(runBlock("1")).toBe("claude-opus-4-8");
    expect(existsSync(join(agentDir, ".session-model"))).toBe(true);
  });

  it("override + corrupt intent → treated as no intent, KEEPS; intent consumed", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    writeFileSync(join(agentDir, ".relaunch-model-intent"), "not json at all\n");
    expect(runBlock("1")).toBe("claude-opus-4-8");
    expect(existsSync(join(agentDir, ".session-model"))).toBe(true);
    expect(existsSync(join(agentDir, ".relaunch-model-intent"))).toBe(false);
  });

  // ── keep-gated hygiene branches ──────────────────────────────────────────
  it("keep + corrupt .session-model → deletes it, boots default", () => {
    writeFileSync(join(agentDir, ".session-model"), "{broken\n");
    writeFileSync(join(agentDir, ".relaunch-model-intent"), intentJson("keep"));
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
  });

  it("keep + shape-gate-failing model → deletes it, boots default (injection surface closed)", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("bad name; rm -rf /"));
    writeFileSync(join(agentDir, ".relaunch-model-intent"), intentJson("keep"));
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
  });

  it("keep + MULTILINE .session-model (two model fields on two lines) → rejected, boots default", () => {
    // The sed extraction emits one match per matching LINE and `grep -Eq`
    // passes if ANY line matches — without the newline check a multiline
    // value (each line individually shape-valid) would reach `claude
    // --model`. Parity with parseSessionModel's single-string strictness.
    writeFileSync(
      join(agentDir, ".session-model"),
      `${sessionModelJson("sr-glm-5")}${sessionModelJson("sr-evil-2")}`,
    );
    writeFileSync(join(agentDir, ".relaunch-model-intent"), intentJson("keep"));
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
  });

  it("keep + configuredDefaultAtWrite mismatch (yaml model changed) → INVALIDATES + announces", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8", "claude-old-model"));
    writeFileSync(join(agentDir, ".relaunch-model-intent"), intentJson("keep"));
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
    const alert = alertText();
    expect(alert).toContain("configured default model changed");
    expect(alert).toContain("`claude-old-model` → `claude-sonnet-5`");
    expect(alert).toContain("override to `claude-opus-4-8` was cleared");
  });

  it("override older than 7 days → NO expiry (#3039: only explicit user action clears it)", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8", DEFAULT_MODEL, Date.now() - 8 * 24 * 3600_000));
    expect(runBlock("1")).toBe("claude-opus-4-8");
    expect(existsSync(join(agentDir, ".session-model"))).toBe(true);
  });

  it("corrupt .session-model → falls back to default AND notifies (never a silent drop)", () => {
    writeFileSync(join(agentDir, ".session-model"), "{broken\n");
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
    const alert = alertText();
    expect(alert).toContain("could not be read");
    expect(alert).toContain("configured default");
  });

  // ── session-effort resolver (#3039) ───────────────────────────────────────
  function effortJson(level: string, cfg = "low", ts = Date.now()): string {
    return `${JSON.stringify({ level, configuredDefaultAtWrite: cfg, ts })}\n`;
  }
  function runBlockEffort(): { model: string; effortArg: string } {
    const script = `set -e\n_LITELLM_OK=1\n${block}\necho "EFFECTIVE=$_EFFECTIVE_MODEL"\necho "EFFORTARG=$_EFFORT_ARG"`;
    const out = execFileSync("bash", ["-c", script], { encoding: "utf-8" });
    return {
      model: out.match(/EFFECTIVE=(.*)/)?.[1].trim() ?? "",
      effortArg: out.match(/EFFORTARG=(.*)/)?.[1].trim() ?? "",
    };
  }

  it("no .session-effort → --effort uses the configured default", () => {
    expect(runBlockEffort().effortArg).toBe("--effort low");
  });

  it(".session-effort override survives the boot and is applied to --effort", () => {
    writeFileSync(join(agentDir, ".session-effort"), effortJson("xhigh"));
    expect(runBlockEffort().effortArg).toBe("--effort xhigh");
    expect(existsSync(join(agentDir, ".session-effort"))).toBe(true);
  });

  it("corrupt/non-allowlisted .session-effort → falls back to configured default AND notifies", () => {
    writeFileSync(join(agentDir, ".session-effort"), effortJson("mega; rm -rf /".replace(/;.*/, "mega")));
    writeFileSync(join(agentDir, ".session-effort"), `${JSON.stringify({ level: "mega", configuredDefaultAtWrite: "low", ts: Date.now() })}\n`);
    expect(runBlockEffort().effortArg).toBe("--effort low");
    expect(existsSync(join(agentDir, ".session-effort"))).toBe(false);
    expect(alertText()).toContain("effort override could not be read");
  });

  it("configured thinking_effort changed since the effort switch → cleared + notifies", () => {
    writeFileSync(join(agentDir, ".session-effort"), effortJson("xhigh", "medium"));
    expect(runBlockEffort().effortArg).toBe("--effort low");
    expect(existsSync(join(agentDir, ".session-effort"))).toBe(false);
    expect(alertText()).toContain("configured default effort changed");
  });

  // ── sr-* + LiteLLM guard (row 18) ─────────────────────────────────────────
  it("keep + sr-* override + LiteLLM DOWN → boots default, RETAINS the file, announces retention", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("sr-glm-5"));
    writeFileSync(join(agentDir, ".relaunch-model-intent"), intentJson("keep"));
    expect(runBlock("")).toBe(DEFAULT_MODEL);
    // Retained — re-applies on the next keep relaunch (NOT the one-shot drop
    // semantics of the retired carrier).
    expect(existsSync(join(agentDir, ".session-model"))).toBe(true);
    const alert = alertText();
    expect(alert).toContain("sr-glm-5");
    expect(alert).toContain("retained");
    expect(alert).toContain("LiteLLM");
  });

  it("keep + Claude override does NOT require LiteLLM (applies with proxy down)", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    writeFileSync(join(agentDir, ".relaunch-model-intent"), intentJson("keep"));
    expect(runBlock("")).toBe("claude-opus-4-8");
  });

  // ── migration from the one-shot carrier (RFC §7) ──────────────────────────
  it("legacy .session-model-override carrier → converted to .session-model and applied THIS boot", () => {
    writeFileSync(join(agentDir, ".session-model-override"), "sr-glm-5\n");
    expect(runBlock("1")).toBe("sr-glm-5");
    expect(existsSync(join(agentDir, ".session-model-override"))).toBe(false);
    const converted = JSON.parse(readFileSync(join(agentDir, ".session-model"), "utf-8"));
    expect(converted.model).toBe("sr-glm-5");
    expect(converted.configuredDefaultAtWrite).toBe(DEFAULT_MODEL);
  });

  it("legacy carrier WINS over an existing .session-model (newer intent)", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    writeFileSync(join(agentDir, ".session-model-override"), "sr-glm-5\n");
    expect(runBlock("1")).toBe("sr-glm-5");
    const converted = JSON.parse(readFileSync(join(agentDir, ".session-model"), "utf-8"));
    expect(converted.model).toBe("sr-glm-5");
  });

  it("malformed legacy carrier → ignored (no conversion), reverts as no-intent", () => {
    writeFileSync(join(agentDir, ".session-model-override"), "bad name; rm -rf /\n");
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model-override"))).toBe(false);
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
  });

  // ── sr-* passthrough→router repoint (carried over from the carrier suite) ──
  it("keep + sr-* override + LiteLLM up → repoints ANTHROPIC_BASE_URL onto the router root", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("sr-glm-5"));
    writeFileSync(join(agentDir, ".relaunch-model-intent"), intentJson("keep"));
    const { effective, baseUrl } = runBlockRouting("1");
    expect(effective).toBe("sr-glm-5");
    expect(baseUrl).toBe(ROUTER_ROOT);
    expect(baseUrl.endsWith("/anthropic")).toBe(false);
  });

  it("no override (Claude default) → KEEPS the /anthropic passthrough (guards the Opus SSE fix)", () => {
    const { effective, baseUrl } = runBlockRouting("1");
    expect(effective).toBe(DEFAULT_MODEL);
    expect(baseUrl).toBe(PASSTHROUGH);
  });

  it("keep + claude-* override → KEEPS the /anthropic passthrough (only sr-* repoints)", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    writeFileSync(join(agentDir, ".relaunch-model-intent"), intentJson("keep"));
    const { effective, baseUrl } = runBlockRouting("1");
    expect(effective).toBe("claude-opus-4-8");
    expect(baseUrl).toBe(PASSTHROUGH);
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
      expect(block).toContain("_EFFECTIVE_MODEL='sr-glm-5'");
      const script = [
        "set -e",
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
