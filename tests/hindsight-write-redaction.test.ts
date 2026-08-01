/**
 * Outcome tests for secret redaction on the TypeScript Hindsight WRITE paths.
 *
 * A credential that reaches a memory bank is effectively permanent — it is
 * recalled into later sessions, folded into mental models, and copied into
 * consolidations, so it outlives its own rotation. These tests assert on the
 * BYTES THAT LEAVE THE PROCESS for each write path, not on "the redactor was
 * called": a test of the latter shape would still pass if redaction were a
 * no-op.
 *
 * Two paths are covered here (the third, the Python plugin retain, is
 * pinned by vendor/hindsight-memory/scripts/tests/test_secret_redact.py).
 * The session-handoff mirror is gone entirely: buildHandoff no longer writes
 * to Hindsight at all (memory-poisoning fix — see
 * src/agents/handoff-summarizer.ts and handoff-summarizer.test.ts):
 *
 *   1. `redactMemoryWriteBody` itself   — the shared REST helper
 *   2. the MCP shim's tools/call seam   — src/cli/hindsight-mcp-shim.ts
 *
 * Every credential-shaped literal below is synthetic and assembled at runtime
 * so nothing token-shaped is committed to the repo.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  redactMemoryWriteBody,
  redactJsonStrings,
} from "../src/memory/hindsight-write-redaction.js";
import {
  HindsightShim,
  READ_ONLY_TOOL_NAMES,
  redactToolCallParams,
} from "../src/cli/hindsight-mcp-shim.js";

/** Synthetic DSN. Assembled at runtime — never a literal in the source. */
function pgDsn(password: string): string {
  return "postgres://appuser:" + password + "@db.internal:5432/prod";
}

const DB_PASSWORD = "Hunter" + "Two99";
const WIFI_PASSWORD = "Fluffy" + "Barnaby" + "1998";

describe("redactMemoryWriteBody", () => {
  it("masks a connection-string password in item content", () => {
    const out = redactMemoryWriteBody({
      items: [{ content: "dsn " + pgDsn(DB_PASSWORD) }],
    });
    const wire = JSON.stringify(out);
    expect(wire).not.toContain(DB_PASSWORD);
    expect(wire).toContain("[REDACTED:db_uri_password]");
  });

  it("masks context and every string leaf of metadata", () => {
    const out = redactMemoryWriteBody({
      items: [
        {
          content: "ordinary text",
          context: "password: " + WIFI_PASSWORD,
          metadata: {
            note: "password: " + WIFI_PASSWORD,
            nested: { deeper: ["password: " + WIFI_PASSWORD] },
            count: 7,
          },
        },
      ],
    });
    const wire = JSON.stringify(out);
    expect(wire).not.toContain(WIFI_PASSWORD);
    // Non-string leaves survive untouched.
    expect(
      (out.items[0].metadata as { count: number }).count,
    ).toBe(7);
  });

  it("leaves structural fields byte-identical", () => {
    // Reconciliation and watermark logic match on these; masking them would
    // change behaviour, not just text.
    const out = redactMemoryWriteBody({
      items: [
        {
          content: "dsn " + pgDsn(DB_PASSWORD),
          document_id: "session_handoff",
          tags: ["session_handoff", "klanker"],
          observation_scopes: ["self"],
        },
      ],
      async: true,
    });
    expect(out.items[0].document_id).toBe("session_handoff");
    expect(out.items[0].tags).toEqual(["session_handoff", "klanker"]);
    expect(out.items[0].observation_scopes).toEqual(["self"]);
    expect(out.async).toBe(true);
  });

  it("still writes a row whose content is entirely credential", () => {
    // Dropping the write would silently break the durability contract the
    // callers rely on (watermark advance). A row saying a
    // secret was here beats a missing row.
    const out = redactMemoryWriteBody({ items: [{ content: pgDsn(DB_PASSWORD) }] });
    expect(out.items).toHaveLength(1);
    expect(out.items[0].content).toContain("[REDACTED");
    expect(out.items[0].content).not.toContain(DB_PASSWORD);
  });

  it("passes through bodies it does not understand rather than throwing", () => {
    expect(redactMemoryWriteBody(null)).toBeNull();
    expect(redactMemoryWriteBody({ nope: 1 })).toEqual({ nope: 1 });
    expect(redactMemoryWriteBody({ items: "not-an-array" })).toEqual({
      items: "not-an-array",
    });
    expect(redactMemoryWriteBody({ items: [null, 3] })).toEqual({
      items: [null, 3],
    });
  });

  it("never rewrites object KEYS", () => {
    const out = redactJsonStrings({ "password: SparrowKettle31": "value" });
    expect(Object.keys(out as object)).toEqual(["password: SparrowKettle31"]);
  });
});

