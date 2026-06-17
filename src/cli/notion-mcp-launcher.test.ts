/**
 * Tests for notion-mcp-launcher — RFC reference/rfcs/notion-integration.md PR 2.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  buildNotionMcpArgs,
  DEFAULT_VAULT_KEY,
  runNotionMcpLauncher,
} from "./notion-mcp-launcher.js";
import { NOTION_MCP_PACKAGE } from "../memory/scaffold-integration.js";

/**
 * Minimal ChildProcess stand-in. Real spawn returns a full
 * `ChildProcessByStdio`; for unit tests we only need the stdio
 * streams and the exit event.
 */
function makeFakeChild(opts: {
  exitCode?: number;
  exitDelayMs?: number;
  errOnSpawn?: boolean;
} = {}) {
  const ee = new EventEmitter() as EventEmitter & {
    stdin: NodeJS.WritableStream;
    stdout: NodeJS.ReadableStream;
    stderr: NodeJS.ReadableStream;
    kill: (sig?: NodeJS.Signals) => boolean;
  };

  // Use PassThrough streams — small enough not to need real stdio.
  const { PassThrough } = require("node:stream");
  ee.stdin = new PassThrough();
  ee.stdout = new PassThrough();
  ee.stderr = new PassThrough();
  ee.kill = vi.fn(() => true);

  // Schedule a deferred exit / error after the test sets up the
  // launcher's await.
  setImmediate(() => {
    if (opts.errOnSpawn) {
      ee.emit("error", new Error("spawn failed"));
      return;
    }
    setTimeout(() => {
      ee.emit("exit", opts.exitCode ?? 0, null);
    }, opts.exitDelayMs ?? 5);
  });

  return ee;
}

describe("buildNotionMcpArgs", () => {
  it("returns `-y <package>@<pinned-version>` by default", () => {
    const args = buildNotionMcpArgs({});
    expect(args[0]).toBe("-y");
    expect(args[1]).toMatch(new RegExp(`^${NOTION_MCP_PACKAGE.replace(/[\/.]/g, "\\$&")}@`));
  });

  it("honours an explicit mcpVersion override", () => {
    const args = buildNotionMcpArgs({ mcpVersion: "9.9.9" });
    expect(args[1]).toBe(`${NOTION_MCP_PACKAGE}@9.9.9`);
  });
});

describe("DEFAULT_VAULT_KEY", () => {
  it("is the canonical notion/integration-token key", () => {
    expect(DEFAULT_VAULT_KEY).toBe("notion/integration-token");
  });
});

describe("runNotionMcpLauncher", () => {
  it("fetches the token, spawns the MCP, bridges stdio, and exits with child's code", async () => {
    const writeHeartbeat = vi.fn();
    const spawnMcp = vi.fn(() => makeFakeChild({ exitCode: 0 }) as never);

    const code = await runNotionMcpLauncher(
      { heartbeatPath: "/tmp/test-heartbeat.json" },
      {
        fetchToken: async () => "secret_TEST_TOKEN",
        spawnMcp,
        writeHeartbeat,
        // Use real timers — child exits in ~5ms, well within test budget
      },
    );

    expect(code).toBe(0);
    expect(spawnMcp).toHaveBeenCalledOnce();
    // Token must be in the child's env block.
    const call = spawnMcp.mock.calls[0] as unknown as [NodeJS.ProcessEnv, string[]];
    expect(call?.[0]?.NOTION_TOKEN).toBe("secret_TEST_TOKEN");
    // Heartbeat written at least once before child exited.
    expect(writeHeartbeat).toHaveBeenCalled();
    const [path, contents] = writeHeartbeat.mock.calls[0]!;
    expect(path).toBe("/tmp/test-heartbeat.json");
    const parsed = JSON.parse(contents);
    expect(parsed).toMatchObject({
      pid: expect.any(Number),
      mcp_package: NOTION_MCP_PACKAGE,
    });
    expect(parsed.ts).toBeGreaterThan(0);
  });

  it("returns 1 when token fetch fails", async () => {
    const writeHeartbeat = vi.fn();
    const spawnMcp = vi.fn();

    const code = await runNotionMcpLauncher(
      {},
      {
        fetchToken: async () => {
          throw new Error("DENIED");
        },
        spawnMcp,
        writeHeartbeat,
      },
    );

    expect(code).toBe(1);
    expect(spawnMcp).not.toHaveBeenCalled();
    expect(writeHeartbeat).not.toHaveBeenCalled();
  });

  it("returns 1 when token is empty", async () => {
    const code = await runNotionMcpLauncher(
      {},
      {
        fetchToken: async () => "",
        spawnMcp: vi.fn(),
        writeHeartbeat: vi.fn(),
      },
    );
    expect(code).toBe(1);
  });

  it("returns 1 on child spawn error", async () => {
    const code = await runNotionMcpLauncher(
      {},
      {
        fetchToken: async () => "ok",
        spawnMcp: vi.fn(() => makeFakeChild({ errOnSpawn: true }) as never),
        writeHeartbeat: vi.fn(),
      },
    );
    expect(code).toBe(1);
  });

  it("propagates non-zero child exit code", async () => {
    const code = await runNotionMcpLauncher(
      {},
      {
        fetchToken: async () => "ok",
        spawnMcp: vi.fn(() => makeFakeChild({ exitCode: 42 }) as never),
        writeHeartbeat: vi.fn(),
      },
    );
    expect(code).toBe(42);
  });

  it("encodes the agent name in the heartbeat when SWITCHROOM_AGENT_NAME is set", async () => {
    const prior = process.env.SWITCHROOM_AGENT_NAME;
    process.env.SWITCHROOM_AGENT_NAME = "clerk";
    const writeHeartbeat = vi.fn();
    try {
      await runNotionMcpLauncher(
        { heartbeatPath: "/tmp/test-heartbeat.json" },
        {
          fetchToken: async () => "ok",
          spawnMcp: vi.fn(() => makeFakeChild({}) as never),
          writeHeartbeat,
        },
      );
      const [, contents] = writeHeartbeat.mock.calls[0]!;
      expect(JSON.parse(contents).agent).toBe("clerk");
    } finally {
      if (prior !== undefined) {
        process.env.SWITCHROOM_AGENT_NAME = prior;
      } else {
        delete process.env.SWITCHROOM_AGENT_NAME;
      }
    }
  });
});
