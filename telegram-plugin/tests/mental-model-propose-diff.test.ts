import { describe, it, expect, vi } from "vitest";
import { parseDocument } from "yaml";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMentalModelAppendDiff,
  readDeclaredMentalModelNames,
} from "../gateway/mental-model-propose-diff.js";
import { ensureDeclaredMentalModels } from "../../src/memory/hindsight.js";

/** Apply a unified diff the way hostd does (git apply -p1) and return the
 *  patched file contents, or null if the patch didn't apply. */
function gitApply(before: string, diff: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "mmp-apply-"));
  try {
    writeFileSync(join(dir, "switchroom.yaml"), before);
    writeFileSync(join(dir, "patch.diff"), diff);
    const init = spawnSync("git", ["init", "-q"], { cwd: dir });
    if (init.status !== 0) return null;
    const r = spawnSync(
      "git",
      ["apply", "--whitespace=nowarn", "--recount", "-p1", "patch.diff"],
      { cwd: dir, encoding: "utf-8" },
    );
    if (r.status !== 0) return null;
    return readFileSync(join(dir, "switchroom.yaml"), "utf-8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * hindsight Phase 5 — the persistence primitive for the agent-proposes →
 * human-approves mental-model flow. An approved proposal must become a
 * first-class DECLARED model in agents.<agent>.memory.mental_models[] so the
 * exact same #2874 ensure/reconcile path consumes it.
 */

const CONFIG_NO_MODELS = `agents:
  coach:
    persona: fitness
    memory:
      collection: coach-bank
  lawyer:
    persona: legal
`;

const CONFIG_WITH_MODELS = `agents:
  coach:
    persona: fitness
    memory:
      collection: coach-bank
      mental_models:
        - name: training-plan-state
          source_query: What is the athlete's current plan?
`;

describe("readDeclaredMentalModelNames", () => {
  it("returns [] when the agent has no declared models", () => {
    expect(readDeclaredMentalModelNames(CONFIG_NO_MODELS, "coach")).toEqual([]);
  });
  it("reads the declared model names for the agent (and not siblings)", () => {
    expect(readDeclaredMentalModelNames(CONFIG_WITH_MODELS, "coach")).toEqual([
      "training-plan-state",
    ]);
    expect(readDeclaredMentalModelNames(CONFIG_WITH_MODELS, "lawyer")).toEqual([]);
  });
  it("never throws on unparseable config", () => {
    expect(readDeclaredMentalModelNames(":\n  bad: [", "coach")).toEqual([]);
  });
});

describe("buildMentalModelAppendDiff — appends the declaration", () => {
  it("creates memory.mental_models[] when absent and appends the model", () => {
    const r = buildMentalModelAppendDiff({
      configText: CONFIG_NO_MODELS,
      agentName: "coach",
      spec: { name: "training-plan-state", source_query: "What is the plan?" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The appended `after` declares the model under the right agent.
    expect(readDeclaredMentalModelNames(r.after, "coach")).toContain(
      "training-plan-state",
    );
    // And the diff is a real git-apply-shaped unified diff.
    expect(r.diff).toContain("--- a/switchroom.yaml");
    expect(r.diff).toContain("+++ b/switchroom.yaml");
    expect(r.diff).toContain("training-plan-state");
  });

  it("appends to an existing mental_models[] without dropping the prior model", () => {
    const r = buildMentalModelAppendDiff({
      configText: CONFIG_WITH_MODELS,
      agentName: "coach",
      spec: { name: "injury-history", source_query: "Which injuries?", max_tokens: 1024 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = readDeclaredMentalModelNames(r.after, "coach");
    expect(names).toEqual(["training-plan-state", "injury-history"]);
  });

  it("only serialises knobs that are set (schema-clean minimal declaration)", () => {
    const r = buildMentalModelAppendDiff({
      configText: CONFIG_NO_MODELS,
      agentName: "coach",
      spec: { name: "plan", source_query: "q", refresh_after_consolidation: true },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const model = (parseDocument(r.after).toJS() as any).agents.coach.memory.mental_models[0];
    expect(model).toEqual({
      name: "plan",
      source_query: "q",
      refresh_after_consolidation: true,
    });
    expect("max_tokens" in model).toBe(false);
  });

  it("the synthesized diff round-trips through git apply against the live config", () => {
    const r = buildMentalModelAppendDiff({
      configText: CONFIG_WITH_MODELS,
      agentName: "coach",
      spec: { name: "injury-history", source_query: "Which injuries?" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // hostd applies with git apply; prove the patch actually lands.
    const applied = gitApply(CONFIG_WITH_MODELS, r.diff);
    expect(applied).not.toBeNull();
    expect(readDeclaredMentalModelNames(applied!, "coach")).toEqual([
      "training-plan-state",
      "injury-history",
    ]);
  });
});

describe("buildMentalModelAppendDiff — guardrails", () => {
  it("REJECTS a duplicate-name proposal (the idempotent-ensure key must be unique)", () => {
    const r = buildMentalModelAppendDiff({
      configText: CONFIG_WITH_MODELS,
      agentName: "coach",
      spec: { name: "training-plan-state", source_query: "different query" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("duplicate");
  });

  it("REJECTS a proposal for an agent that is not in the config (never invents one)", () => {
    const r = buildMentalModelAppendDiff({
      configText: CONFIG_NO_MODELS,
      agentName: "ghost",
      spec: { name: "x", source_query: "q" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("agent-not-found");
  });
});

describe("appended declaration is consumed by #2874's ensure path", () => {
  it("the appended model is ensured by ensureDeclaredMentalModels (create fired)", async () => {
    const r = buildMentalModelAppendDiff({
      configText: CONFIG_NO_MODELS,
      agentName: "coach",
      spec: { name: "training-plan-state", source_query: "What is the plan?" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Read the newly-declared model set exactly as scaffold/reconcile would.
    const declared = (parseDocument(r.after).toJS() as any).agents.coach.memory
      .mental_models;

    const mockFetch = vi
      .fn()
      // init
      .mockResolvedValueOnce({ ok: true, headers: new Map([["mcp-session-id", "s"]]), text: async () => "" })
      // list (empty → create)
      .mockResolvedValueOnce({ ok: true, text: async () => `data: {"result":{"content":[{"text":${JSON.stringify(JSON.stringify({ items: [] }))}}]}}\n` })
      // create
      .mockResolvedValueOnce({ ok: true, text: async () => 'data: {"result":{"isError":false}}\n' });

    const outcomes = await ensureDeclaredMentalModels(
      "http://test.local/mcp/",
      "coach-bank",
      declared,
      { fetchImpl: mockFetch as any },
    );
    expect(outcomes).toEqual([{ name: "training-plan-state", ok: true }]);
    // create_mental_model actually fired with the declared source_query.
    const createBody = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(createBody.params.name).toBe("create_mental_model");
    expect(createBody.params.arguments.name).toBe("training-plan-state");
    expect(createBody.params.arguments.source_query).toBe("What is the plan?");
  });
});
