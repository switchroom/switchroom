/**
 * Outcome tests for directive retirement — `DirectiveAdmin`
 * (src/memory/hindsight-directive-admin.ts) and the two shim-synthesized MCP
 * tools that wrap it (src/cli/hindsight-mcp-shim.ts).
 *
 * These drive the real modules against a stateful mock of the hindsight REST
 * API, and assert the STATE THE SERVER ENDS UP IN plus the requests it
 * actually received — not that a code path ran. Each guard below is written so
 * it fails on the specific defect it exists for:
 *
 *   • bank pinning     — remove the pin and the request lands on a peer bank
 *   • field whitelist  — widen the PATCH body and a directive's text changes
 *   • pair atomicity   — drop the rollback and the winner keeps a dangling tag
 *   • loud failure     — swallow the rollback failure and a half-written pair
 *                        reports success
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DirectiveAdmin,
  DirectivePairInconsistentError,
  RulesBlockDeactivationRefusedError,
  RULES_BLOCK_MARKER_TAG,
  buildDirectivePatchBody,
  type HindsightDirective,
} from "../src/memory/hindsight-directive-admin.js";
import {
  HindsightShim,
  SYNTHESIZED_TOOL_NAMES,
} from "../src/cli/hindsight-mcp-shim.js";

// ─── stateful mock of the hindsight REST directive API ────────────────────

interface SeenRequest {
  method: string;
  path: string;
  body: unknown;
}

interface MockApi {
  baseUrl: string;
  server: Server;
  /** bank id → directives, mutated by PATCH exactly as the real API would. */
  banks: Record<string, HindsightDirective[]>;
  seen: SeenRequest[];
  /** Return an HTTP status to fail a PATCH with, or null to let it through. */
  failPatch: (directiveId: string, patchIndex: number) => number | null;
  close: () => Promise<void>;
}

