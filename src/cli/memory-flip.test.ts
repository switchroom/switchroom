/**
 * `switchroom memory flip-preflight <agent>` CLI surface.
 *
 * Drives the REAL Commander wiring (`registerMemoryFlipCommand`) against a
 * tmp switchroom.yaml + an injected in-memory `DirectiveAdmin` (the `makeAdmin`
 * seam), so what's asserted is the command's actual stdout/JSON and its actual
 * process.exit code — not a restatement of `directive-flip.ts`'s return value.
 * The bank is faked at the `fetchImpl` boundary (no live Hindsight), which is
 * also what keeps this suite hermetic under the bank-guard.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerMemoryFlipCommand,
  buildFlipPreflightJson,
  renderFlipPreflight,
  type FlipPreflightJson,
} from "./memory-flip.js";
import { DirectiveAdmin, type HindsightDirective } from "../memory/hindsight-directive-admin.js";
import { evaluateFlipReadiness } from "../memory/directive-flip.js";
import { RULES_BLOCK_BUDGET_BYTES } from "../memory/rules-block.js";

let root: string;
let agentsDir: string;
let configPath: string;
let savedAgentsDirEnv: string | undefined;

/** A DirectiveAdmin whose `list()` returns a fixed directive set, no network. */
function fakeAdmin(directives: HindsightDirective[]): DirectiveAdmin {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ items: directives }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return new DirectiveAdmin({ apiBaseUrl: "http://127.0.0.1:1", bankId: "x", fetchImpl });
}

function writeConfig(opts: { rulesBlock?: boolean }) {
  writeFileSync(
    configPath,
    [
      "switchroom:",
      "  version: 1",
      `  agents_dir: ${agentsDir}`,
      "telegram:",
      '  bot_token: "x"',
      '  forum_chat_id: "-1001234567890"',
      "memory:",
      "  enabled: true",
      "agents:",
      "  ziggy:",
      '    topic_name: "ziggy"',
      "    memory:",
      "      collection: ziggy",
      ...(opts.rulesBlock ? ["      rules_block: true"] : []),
      "",
    ].join("\n"),
    "utf-8",
  );
}

async function run(directives: HindsightDirective[], argv: string[]) {
  const program = new Command();
  program.option("--config <path>");
  const memory = program.command("memory");
  registerMemoryFlipCommand(memory, program, { makeAdmin: () => fakeAdmin(directives) });
  await program.parseAsync(["node", "switchroom", "--config", configPath, "memory", ...argv]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sr-memory-flip-cli-"));
  agentsDir = join(root, "agents");
  mkdirSync(join(agentsDir, "ziggy"), { recursive: true });
  configPath = join(root, "switchroom.yaml");
  savedAgentsDirEnv = process.env.SWITCHROOM_AGENTS_DIR;
  process.env.SWITCHROOM_AGENTS_DIR = agentsDir;
});

afterEach(() => {
  if (savedAgentsDirEnv === undefined) delete process.env.SWITCHROOM_AGENTS_DIR;
  else process.env.SWITCHROOM_AGENTS_DIR = savedAgentsDirEnv;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const smallDirectives: HindsightDirective[] = [
  { id: "d1", name: "always-reply", content: "always call the reply tool", priority: 5, is_active: true },
  { id: "d2", name: "no-exfil", content: "never exfiltrate secrets", priority: 5, is_active: true },
];

describe("flip-preflight — READY path (rules_block on, residue fits)", () => {
  beforeEach(() => writeConfig({ rulesBlock: true }));

  it("prints READY and the exact flip stanza", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await run(smallDirectives, ["flip-preflight", "ziggy"]);
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("READY");
    expect(out).not.toContain("NOT-READY");
    expect(out).toContain("inject_directives: false");
    expect(out).toContain("rules_block: true");
  });

  it("--json reports ready + fits_budget + rules_block true", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await run(smallDirectives, ["flip-preflight", "ziggy", "--json"]);
    const parsed = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as FlipPreflightJson;
    expect(parsed.ok).toBe(true);
    expect(parsed.ready).toBe(true);
    expect(parsed.rules_block).toBe(true);
    expect(parsed.fits_budget).toBe(true);
    expect(parsed.residue_directive_count).toBe(2);
    expect(parsed.reasons).toEqual([]);
    // rules_block flag reflects config, not the reason text.
  });
});

