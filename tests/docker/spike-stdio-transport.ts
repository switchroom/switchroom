/**
 * Spike — does @modelcontextprotocol/sdk's StdioClientTransport tolerate
 * being pointed at a `docker exec -i <ctr> <cmd>` shell wrapper?
 *
 * The PR C smoke test depends on this: we want to list tools from an
 * MCP server running inside a fresh agent container WITHOUT having to
 * implement a custom transport. If `StdioClientTransport`'s spawn
 * argument list happily forwards stdio through `docker exec`, we're
 * done. If not, the smoke test can't work in its current shape.
 *
 * Run standalone with `bun tests/docker/spike-stdio-transport.ts <ctr>`
 * or via the test harness which probes a throwaway `docker exec echo`
 * pipe before launching the real MCP server.
 *
 * Returns true on success; throws with a descriptive message on
 * failure. The thrown message is the exact actionable string the
 * smoke-test harness re-raises.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface SpikeOpts {
  /** Container name or id to docker exec into. */
  containerId: string;
  /** Command to run inside the container — defaults to `cat` which
   *  trivially echoes whatever JSONRPC handshake bytes the SDK writes
   *  back at it (useful for testing the transport pipe only, NOT for
   *  any actual MCP behaviour). */
  command?: string;
  /** Args to pass after the command. */
  args?: string[];
  /** Connection timeout in ms (default 5000). */
  timeoutMs?: number;
}

const SPIKE_FAIL_MESSAGE =
  "stdio-over-docker-exec transport is broken in this SDK version — pin or patch before re-running smoke-test";

export async function spikeStdioOverDockerExec(opts: SpikeOpts): Promise<boolean> {
  const { containerId, command = "cat", args = [], timeoutMs = 5000 } = opts;
  const transport = new StdioClientTransport({
    command: "docker",
    args: ["exec", "-i", containerId, command, ...args],
  });
  const client = new Client(
    { name: "switchroom-smoke-spike", version: "0.0.1" },
    { capabilities: {} },
  );
  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("connect timeout")), timeoutMs),
  );
  try {
    await Promise.race([connectPromise, timeoutPromise]);
    await client.close();
    return true;
  } catch (err) {
    // Some SDK versions surface the docker-exec wrapping issue as a
    // "Cannot spawn ..." error — others as a hang. Either way, fail
    // fast with the actionable string.
    throw new Error(
      `${SPIKE_FAIL_MESSAGE}: ${(err as Error).message ?? String(err)}`,
    );
  }
}

// Standalone CLI mode for ad-hoc verification: `bun spike-stdio-transport.ts <ctr>`
if (import.meta.url === `file://${process.argv[1]}`) {
  const ctr = process.argv[2];
  if (!ctr) {
    console.error("usage: bun spike-stdio-transport.ts <container-id-or-name>");
    process.exit(2);
  }
  spikeStdioOverDockerExec({ containerId: ctr })
    .then(() => {
      console.log("spike PASS — StdioClientTransport works over docker exec");
      process.exit(0);
    })
    .catch((err) => {
      console.error(`spike FAIL: ${(err as Error).message}`);
      process.exit(1);
    });
}