async function startMockApi(
  banks: Record<string, HindsightDirective[]>,
): Promise<MockApi> {
  const state: MockApi = {
    baseUrl: "",
    server: undefined as unknown as Server,
    banks,
    seen: [],
    failPatch: () => null,
    close: async () => undefined,
  };
  let patchCount = 0;

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = req.url ?? "";
      const body = raw ? JSON.parse(raw) : undefined;
      state.seen.push({ method: req.method ?? "", path, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const [rawPath, rawQuery] = path.split("?");
      const query = new URLSearchParams(rawQuery ?? "");
      const m = /^\/v1\/default\/banks\/([^/]+)\/directives(?:\/([^/]+))?$/.exec(
        rawPath,
      );
      if (!m) return send(404, { detail: "not found" });
      const bank = decodeURIComponent(m[1]);
      const directiveId = m[2] ? decodeURIComponent(m[2]) : undefined;
      const items = state.banks[bank];
      if (!items) return send(404, { detail: "no such bank" });

      if (req.method === "GET" && !directiveId) {
        // Mirror the REAL upstream defaults, which are the trap here:
        // `active_only` defaults to TRUE and `limit` to 100, so a caller that
        // omits them cannot see (and therefore cannot reactivate) a
        // deactivated directive. A permissive mock would hide that bug.
        const activeOnly = (query.get("active_only") ?? "true") !== "false";
        const limit = Number(query.get("limit") ?? "100");
        const offset = Number(query.get("offset") ?? "0");
        const visible = (activeOnly ? items.filter((d) => d.is_active) : items)
          .slice(offset, offset + limit);
        return send(200, { items: visible });
      }
      if (req.method === "PATCH" && directiveId) {
        const failStatus = state.failPatch(directiveId, patchCount++);
        if (failStatus !== null) return send(failStatus, { detail: "injected" });
        const target = items.find((d) => d.id === directiveId);
        if (!target) return send(404, { detail: "no such directive" });
        // Mirror the real UpdateDirectiveRequest semantics: any field present
        // in the body is applied; tags REPLACE wholesale.
        for (const key of Object.keys(body as Record<string, unknown>)) {
          (target as Record<string, unknown>)[key] = (
            body as Record<string, unknown>
          )[key];
        }
        return send(200, target);
      }
      return send(405, { detail: "method not allowed" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  state.baseUrl = `http://127.0.0.1:${port}`;
  state.server = server;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}

const OWN_BANK = "agent-own-bank";
const PEER_BANK = "peer-bank";

function fixtureBanks(): Record<string, HindsightDirective[]> {
  return {
    [OWN_BANK]: [
      {
        id: "d-old",
        name: "old-rule",
        content: "The original guardrail text.",
        priority: 7,
        is_active: true,
        tags: ["style"],
      },
      {
        id: "d-new",
        name: "new-rule",
        content: "The replacement guardrail text.",
        priority: 3,
        is_active: true,
        tags: ["style", "keep"],
      },
      {
        id: "d-off",
        name: "retired-rule",
        content: "Already off.",
        priority: 0,
        is_active: false,
        tags: [],
      },
    ],
    [PEER_BANK]: [
      {
        id: "p-1",
        name: "peer-guardrail",
        content: "A peer agent's standing rule.",
        priority: 9,
        is_active: true,
        tags: [],
      },
    ],
  };
}

let api: MockApi;
beforeEach(async () => {
  api = await startMockApi(fixtureBanks());
});
afterEach(async () => {
  await api.close();
});

const admin = (overrides: Partial<{ bankId: string }> = {}) =>
  new DirectiveAdmin({
    apiBaseUrl: api.baseUrl,
    bankId: overrides.bankId ?? OWN_BANK,
    timeoutMs: 2000,
  });

const byId = (bank: string, id: string) =>
  api.banks[bank].find((d) => d.id === id)!;

// ─── 1. bank pinning ──────────────────────────────────────────────────────

describe("bank pinning", () => {
  it("every request targets the pinned bank and only the pinned bank", async () => {
    await admin().deactivate({ name: "old-rule" });
    expect(api.seen.length).toBeGreaterThan(0);
    for (const r of api.seen) {
      expect(
        r.path.startsWith(`/v1/default/banks/${OWN_BANK}/`),
        `request ${r.method} ${r.path} escaped the pinned bank`,
      ).toBe(true);
    }
    expect(byId(PEER_BANK, "p-1").is_active).toBe(true);
  });

  it("a directive NAME cannot be used to path-traverse into a peer bank", async () => {
    // Names are resolved against a listing of the pinned bank, never
    // interpolated into a URL. A traversal-shaped name must therefore fail as
    // "not found" WITHOUT any request reaching the peer bank.
    await expect(
      admin().deactivate({
        name: `../../${PEER_BANK}/directives/p-1`,
      }),
    ).rejects.toThrow(/no directive named/);
    for (const r of api.seen) {
      expect(r.path).not.toContain(PEER_BANK);
    }
    expect(byId(PEER_BANK, "p-1").is_active).toBe(true);
  });

  it("a name that exists ONLY in a peer bank is not reachable", async () => {
    await expect(
      admin().deactivate({ name: "peer-guardrail" }),
    ).rejects.toThrow(/no directive named 'peer-guardrail'/);
    expect(byId(PEER_BANK, "p-1").is_active).toBe(true);
    expect(api.seen.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("the tool schemas expose no bank_id, and a bank_id argument is REJECTED", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "shim-directive-test-"));
    try {
      const shim = new HindsightShim({
        url: `${api.baseUrl}/mcp/`,
        bankId: OWN_BANK,
        cacheDir,
        logger: () => undefined,
      });
      const list = (await shim.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      })) as { result: { tools: { name: string; inputSchema: unknown }[] } };
      const tool = list.result.tools.find(
        (t) => t.name === "deactivate_directive",
      )!;
      const props = Object.keys(
        (tool.inputSchema as { properties: Record<string, unknown> }).properties,
      );
      expect(props).not.toContain("bank_id");

      // ...and passing one anyway must fail loudly rather than be ignored.
      const res = (await shim.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "deactivate_directive",
          arguments: { name: "old-rule", bank_id: PEER_BANK },
        },
      })) as { result: { isError: boolean; content: { text: string }[] } };
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain("bank_id");
      // Nothing was written anywhere — not the peer bank, not our own.
      expect(byId(PEER_BANK, "p-1").is_active).toBe(true);
      expect(byId(OWN_BANK, "d-old").is_active).toBe(true);
      expect(api.seen.some((r) => r.method === "PATCH")).toBe(false);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

// ─── 2. the PATCH body whitelist ──────────────────────────────────────────

describe("field whitelist — only is_active and tags are ever written", () => {
  it("buildDirectivePatchBody cannot emit name/content/priority", () => {
    const body = buildDirectivePatchBody({ isActive: false, tags: ["x"] }) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual(["is_active", "tags"]);
    for (const forbidden of ["name", "content", "priority"]) {
      expect(Object.keys(body)).not.toContain(forbidden);
    }
    expect(Object.keys(buildDirectivePatchBody({ isActive: true }))).toEqual([
      "is_active",
    ]);
  });

  it("deactivate sends is_active only, and leaves content/name/priority byte-identical", async () => {
    const before = { ...byId(OWN_BANK, "d-old") };
    await admin().deactivate({ name: "old-rule" });
    const patches = api.seen.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(Object.keys(patches[0].body as object)).toEqual(["is_active"]);

    const after = byId(OWN_BANK, "d-old");
    expect(after.is_active).toBe(false);
    expect(after.content).toBe(before.content);
    expect(after.name).toBe(before.name);
    expect(after.priority).toBe(before.priority);
    expect(after.tags).toEqual(before.tags);
  });

  it("can see — and therefore restore — an ALREADY-INACTIVE directive", async () => {
    // Regression guard: upstream's `active_only` defaults to true, so a
    // listing that omits `active_only=false` cannot see 'retired-rule' at all
    // and reactivate_directive becomes permanently unable to do its one job.
    expect(byId(OWN_BANK, "d-off").is_active).toBe(false);
    await admin().reactivate({ name: "retired-rule" });
    expect(byId(OWN_BANK, "d-off").is_active).toBe(true);
  });

  it("reactivate sends is_active only, and leaves content/name/priority byte-identical", async () => {
    const before = { ...byId(OWN_BANK, "d-off") };
    await admin().reactivate({ name: "retired-rule" });
    const patches = api.seen.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ is_active: true });

    const after = byId(OWN_BANK, "d-off");
    expect(after.is_active).toBe(true);
    expect(after.content).toBe(before.content);
    expect(after.name).toBe(before.name);
    expect(after.priority).toBe(before.priority);
  });

  it("the supersession path also never writes content/name/priority", async () => {
    const oldBefore = { ...byId(OWN_BANK, "d-old") };
    const newBefore = { ...byId(OWN_BANK, "d-new") };
    await admin().deactivate({ name: "old-rule", supersededBy: "new-rule" });
    for (const p of api.seen.filter((r) => r.method === "PATCH")) {
      for (const forbidden of ["name", "content", "priority"]) {
        expect(
          Object.keys(p.body as object),
          `PATCH ${p.path} carried '${forbidden}' — this tool must never ` +
            `rewrite a guardrail's text`,
        ).not.toContain(forbidden);
      }
    }
    expect(byId(OWN_BANK, "d-old").content).toBe(oldBefore.content);
    expect(byId(OWN_BANK, "d-new").content).toBe(newBefore.content);
    expect(byId(OWN_BANK, "d-new").priority).toBe(newBefore.priority);
  });
});

// ─── 3. supersession provenance + atomicity ───────────────────────────────

describe("supersession provenance", () => {
  it("writes both tags and deactivates only the superseded directive", async () => {
    const msg = await admin().deactivate({
      name: "old-rule",
      supersededBy: "new-rule",
    });
    const retired = byId(OWN_BANK, "d-old");
    const winner = byId(OWN_BANK, "d-new");

    expect(retired.is_active).toBe(false);
    expect(retired.tags).toContain("superseded-by:new-rule");
    expect(retired.tags).toContain("style"); // pre-existing tag preserved

    expect(winner.is_active).toBe(true); // the winner is NOT touched otherwise
    expect(winner.tags).toContain("supersedes:old-rule");
    expect(winner.tags).toEqual(
      expect.arrayContaining(["style", "keep"]), // pre-existing tags preserved
    );
    expect(msg).toContain("superseded by 'new-rule'");
  });

  it("refuses self-supersession", async () => {
    await expect(
      admin().deactivate({ name: "old-rule", supersededBy: "old-rule" }),
    ).rejects.toThrow(/cannot supersede itself/);
    expect(byId(OWN_BANK, "d-old").is_active).toBe(true);
    expect(api.seen.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("an unknown superseded_by aborts BEFORE any write", async () => {
    await expect(
      admin().deactivate({ name: "old-rule", supersededBy: "no-such-rule" }),
    ).rejects.toThrow(/no directive named 'no-such-rule'/);
    expect(byId(OWN_BANK, "d-old").is_active).toBe(true);
    expect(api.seen.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("NEVER leaves a half-written pair: a failed second write rolls the first back", async () => {
    const winnerTagsBefore = [...byId(OWN_BANK, "d-new").tags!];
    // Fail the PATCH that retires the loser; the winner's tag write already
    // landed, so the ONLY thing standing between this and a dangling
    // `supersedes:` tag is the rollback.
    api.failPatch = (id) => (id === "d-old" ? 500 : null);

    await expect(
      admin().deactivate({ name: "old-rule", supersededBy: "new-rule" }),
    ).rejects.toThrow(/rolled back/);

    const retired = byId(OWN_BANK, "d-old");
    const winner = byId(OWN_BANK, "d-new");
    expect(retired.is_active).toBe(true); // not retired
    expect(retired.tags).not.toContain("superseded-by:new-rule");
    expect(
      winner.tags,
      "the winner kept a supersedes: tag for a supersession that never " +
        "happened — that is exactly the half-written pair this forbids",
    ).not.toContain("supersedes:old-rule");
    expect(winner.tags).toEqual(winnerTagsBefore); // restored EXACTLY
  });

  it("when the rollback ALSO fails it throws loudly and names the residue", async () => {
    // Every PATCH after the winner's initial tag write fails: the retire
    // fails, and so does the rollback.
    api.failPatch = (_id, index) => (index === 0 ? null : 500);

    let caught: unknown;
    try {
      await admin().deactivate({ name: "old-rule", supersededBy: "new-rule" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DirectivePairInconsistentError);
    const msg = (caught as Error).message;
    expect(msg).toContain("INCONSISTENT STATE");
    expect(msg).toContain("old-rule");
    expect(msg).toContain("new-rule");
    // The residue the message describes is the residue that exists.
    expect(byId(OWN_BANK, "d-new").tags).toContain("supersedes:old-rule");
    expect(byId(OWN_BANK, "d-old").is_active).toBe(true);
  });

  it("the failed-pair result surfaces as an MCP tool error, never as success", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "shim-directive-test-"));
    try {
      const shim = new HindsightShim({
        url: `${api.baseUrl}/mcp/`,
        bankId: OWN_BANK,
        cacheDir,
        logger: () => undefined,
      });
      api.failPatch = (_id, index) => (index === 0 ? null : 500);
      const res = (await shim.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "deactivate_directive",
          arguments: { name: "old-rule", superseded_by: "new-rule" },
        },
      })) as { result: { isError: boolean; content: { text: string }[] } };
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain("INCONSISTENT STATE");
      expect(byId(OWN_BANK, "d-old").is_active).toBe(true);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

// ─── 4. the synthesized tools are never forwarded upstream ────────────────

describe("shim wiring", () => {
  it("advertises both synthesized tools and answers them without an MCP session", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "shim-directive-test-"));
    try {
      const shim = new HindsightShim({
        // /mcp/ on the mock answers 404 — proving the synthesized call never
        // touches the MCP transport, only the REST endpoints.
        url: `${api.baseUrl}/mcp/`,
        bankId: OWN_BANK,
        cacheDir,
        toolsListTimeoutMs: 500,
        logger: () => undefined,
      });
      const list = (await shim.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      })) as { result: { tools: { name: string }[] } };
      const names = list.result.tools.map((t) => t.name);
      for (const n of SYNTHESIZED_TOOL_NAMES) expect(names).toContain(n);

      // From here on, ANY /mcp request would mean the call was forwarded.
      const mark = api.seen.length;
      const res = (await shim.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "deactivate_directive",
          arguments: { name: "old-rule" },
        },
      })) as { result: { isError: boolean } };
      expect(res.result.isError).toBe(false);
      expect(byId(OWN_BANK, "d-old").is_active).toBe(false);
      expect(
        api.seen.slice(mark).some((r) => r.path.startsWith("/mcp")),
        "the synthesized call was forwarded to the MCP transport — upstream " +
          "has no directive-update tool, so a forward is a silent no-op",
      ).toBe(false);
      expect(api.seen.slice(mark).some((r) => r.method === "PATCH")).toBe(true);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("refuses to act when the agent has no pinned bank", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "shim-directive-test-"));
    try {
      const shim = new HindsightShim({
        url: `${api.baseUrl}/mcp/`,
        bankId: "",
        cacheDir,
        logger: () => undefined,
      });
      const res = (await shim.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "reactivate_directive",
          arguments: { name: "retired-rule" },
        },
      })) as { result: { isError: boolean; content: { text: string }[] } };
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain("HINDSIGHT_BANK_ID");
      expect(api.seen).toHaveLength(0);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

// ─── deactivateAllActiveByName — M3 directive-placement campaign entry ─────
//
// Each test asserts the STATE the mock server ends up in (is_active flags,
// which directives survive) and that the row STILL EXISTS after retirement —
// not merely that a code path ran. The rules-block guard test would pass even
// if the marker were ignored, so it asserts BOTH the throw AND that no PATCH
// touched the bank; the reversibility test would pass on a delete-based
// implementation, so it asserts the row is still listable and reactivatable.

describe("deactivateAllActiveByName — M3 campaign deactivate", () => {
  const BANK = "m3-bank";
  let byName: MockApi;

  function m3Fixture(): Record<string, HindsightDirective[]> {
    return {
      [BANK]: [
        {
          id: "d-a1",
          name: "relocated-guardrail",
          content: "First active copy.",
          priority: 6,
          is_active: true,
          tags: ["style"],
        },
        {
          id: "d-a2",
          name: "relocated-guardrail",
          content: "Second active copy (windows-boxes-class duplicate).",
          priority: 4,
          is_active: true,
          tags: [],
        },
        {
          id: "d-off",
          name: "relocated-guardrail",
          content: "A copy already retired by a prior pass.",
          priority: 0,
          is_active: false,
          tags: ["superseded-by:relocated-guardrail"],
        },
        {
          id: "d-rb",
          name: "rules-block-guardrail",
          content: "Belongs in CLAUDE.md rules block, staged until M3 flip.",
          priority: 8,
          is_active: true,
          tags: [RULES_BLOCK_MARKER_TAG],
        },
        {
          id: "d-solo",
          name: "solo-guardrail",
          content: "One active copy.",
          priority: 5,
          is_active: true,
          tags: [],
        },
      ],
    };
  }

  beforeEach(async () => {
    byName = await startMockApi(m3Fixture());
  });
  afterEach(async () => {
    await byName.close();
  });

  const m3Admin = () =>
    new DirectiveAdmin({ apiBaseUrl: byName.baseUrl, bankId: BANK, timeoutMs: 2000 });

  const row = (id: string) => byName.banks[BANK].find((d) => d.id === id)!;

  it("flips is_active=false on the active copy, and it drops out of active-only listing", async () => {
    const admin = m3Admin();
    const result = await admin.deactivateAllActiveByName({ name: "solo-guardrail" });

    expect(result.deactivated.map((d) => d.id)).toEqual(["d-solo"]);
    expect(result.deactivated[0].priority).toBe(5);
    // State: the directive is now inactive on the server.
    expect(row("d-solo").is_active).toBe(false);
    // And gone from an active-only listing (what the recall hook injects).
    const active = await admin.list();
    expect(active.filter((d) => d.is_active).map((d) => d.id)).not.toContain("d-solo");
  });

  it("deactivates EVERY active copy sharing the name, skipping the already-inactive one", async () => {
    const result = await m3Admin().deactivateAllActiveByName({
      name: "relocated-guardrail",
    });
    expect(result.deactivated.map((d) => d.id).sort()).toEqual(["d-a1", "d-a2"]);
    expect(result.alreadyInactive.map((d) => d.id)).toEqual(["d-off"]);
    expect(row("d-a1").is_active).toBe(false);
    expect(row("d-a2").is_active).toBe(false);
    // The already-inactive copy was never re-PATCHed.
    expect(byName.seen.some((r) => r.method === "PATCH" && r.path.endsWith("/d-off"))).toBe(
      false,
    );
  });

  it("is REVERSIBLE: a deactivated directive still exists and can be reactivated", async () => {
    const admin = m3Admin();
    await admin.deactivateAllActiveByName({ name: "solo-guardrail" });
    expect(row("d-solo").is_active).toBe(false);

    // Still present in the bank (not deleted) — visible with active_only=false.
    const all = await admin.list();
    expect(all.map((d) => d.id)).toContain("d-solo");

    // And reactivatable — the whole point of deactivate-not-delete.
    await admin.reactivate({ name: "solo-guardrail" });
    expect(row("d-solo").is_active).toBe(true);
  });

  it("only is_active is PATCHed — never content/name/priority (no guardrail-text rewrite)", async () => {
    await m3Admin().deactivateAllActiveByName({ name: "solo-guardrail" });
    const patch = byName.seen.find((r) => r.method === "PATCH" && r.path.endsWith("/d-solo"));
    expect(patch).toBeDefined();
    expect(patch!.body).toEqual({ is_active: false });
    // Content and priority survived untouched on the server row.
    expect(row("d-solo").content).toBe("One active copy.");
    expect(row("d-solo").priority).toBe(5);
  });

  it("REFUSES a rules-block-marked directive and mutates nothing", async () => {
    const admin = m3Admin();
    await expect(
      admin.deactivateAllActiveByName({ name: "rules-block-guardrail" }),
    ).rejects.toBeInstanceOf(RulesBlockDeactivationRefusedError);
    // Still active — the refusal fired before any PATCH.
    expect(row("d-rb").is_active).toBe(true);
    expect(byName.seen.some((r) => r.method === "PATCH")).toBe(false);
    // The marker was NOT stripped — that is the M3-flip / mark-rules-block job.
    expect(row("d-rb").tags).toContain(RULES_BLOCK_MARKER_TAG);
  });

  it("idempotent: re-running after full deactivation is a clean no-op, not an error", async () => {
    const admin = m3Admin();
    const first = await admin.deactivateAllActiveByName({ name: "relocated-guardrail" });
    expect(first.deactivated).toHaveLength(2);

    // Second run: every copy is now inactive. No throw, empty deactivated,
    // and NO further PATCH reaches the server.
    const patchesBefore = byName.seen.filter((r) => r.method === "PATCH").length;
    const second = await admin.deactivateAllActiveByName({ name: "relocated-guardrail" });
    expect(second.deactivated).toEqual([]);
    expect(second.alreadyInactive.map((d) => d.id).sort()).toEqual(["d-a1", "d-a2", "d-off"]);
    const patchesAfter = byName.seen.filter((r) => r.method === "PATCH").length;
    expect(patchesAfter).toBe(patchesBefore);
  });

  it("throws only when NO directive (active or inactive) carries the name", async () => {
    await expect(
      m3Admin().deactivateAllActiveByName({ name: "never-existed" }),
    ).rejects.toThrow(/no directive named 'never-existed'/);
  });

  it("dry-run computes the plan but issues no PATCH", async () => {
    const admin = m3Admin();
    const result = await admin.deactivateAllActiveByName({
      name: "relocated-guardrail",
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.deactivated.map((d) => d.id).sort()).toEqual(["d-a1", "d-a2"]);
    // Nothing mutated.
    expect(row("d-a1").is_active).toBe(true);
    expect(row("d-a2").is_active).toBe(true);
    expect(byName.seen.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("dry-run still surfaces the rules-block refusal without mutating", async () => {
    await expect(
      m3Admin().deactivateAllActiveByName({ name: "rules-block-guardrail", dryRun: true }),
    ).rejects.toBeInstanceOf(RulesBlockDeactivationRefusedError);
    expect(row("d-rb").is_active).toBe(true);
    expect(byName.seen.some((r) => r.method === "PATCH")).toBe(false);
  });
});
