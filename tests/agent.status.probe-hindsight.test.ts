/**
 * Regression coverage for the `hindsight: fail unreachable (no session
 * id)` false-negative.
 *
 * `src/agents/status.ts` carries its OWN `probeHindsight` (used by
 * `switchroom agent status`), distinct from the one in
 * `src/memory/hindsight.ts` that doctor uses. #1515 made the
 * memory/hindsight.ts copy tolerate a stateless server (no
 * `mcp-session-id`) but MISSED this status.ts copy — so every
 * `agent status` against a (correctly) stateless hindsight reported
 * `reachable: false, reason: "no session id"`, driving `overall: fail`
 * on a healthy daemon (observed live: lawgpt, 2026-05-19).
 *
 * Hindsight runs stateless by design (HINDSIGHT_API_MCP_STATELESS=true):
 * `initialize` returns 200 OK with NO `mcp-session-id` header. A 200 on
 * init already proves reachability; the session header must be
 * forwarded only when a stateful server actually issued one.
 */
import { describe, it, expect } from "vitest";

import { probeHindsight } from "../src/agents/status.js";

type Init = { headers: Record<string, string> };

/** Minimal Response-like stub matching what probeHindsight consumes. */
function makeFetch(opts: {
  initStatus?: number;
  initHeaders?: Record<string, string>;
  listStatus?: number;
  listBody?: string;
}): { fetchImpl: typeof fetch; calls: Init[] } {
  const calls: Init[] = [];
  let n = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    n += 1;
    calls.push({ headers: (init.headers ?? {}) as Record<string, string> });
    if (n === 1) {
      const status = opts.initStatus ?? 200;
      const h = new Map(Object.entries(opts.initHeaders ?? {}));
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k: string) => h.get(k.toLowerCase()) ?? h.get(k) ?? null },
        text: async () => "",
      };
    }
    const status = opts.listStatus ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => opts.listBody ?? "",
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const BANK = "user-profile-lawgpt";
const listBodyWithBank = `data: ${JSON.stringify({
  result: { content: [{ text: BANK }] },
})}`;

describe("probeHindsight — stateless tolerance (the lawgpt false-negative)", () => {
  it("reports reachable when a STATELESS server omits mcp-session-id", async () => {
    // Pre-fix this returned { reachable:false, reason:"no session id" }.
    const { fetchImpl } = makeFetch({
      initHeaders: {}, // stateless: NO mcp-session-id
      listBody: listBodyWithBank,
    });
    const r = await probeHindsight("http://h:18888/mcp", BANK, { fetchImpl });
    expect(r.reachable).toBe(true);
    expect(r.bankExists).toBe(true);
  });

  it("does NOT forward a session header when the server is stateless", async () => {
    const { fetchImpl, calls } = makeFetch({
      initHeaders: {},
      listBody: listBodyWithBank,
    });
    await probeHindsight("http://h:18888/mcp", BANK, { fetchImpl });
    expect("mcp-session-id" in calls[1]!.headers).toBe(false);
  });

  it("still forwards the session header when a STATEFUL server issues one", async () => {
    const { fetchImpl, calls } = makeFetch({
      initHeaders: { "mcp-session-id": "sess-abc" },
      listBody: listBodyWithBank,
    });
    const r = await probeHindsight("http://h:18888/mcp", BANK, { fetchImpl });
    expect(r.reachable).toBe(true);
    expect(r.bankExists).toBe(true);
    expect((calls[1]!.headers as Record<string, string>)["mcp-session-id"]).toBe(
      "sess-abc",
    );
  });

  it("stateless + bank absent → reachable but bankExists:false (NOT a false 'unreachable')", async () => {
    const { fetchImpl } = makeFetch({
      initHeaders: {},
      listBody: `data: ${JSON.stringify({ result: { content: [{ text: "some-other-bank" }] } })}`,
    });
    const r = await probeHindsight("http://h:18888/mcp", BANK, { fetchImpl });
    expect(r.reachable).toBe(true);
    expect(r.bankExists).toBe(false);
  });

  it("genuine unreachable still reported (init non-2xx) — fix didn't mask real failures", async () => {
    const { fetchImpl } = makeFetch({ initStatus: 503 });
    const r = await probeHindsight("http://h:18888/mcp", BANK, { fetchImpl });
    expect(r.reachable).toBe(false);
    expect(r.reason).toContain("503");
  });
});