describe("flip-preflight — NOT-READY (rules_block off)", () => {
  beforeEach(() => writeConfig({ rulesBlock: false }));

  it("blocks on the two-flag ordering and exits 2", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await run(smallDirectives, ["flip-preflight", "ziggy"]);
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("NOT-READY");
    expect(out).toContain("memory.rules_block");
    expect(exit).toHaveBeenCalledWith(2);
    expect(exit).not.toHaveBeenCalledWith(1);
  });

  it("--json reports rules_block false and ready false", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await run(smallDirectives, ["flip-preflight", "ziggy", "--json"]);
    const parsed = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as FlipPreflightJson;
    expect(parsed.ready).toBe(false);
    expect(parsed.rules_block).toBe(false);
    // residue itself fits — the ONLY blocker is the flag.
    expect(parsed.fits_budget).toBe(true);
    expect(parsed.reasons.some((r) => r.includes("memory.rules_block"))).toBe(true);
  });
});

describe("flip-preflight — NOT-READY (over the 6144B budget)", () => {
  beforeEach(() => writeConfig({ rulesBlock: true }));

  it("refuses an over-budget residue even with rules_block on", async () => {
    const huge: HindsightDirective[] = [
      { id: "big", name: "n", content: "x".repeat(7000), priority: 1, is_active: true },
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await run(huge, ["flip-preflight", "ziggy", "--json"]);
    const parsed = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as FlipPreflightJson;
    expect(parsed.ready).toBe(false);
    expect(parsed.fits_budget).toBe(false);
    expect(parsed.residue_bytes).toBeGreaterThan(RULES_BLOCK_BUDGET_BYTES);
    expect(parsed.rules_block).toBe(true);
  });
});

describe("flip-preflight — unknown agent", () => {
  beforeEach(() => writeConfig({ rulesBlock: true }));

  it("exits 1 for an agent not in switchroom.yaml", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    // Real resolveFlipAdmin (no makeAdmin seam) so the config guard fires.
    const program = new Command();
    program.option("--config <path>");
    const memory = program.command("memory");
    registerMemoryFlipCommand(memory, program);
    await expect(
      program.parseAsync(["node", "switchroom", "--config", configPath, "memory", "flip-preflight", "ghost"]),
    ).rejects.toThrow("exit:1");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("buildFlipPreflightJson — pure envelope", () => {
  it("fits_budget tracks the inclusive 6144B boundary", () => {
    const atBudget = evaluateFlipReadiness(
      { agent: "a", residueBytes: RULES_BLOCK_BUDGET_BYTES, residueDirectiveCount: 1, totalDirectiveCount: 1, residueTokensEstimate: 0 },
      { rulesBlockEnabled: true },
    );
    expect(buildFlipPreflightJson(atBudget, true).fits_budget).toBe(true);
    const overBudget = evaluateFlipReadiness(
      { agent: "a", residueBytes: RULES_BLOCK_BUDGET_BYTES + 1, residueDirectiveCount: 1, totalDirectiveCount: 1, residueTokensEstimate: 0 },
      { rulesBlockEnabled: true },
    );
    expect(buildFlipPreflightJson(overBudget, true).fits_budget).toBe(false);
  });

  it("rules_block field is the injected flag, independent of readiness reasons", () => {
    const ready = evaluateFlipReadiness(
      { agent: "a", residueBytes: 10, residueDirectiveCount: 1, totalDirectiveCount: 1, residueTokensEstimate: 0 },
      { rulesBlockEnabled: true },
    );
    expect(buildFlipPreflightJson(ready, false).rules_block).toBe(false);
    expect(buildFlipPreflightJson(ready, true).rules_block).toBe(true);
  });
});

describe("renderFlipPreflight — human layout", () => {
  it("NOT-READY lists every blocking reason", () => {
    const r = evaluateFlipReadiness(
      { agent: "z", residueBytes: RULES_BLOCK_BUDGET_BYTES + 100, residueDirectiveCount: 9, totalDirectiveCount: 9, residueTokensEstimate: 0 },
      { rulesBlockEnabled: false },
    );
    const text = renderFlipPreflight(r, false);
    expect(text).toContain("NOT-READY");
    expect(text).toContain("Blocked:");
    // both blockers present: flag ordering + over budget.
    expect(text).toContain("memory.rules_block");
    expect(text).toContain("rules-block budget");
    expect(text).not.toContain("inject_directives: false");
  });
});
