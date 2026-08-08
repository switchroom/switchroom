/**
 * Outcome tests for the lazy-connect Hindsight stdio MCP shim
 * (src/cli/hindsight-mcp-shim.ts):
 *
 *   1. stdio initialize handshake succeeds with the backend DOWN
 *   2. tools/list is served from the disk cache with the backend down
 *   3. tools/list falls back to the static manifest on first boot (no cache)
 *   4. tools/call returns an isError tool result (not a crash) when down
 *   5. calls pass through to a live (mock) backend, including the lazy
 *      Streamable HTTP session handshake + X-Bank-Id header
 *   6. a successful live tools/list refreshes the disk cache
 *   7. recovery: after a down-backend isError, the SAME shim instance
 *      succeeds once the backend comes up (per-call reconnect)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HindsightShim,
  buildFallbackToolsList,
  FALLBACK_TOOL_TABLE,
  TOOLS_CACHE_FILENAME,
  SHIM_SUPPORTED_PROTOCOL_VERSIONS,
  SYNTHESIZED_TOOL_NAMES,
  SYNTHESIZED_TOOL_TABLE,
  coerceSynthesizedArg,
  guardAndClampToolCall,
  DEFAULT_RECALL_MAX_TOKENS,
  DEFAULT_RECALL_BUDGET,
  DEFAULT_REFLECT_BUDGET,
  isReflectToolCallFailure,
  REFLECT_TOOL_CALL_RETRIES,
  REFLECT_NO_TOOL_CALL_SIGNATURE,
  type ShimOptions,
} from "../src/cli/hindsight-mcp-shim.js";

// ─── helpers ──────────────────────────────────────────────────────────────

/** A 127.0.0.1 URL where nothing listens (bind :0, close, reuse port). */
async function deadUrl(): Promise<string> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return `http://127.0.0.1:${port}/mcp/`;
}

interface MockBackend {
  url: string;
  server: Server;
  /** Every JSON-RPC request body received, in order. */
  requests: {
    method?: string;
    headers: Record<string, unknown>;
    params?: { name?: string; arguments?: unknown };
  }[];
  close: () => Promise<void>;
}

/**
 * Minimal Streamable HTTP MCP backend: answers initialize (issuing a
 * session id), accepts notifications, and serves tools/list + tools/call.
 */
