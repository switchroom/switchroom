import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractTurnsFromJsonl,
  formatTranscriptTail,
  deriveTopic,
  writeSidecarsAtomic,
  buildHandoff,
  findLatestSessionJsonl,
  TOPIC_MAX_CHARS,
  TURN_TEXT_MAX_CHARS,
  type Turn,
} from "../src/agents/handoff-summarizer.js";

function makeJsonl(lines: Record<string, unknown>[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe("extractTurnsFromJsonl", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "handoff-extract-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns [] for missing file", () => {
    expect(extractTurnsFromJsonl(join(tmp, "missing.jsonl"), 10)).toEqual([]);
  });

  it("parses assistant text blocks", () => {
    const path = join(tmp, "a.jsonl");
    writeFileSync(
      path,
      makeJsonl([
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello there" }] },
        },
      ]),
    );
    const turns = extractTurnsFromJsonl(path, 10);
    expect(turns).toEqual([{ role: "assistant", text: "Hello there" }]);
  });

  it("parses user queue-operation enqueue content", () => {
    const path = join(tmp, "b.jsonl");
    writeFileSync(
      path,
      makeJsonl([
        {
          type: "queue-operation",
          operation: "enqueue",
          content:
            '<channel source="switchroom-telegram" chat_id="1" message_id="2">\nHi bot\n</channel>',
        },
      ]),
    );
    const turns = extractTurnsFromJsonl(path, 10);
    expect(turns).toEqual([{ role: "user", text: "Hi bot" }]);
  });

  it("ignores queue-operation dequeue and malformed lines", () => {
    const path = join(tmp, "c.jsonl");
    writeFileSync(
      path,
      makeJsonl([
        { type: "queue-operation", operation: "dequeue" },
        { type: "unknown" },
      ]) + "not json {\n",
    );
    expect(extractTurnsFromJsonl(path, 10)).toEqual([]);
  });

  it("truncates to the last maxTurns entries", () => {
    const path = join(tmp, "d.jsonl");
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push({
        type: "assistant",
        message: { content: [{ type: "text", text: `turn ${i}` }] },
      });
    }
    writeFileSync(path, makeJsonl(rows));
    const turns = extractTurnsFromJsonl(path, 3);
    expect(turns.map((t) => t.text)).toEqual(["turn 7", "turn 8", "turn 9"]);
  });

  it("skips assistant messages with only tool_use blocks", () => {
    const path = join(tmp, "e.jsonl");
    writeFileSync(
      path,
      makeJsonl([
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Read", input: {} }],
          },
        },
      ]),
    );
    expect(extractTurnsFromJsonl(path, 10)).toEqual([]);
  });

  it("strips the <channel> wrapper from a type:user entry and collapses the queue-op twin", () => {
    // A telegram message lands in the JSONL twice — once as a clean
    // queue-operation enqueue, once as a type:"user" entry whose
    // string content is the raw <channel>…</channel> envelope. The
    // extractor must yield ONE clean user turn, not two (and not raw XML).
    const path = join(tmp, "f.jsonl");
    const channelBlock =
      '<channel source="t" chat_id="1" message_id="2">what is 2 + 2?</channel>';
    writeFileSync(
      path,
      makeJsonl([
        { type: "queue-operation", operation: "enqueue", content: channelBlock },
        { type: "user", message: { content: channelBlock } },
        { type: "assistant", message: { content: [{ type: "text", text: "4" }] } },
      ]),
    );
    expect(extractTurnsFromJsonl(path, 10)).toEqual([
      { role: "user", text: "what is 2 + 2?" },
      { role: "assistant", text: "4" },
    ]);
  });
});

describe("formatTranscriptTail", () => {
  it("emits a transcript tail with both roles, oldest first", () => {
    const out = formatTranscriptTail([
      { role: "user", text: "start the app" },
      { role: "assistant", text: "app started" },
    ]);
    expect(out).toContain("## Recent turns");
    expect(out).toContain("### User\nstart the app");
    expect(out).toContain("### Assistant\napp started");
    // oldest first — user precedes assistant in the rendered body
    expect(out.indexOf("start the app")).toBeLessThan(out.indexOf("app started"));
  });

  it("contains no LLM-summary structure — it is a raw tail, not a briefing", () => {
    const out = formatTranscriptTail([{ role: "user", text: "hi" }]);
    expect(out).not.toContain("## Summary");
    expect(out).not.toContain("## Topic:");
  });

  it("handles an empty transcript", () => {
    const out = formatTranscriptTail([]);
    expect(out).toContain("No recent turns were recoverable");
  });

  it("truncates an over-long turn", () => {
    const huge = "x".repeat(TURN_TEXT_MAX_CHARS + 500);
    const out = formatTranscriptTail([{ role: "assistant", text: huge }]);
    expect(out).toContain("…[truncated]");
    // the rendered turn body is bounded
    expect(out.length).toBeLessThan(huge.length);
  });
});

describe("deriveTopic", () => {
  it("uses the most recent user turn", () => {
    expect(
      deriveTopic([
        { role: "user", text: "first thing" },
        { role: "assistant", text: "did it" },
        { role: "user", text: "now the second thing" },
        { role: "assistant", text: "working on it" },
      ]),
    ).toBe("now the second thing");
  });

  it("falls back to the last turn when there is no user turn", () => {
    expect(
      deriveTopic([{ role: "assistant", text: "cron-fired report" }]),
    ).toBe("cron-fired report");
  });

  it("returns a placeholder for an empty transcript", () => {
    expect(deriveTopic([])).toBe("previous session");
  });

  it("uses the first non-empty line of a multi-line turn", () => {
    expect(
      deriveTopic([{ role: "user", text: "\n\nfix the build\nand also tests" }]),
    ).toBe("fix the build");
  });

  it("clamps a long topic with an ellipsis", () => {
    const long = "y".repeat(TOPIC_MAX_CHARS + 40);
    const topic = deriveTopic([{ role: "user", text: long }]);
    expect(topic.endsWith("…")).toBe(true);
    expect(topic.length).toBe(TOPIC_MAX_CHARS + 1);
  });
});

