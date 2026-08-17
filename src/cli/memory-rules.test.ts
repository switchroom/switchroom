/**
 * T8 — `switchroom memory rule ...` CLI surface.
 *
 * Drives the real Commander wiring (`registerMemoryRuleCommand`) against a
 * tmp switchroom.yaml + tmp agent dir (via the `SWITCHROOM_AGENTS_DIR`
 * container-mode override — same pattern as
 * `doctor-routing-mode.test.ts`/`doctor-agent-dotfile-ownership.test.ts`),
 * so what's asserted is the CLI's actual stdout announcement string and
 * actual process.exit code, not a restatement of `rules-store.ts`'s
 * return value.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMemoryRuleCommand } from "./memory-rules.js";

const MARKER = "# --- Yours (preserved across apply) ---";

let root: string;
let agentsDir: string;
let configPath: string;
let savedAgentsDirEnv: string | undefined;

function seedAgent(name: string) {
  const dir = join(agentsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "CLAUDE.md"),
    `# Managed section\n\n${MARKER}\n\nThis space is yours.\n`,
    "utf-8",
  );
  return dir;
}

function buildProgram(): Command {
  const program = new Command();
  program.option("--config <path>");
  const memory = program.command("memory");
  registerMemoryRuleCommand(memory, program);
  return program;
}

async function run(argv: string[]) {
  const program = buildProgram();
  await program.parseAsync([
    "node",
    "switchroom",
    "--config",
    configPath,
    "memory",
    ...argv,
  ]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sr-memory-rules-cli-"));
  agentsDir = join(root, "agents");
  mkdirSync(agentsDir, { recursive: true });
  configPath = join(root, "switchroom.yaml");
  writeFileSync(
    configPath,
    [
      "switchroom:",
      "  version: 1",
      `  agents_dir: ${agentsDir}`,
      "telegram:",
      '  bot_token: "x"',
      '  forum_chat_id: "-1001234567890"',
      "agents:",
      "  bot:",
      '    topic_name: "bot"',
      "    memory:",
      "      collection: bot-bank",
      "      rules_block: true",
      "  dark:",
      '    topic_name: "dark"',
      "",
    ].join("\n"),
    "utf-8",
  );
  seedAgent("bot");
  seedAgent("dark");

  savedAgentsDirEnv = process.env.SWITCHROOM_AGENTS_DIR;
  process.env.SWITCHROOM_AGENTS_DIR = agentsDir;
});

afterEach(() => {
  if (savedAgentsDirEnv !== undefined) {
    process.env.SWITCHROOM_AGENTS_DIR = savedAgentsDirEnv;
  } else {
    delete process.env.SWITCHROOM_AGENTS_DIR;
  }
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("memory rule add — announcement string", () => {
  it("prints the exact 'added standing rule R-<n>: <text>' announcement", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await run(["rule", "add", "bot", "Always", "confirm", "destructive", "ops."]);

    const printed = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toContain("added standing rule R-01: Always confirm destructive ops.");
  });
});

describe("memory rule write verbs — darkness gate (flag off)", () => {
  it("add refuses with a clean error, exits non-zero, and writes nothing for a flag-off agent", async () => {
    const claudeMdPath = join(agentsDir, "dark", "CLAUDE.md");
    const before = readFileSync(claudeMdPath, "utf-8");
    const logPath = join(agentsDir, "dark", "memory", "rules-mutation.log");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__process_exit__");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(run(["rule", "add", "dark", "Should", "not", "land."])).rejects.toThrow(
      "__process_exit__",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toContain("memory.rules_block is off");

    // Byte-identical: no block rendered, no mutation log created.
    expect(readFileSync(claudeMdPath, "utf-8")).toBe(before);
    expect(existsSync(logPath)).toBe(false);
  });

  it("edit-yours also refuses for a flag-off agent", async () => {
    const claudeMdPath = join(agentsDir, "dark", "CLAUDE.md");
    const before = readFileSync(claudeMdPath, "utf-8");
    vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__process_exit__");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(run(["rule", "edit-yours", "dark", "new", "notes"])).rejects.toThrow(
      "__process_exit__",
    );
    const printed = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toContain("memory.rules_block is off");
    expect(readFileSync(claudeMdPath, "utf-8")).toBe(before);
  });
});

describe("memory rule add — budget refusal", () => {
  it("exits non-zero and leaves the CLAUDE.md byte-identical when the block would exceed budget", async () => {
    const claudeMdPath = join(agentsDir, "bot", "CLAUDE.md");
    const before = readFileSync(claudeMdPath, "utf-8");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__process_exit__");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const hugeWords = Array(1200).fill("x".repeat(6));
    await expect(run(["rule", "add", "bot", ...hugeWords])).rejects.toThrow(
      "__process_exit__",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    const after = readFileSync(claudeMdPath, "utf-8");
    expect(after).toBe(before);
  });
});

describe("memory rule list / retire round-trip", () => {
  it("list shows the created rule; retire removes it", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await run(["rule", "add", "bot", "Rule", "one."]);
    logSpy.mockClear();

    await run(["rule", "list", "bot"]);
    const listed = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(listed).toContain("R-01");
    expect(listed).toContain("Rule one.");

    logSpy.mockClear();
    await run(["rule", "retire", "bot", "R-01"]);
    const retired = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(retired).toContain("retired rule R-01");

    logSpy.mockClear();
    await run(["rule", "list", "bot"]);
    const listedAfter = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(listedAfter).not.toContain("R-01");
  });
});