// ─── MCP shim seam ────────────────────────────────────────────────────────

interface BodyRecordingBackend {
  url: string;
  server: Server;
  bodies: string[];
  close: () => Promise<void>;
}

/** Mock Streamable HTTP MCP backend that records raw request bodies. */
async function startRecordingBackend(): Promise<BodyRecordingBackend> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      const msg = JSON.parse(body) as { id?: number; method?: string };
      const reply = (result: unknown) => {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "sess-1",
        });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      if (msg.method === "initialize") {
        reply({
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "mock", version: "0" },
        });
        return;
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      reply({ content: [{ type: "text", text: "ok" }], isError: false });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/mcp/`,
    server,
    bodies,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

describe("hindsight MCP shim tools/call redaction", () => {
  let backend: BodyRecordingBackend | undefined;
  let cacheDir: string | undefined;
  afterEach(async () => {
    await backend?.close();
    backend = undefined;
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
    cacheDir = undefined;
  });

  const makeShim = (url: string) => {
    cacheDir = mkdtempSync(join(tmpdir(), "hindsight-redact-test-"));
    return new HindsightShim({
      url,
      bankId: "test-bank",
      cacheDir,
      toolsListTimeoutMs: 500,
      toolsCallTimeoutMs: 2000,
      connectTimeoutMs: 500,
      logger: () => undefined,
    });
  };

  it("does not forward a credential in a retain call", async () => {
    backend = await startRecordingBackend();
    const shim = makeShim(backend.url);
    await shim.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "retain",
        arguments: { content: "the wifi password is " + WIFI_PASSWORD },
      },
    } as never);
    const wire = backend.bodies.join("\n");
    expect(wire).toContain("tools/call");
    expect(wire).not.toContain(WIFI_PASSWORD);
    expect(wire).toContain("[REDACTED:memorable_password]");
  });

  it("redacts an UNKNOWN tool by default (fail-closed)", async () => {
    // The seam allowlists READS, not writes — so a write tool the backend
    // adds tomorrow is covered on the day it appears, with no change here.
    backend = await startRecordingBackend();
    const shim = makeShim(backend.url);
    expect(READ_ONLY_TOOL_NAMES.has("some_future_write_tool")).toBe(false);
    await shim.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "some_future_write_tool",
        arguments: { text: "dsn " + pgDsn(DB_PASSWORD) },
      },
    } as never);
    expect(backend.bodies.join("\n")).not.toContain(DB_PASSWORD);
  });

  it("forwards a recall query verbatim", async () => {
    // recall is a READ. Rewriting the query would silently change which
    // memories come back, for no security gain — nothing is persisted.
    backend = await startRecordingBackend();
    const shim = makeShim(backend.url);
    const query = "what was the " + pgDsn(DB_PASSWORD) + " dsn";
    await shim.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "recall", arguments: { query } },
    } as never);
    expect(backend.bodies.join("\n")).toContain(DB_PASSWORD);
  });

  it("redactToolCallParams leaves the tool name and shape intact", () => {
    const out = redactToolCallParams({
      name: "retain",
      arguments: { content: "password: " + WIFI_PASSWORD, importance: 5 },
    }) as { name: string; arguments: { content: string; importance: number } };
    expect(out.name).toBe("retain");
    expect(out.arguments.importance).toBe(5);
    expect(out.arguments.content).not.toContain(WIFI_PASSWORD);
  });

  it("redactToolCallParams tolerates missing arguments", () => {
    expect(redactToolCallParams(undefined)).toBeUndefined();
    expect(redactToolCallParams({ name: "retain" })).toEqual({ name: "retain" });
  });
});