describe("writeSidecarsAtomic", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "handoff-write-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes both files and cleans up tmp files", () => {
    writeSidecarsAtomic(tmp, "# briefing body", "my topic");
    expect(readFileSync(join(tmp, ".handoff.md"), "utf-8")).toBe("# briefing body");
    expect(readFileSync(join(tmp, ".handoff-topic"), "utf-8")).toBe("my topic");
    expect(existsSync(join(tmp, ".handoff.md.tmp"))).toBe(false);
    expect(existsSync(join(tmp, ".handoff-topic.tmp"))).toBe(false);
  });
});

describe("buildHandoff pipeline", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "handoff-build-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 'no-turns' when JSONL is empty", async () => {
    const jsonlPath = join(tmp, "empty.jsonl");
    writeFileSync(jsonlPath, "");
    const status = await buildHandoff({
      jsonlPath,
      agentDir: tmp,
      agentName: "test",
    });
    expect(status).toBe("no-turns");
  });

  it("returns 'ok' and writes the transcript-tail sidecars — no claude -p", async () => {
    const jsonlPath = join(tmp, "turns.jsonl");
    writeFileSync(
      jsonlPath,
      makeJsonl([
        {
          type: "queue-operation",
          operation: "enqueue",
          content: '<channel source="t" chat_id="1" message_id="2">deploy the worker</channel>',
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Worker deployed." }] },
        },
      ]),
    );
    const status = await buildHandoff({
      jsonlPath,
      agentDir: tmp,
      agentName: "test",
    });
    expect(status).toBe("ok");

    const handoff = readFileSync(join(tmp, ".handoff.md"), "utf-8");
    expect(handoff).toContain("## Recent turns");
    expect(handoff).toContain("deploy the worker");
    expect(handoff).toContain("Worker deployed.");

    // Topic is derived from the last user turn — deterministically.
    expect(readFileSync(join(tmp, ".handoff-topic"), "utf-8")).toBe("deploy the worker");
  });

  it("NEVER writes the tail into Hindsight — even with HINDSIGHT_API_URL set (memory-poisoning regression)", async () => {
    // Regression for the session_handoff memory-poisoning defect (verified
    // live 2026-08-02): the Stop hook used to POST the raw transcript tail —
    // the assistant's own prior output, tool-result fragments included — to
    // Hindsight's retain API as document_id "session_handoff". Fact
    // extraction then re-minted the model's hallucinations (a guessed date,
    // a wrong issue id) as first-class world facts, and the next session's
    // recall served them back as ground truth. buildHandoff must therefore
    // perform NO network call at all, even in the exact environment the
    // container runs it in (HINDSIGHT_API_URL + HINDSIGHT_BANK_ID exported).
    // This test FAILS on the pre-fix code, which read those env vars and
    // called global fetch.
    const jsonlPath = join(tmp, "turns.jsonl");
    writeFileSync(
      jsonlPath,
      makeJsonl([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: "Article 1 (Ken-ID KEN146) published on June 19, 2026",
              },
            ],
          },
        },
      ]),
    );
    const savedUrl = process.env.HINDSIGHT_API_URL;
    const savedBank = process.env.HINDSIGHT_BANK_ID;
    process.env.HINDSIGHT_API_URL = "http://127.0.0.1:9";
    process.env.HINDSIGHT_BANK_ID = "carrie";
    const fetchCalls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      fetchCalls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const status = await buildHandoff({
        jsonlPath,
        agentDir: tmp,
        agentName: "carrie",
      });
      expect(status).toBe("ok");
      // The sidecar is still written — session continuity is unaffected.
      expect(readFileSync(join(tmp, ".handoff.md"), "utf-8")).toContain(
        "KEN146",
      );
      // ...but nothing left the process: no retain POST, no ingestion path.
      expect(fetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      if (savedUrl === undefined) delete process.env.HINDSIGHT_API_URL;
      else process.env.HINDSIGHT_API_URL = savedUrl;
      if (savedBank === undefined) delete process.env.HINDSIGHT_BANK_ID;
      else process.env.HINDSIGHT_BANK_ID = savedBank;
    }
  });
});

describe("findLatestSessionJsonl", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "handoff-find-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when no projects dir", () => {
    expect(findLatestSessionJsonl(tmp)).toBeNull();
  });

  it("finds the newest jsonl recursively", () => {
    const projects = join(tmp, "projects", "agent-x");
    const fs = require("node:fs");
    fs.mkdirSync(projects, { recursive: true });
    const older = join(projects, "a.jsonl");
    const newer = join(projects, "b.jsonl");
    writeFileSync(older, "old\n");
    // Make sure mtimes differ
    fs.utimesSync(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    writeFileSync(newer, "new\n");
    expect(findLatestSessionJsonl(tmp)).toBe(newer);
  });

  it("ignores non-.jsonl files", () => {
    const projects = join(tmp, "projects", "agent-x");
    const fs = require("node:fs");
    fs.mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "notes.txt"), "ignored");
    expect(findLatestSessionJsonl(tmp)).toBeNull();
  });
});

// Keeps the `Turn` type referenced so a rename breaks this file (canary).
const _typeCanary: Turn = { role: "user", text: "x" };
void _typeCanary;
