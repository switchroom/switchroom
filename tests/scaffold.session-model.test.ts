import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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
// Contract under test (CONSUME-ONCE): a `.session-model` carrier is applied on
// the single boot that reads it and then DELETED, so the model-apply relaunch
// picks it up and EVERY subsequent restart reverts to the configured default.
// There is no `.relaunch-model-intent`, no crashloop counter, and no
// kept-notified sentinel. Invalidation (corrupt / configured-default changed /
// sr-*+LiteLLM-down) drops the carrier and writes a `.session-model-alert` the
// gateway relays.

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

  it("renders the consume-once carrier wiring in start.sh (no intent resolution)", () => {
    expect(block).toContain(".session-model");
    expect(block).toContain(".configured-default-model");
    expect(block).toContain(".session-model-alert");
    // Migration shim still consumes the legacy one-shot carrier.
    expect(block).toContain(".session-model-override");
    // The retired keep/revert intent + crashloop machinery is no longer
    // RESOLVED — the retired filenames appear only in the one-line hygiene
    // `rm -f` (#3184 LOW-2), never in a read/parse/stamp.
    expect(block).not.toContain('"intent"');
    expect(block).not.toContain("_sm_revert");
    expect(block).not.toMatch(/(cat|read -r|<)[^\n]*\.relaunch-model-intent/);
    expect(block).not.toMatch(/(cat|read -r|<)[^\n]*\.session-model-boot-attempts/);
    expect(block).not.toMatch(/(cat|read -r|<)[^\n]*\.session-model-kept-notified/);
    // modelQ is assigned BARE (already shell-quoted by the scaffold).
    expect(block).toContain("_EFFECTIVE_MODEL='claude-sonnet-5'");
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
    // applies + consumes regardless of any leftover intent content.
    writeFileSync(join(agentDir, ".relaunch-model-intent"), `${JSON.stringify({ intent: "revert", reason: "old", ts: Date.now() })}\n`);
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    expect(runBlock("1")).toBe("claude-opus-4-8");
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
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
  it("valid carrier → APPLIES the override this boot and CONSUMES the carrier (no boot alert)", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    expect(runBlock("1")).toBe("claude-opus-4-8");
    // Consume-once: the carrier is deleted on the apply boot.
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
    // The gateway already acked the /model in chat — no boot alert on apply.
    expect(existsSync(join(agentDir, ".session-model-alert"))).toBe(false);
  });

  // ── requirement (b): the next restart reverts to the configured default ──
  it("SUBSEQUENT restart (carrier already consumed) → reverts to the configured default", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    expect(runBlock("1")).toBe("claude-opus-4-8"); // apply-relaunch
    expect(runBlock("1")).toBe(DEFAULT_MODEL); // any later restart
    expect(runBlock("1")).toBe(DEFAULT_MODEL); // and every one after
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
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

  it("Claude carrier does NOT require LiteLLM (applies with proxy down, consumed)", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    expect(runBlock("")).toBe("claude-opus-4-8");
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
  });

  it("sr-* carrier + LiteLLM up → applies once + repoints ANTHROPIC_BASE_URL + consumed", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("sr-glm-5"));
    const { effective, baseUrl } = runBlockRouting("1");
    expect(effective).toBe("sr-glm-5");
    expect(baseUrl).toBe(ROUTER_ROOT);
    expect(baseUrl.endsWith("/anthropic")).toBe(false);
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
  });

  it("no carrier (Claude default) → KEEPS the /anthropic passthrough (guards the Opus SSE fix)", () => {
    const { effective, baseUrl } = runBlockRouting("1");
    expect(effective).toBe(DEFAULT_MODEL);
    expect(baseUrl).toBe(PASSTHROUGH);
  });

  it("claude-* carrier → KEEPS the /anthropic passthrough (only sr-* repoints)", () => {
    writeFileSync(join(agentDir, ".session-model"), sessionModelJson("claude-opus-4-8"));
    const { effective, baseUrl } = runBlockRouting("1");
    expect(effective).toBe("claude-opus-4-8");
    expect(baseUrl).toBe(PASSTHROUGH);
  });

  // ── migration from the one-shot carrier ──────────────────────────────────
  it("legacy .session-model-override carrier → converted, applied + consumed THIS boot", () => {
    writeFileSync(join(agentDir, ".session-model-override"), "sr-glm-5\n");
    expect(runBlock("1")).toBe("sr-glm-5");
    expect(existsSync(join(agentDir, ".session-model-override"))).toBe(false);
    // Consume-once: the converted carrier is also gone after the apply boot.
    expect(existsSync(join(agentDir, ".session-model"))).toBe(false);
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

  // ── session-effort resolver (#3039 — UNCHANGED by rev 4) ──────────────────
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

  it(".session-effort override survives the boot and is applied to --effort (still keep-across-restarts)", () => {
    writeFileSync(join(agentDir, ".session-effort"), effortJson("xhigh"));
    expect(runBlockEffort().effortArg).toBe("--effort xhigh");
    expect(existsSync(join(agentDir, ".session-effort"))).toBe(true);
  });

  it("corrupt/non-allowlisted .session-effort → falls back to configured default AND notifies", () => {
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
