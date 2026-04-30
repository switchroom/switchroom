import { describe, it, expect } from "vitest";
import { probeHindsight } from "../src/memory/hindsight.js";

describe("doctor memory section — source structure", () => {
  // The internal `checkHindsight` function isn't exported (it's an
  // internal helper inside src/cli/doctor.ts). These structure-only
  // assertions guard the wiring: the function exists, gates on the
  // hindsight backend, probes the URL via MCP rather than container
  // name, and validates per-agent missions.

  it("checkHindsight skips when backend is not hindsight", () => {
    const fs = require("fs");
    const doctorSource = fs.readFileSync("src/cli/doctor.ts", "utf-8");
    expect(doctorSource).toContain("async function checkHindsight");
    expect(doctorSource).toContain('if (memoryBackend !== "hindsight")');
  });

  it("checkHindsight probes the URL via MCP initialize, not container name", () => {
    const fs = require("fs");
    const doctorSource = fs.readFileSync("src/cli/doctor.ts", "utf-8");
    expect(doctorSource).toContain("probeHindsight(url)");
    expect(doctorSource).toContain("not speaking MCP");
    // No container-name filter remains (the legacy behaviour we removed
    // was filtering by `name=switchroom-hindsight` in `docker ps`).
    expect(doctorSource).not.toContain('"name=switchroom-hindsight"');
  });

  it("checkHindsight surfaces server name + version in the detail line", () => {
    const fs = require("fs");
    const doctorSource = fs.readFileSync("src/cli/doctor.ts", "utf-8");
    expect(doctorSource).toContain("probe.serverName");
    expect(doctorSource).toContain("probe.serverVersion");
  });

  it("checkHindsight checks per-agent bank missions", () => {
    const fs = require("fs");
    const doctorSource = fs.readFileSync("src/cli/doctor.ts", "utf-8");
    expect(doctorSource).toContain("bank_mission");
    expect(doctorSource).toContain("retain_mission");
    expect(doctorSource).toContain("missions");
  });
});

describe("probeHindsight", () => {
  it("returns ok with serverInfo when initialize succeeds", async () => {
    const fakeFetch = (async () => {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "hindsight-mcp-server", version: "3.2.0" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await probeHindsight("http://localhost:18888/mcp/", {
      fetchImpl: fakeFetch,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.serverName).toBe("hindsight-mcp-server");
      expect(result.serverVersion).toBe("3.2.0");
    }
  });

  it("parses SSE-framed initialize responses (Hindsight's default content-type)", async () => {
    const sseBody =
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"hindsight-mcp-server","version":"3.2.0"}}}\n\n';
    const fakeFetch = (async () => {
      return new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const result = await probeHindsight("http://localhost:18888/mcp/", {
      fetchImpl: fakeFetch,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.serverVersion).toBe("3.2.0");
    }
  });

  it("returns Unreachable on connection refused", async () => {
    const fakeFetch = (async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await probeHindsight("http://localhost:18888/mcp/", {
      fetchImpl: fakeFetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("Unreachable");
    }
  });

  it("returns HTTP <code> on non-200 responses", async () => {
    const fakeFetch = (async () => {
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await probeHindsight("http://localhost:18888/mcp/", {
      fetchImpl: fakeFetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("HTTP 404");
    }
  });

  it("returns a parse-error reason when serverInfo is missing", async () => {
    const fakeFetch = (async () => {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await probeHindsight("http://localhost:18888/mcp/", {
      fetchImpl: fakeFetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("serverInfo");
    }
  });
});
