/**
 * T3 (doctor half) / T7 — doctor-rules-block.ts.
 *
 * T7 is the red-team's Blocker 2 regression test: the engine's documented
 * `200 {"items":[]}` response for an unknown bank_id (E-33) must never be
 * read as content-divergence tampering. See red-team-M1.md §D.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runRulesBlockChecks, runDirectiveFlipChecks } from "./doctor-rules-block.js";
import { renderIndexBlock } from "../memory/rules-block.js";
import { createRule } from "../memory/rules-store.js";
import type { SwitchroomConfig } from "../config/schema.js";

const MARKER = "# --- Yours (preserved across apply) ---";

function config(agents: Record<string, { rules_block?: boolean; collection?: string }>) {
  const out: Record<string, unknown> = {};
  for (const [name, opts] of Object.entries(agents)) {
    out[name] = { memory: { rules_block: opts.rules_block, collection: opts.collection } };
  }
  return { agents: out } as unknown as SwitchroomConfig;
}

function stubFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

function seedAgentWithIndex(agentsDir: string, agentName: string, modelNames: string[]) {
  const dir = join(agentsDir, agentName);
  mkdirSync(dir, { recursive: true });
  const indexBlock = renderIndexBlock(modelNames);
  writeFileSync(
    join(dir, "CLAUDE.md"),
    `# Managed\n\n${MARKER}\n\n${indexBlock}\n`,
    "utf-8",
  );
  return dir;
}

let root: string;

function freshRoot(): string {
  root = mkdtempSync(join(tmpdir(), "sr-doctor-rules-block-"));
  return root;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("dark build — flag off is skipped entirely", () => {
  it("returns no rows for an agent with memory.rules_block unset", async () => {
    const agentsDir = freshRoot();
    const results = await runRulesBlockChecks(
      config({ bot: { rules_block: false } }),
      "http://engine.invalid",
      { agentsDir, fetchImpl: stubFetch({ items: [] }) },
    );
    expect(results).toEqual([]);
  });
});

describe("T7 — Blocker 2: reachable-but-empty engine response is never a FAIL", () => {
  it("skips (ok) when both sides are empty", async () => {
    const agentsDir = freshRoot();
    seedAgentWithIndex(agentsDir, "bot", []);
    const results = await runRulesBlockChecks(
      config({ bot: { rules_block: true } }),
      "http://engine.invalid",
      { agentsDir, fetchImpl: stubFetch({ items: [] }) },
    );
    const divergence = results.find((r) => r.name.includes("index divergence"))!;
    expect(divergence.status).toBe("ok");
  });

  it("WARNs (not FAILs) when the engine reports empty but the local index is non-empty (E-33 misroute symptom)", async () => {
    const agentsDir = freshRoot();
    seedAgentWithIndex(agentsDir, "bot", ["orientation", "training-plan-state"]);
    const results = await runRulesBlockChecks(
      config({ bot: { rules_block: true } }),
      "http://engine.invalid",
      { agentsDir, fetchImpl: stubFetch({ items: [] }) },
    );
    const divergence = results.find((r) => r.name.includes("index divergence"))!;
    expect(divergence.status).toBe("warn");
    expect(divergence.detail).toContain("E-33");
    expect(divergence.status).not.toBe("fail");
  });
});

describe("index divergence — genuine content mismatch FAILs", () => {
  it("FAILs with a diff-bearing detail when the engine's non-empty model list differs from the local index", async () => {
    const agentsDir = freshRoot();
    seedAgentWithIndex(agentsDir, "bot", ["orientation"]);
    const results = await runRulesBlockChecks(
      config({ bot: { rules_block: true } }),
      "http://engine.invalid",
      {
        agentsDir,
        fetchImpl: stubFetch({
          items: [{ name: "orientation" }, { name: "training-plan-state" }],
        }),
      },
    );
    const divergence = results.find((r) => r.name.includes("index divergence"))!;
    expect(divergence.status).toBe("fail");
    expect(divergence.detail).toContain("orientation");
    expect(divergence.detail).toContain("training-plan-state");
  });

  it("is OK when the non-empty sets match", async () => {
    const agentsDir = freshRoot();
    seedAgentWithIndex(agentsDir, "bot", ["orientation"]);
    const results = await runRulesBlockChecks(
      config({ bot: { rules_block: true } }),
      "http://engine.invalid",
      { agentsDir, fetchImpl: stubFetch({ items: [{ name: "orientation" }] }) },
    );
    const divergence = results.find((r) => r.name.includes("index divergence"))!;
    expect(divergence.status).toBe("ok");
  });
});

describe("engine unreachable — warn, not fail", () => {
  it("WARNs when the engine fetch throws", async () => {
    const agentsDir = freshRoot();
    seedAgentWithIndex(agentsDir, "bot", []);
    const results = await runRulesBlockChecks(
      config({ bot: { rules_block: true } }),
      "http://engine.invalid",
      {
        agentsDir,
        fetchImpl: (() =>
          Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
      },
    );
    const divergence = results.find((r) => r.name.includes("index divergence"))!;
    expect(divergence.status).toBe("warn");
  });
});

describe("T3 (doctor half) — local integrity check surfaces tamper with a quoted detail", () => {
  it("OKs a clean, untouched rules block", async () => {
    const agentsDir = freshRoot();
    const dir = join(agentsDir, "bot");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), `# Managed\n\n${MARKER}\n\nfree text\n`, "utf-8");
    createRule(dir, { text: "Keep tests green.", source: "telegram", actor: "klanker" });

    const results = await runRulesBlockChecks(
      config({ bot: { rules_block: true } }),
      "http://engine.invalid",
      { agentsDir, fetchImpl: stubFetch({ items: [] }) },
    );
    const integrity = results.find((r) => r.name.includes("integrity"))!;
    expect(integrity.status).toBe("ok");
  });

  it("FAILs with a sentinel-mismatch detail when the block is hand-edited out-of-band", async () => {
    const agentsDir = freshRoot();
    const dir = join(agentsDir, "bot");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), `# Managed\n\n${MARKER}\n\nfree text\n`, "utf-8");
    createRule(dir, { text: "Keep tests green.", source: "telegram", actor: "klanker" });

    const claudeMdPath = join(dir, "CLAUDE.md");
    const before = readFileSync(claudeMdPath, "utf-8");
    writeFileSync(claudeMdPath, before.replace("Keep tests green.", "Tampered."), "utf-8");

    const results = await runRulesBlockChecks(
      config({ bot: { rules_block: true } }),
      "http://engine.invalid",
      { agentsDir, fetchImpl: stubFetch({ items: [] }) },
    );
    const integrity = results.find((r) => r.name.includes("integrity"))!;
    expect(integrity.status).toBe("fail");
    expect(integrity.detail).toContain("sentinel mismatch");
    expect(integrity.fix).toContain("switchroom memory rule verify bot");
  });
});

describe("bank dedup — one bank shared by several agents", () => {
  it("dedups index divergence per-bank but checks integrity per-agent", async () => {
    const agentsDir = freshRoot();
    seedAgentWithIndex(agentsDir, "bot-a", []);
    seedAgentWithIndex(agentsDir, "bot-b", []);
    const results = await runRulesBlockChecks(
      config({
        "bot-a": { rules_block: true, collection: "shared-bank" },
        "bot-b": { rules_block: true, collection: "shared-bank" },
      }),
      "http://engine.invalid",
      { agentsDir, fetchImpl: stubFetch({ items: [] }) },
    );
    // Index divergence is a per-BANK probe (shared engine bank) → one row.
    const divergenceRows = results.filter((r) => r.name.includes("index divergence"));
    expect(divergenceRows).toHaveLength(1);
    expect(divergenceRows[0].name).toContain("bot-a");
    expect(divergenceRows[0].name).toContain("bot-b");
    // Integrity is per-AGENT (each has its own CLAUDE.md) → one row each.
    const integrityRows = results.filter((r) => r.name.includes("integrity"));
    expect(integrityRows).toHaveLength(2);
    expect(integrityRows.some((r) => r.name.includes("(bot-a)"))).toBe(true);
    expect(integrityRows.some((r) => r.name.includes("(bot-b)"))).toBe(true);
  });

  it("FAILs integrity for the SECOND agent when only its block is tampered (MEDIUM regression)", async () => {
    const agentsDir = freshRoot();
    // bot-a: clean rule block. bot-b: rule block then hand-edited out-of-band.
    const dirA = join(agentsDir, "bot-a");
    const dirB = join(agentsDir, "bot-b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirA, "CLAUDE.md"), `# Managed\n\n${MARKER}\n\nfree text\n`, "utf-8");
    writeFileSync(join(dirB, "CLAUDE.md"), `# Managed\n\n${MARKER}\n\nfree text\n`, "utf-8");
    createRule(dirA, { text: "Keep tests green.", source: "telegram", actor: "klanker" });
    createRule(dirB, { text: "Keep tests green.", source: "telegram", actor: "klanker" });

    // Tamper ONLY bot-b's block (the non-first agent).
    const bPath = join(dirB, "CLAUDE.md");
    const beforeB = readFileSync(bPath, "utf-8");
    writeFileSync(bPath, beforeB.replace("Keep tests green.", "Tampered."), "utf-8");

    const results = await runRulesBlockChecks(
      config({
        "bot-a": { rules_block: true, collection: "shared-bank" },
        "bot-b": { rules_block: true, collection: "shared-bank" },
      }),
      "http://engine.invalid",
      { agentsDir, fetchImpl: stubFetch({ items: [] }) },
    );
    const aRow = results.find((r) => r.name.includes("integrity") && r.name.includes("(bot-a)"))!;
    const bRow = results.find((r) => r.name.includes("integrity") && r.name.includes("(bot-b)"))!;
    expect(aRow.status).toBe("ok");
    expect(bRow.status).toBe("fail");
    expect(bRow.detail).toContain("sentinel mismatch");
    expect(bRow.fix).toContain("switchroom memory rule verify bot-b");
  });
});

describe("Memory v2 M3 — directive-flip suppress-flag cross-check", () => {
  function flipConfig(
    agents: Record<string, { rules_block?: boolean; inject_directives?: boolean }>,
  ): SwitchroomConfig {
    const out: Record<string, unknown> = {};
    for (const [name, opts] of Object.entries(agents)) {
      out[name] = {
        memory: {
          rules_block: opts.rules_block,
          inject_directives: opts.inject_directives,
        },
      };
    }
    return { agents: out } as unknown as SwitchroomConfig;
  }

  function seedPopulatedRulesBlock(agentsDir: string, agentName: string): string {
    const dir = join(agentsDir, agentName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), `# Managed\n\n${MARKER}\n\nfree text\n`, "utf-8");
    createRule(dir, { text: "Never send email without approval.", source: "reflect-directive", actor: "klanker" });
    return dir;
  }

  it("produces NO rows for an agent that is not flipped", () => {
    const agentsDir = freshRoot();
    seedPopulatedRulesBlock(agentsDir, "ziggy");
    const results = runDirectiveFlipChecks(
      flipConfig({ ziggy: { rules_block: true, inject_directives: true } }),
      { agentsDir },
    );
    expect(results).toEqual([]);
  });

  it("is OK for a flipped agent whose rules block carries rules (the ziggy canary)", () => {
    const agentsDir = freshRoot();
    seedPopulatedRulesBlock(agentsDir, "ziggy");
    const results = runDirectiveFlipChecks(
      flipConfig({ ziggy: { rules_block: true, inject_directives: false } }),
      { agentsDir },
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("ok");
    expect(results[0].detail).toContain("1 rule");
  });

  it("FAILs a flipped agent with an EMPTY rules block (guardrail-less flip)", () => {
    const agentsDir = freshRoot();
    // Enable the toolchain but add NO rule → empty block.
    const dir = join(agentsDir, "ziggy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), `# Managed\n\n${MARKER}\n\nfree text\n`, "utf-8");
    const results = runDirectiveFlipChecks(
      flipConfig({ ziggy: { rules_block: true, inject_directives: false } }),
      { agentsDir },
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("empty");
  });

  it("FAILs a flipped agent whose rules_block flag is not even on (two-flag ordering)", () => {
    const agentsDir = freshRoot();
    seedPopulatedRulesBlock(agentsDir, "ziggy");
    const results = runDirectiveFlipChecks(
      flipConfig({ ziggy: { rules_block: false, inject_directives: false } }),
      { agentsDir },
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("rules_block is not true");
  });

  it("FAILs a flipped agent whose CLAUDE.md is missing entirely", () => {
    const agentsDir = freshRoot();
    const results = runDirectiveFlipChecks(
      flipConfig({ ziggy: { rules_block: true, inject_directives: false } }),
      { agentsDir },
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("fail");
  });
});

