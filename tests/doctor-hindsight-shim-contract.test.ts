/**
 * Outcome tests for the `switchroom doctor` hindsight-shim contract probe
 * (src/cli/doctor-hindsight-shim-contract.ts) — design-v2.md §2.5's "a
 * doctor contract probe ... not built", now built.
 *
 * Each guard fails on the specific defect it exists for:
 *   • route drift    — a synthesized tool's route missing from /openapi.json
 *                       must produce a `fail` row naming the tool AND route
 *   • no false alarm — a fully-present contract must produce exactly one
 *                       rollup `ok` row, not five
 *   • version skew   — older/equal/newer against the pin must classify as
 *                       fail/ok/warn respectively
 *   • quiet on outage — an unreachable /openapi.json must produce NO rows
 *                       (reachability is another check's job), not a fail
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import {
  classifyHindsightShimContract,
  classifyShimContractVersion,
  classifySynthesizedToolRoute,
  runHindsightShimContractCheck,
  SHIM_CONTRACT_CHECK_PREFIX,
} from "../src/cli/doctor-hindsight-shim-contract.js";
import type { OpenApiSpec } from "../src/memory/hindsight-shim-contract.js";
import { HINDSIGHT_MIN_API_VERSION } from "../src/memory/hindsight-tools.js";

function fullSpec(version = HINDSIGHT_MIN_API_VERSION): OpenApiSpec {
  return {
    info: { version },
    paths: {
      "/v1/default/banks/{bank_id}/directives": { get: {}, post: {} },
      "/v1/default/banks/{bank_id}/directives/{directive_id}": {
        get: {},
        patch: {},
        delete: {},
      },
      "/v1/default/banks/{bank_id}/knowledge-base/search": { get: {} },
      "/v1/default/banks/{bank_id}/knowledge-base/pages/{page_id}": { get: {} },
      "/v1/default/banks/{bank_id}/knowledge-base/tree": { get: {} },
    },
  };
}

describe("classifySynthesizedToolRoute", () => {
  it("null (no row) when every route the tool needs is present", () => {
    expect(classifySynthesizedToolRoute(fullSpec(), "get_knowledge_tree")).toBeNull();
  });

  it("fail row naming the tool and the exact missing route", () => {
    const spec = fullSpec();
    delete spec.paths!["/v1/default/banks/{bank_id}/knowledge-base/tree"];
    const row = classifySynthesizedToolRoute(spec, "get_knowledge_tree");
    expect(row?.status).toBe("fail");
    expect(row?.name).toBe(`${SHIM_CONTRACT_CHECK_PREFIX}: get_knowledge_tree`);
    expect(row?.detail).toContain(
      "GET /v1/default/banks/{bank_id}/knowledge-base/tree",
    );
    expect(row?.fix).toBeTruthy();
  });
});

describe("classifyShimContractVersion", () => {
  it("ok when the live version matches the pin exactly", () => {
    const row = classifyShimContractVersion(fullSpec(HINDSIGHT_MIN_API_VERSION));
    expect(row.status).toBe("ok");
  });

  it("fail when the live version is OLDER than the pin", () => {
    const row = classifyShimContractVersion(fullSpec("0.1.0"));
    expect(row.status).toBe("fail");
    expect(row.detail).toContain("OLDER");
    expect(row.fix).toBeTruthy();
  });

  it("warn when the live version is NEWER than the pin", () => {
    const row = classifyShimContractVersion(fullSpec("99.0.0"));
    expect(row.status).toBe("warn");
    expect(row.detail).toContain("NEWER");
  });

  it("warn when the spec has no info.version", () => {
    const row = classifyShimContractVersion({ paths: {} });
    expect(row.status).toBe("warn");
  });
});

describe("classifyHindsightShimContract", () => {
  it("a fully-present contract at the pinned version produces exactly one route rollup ok row plus one version ok row — never five", () => {
    const rows = classifyHindsightShimContract(fullSpec());
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(rows.find((r) => r.name.endsWith(": routes"))).toBeTruthy();
    expect(rows.find((r) => r.name.endsWith(": version"))).toBeTruthy();
  });

  it("THE GUARD: a dropped route surfaces as a fail row, not silence", () => {
    const spec = fullSpec();
    delete spec.paths!["/v1/default/banks/{bank_id}/knowledge-base/pages/{page_id}"];
    const rows = classifyHindsightShimContract(spec);
    const failRows = rows.filter((r) => r.status === "fail");
    expect(failRows).toHaveLength(1);
    expect(failRows[0].name).toBe(`${SHIM_CONTRACT_CHECK_PREFIX}: get_knowledge_page`);
    // The clean rollup row must NOT appear once there is real drift.
    expect(rows.find((r) => r.name.endsWith(": routes") && r.status === "ok")).toBeUndefined();
  });

  it("multiple dropped routes each get their own named row", () => {
    const spec = fullSpec();
    delete spec.paths!["/v1/default/banks/{bank_id}/knowledge-base/tree"];
    delete spec.paths!["/v1/default/banks/{bank_id}/directives/{directive_id}"];
    const rows = classifyHindsightShimContract(spec);
    const names = rows.filter((r) => r.status === "fail").map((r) => r.name);
    expect(names).toContain(`${SHIM_CONTRACT_CHECK_PREFIX}: get_knowledge_tree`);
    expect(names).toContain(`${SHIM_CONTRACT_CHECK_PREFIX}: deactivate_directive`);
    expect(names).toContain(`${SHIM_CONTRACT_CHECK_PREFIX}: reactivate_directive`);
  });
});

// ─── live wrapper against a real HTTP server ───────────────────────────────

async function startOpenApiServer(
  respond: (res: import("node:http").ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/openapi.json") return respond(res);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/mcp/`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

describe("runHindsightShimContractCheck", () => {
  let srv: { url: string; close: () => Promise<void> } | null = null;
  afterEach(async () => {
    await srv?.close();
    srv = null;
  });

  it("returns the classified rows for a reachable spec", async () => {
    srv = await startOpenApiServer((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(fullSpec()));
    });
    const rows = await runHindsightShimContractCheck(srv.url);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "ok")).toBe(true);
  });

  it("returns NO rows when /openapi.json is unreachable — reachability is a different check's job", async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as { port: number }).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const rows = await runHindsightShimContractCheck(
      `http://127.0.0.1:${port}/mcp/`,
      { timeoutMs: 300 },
    );
    expect(rows).toEqual([]);
  });
});
