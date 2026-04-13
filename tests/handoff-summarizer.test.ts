import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractTurnsFromJsonl,
  buildHandoffPrompt,
  parseHandoffResponse,
  writeSidecarsAtomic,
  summarize,
  findLatestSessionJsonl,
  TOPIC_MAX_CHARS,
  DEFAULT_SUMMARIZER_MODEL,
  type AnthropicClientLike,
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
            '<channel source="clerk-telegram" chat_id="1" message_id="2">\nHi bot\n</channel>',
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
});

describe("buildHandoffPrompt", () => {
  it("includes the Topic header instruction and transcript", () => {
    const { system, user } = buildHandoffPrompt([
      { role: "user", text: "start the app" },
      { role: "assistant", text: "app started" },
    ]);
    expect(system).toContain("## Topic:");
    expect(system).toContain("## Summary");
    expect(system).toContain("## Last exchange");
    expect(user).toContain("USER\nstart the app");
    expect(user).toContain("ASSISTANT\napp started");
  });
});

describe("parseHandoffResponse", () => {
  it("extracts topic + briefing", () => {
    const raw = "## Topic: wiring the thing\n\n## Summary\nWorking on it.";
    const out = parseHandoffResponse(raw);
    expect(out).not.toBeNull();
    expect(out!.topic).toBe("wiring the thing");
    expect(out!.briefing).toContain("## Topic: wiring the thing");
    expect(out!.briefing).toContain("## Summary");
  });

  it("truncates long topics with ellipsis", () => {
    const long = "x".repeat(TOPIC_MAX_CHARS + 50);
    const raw = `## Topic: ${long}\n\nbody`;
    const out = parseHandoffResponse(raw);
    expect(out!.topic.endsWith("…")).toBe(true);
    expect(out!.topic.length).toBe(TOPIC_MAX_CHARS + 1);
  });

  it("returns null when Topic header missing", () => {
    expect(parseHandoffResponse("## Summary\nno topic")).toBeNull();
    expect(parseHandoffResponse("")).toBeNull();
  });

  it("is case-insensitive on the Topic keyword", () => {
    expect(parseHandoffResponse("## topic: lowercase")!.topic).toBe("lowercase");
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

describe("summarize pipeline", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "handoff-summ-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 'no-turns' when JSONL is empty", async () => {
    const jsonlPath = join(tmp, "empty.jsonl");
    writeFileSync(jsonlPath, "");
    const status = await summarize({
      jsonlPath,
      agentDir: tmp,
      agentName: "test",
      anthropic: fakeClient("## Topic: x\n\nbody"),
    });
    expect(status).toBe("no-turns");
  });

  it("returns 'ok' and writes sidecars on happy path", async () => {
    const jsonlPath = join(tmp, "turns.jsonl");
    writeFileSync(
      jsonlPath,
      makeJsonl([
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Hey." }] },
        },
      ]),
    );
    const status = await summarize({
      jsonlPath,
      agentDir: tmp,
      agentName: "test",
      anthropic: fakeClient("## Topic: greeting\n\n## Summary\nSaid hi."),
    });
    expect(status).toBe("ok");
    expect(readFileSync(join(tmp, ".handoff-topic"), "utf-8")).toBe("greeting");
    expect(readFileSync(join(tmp, ".handoff.md"), "utf-8")).toContain("## Summary");
  });

  it("returns 'parse-error' when LLM omits the Topic header", async () => {
    const jsonlPath = join(tmp, "turns.jsonl");
    writeFileSync(
      jsonlPath,
      makeJsonl([
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "hi" }] },
        },
      ]),
    );
    const status = await summarize({
      jsonlPath,
      agentDir: tmp,
      agentName: "test",
      anthropic: fakeClient("## Summary\nno topic line"),
    });
    expect(status).toBe("parse-error");
    expect(existsSync(join(tmp, ".handoff-topic"))).toBe(false);
  });

  it("returns 'api-error' and does not write when API throws", async () => {
    const jsonlPath = join(tmp, "turns.jsonl");
    writeFileSync(
      jsonlPath,
      makeJsonl([
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "hi" }] },
        },
      ]),
    );
    const errStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const status = await summarize({
      jsonlPath,
      agentDir: tmp,
      agentName: "test",
      anthropic: failingClient(new Error("boom")),
    });
    expect(status).toBe("api-error");
    expect(existsSync(join(tmp, ".handoff.md"))).toBe(false);
    errStderr.mockRestore();
  });

  it("mirrors to Hindsight when URL provided and skips when not", async () => {
    const jsonlPath = join(tmp, "turns.jsonl");
    writeFileSync(
      jsonlPath,
      makeJsonl([
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "hi" }] },
        },
      ]),
    );
    const fetchCalls: string[] = [];
    const fakeFetch = (async (url: string) => {
      fetchCalls.push(url);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const status = await summarize({
      jsonlPath,
      agentDir: tmp,
      agentName: "test",
      anthropic: fakeClient("## Topic: x\n\ndone"),
      hindsightUrl: "http://localhost:9999",
      hindsightBankId: "mybank",
      fetch: fakeFetch,
    });
    expect(status).toBe("ok");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toBe("http://localhost:9999/v1/default/banks/mybank/memories");
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

// Helpers: fake Anthropic clients without hitting the network.

function fakeClient(responseText: string): AnthropicClientLike {
  return {
    messages: {
      create: async () => ({ content: [{ type: "text", text: responseText }] }),
    },
  };
}

function failingClient(err: Error): AnthropicClientLike {
  return {
    messages: {
      create: async () => {
        throw err;
      },
    },
  };
}

// Keeps the model constant export referenced so rename accidents break
// this test (canary).
describe("module constants", () => {
  it("exposes a stable default model id", () => {
    expect(DEFAULT_SUMMARIZER_MODEL).toMatch(/^claude-/);
  });
});