async function startMockBackend(
  opts: {
    tools?: { name: string; inputSchema: unknown }[];
    sse?: boolean;
    /** Never answer tools/call — request is DELIVERED but hangs (slow backend). */
    hangToolsCall?: boolean;
    /**
     * Override the tools/call answer per attempt. `callIndex` is 1-based over
     * tools/call requests only. Return undefined to fall through to the
     * default success payload.
     */
    onToolsCall?: (
      callIndex: number,
      name?: string,
    ) => { result?: unknown; error?: unknown } | undefined;
  } = {},
): Promise<MockBackend> {
  const tools = opts.tools ?? [
    { name: "recall", inputSchema: { type: "object" } },
    { name: "retain", inputSchema: { type: "object" } },
  ];
  const requests: MockBackend["requests"] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body) as {
        id?: number;
        method?: string;
        params?: { name?: string; arguments?: unknown };
      };
      requests.push({
        method: msg.method,
        headers: { ...req.headers },
        params: msg.params,
      });
      const reply = (result: unknown) => {
        const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
        if (opts.sse) {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "mcp-session-id": "sess-1",
          });
          res.end(`event: message\ndata: ${payload}\n\n`);
        } else {
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": "sess-1",
          });
          res.end(payload);
        }
      };
      switch (msg.method) {
        case "initialize":
          reply({
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "mock-hindsight", version: "0.8.4" },
          });
          return;
        case "notifications/initialized":
          res.writeHead(202).end();
          return;
        case "tools/list":
          reply({ tools });
          return;
        case "tools/call": {
          if (opts.hangToolsCall) return; // delivered, never answered
          const callIndex = requests.filter(
            (r) => r.method === "tools/call",
          ).length;
          const custom = opts.onToolsCall?.(callIndex, msg.params?.name);
          if (custom) {
            res.writeHead(200, {
              "content-type": "application/json",
              "mcp-session-id": "sess-1",
            });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...custom }));
            return;
          }
          reply({
            content: [
              { type: "text", text: `called:${msg.params?.name}` },
            ],
            isError: false,
          });
          return;
        }
        default:
          reply({});
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/mcp/`,
    server,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function makeShim(overrides: Partial<ShimOptions> & { url: string; cacheDir: string }): HindsightShim {
  return new HindsightShim({
    bankId: "test-bank",
    toolsListTimeoutMs: 500,
    toolsCallTimeoutMs: 1000,
    connectTimeoutMs: 500,
    logger: () => undefined,
    ...overrides,
  });
}

const rpc = (id: number, method: string, params?: unknown) =>
  ({ jsonrpc: "2.0" as const, id, method, params });

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "hindsight-shim-test-"));
});
afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

// ─── 1. handshake never depends on the backend ────────────────────────────

describe("initialize handshake", () => {
  it("succeeds immediately with the backend down", async () => {
    const shim = makeShim({ url: await deadUrl(), cacheDir });
    const res = await shim.handle(
      rpc(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "claude-code", version: "2.x" },
      }) as never,
    );
    expect(res?.error).toBeUndefined();
    const result = res?.result as {
      protocolVersion: string;
      capabilities: { tools: unknown };
      serverInfo: { name: string };
    };
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe("switchroom-hindsight-shim");
  });

  it("negotiates down to our newest version for unknown client versions", async () => {
    const shim = makeShim({ url: await deadUrl(), cacheDir });
    const res = await shim.handle(
      rpc(1, "initialize", { protocolVersion: "2099-01-01" }) as never,
    );
    expect((res?.result as { protocolVersion: string }).protocolVersion).toBe(
      SHIM_SUPPORTED_PROTOCOL_VERSIONS[0],
    );
  });

  it("answers ping locally with backend down (keepalive can't kill the session)", async () => {
    const shim = makeShim({ url: await deadUrl(), cacheDir });
    const res = await shim.handle(rpc(2, "ping") as never);
    expect(res?.error).toBeUndefined();
    expect(res?.result).toEqual({});
  });
});

// ─── 2+3. tools/list resilience ───────────────────────────────────────────

describe("tools/list with backend down", () => {
  it("serves the persisted cache when one exists", async () => {
    const cached = {
      tools: [
        { name: "recall", description: "cached", inputSchema: { type: "object" } },
      ],
    };
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, TOOLS_CACHE_FILENAME), JSON.stringify(cached));
    const shim = makeShim({ url: await deadUrl(), cacheDir });

    const res = await shim.handle(rpc(3, "tools/list") as never);
    expect(res?.error).toBeUndefined();
    // The cached BACKEND manifest is served verbatim; the shim-synthesized
    // directive tools ride on top. They don't depend on the backend at all, so
    // an agent must not lose the retirement path just because memory is down.
    const { tools } = res?.result as { tools: { name: string }[] };
    expect(tools.map((t) => t.name)).toEqual([
      "recall",
      ...SYNTHESIZED_TOOL_NAMES,
    ]);
    expect(tools[0]).toEqual(cached.tools[0]);
  });

  it("serves the static fallback manifest on first boot (no cache)", async () => {
    const shim = makeShim({ url: await deadUrl(), cacheDir });
    const res = await shim.handle(rpc(3, "tools/list") as never);
    expect(res?.error).toBeUndefined();
    const { tools } = res?.result as { tools: { name: string }[] };
    const names = tools.map((t) => t.name);
    // The load-bearing memory surface must exist at session start.
    for (const required of ["recall", "retain", "sync_retain", "reflect", "create_directive"]) {
      expect(names).toContain(required);
    }
    for (const synthesized of SYNTHESIZED_TOOL_NAMES) {
      expect(names).toContain(synthesized);
    }
    expect(tools.length).toBe(
      Object.keys(FALLBACK_TOOL_TABLE).length + SYNTHESIZED_TOOL_NAMES.length,
    );
  });
});

// ─── 4. tools/call error result, never a crash ────────────────────────────

describe("tools/call with backend down", () => {
  it("returns isError:true with a temporarily-unavailable message", async () => {
    const shim = makeShim({ url: await deadUrl(), cacheDir });
    const res = await shim.handle(
      rpc(4, "tools/call", { name: "recall", arguments: { query: "x" } }) as never,
    );
    expect(res?.error).toBeUndefined(); // tool ERROR RESULT, not protocol error
    const result = res?.result as {
      isError: boolean;
      content: { type: string; text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/temporarily unavailable/i);
  });
});

// ─── 5+6. pass-through against a live mock backend ────────────────────────

describe("with the backend up", () => {
  let backend: MockBackend;
  afterEach(async () => {
    await backend.close();
  });

  it("lazily handshakes upstream and passes tools/call through", async () => {
    backend = await startMockBackend();
    const shim = makeShim({ url: backend.url, cacheDir });

    // Client-side handshake first (local, no upstream traffic yet).
    await shim.handle(rpc(1, "initialize", { protocolVersion: "2025-06-18" }) as never);
    expect(backend.requests.length).toBe(0);

    const res = await shim.handle(
      rpc(2, "tools/call", { name: "recall", arguments: { query: "x" } }) as never,
    );
    const result = res?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe("called:recall");

    // Upstream saw a full lazy handshake then the call, with the bank header.
    expect(backend.requests.map((r) => r.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(backend.requests[2].headers["x-bank-id"]).toBe("test-bank");
    expect(backend.requests[2].headers["mcp-session-id"]).toBe("sess-1");
  });

  it("parses SSE-framed backend responses", async () => {
    backend = await startMockBackend({ sse: true });
    const shim = makeShim({ url: backend.url, cacheDir });
    const res = await shim.handle(
      rpc(2, "tools/call", { name: "retain", arguments: {} }) as never,
    );
    expect((res?.result as { content: { text: string }[] }).content[0].text).toBe(
      "called:retain",
    );
  });

  it("refreshes the disk cache from a live tools/list (stale cache replaced)", async () => {
    // Seed a stale cache the live result must overwrite.
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, TOOLS_CACHE_FILENAME),
      JSON.stringify({ tools: [{ name: "stale_tool", inputSchema: {} }] }),
    );
    backend = await startMockBackend({
      tools: [{ name: "fresh_tool", inputSchema: { type: "object" } }],
    });
    const shim = makeShim({ url: backend.url, cacheDir });

    const res = await shim.handle(rpc(5, "tools/list") as never);
    const { tools } = res?.result as { tools: { name: string }[] };
    expect(tools.map((t) => t.name)).toEqual([
      "fresh_tool",
      ...SYNTHESIZED_TOOL_NAMES,
    ]);

    // The CACHE is a record of upstream truth only — the synthesized tools are
    // layered on at serve time, never baked into the file, so a later shim
    // version that retires them can't be haunted by a stale cache.
    const persisted = JSON.parse(
      readFileSync(join(cacheDir, TOOLS_CACHE_FILENAME), "utf-8"),
    ) as { tools: { name: string }[] };
    expect(persisted.tools.map((t) => t.name)).toEqual(["fresh_tool"]);
  });

  it("recovers per-call: isError while down, real result after the backend comes up", async () => {
    // Reserve a port, keep it dead for the first call...
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const url = `http://127.0.0.1:${port}/mcp/`;

    const shim = makeShim({ url, cacheDir });
    const down = await shim.handle(
      rpc(1, "tools/call", { name: "recall", arguments: {} }) as never,
    );
    expect((down?.result as { isError: boolean }).isError).toBe(true);

    // ...then bring a backend up on THAT port and reuse the same shim.
    backend = await startMockBackend();
    const liveServer = backend.server;
    await new Promise<void>((r) => liveServer.close(() => r()));
    await new Promise<void>((resolve, reject) => {
      liveServer.once("error", reject);
      liveServer.listen(port, "127.0.0.1", resolve);
    });
    backend.url = url;

    const up = await shim.handle(
      rpc(2, "tools/call", { name: "recall", arguments: {} }) as never,
    );
    const result = up?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe("called:recall");
  });
});

