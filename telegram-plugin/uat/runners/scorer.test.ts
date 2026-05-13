/**
 * Tests for the agent-self-sufficiency UAT runner's pure functions.
 * The driver / Telegram orchestration is exercised live via the
 * runner script itself (`agent-self-sufficiency.ts`) — these tests
 * pin the scoring + reporting contracts so a refactor doesn't
 * silently flip "fail" to "pass" or scramble the markdown layout.
 */

import { describe, it, expect } from "vitest";
import { scoreReply, aggregate, type CaseResult } from "./scorer.js";
import { CRITERIA, patternFor } from "./paraphrases.js";
import { renderMarkdown } from "./report.js";

const SPEC_IDENTITY = CRITERIA.find((c) => c.id === "2a_what_are_you")!;
const SPEC_NAME = CRITERIA.find((c) => c.id === "2b_your_name")!;
const SPEC_PEERS = CRITERIA.find((c) => c.id === "2c_peers")!;
const SPEC_CRON = CRITERIA.find((c) => c.id === "1b_cron_list")!;
const SPEC_REFUSAL = CRITERIA.find((c) => c.id === "3d_admin_refusal")!;

describe("CRITERIA corpus shape", () => {
  it("has at least 10 paraphrases per criterion (goal acceptance gate)", () => {
    for (const c of CRITERIA) {
      expect(c.paraphrases.length, `criterion ${c.id}`).toBeGreaterThanOrEqual(
        10,
      );
    }
  });

  it("covers every paraphrase shape at least once per criterion", () => {
    const shapes = ["formal", "terse", "typo", "voice", "multi"] as const;
    for (const c of CRITERIA) {
      const seen = new Set(c.paraphrases.map((p) => p.shape));
      for (const s of shapes) {
        expect(seen.has(s), `${c.id} missing shape ${s}`).toBe(true);
      }
    }
  });
});

describe("scoreReply", () => {
  it("returns pass when the identity criterion's reply mentions switchroom + claude code", () => {
    const reply =
      "I'm a switchroom agent running Claude Code under the official `claude` CLI.";
    expect(scoreReply(SPEC_IDENTITY, reply, { agentName: "x" })).toBe("pass");
  });

  it("returns fail when the identity reply is generic 'AI assistant' boilerplate", () => {
    const reply = "I'm an AI assistant here to help you with tasks.";
    expect(scoreReply(SPEC_IDENTITY, reply, { agentName: "x" })).toBe("fail");
  });

  it("returns fail on empty replies regardless of criterion", () => {
    expect(scoreReply(SPEC_PEERS, "", { agentName: "x" })).toBe("fail");
    expect(scoreReply(SPEC_PEERS, "   ", { agentName: "x" })).toBe("fail");
  });

  it("strips markdown bold/code before matching so formatting doesn't flip outcomes", () => {
    // The bold + backticks would have shielded the keyword if we
    // matched raw — this proves stripMarkdown does its job.
    const reply = "I'm a **switchroom** agent on `claude code`.";
    expect(scoreReply(SPEC_IDENTITY, reply, { agentName: "x" })).toBe("pass");
  });

  it("substitutes __INJECTED_AGENT_NAME__ for the per-agent name criterion", () => {
    const pattern = patternFor(SPEC_NAME, { agentName: "klanker" });
    expect(pattern.test("my name is klanker")).toBe(true);
    expect(pattern.test("my name is doc")).toBe(false);
  });

  it("scores 2b_your_name pass when the reply contains the agent name", () => {
    const reply = "My name is klanker.";
    expect(scoreReply(SPEC_NAME, reply, { agentName: "klanker" })).toBe("pass");
  });

  it("scores 2b_your_name fail when the reply names a different agent", () => {
    const reply = "I'm doc.";
    expect(scoreReply(SPEC_NAME, reply, { agentName: "klanker" })).toBe("fail");
  });

  it("scores 1b_cron_list pass for honest 'nothing scheduled' replies", () => {
    const reply = "Nothing scheduled right now — my cron list is empty.";
    expect(scoreReply(SPEC_CRON, reply, { agentName: "x" })).toBe("pass");
  });

  it("scores 3d_admin_refusal pass when reply says can't + names admin agent", () => {
    const reply =
      "I can't restart the fleet — ask klanker, they're the admin agent on this instance.";
    expect(scoreReply(SPEC_REFUSAL, reply, { agentName: "scribe" })).toBe(
      "pass",
    );
  });
});

describe("aggregate", () => {
  it("counts by criterion / agent / shape", () => {
    const mk = (
      agent: string,
      criterion: CaseResult["criterion"],
      shape: "formal" | "terse" | "typo" | "voice" | "multi",
      outcome: "pass" | "fail" | "timeout" | "error",
    ): CaseResult => ({
      agent,
      criterion,
      paraphrase: { label: "x", shape, text: "y" },
      outcome,
      reply: "",
      durationMs: 1,
    });
    const results = [
      mk("a", "2a_what_are_you", "formal", "pass"),
      mk("a", "2a_what_are_you", "typo", "fail"),
      mk("b", "2a_what_are_you", "voice", "pass"),
      mk("b", "2c_peers", "terse", "timeout"),
    ];
    const a = aggregate(results);
    expect(a.byCriterion.get("2a_what_are_you")).toEqual({
      pass: 2,
      fail: 1,
      timeout: 0,
      error: 0,
    });
    expect(a.byAgent.get("a")).toEqual({
      pass: 1,
      fail: 1,
      timeout: 0,
      error: 0,
    });
    expect(a.byShape.get("typo")).toEqual({
      pass: 0,
      fail: 1,
      timeout: 0,
      error: 0,
    });
  });
});

describe("renderMarkdown", () => {
  it("produces a report with overall pass rate, per-criterion table, and triage when there are failures", () => {
    const results: CaseResult[] = [
      {
        agent: "a",
        criterion: "2a_what_are_you",
        paraphrase: { label: "p1", shape: "formal", text: "what are you?" },
        outcome: "pass",
        reply: "I'm a switchroom agent.",
        durationMs: 500,
      },
      {
        agent: "a",
        criterion: "2a_what_are_you",
        paraphrase: { label: "p2", shape: "typo", text: "wht r u" },
        outcome: "fail",
        reply: "I'm just an AI.",
        durationMs: 800,
      },
      {
        agent: "b",
        criterion: "2c_peers",
        paraphrase: { label: "p3", shape: "voice", text: "who else is here?" },
        outcome: "timeout",
        reply: "",
        durationMs: 60_000,
      },
    ];
    const md = renderMarkdown(results, {
      startedAt: new Date("2026-05-14T00:00:00Z"),
      durationSeconds: 90,
      agents: ["a", "b"],
    });
    expect(md).toContain("# Agent self-sufficiency UAT report");
    expect(md).toContain("33.3% (1/3)");
    expect(md).toContain("`2a_what_are_you`");
    expect(md).toContain("Triage");
    // Triage row carries the verbatim prompt + reply.
    expect(md).toContain("wht r u");
    expect(md).toContain("I'm just an AI.");
    expect(md).toMatch(/timeout after 60000ms/);
  });

  it("renders 'All cases passed' when there are no failures", () => {
    const md = renderMarkdown(
      [
        {
          agent: "a",
          criterion: "2a_what_are_you",
          paraphrase: { label: "p", shape: "formal", text: "what are you?" },
          outcome: "pass",
          reply: "I'm a switchroom agent.",
          durationMs: 500,
        },
      ],
      { startedAt: new Date(), durationSeconds: 1, agents: ["a"] },
    );
    expect(md).toContain("All cases passed");
  });
});