// ─── review #3313 must-fix 1: no post-delivery re-send ────────────────────

describe("double-execution guard", () => {
  let backend: MockBackend;
  afterEach(async () => {
    await backend.close();
  });

  it("a delivered-then-timed-out tools/call is NOT re-sent to the backend", async () => {
    backend = await startMockBackend({ hangToolsCall: true });
    const shim = makeShim({ url: backend.url, cacheDir, toolsCallTimeoutMs: 300 });

    const res = await shim.handle(
      rpc(1, "tools/call", { name: "retain", arguments: { content: "x" } }) as never,
    );
    // Outcome 1: the caller gets a clean isError result, not a crash.
    expect((res?.result as { isError: boolean }).isError).toBe(true);
    // Outcome 2: the backend received the non-idempotent call EXACTLY once
    // (blind retry-after-abort would show 2 → duplicate retain).
    const callPosts = backend.requests.filter((r) => r.method === "tools/call");
    expect(callPosts.length).toBe(1);
  });

  it("still retries pre-delivery failures (classification unit)", async () => {
    backend = await startMockBackend();
    const { isPreDeliveryError } = await import("../src/cli/hindsight-mcp-shim.js");
    const refused = new TypeError("fetch failed");
    (refused as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    expect(isPreDeliveryError(refused)).toBe(true);
    const abort = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    expect(isPreDeliveryError(abort)).toBe(false);
    expect(isPreDeliveryError(new Error("mid-response parse failure"))).toBe(false);
  });
});

// ─── review #3313 must-fix 2: no head-of-line blocking ────────────────────

describe("concurrent handling", () => {
  let backend: MockBackend;
  afterEach(async () => {
    await backend.close();
  });

  it("a hung tools/call does not block a concurrent ping", async () => {
    const { PassThrough } = await import("node:stream");
    backend = await startMockBackend({ hangToolsCall: true });
    const shim = makeShim({ url: backend.url, cacheDir, toolsCallTimeoutMs: 1500 });

    const input = new PassThrough();
    const output = new PassThrough();
    const lines: { id?: number; result?: unknown }[] = [];
    let buf = "";
    output.on("data", (c) => {
      buf += c.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
    });
    const done = shim.run(input, output);

    input.write(JSON.stringify(rpc(1, "tools/call", { name: "recall", arguments: {} })) + "\n");
    input.write(JSON.stringify(rpc(2, "ping")) + "\n");

    // The ping must answer while the tools/call is still pending — not
    // queued behind its 1.5s timeout.
    const start = Date.now();
    while (lines.length === 0 && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(lines.length).toBe(1);
    expect(lines[0].id).toBe(2); // ping answered FIRST
    expect(Date.now() - start).toBeLessThan(1000);

    input.end();
    await done; // drain still waits for the hung call's isError flush
    expect(lines.length).toBe(2);
    expect(lines[1].id).toBe(1);
    expect((lines[1].result as { isError: boolean }).isError).toBe(true);
  });
});

// ─── review #3313 finding 3: honest listChanged ───────────────────────────

describe("tools/list_changed on recovery", () => {
  it("emits the notification after fallback-served manifest and backend recovery", async () => {
    // Reserve a port, keep it dead for tools/list...
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const url = `http://127.0.0.1:${port}/mcp/`;

    const shim = makeShim({ url, cacheDir });
    const notifications: { method?: string }[] = [];
    shim.notificationSink = (m) => notifications.push(m as { method?: string });

    const list = await shim.handle(rpc(1, "tools/list") as never);
    expect((list?.result as { tools: unknown[] }).tools.length).toBeGreaterThan(0);
    expect(notifications.length).toBe(0); // still down — nothing to announce

    // ...bring the backend up on that port; next successful call announces
    // that the client's stale manifest should be re-listed.
    const backend = await startMockBackend();
    const liveServer = backend.server;
    await new Promise<void>((r) => liveServer.close(() => r()));
    await new Promise<void>((resolve, reject) => {
      liveServer.once("error", reject);
      liveServer.listen(port, "127.0.0.1", resolve);
    });
    try {
      await shim.handle(rpc(2, "tools/call", { name: "recall", arguments: {} }) as never);
      expect(notifications.map((n) => n.method)).toEqual([
        "notifications/tools/list_changed",
      ]);
      // One-shot: a second successful call does not re-announce.
      await shim.handle(rpc(3, "tools/call", { name: "recall", arguments: {} }) as never);
      expect(notifications.length).toBe(1);
    } finally {
      await new Promise<void>((r) => liveServer.close(() => r()));
    }
  });
});

// ─── stdio wiring ─────────────────────────────────────────────────────────

describe("run() stdio loop", () => {
  it("flushes every pending response before resolving on input end (backend down)", async () => {
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough();
    const output = new PassThrough();
    const shim = makeShim({ url: await deadUrl(), cacheDir });

    const done = shim.run(input, output);
    input.write(
      JSON.stringify(rpc(1, "initialize", { protocolVersion: "2025-06-18" })) + "\n",
    );
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    input.write(JSON.stringify(rpc(2, "tools/list")) + "\n");
    input.end(); // Claude Code teardown — must NOT drop the tools/list reply
    await done;

    const lines = output.read()?.toString().trim().split("\n") ?? [];
    expect(lines.length).toBe(2);
    const [init, list] = lines.map((l: string) => JSON.parse(l));
    expect(init.id).toBe(1);
    expect(init.result.serverInfo.name).toBe("switchroom-hindsight-shim");
    expect(list.id).toBe(2);
    expect(list.result.tools.length).toBeGreaterThan(0);
  });
});

// ─── fallback manifest drift guard ────────────────────────────────────────

describe("static fallback manifest", () => {
  it("stays in lockstep with the captured hindsight tools/list snapshot", () => {
    const snapshot = JSON.parse(
      readFileSync(
        join(__dirname, "fixtures", "hindsight-tools-list.snapshot.json"),
        "utf-8",
      ),
    ) as { tools: Record<string, { required: string[]; props: string[] }> };
    const fromSnapshot = Object.fromEntries(
      Object.entries(snapshot.tools).map(([name, t]) => [
        name,
        [t.required ?? [], t.props ?? []],
      ]),
    );
    expect(FALLBACK_TOOL_TABLE).toEqual(fromSnapshot);
  });

  it("materializes valid MCP tool defs (object schemas with required lists)", () => {
    const { tools } = buildFallbackToolsList();
    for (const tool of tools) {
      const schema = tool.inputSchema as {
        type: string;
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(schema.type).toBe("object");
      for (const req of schema.required) {
        expect(Object.keys(schema.properties)).toContain(req);
      }
    }
  });
});

// ─── recall/reflect budget clamp + loud unknown-arg rejection ──────────────
//
// Two engine holes the shim closes (both live-reproduced): the engine's fat
// MCP defaults (budget:high + max_tokens:4096 → ~53 facts / ~80KB, over the
// MCP output cap so it never lands) and its NON-enforcement of
// additionalProperties:false (an unknown arg like `limit` is dropped silently
// with isError:false, so the agent thinks it capped results when it did not).

describe("guardAndClampToolCall (unit)", () => {
  it("rejects recall's nonexistent 'limit' loudly, naming limit AND max_tokens", () => {
    // On origin/main there is no guard: the arg is forwarded and the engine
    // silently drops it. This asserts the loud, self-correcting replacement.
    const res = guardAndClampToolCall(
      { name: "recall", arguments: { query: "x", limit: 6 } },
      {},
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected rejection");
    expect(res.text).toContain("limit");
    expect(res.text).toContain("max_tokens");
    expect(res.text.toLowerCase()).toContain("budget");
  });

  it("injects max_tokens + budget:low into a bare recall (caller omitted both)", () => {
    const res = guardAndClampToolCall(
      { name: "recall", arguments: { query: "x" } },
      {},
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unexpected rejection");
    const args = (res.params as { arguments: Record<string, unknown> }).arguments;
    expect(args.max_tokens).toBe(DEFAULT_RECALL_MAX_TOKENS);
    expect(args.max_tokens).toBe(1024);
    expect(args.budget).toBe("low");
    expect(args.query).toBe("x"); // caller arg preserved
  });

  it("leaves an explicit max_tokens:4096 UNTOUCHED (caller always wins)", () => {
    const res = guardAndClampToolCall(
      { name: "recall", arguments: { query: "x", max_tokens: 4096 } },
      {},
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unexpected rejection");
    const args = (res.params as { arguments: Record<string, unknown> }).arguments;
    expect(args.max_tokens).toBe(4096);
  });

  it("leaves an explicit budget UNTOUCHED (caller always wins)", () => {
    const res = guardAndClampToolCall(
      { name: "recall", arguments: { query: "x", budget: "high" } },
      {},
    );
    if (!res.ok) throw new Error("unexpected rejection");
    const args = (res.params as { arguments: Record<string, unknown> }).arguments;
    expect(args.budget).toBe("high");
    expect(args.max_tokens).toBe(1024); // the omitted one is still clamped
  });

  it("clamps reflect's max_tokens the same way, but injects budget:mid", () => {
    // The shipped fleet default: reflect budget defaults to "mid" (recall
    // stays "low"). On origin/main both defaulted to "low" — this FAILS there.
    const res = guardAndClampToolCall(
      { name: "reflect", arguments: { query: "x" } },
      {},
    );
    if (!res.ok) throw new Error("unexpected rejection");
    const args = (res.params as { arguments: Record<string, unknown> }).arguments;
    expect(args.max_tokens).toBe(1024);
    expect(args.budget).toBe("mid");
  });

  it("injects reflect budget:mid but recall budget:low when omitted", () => {
    expect(DEFAULT_REFLECT_BUDGET).toBe("mid");
    expect(DEFAULT_RECALL_BUDGET).toBe("low");
    const reflect = guardAndClampToolCall(
      { name: "reflect", arguments: { query: "x" } },
      {},
    );
    const recall = guardAndClampToolCall(
      { name: "recall", arguments: { query: "x" } },
      {},
    );
    if (!reflect.ok || !recall.ok) throw new Error("unexpected rejection");
    const rArgs = (reflect.params as { arguments: Record<string, unknown> }).arguments;
    const cArgs = (recall.params as { arguments: Record<string, unknown> }).arguments;
    expect(rArgs.budget).toBe("mid");
    expect(cArgs.budget).toBe("low");
  });

  it("honors HINDSIGHT_SHIM_REFLECT_BUDGET override (low and high)", () => {
    const low = guardAndClampToolCall(
      { name: "reflect", arguments: { query: "x" } },
      { HINDSIGHT_SHIM_REFLECT_BUDGET: "low" },
    );
    const high = guardAndClampToolCall(
      { name: "reflect", arguments: { query: "x" } },
      { HINDSIGHT_SHIM_REFLECT_BUDGET: "high" },
    );
    if (!low.ok || !high.ok) throw new Error("unexpected rejection");
    expect((low.params as { arguments: Record<string, unknown> }).arguments.budget).toBe("low");
    expect((high.params as { arguments: Record<string, unknown> }).arguments.budget).toBe("high");
  });

  it("falls back to reflect default mid on a garbage budget env value", () => {
    const res = guardAndClampToolCall(
      { name: "reflect", arguments: { query: "x" } },
      { HINDSIGHT_SHIM_REFLECT_BUDGET: "turbo" },
    );
    if (!res.ok) throw new Error("unexpected rejection");
    const args = (res.params as { arguments: Record<string, unknown> }).arguments;
    expect(args.budget).toBe("mid");
  });

  it("leaves an explicit reflect budget UNTOUCHED even with an env override set", () => {
    const res = guardAndClampToolCall(
      { name: "reflect", arguments: { query: "x", budget: "low" } },
      { HINDSIGHT_SHIM_REFLECT_BUDGET: "high" },
    );
    if (!res.ok) throw new Error("unexpected rejection");
    const args = (res.params as { arguments: Record<string, unknown> }).arguments;
    expect(args.budget).toBe("low");
  });

  it("injects reflect budget:mid + max_tokens:1024 when arguments is undefined", () => {
    const res = guardAndClampToolCall({ name: "reflect" }, {});
    if (!res.ok) throw new Error("unexpected rejection");
    const args = (res.params as { arguments: Record<string, unknown> }).arguments;
    expect(args.budget).toBe("mid");
    expect(args.max_tokens).toBe(1024);
  });

  it("honors the env override for the injected recall max_tokens", () => {
    const res = guardAndClampToolCall(
      { name: "recall", arguments: { query: "x" } },
      { HINDSIGHT_SHIM_RECALL_MAX_TOKENS: "600" },
    );
    if (!res.ok) throw new Error("unexpected rejection");
    const args = (res.params as { arguments: Record<string, unknown> }).arguments;
    expect(args.max_tokens).toBe(600);
  });

  it("honors the env override for the injected reflect max_tokens", () => {
    const res = guardAndClampToolCall(
      { name: "reflect", arguments: { query: "x" } },
      { HINDSIGHT_SHIM_REFLECT_MAX_TOKENS: "2048" },
    );
    if (!res.ok) throw new Error("unexpected rejection");
    const args = (res.params as { arguments: Record<string, unknown> }).arguments;
    expect(args.max_tokens).toBe(2048);
  });

  it("does NOT clamp non-recall/reflect tools (retain passes through)", () => {
    const res = guardAndClampToolCall(
      { name: "retain", arguments: { content: "hi" } },
      {},
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unexpected rejection");
    const args = (res.params as { arguments: Record<string, unknown> }).arguments;
    expect(args.max_tokens).toBeUndefined();
    expect(args.budget).toBeUndefined();
  });

  it("passes through tools with no pinned table entry unvalidated", () => {
    const res = guardAndClampToolCall(
      { name: "search", arguments: { anything: 1 } },
      {},
    );
    expect(res.ok).toBe(true); // 'search' is not in FALLBACK_TOOL_TABLE
  });

  // Constraint (d): the accepted-prop list is DERIVED from FALLBACK_TOOL_TABLE
  // (the single pinned source), not a parallel hand-written list. Proven by
  // driving the guard off the table entry itself — so the existing contract
  // fixture pin (FALLBACK_TOOL_TABLE ≡ snapshot) already guards call-time
  // validation against drift, in both directions.
  it("accepts EVERY prop the table declares for recall, and only those", () => {
    const [required, optional] = FALLBACK_TOOL_TABLE.recall;
    for (const prop of [...required, ...optional]) {
      const res = guardAndClampToolCall(
        { name: "recall", arguments: { query: "x", [prop]: "v" } },
        {},
      );
      expect(res.ok, `recall.${prop} should be accepted`).toBe(true);
    }
    // A prop NOT in the table is rejected.
    const bogus = guardAndClampToolCall(
      { name: "recall", arguments: { query: "x", not_a_real_prop: 1 } },
      {},
    );
    expect(bogus.ok).toBe(false);
  });
});

describe("tools/call clamp + rejection through the live shim", () => {
  let backend: MockBackend;
  afterEach(async () => {
    await backend.close();
  });

  it("a bare recall forwards max_tokens:1024 + budget:low to the backend", async () => {
    backend = await startMockBackend();
    const shim = makeShim({ url: backend.url, cacheDir });
    await shim.handle(rpc(1, "initialize", { protocolVersion: "2025-06-18" }) as never);

    await shim.handle(
      rpc(2, "tools/call", { name: "recall", arguments: { query: "x" } }) as never,
    );
    const call = backend.requests.find((r) => r.method === "tools/call");
    expect(call).toBeDefined();
    const args = call?.params?.arguments as Record<string, unknown>;
    expect(args.max_tokens).toBe(1024);
    expect(args.budget).toBe("low");
    expect(args.query).toBe("x");
  });

  it("a bare reflect forwards budget:mid to the backend", async () => {
    backend = await startMockBackend();
    const shim = makeShim({ url: backend.url, cacheDir });
    await shim.handle(rpc(1, "initialize", { protocolVersion: "2025-06-18" }) as never);

    await shim.handle(
      rpc(2, "tools/call", { name: "reflect", arguments: { query: "x" } }) as never,
    );
    const call = backend.requests.find((r) => r.method === "tools/call");
    expect(call).toBeDefined();
    const args = call?.params?.arguments as Record<string, unknown>;
    expect(args.budget).toBe("mid");
    expect(args.max_tokens).toBe(1024);
    expect(args.query).toBe("x");
  });

  it("an explicit max_tokens:4096 reaches the backend untouched", async () => {
    backend = await startMockBackend();
    const shim = makeShim({ url: backend.url, cacheDir });
    await shim.handle(rpc(1, "initialize", { protocolVersion: "2025-06-18" }) as never);

    await shim.handle(
      rpc(2, "tools/call", {
        name: "recall",
        arguments: { query: "x", max_tokens: 4096 },
      }) as never,
    );
    const call = backend.requests.find((r) => r.method === "tools/call");
    const args = call?.params?.arguments as Record<string, unknown>;
    expect(args.max_tokens).toBe(4096);
  });

  it("recall {limit:6} is rejected loudly and NEVER reaches the backend", async () => {
    backend = await startMockBackend();
    const shim = makeShim({ url: backend.url, cacheDir });
    await shim.handle(rpc(1, "initialize", { protocolVersion: "2025-06-18" }) as never);

    const res = await shim.handle(
      rpc(2, "tools/call", { name: "recall", arguments: { limit: 6 } }) as never,
    );
    const result = res?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("limit");
    expect(result.content[0].text).toContain("max_tokens");
    // The silent-drop is prevented: no tools/call was forwarded at all.
    expect(backend.requests.some((r) => r.method === "tools/call")).toBe(false);
  });
});


// ─── reflect re-roll (upstream ReflectToolCallError, hindsight v0.8.6) ─────

/** Verbatim shape of upstream's ReflectToolCallError message. */
const REFLECT_ERR =
  "Reflect requires a tool-calling model, but litellm/gpt-oss-20b produced " +
  "no usable tool call (the transport may not support function calling). " +
  "Response: 'Current article ...'";

describe("isReflectToolCallFailure (unit)", () => {
  it("matches the isError tool-result shape", () => {
    expect(
      isReflectToolCallFailure("reflect", {
        result: { isError: true, content: [{ type: "text", text: REFLECT_ERR }] },
      }),
    ).toBe(true);
  });

  it("matches the JSON-RPC protocol-error shape", () => {
    expect(
      isReflectToolCallFailure("reflect", {
        error: { message: REFLECT_ERR },
      }),
    ).toBe(true);
  });

  it("is scoped to reflect — the same failure on a WRITE is never retried", () => {
    // The double-execution guard's whole point: retain must not run twice.
    expect(
      isReflectToolCallFailure("retain", {
        result: { isError: true, content: [{ type: "text", text: REFLECT_ERR }] },
      }),
    ).toBe(false);
  });

  it("does not match an unrelated reflect failure", () => {
    expect(
      isReflectToolCallFailure("reflect", {
        result: { isError: true, content: [{ type: "text", text: "bank not found" }] },
      }),
    ).toBe(false);
  });

  it("does not match a SUCCESSFUL reflect that merely quotes the phrase", () => {
    // isError:false — a synthesised answer discussing tool calls is an answer.
    expect(
      isReflectToolCallFailure("reflect", {
        result: {
          isError: false,
          content: [{ type: "text", text: `the model ${REFLECT_NO_TOOL_CALL_SIGNATURE}` }],
        },
      }),
    ).toBe(false);
  });
});

describe("reflect re-roll through the live shim", () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "shim-reflect-"));
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("re-issues reflect on ReflectToolCallError and returns the retry's answer", async () => {
    const calls: number[] = [];
    const backend = await startMockBackend({
      tools: [{ name: "reflect", inputSchema: { type: "object" } }],
      onToolsCall: (i) => {
        calls.push(i);
        return i === 1
          ? {
              result: {
                isError: true,
                content: [{ type: "text", text: REFLECT_ERR }],
              },
            }
          : undefined; // second attempt succeeds
      },
    });
    const shim = makeShim({ url: backend.url, cacheDir });
    const res = (await shim.handle(
      rpc(1, "tools/call", { name: "reflect", arguments: { query: "q" } }),
    )) as { result?: { isError?: boolean; content?: { text?: string }[] } };

    expect(calls).toEqual([1, 2]); // exactly one re-roll, not more
    expect(res.result?.isError).toBe(false);
    expect(res.result?.content?.[0]?.text).toBe("called:reflect");
    await backend.close();
  });

  it("gives up after REFLECT_TOOL_CALL_RETRIES and surfaces upstream's real error", async () => {
    let n = 0;
    const backend = await startMockBackend({
      tools: [{ name: "reflect", inputSchema: { type: "object" } }],
      onToolsCall: () => {
        n++;
        return {
          result: { isError: true, content: [{ type: "text", text: REFLECT_ERR }] },
        };
      },
    });
    const shim = makeShim({ url: backend.url, cacheDir });
    const res = (await shim.handle(
      rpc(1, "tools/call", { name: "reflect", arguments: { query: "q" } }),
    )) as { result?: { isError?: boolean; content?: { text?: string }[] } };

    // 1 initial attempt + REFLECT_TOOL_CALL_RETRIES re-rolls, then stop.
    expect(n).toBe(1 + REFLECT_TOOL_CALL_RETRIES);
    expect(res.result?.isError).toBe(true);
    // The agent sees upstream's diagnostic text, not a shim-invented one.
    expect(res.result?.content?.[0]?.text).toContain(
      REFLECT_NO_TOOL_CALL_SIGNATURE,
    );
    await backend.close();
  });

  it("never re-issues a WRITE that fails with the same message", async () => {
    let n = 0;
    const backend = await startMockBackend({
      tools: [{ name: "retain", inputSchema: { type: "object" } }],
      onToolsCall: () => {
        n++;
        return {
          result: { isError: true, content: [{ type: "text", text: REFLECT_ERR }] },
        };
      },
    });
    const shim = makeShim({ url: backend.url, cacheDir });
    await shim.handle(
      rpc(1, "tools/call", { name: "retain", arguments: { content: "x" } }),
    );
    expect(n).toBe(1);
    await backend.close();
  });
});

// ─── 8. the synthesized knowledge-page reads ──────────────────────────────

/**
 * The knowledge tools are shim-local, so their contract must hold with the
 * backend DOWN — that is the whole reason they are synthesized rather than
 * forwarded. The REST-backed behaviour lives in
 * tests/hindsight-knowledge-admin.test.ts; what is pinned here is the shim
 * half: advertisement, argument validation, and that validation happens
 * before any network I/O.
 */
describe("synthesized knowledge-page tools", () => {
  it("are advertised with the backend dead, schemas intact", async () => {
    const shim = makeShim({ url: await deadUrl(), cacheDir });
    const res = await shim.handle(rpc(1, "tools/list") as never);
    const { tools } = res?.result as {
      tools: { name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }[];
    };
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const n of [
      "search_knowledge_pages",
      "get_knowledge_page",
      "get_knowledge_tree",
    ]) {
      expect(SYNTHESIZED_TOOL_NAMES).toContain(n);
      expect(byName.has(n), `${n} missing from the served manifest`).toBe(true);
    }
    expect(byName.get("search_knowledge_pages")!.inputSchema.required).toEqual([
      "query",
    ]);
    expect(
      byName.get("search_knowledge_pages")!.inputSchema.properties.limit,
    ).toMatchObject({ type: "integer", minimum: 1, maximum: 50 });
    expect(byName.get("get_knowledge_page")!.inputSchema.required).toEqual([
      "page_id",
    ]);
    expect(byName.get("get_knowledge_tree")!.inputSchema.required).toEqual([]);
  });

  it("rejects an unknown argument locally, naming bank_id explicitly", async () => {
    const shim = makeShim({ url: await deadUrl(), cacheDir });
    const res = await shim.handle(
      rpc(2, "tools/call", {
        name: "get_knowledge_tree",
        arguments: { bank_id: "someone-elses-bank" },
      }) as never,
    );
    const result = res?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bank_id");
    expect(result.content[0].text).toContain("your own memory bank");
    // NOT the forwarded "memory is temporarily unavailable" path: the backend
    // is dead and the answer still came from the shim.
    expect(result.content[0].text).not.toMatch(/temporarily unavailable/i);
  });

  it("requires the declared required argument", async () => {
    const shim = makeShim({ url: await deadUrl(), cacheDir });
    const res = await shim.handle(
      rpc(3, "tools/call", {
        name: "search_knowledge_pages",
        arguments: {},
      }) as never,
    );
    const result = res?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("search_knowledge_pages requires 'query'.");
  });

  /**
   * The regression this exists for: the validator used to require EVERY
   * argument to be a non-empty string, so a schema-legal `limit: 5` was
   * rejected with an error the model could not act on.
   */
  it("accepts an integer limit and a numeric string, rejects the rest", () => {
    const spec = SYNTHESIZED_TOOL_TABLE.search_knowledge_pages;
    const arg = (v: unknown) =>
      coerceSynthesizedArg("search_knowledge_pages", "limit", spec.props.limit, v);
    expect(arg(5)).toEqual({ ok: true, value: 5 });
    expect(arg("5")).toEqual({ ok: true, value: 5 });
    expect(arg(1)).toEqual({ ok: true, value: 1 });
    expect(arg(50)).toEqual({ ok: true, value: 50 });
    // The accepted STRING spelling is exact: no surrounding whitespace, no
    // leading zeros. `" 5 "`, `"01"` and `"50\n"` are not what an MCP client's
    // number stringification emits, so taking them means silently accepting a
    // mangled argument as though the caller had meant it that way.
    for (const bad of [
      0,
      51,
      -1,
      2.5,
      "abc",
      "",
      " 5 ",
      "01",
      "50\n",
      Number.MAX_SAFE_INTEGER + 2,
      true,
      null,
      {},
    ]) {
      const r = arg(bad);
      expect(r.ok, `${JSON.stringify(bad)} must not be an accepted limit`).toBe(
        false,
      );
      if (!r.ok) expect(r.text).toContain("integer");
    }
    // Out-of-range says the range rather than silently clamping — a clamped
    // 500 reads to the model as "you got 500 hits".
    const over = arg(500);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.text).toContain("between 1 and 50");
      expect(over.text).toContain("500");
    }
  });

  it("still rejects an empty STRING argument (the old rule is intact)", () => {
    const spec = SYNTHESIZED_TOOL_TABLE.search_knowledge_pages;
    const r = coerceSynthesizedArg(
      "search_knowledge_pages",
      "query",
      spec.props.query,
      "",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.text).toContain("non-empty string");
    expect(
      coerceSynthesizedArg(
        "deactivate_directive",
        "superseded_by",
        SYNTHESIZED_TOOL_TABLE.deactivate_directive.props.superseded_by,
        "",
      ).ok,
    ).toBe(false);
  });

  it("an out-of-range limit is refused before any network I/O", async () => {
    const shim = makeShim({ url: await deadUrl(), cacheDir });
    const res = await shim.handle(
      rpc(4, "tools/call", {
        name: "search_knowledge_pages",
        arguments: { query: "x", limit: 500 },
      }) as never,
    );
    const result = res?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("between 1 and 50");
  });

  it("every advertised synthesized tool has a dispatch arm", async () => {
    // The name switch throws on an unmatched name, so a table entry added
    // without an arm surfaces here as "no dispatch arm" instead of silently
    // running whichever tool the old ternary's else branch happened to be.
    // Each call gets SCHEMA-VALID required args so it clears validation and
    // actually reaches the switch; the backend is dead, so a wired arm fails
    // at the network with "<name> failed:".
    const shim = makeShim({ url: await deadUrl(), cacheDir });
    for (const name of SYNTHESIZED_TOOL_NAMES) {
      const spec = SYNTHESIZED_TOOL_TABLE[name];
      const args = Object.fromEntries(
        spec.required.map((k) => [
          k,
          (spec.props[k] as { type?: string })?.type === "integer" ? 1 : "x",
        ]),
      );
      const res = await shim.handle(
        rpc(5, "tools/call", { name, arguments: args }) as never,
      );
      const result = res?.result as {
        isError: boolean;
        content: { text: string }[];
      };
      expect(result.isError, `${name} unexpectedly succeeded`).toBe(true);
      expect(
        result.content[0].text,
        `${name} is advertised but the dispatch switch has no arm for it`,
      ).not.toContain("no dispatch arm");
      expect(result.content[0].text).toContain(`${name} failed:`);
    }
  });
});
