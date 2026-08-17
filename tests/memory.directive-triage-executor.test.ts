/**
 * Outcome tests for the directive-triage apply-batch executor
 * (carve-M2.md T3, TDD-b/TDD-c, UAT-2/UAT-4; redteam-M2.md §3, §6;
 * PR #4760 review B1/B2/M1/M2/M3).
 *
 * Drives the real modules against a throwaway in-process mock of the
 * hindsight REST API — no live agent bank is touched. Each guard is written
 * to fail on the specific defect it exists to catch:
 *
 *   • rules-block chokepoint  — remove DirectiveAdmin's marker check and a
 *                                mis-classified row (or one whose row.category
 *                                lies about it) gets deactivated anyway
 *   • sequential execution    — run rows via Promise.all and the request
 *                                order assertion breaks
 *   • by-id, not by-name      — deactivate by name in a two-same-name bank
 *                                and `resolve()`'s "ambiguous" error aborts
 *                                the whole batch mid-way
 *   • create-before-deactivate — reorder the reconcile and a simulated
 *                                create-failure leaves the ORIGINAL inactive
 *   • idempotent retry        — reorder to create-a-third-copy-on-retry and
 *                                two actives are left behind
 *   • reversibility           — patch the deactivate path to a no-op and the
 *                                reactivate-then-relist assertion fails
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import {
  DirectiveAdmin,
  RULES_BLOCK_MARKER_TAG,
  type HindsightDirective,
} from "../src/memory/hindsight-directive-admin.js";
import { buildDirectiveTriageRows } from "../src/memory/directive-triage.js";
import type { DirectiveTriageOverride, DirectiveTriageRow } from "../src/memory/directive-triage.js";
import {
  applyDirectiveTriageBatch,
  reconcileDirectiveSuperset,
  RulesBlockDeactivationRefusedError,
} from "../src/memory/directive-triage-executor.js";

interface SeenRequest {
  method: string;
  path: string;
  body: unknown;
}

interface MockApi {
  baseUrl: string;
  server: Server;
  banks: Record<string, HindsightDirective[]>;
  seen: SeenRequest[];
  failCreate: boolean;
  close: () => Promise<void>;
}

let idCounter = 0;

async function startMockApi(banks: Record<string, HindsightDirective[]>): Promise<MockApi> {
  const state: MockApi = {
    baseUrl: "",
    server: undefined as unknown as Server,
    banks,
    seen: [],
    failCreate: false,
    close: async () => undefined,
  };

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
      const m = /^\/v1\/default\/banks\/([^/]+)\/directives(?:\/([^/]+))?$/.exec(rawPath);
      if (!m) return send(404, { detail: "not found" });
      const bank = decodeURIComponent(m[1]);
      const directiveId = m[2] ? decodeURIComponent(m[2]) : undefined;
      const items = state.banks[bank];
      if (!items) return send(404, { detail: "no such bank" });

      if (req.method === "GET" && !directiveId) {
        const activeOnly = (query.get("active_only") ?? "true") !== "false";
        const visible = activeOnly ? items.filter((d) => d.is_active) : items;
        return send(200, { items: visible });
      }
      if (req.method === "POST" && !directiveId) {
        if (state.failCreate) return send(500, { detail: "injected create failure" });
        idCounter += 1;
        const created: HindsightDirective = {
          id: `created-${idCounter}`,
          bank_id: bank,
          name: (body as Record<string, unknown>).name as string,
          content: (body as Record<string, unknown>).content as string,
          priority: ((body as Record<string, unknown>).priority as number) ?? 0,
          is_active: true,
          tags: ((body as Record<string, unknown>).tags as string[]) ?? [],
        };
        items.push(created);
        return send(201, created);
      }
      if (req.method === "PATCH" && directiveId) {
        const target = items.find((d) => d.id === directiveId);
        if (!target) return send(404, { detail: "no such directive" });
        for (const key of Object.keys(body as Record<string, unknown>)) {
          (target as Record<string, unknown>)[key] = (body as Record<string, unknown>)[key];
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

const BANK = "own-bank";

// Seeded INDEPENDENTLY of overlord's target text (tests below), so the
// content-equality assertion in the reconcile tests actually exercises the
// copy rather than comparing a shared constant to itself (carve-M2.md §4
// tautology guard).
const WINDOWS_BOXES_KLANKER_TEXT =
  "klanker's drifted 2,362-char windows-boxes text (fixture stand-in, independent of overlord's)";

function fixtureBanks(): Record<string, HindsightDirective[]> {
  return {
    [BANK]: [
      { id: "d-1", name: "retire-me", content: "stale rule", priority: 5, is_active: true, tags: [] },
      { id: "d-2", name: "rules-block-row", content: "belongs in rules block", priority: 8, is_active: true, tags: [] },
      { id: "d-3", name: "keep-me", content: "genuine guardrail", priority: 3, is_active: true, tags: [] },
      {
        id: "d-4",
        name: "windows-boxes-access-and-full-stop",
        content: WINDOWS_BOXES_KLANKER_TEXT,
        priority: 12,
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

const admin = () => new DirectiveAdmin({ apiBaseUrl: api.baseUrl, bankId: BANK });

describe("applyDirectiveTriageBatch — rules-block refusal (Decision 3, code-enforced)", () => {
  it("does NOT deactivate a row categorised rules-block even when action is (mis-)marked retire, and stamps the marker instead", async () => {
    // Bypass the card generator's own guard to prove the EXECUTOR refuses
    // independently — this is the test that would fail if the refusal were
    // only prose/reviewer discipline instead of a code check.
    const rows = buildDirectiveTriageRows(fixtureBanks()[BANK]!).map((r) =>
      r.name === "rules-block-row" ? { ...r, category: "rules-block" as const, action: "retire" as const } : r,
    );

    const result = await applyDirectiveTriageBatch(admin(), rows);

    expect(result.deactivated).not.toContain("rules-block-row");
    expect(result.stagedRulesBlock).toContain("rules-block-row");

    const listed = await admin().list();
    const rb = listed.find((d) => d.name === "rules-block-row");
    expect(rb?.is_active).not.toBe(false);
    expect(rb?.tags).toContain(RULES_BLOCK_MARKER_TAG);
  });

  it("the admin-level chokepoint refuses even when the ROW LIES (category is NOT rules-block but the directive already carries the marker) — proves B1/B2: the classifier cannot rewrite this invariant", async () => {
    // Simulate a directive that was ALREADY marked rules-block by a prior
    // triage pass, but hand-build a row that (via a bug, a stale cache, or
    // a hostile caller) claims a normal retire classification for it. The
    // executor's own `row.category === "rules-block"` pre-check would NOT
    // catch this — only DirectiveAdmin's chokepoint, reading the real tag
    // off the directive, can.
    const bank = fixtureBanks();
    bank[BANK]!.find((d) => d.id === "d-2")!.tags = [RULES_BLOCK_MARKER_TAG];
    api = await startMockApi(bank);

    const lyingRow: DirectiveTriageRow = {
      id: "d-2",
      name: "rules-block-row",
      priority: 8,
      isActive: true,
      category: "retire",
      signal: "a bug/stale-cache/hostile caller claims this is a normal retire",
      action: "retire",
    };

    const result = await applyDirectiveTriageBatch(admin(), [lyingRow]);
    expect(result.deactivated).not.toContain("rules-block-row");
    expect(result.refusedRulesBlock).toContain("rules-block-row");

    const listed = await admin().list();
    expect(listed.find((d) => d.id === "d-2")?.is_active).not.toBe(false);
  });

  it("throwOnRulesBlockRow: true raises RulesBlockDeactivationRefusedError from the admin-level chokepoint", async () => {
    const bank = fixtureBanks();
    bank[BANK]!.find((d) => d.id === "d-2")!.tags = [RULES_BLOCK_MARKER_TAG];
    api = await startMockApi(bank);
    const lyingRow: DirectiveTriageRow = {
      id: "d-2",
      name: "rules-block-row",
      priority: 8,
      isActive: true,
      category: "retire",
      signal: "lying row",
      action: "retire",
    };
    await expect(
      applyDirectiveTriageBatch(admin(), [lyingRow], { throwOnRulesBlockRow: true }),
    ).rejects.toBeInstanceOf(RulesBlockDeactivationRefusedError);
  });

  it("a legitimate retire row in the SAME batch still lands even when a rules-block row is staged instead", async () => {
    const overrides = new Map<string, DirectiveTriageOverride>([
      ["d-1", { category: "retire", signal: "mechanized, dead weight" }],
    ]);
    const rows = buildDirectiveTriageRows(fixtureBanks()[BANK]!, overrides).map((r) =>
      r.name === "rules-block-row" ? { ...r, category: "rules-block" as const, action: "retire" as const } : r,
    );

    const result = await applyDirectiveTriageBatch(admin(), rows);
    expect(result.deactivated).toContain("retire-me");
    expect(result.stagedRulesBlock).toContain("rules-block-row");
  });

  it("never deactivates a row whose isActive is already false (M2 redteam M1)", async () => {
    const bank = fixtureBanks();
    bank[BANK]!.find((d) => d.id === "d-1")!.is_active = false;
    api = await startMockApi(bank);

    const inactiveRow: DirectiveTriageRow = {
      id: "d-1",
      name: "retire-me",
      priority: 5,
      isActive: false,
      category: "retire",
      signal: "already inactive, should be a no-op",
      action: "retire",
    };
    const result = await applyDirectiveTriageBatch(admin(), [inactiveRow]);
    expect(result.deactivated).toEqual([]);
    expect(result.kept).toContain("retire-me");
  });
});

describe("applyDirectiveTriageBatch — resolves by id, not name (M2 redteam M1)", () => {
  it("survives a same-name-duplicate bank state that would make `resolve()` throw 'ambiguous'", async () => {
    // Simulate the state right after a windows-boxes-class reconcile has
    // created the new superset copy but not yet deactivated the old one:
    // two directives share a name. A by-NAME deactivate would hit
    // `resolve()`'s ambiguous-name error and abort the whole batch.
    const bank = fixtureBanks();
    bank[BANK]!.push({
      id: "d-1-dup",
      name: "retire-me",
      content: "duplicate name, different id",
      priority: 5,
      is_active: true,
      tags: [],
    });
    api = await startMockApi(bank);

    const overrides = new Map<string, DirectiveTriageOverride>([
      ["d-1", { category: "retire", signal: "targets id d-1 specifically" }],
    ]);
    const rows = buildDirectiveTriageRows(bank[BANK]!, overrides).filter((r) => r.id === "d-1");

    const result = await applyDirectiveTriageBatch(admin(), rows);
    expect(result.deactivated).toEqual(["retire-me"]);

    const listed = await admin().list();
    expect(listed.find((d) => d.id === "d-1")?.is_active).toBe(false);
    // The same-named duplicate (a DIFFERENT id) was never touched.
    expect(listed.find((d) => d.id === "d-1-dup")?.is_active).not.toBe(false);
  });
});

describe("applyDirectiveTriageBatch — apply lands via the shim path, reversible (UAT-2)", () => {
  it("deactivates marked rows, leaves untouched rows active, and reactivate restores it", async () => {
    const overrides = new Map<string, DirectiveTriageOverride>([
      ["d-1", { category: "retire", signal: "superseded / dead weight" }],
    ]);
    const rows = buildDirectiveTriageRows(fixtureBanks()[BANK]!, overrides);

    const result = await applyDirectiveTriageBatch(admin(), rows);
    expect(result.deactivated).toEqual(["retire-me"]);

    const afterDeactivate = await admin().list();
    expect(afterDeactivate.find((d) => d.name === "retire-me")?.is_active).toBe(false);
    expect(afterDeactivate.find((d) => d.name === "keep-me")?.is_active).not.toBe(false);

    // Every write for "retire-me" went through PATCH on its own directive id
    // (the DirectiveAdmin/shim path), never a raw create/delete.
    const patchesForRetireMe = api.seen.filter((r) => r.method === "PATCH" && r.path.endsWith("/d-1"));
    expect(patchesForRetireMe.length).toBeGreaterThan(0);

    await admin().reactivate({ name: "retire-me" });
    const afterReactivate = await admin().list();
    expect(afterReactivate.find((d) => d.name === "retire-me")?.is_active).toBe(true);
  });

  it("runs rows sequentially, never concurrently (redteam-M2.md §7)", async () => {
    const overrides = new Map<string, DirectiveTriageOverride>([
      ["d-1", { category: "retire", signal: "dead weight" }],
      ["d-3", { category: "retire", signal: "category-error, already held as memory" }],
    ]);
    const rows = buildDirectiveTriageRows(fixtureBanks()[BANK]!, overrides);
    await applyDirectiveTriageBatch(admin(), rows);

    const patchRequests = api.seen.filter((r) => r.method === "PATCH");
    // Two independent deactivations against a mock server with no artificial
    // delay will still show up in send order — assert the PATCH targets
    // appear in the SAME order the rows were passed in, which sequential
    // (awaited) execution guarantees and Promise.all does not.
    const order = patchRequests.map((r) => r.path.split("/").pop());
    expect(order).toEqual(["d-1", "d-3"]);
  });
});

describe("reconcileDirectiveSuperset — windows-boxes-class fix, create+deactivate, Shape α by construction (TDD-c, UAT-4)", () => {
  const klankerText = WINDOWS_BOXES_KLANKER_TEXT;
  const overlordText = "overlord's 3,567-char windows-boxes SUPERSET text (fixture stand-in, independent of klanker's)";

  it("create-first: exactly one ACTIVE windows-boxes-named directive post-call, content byte-identical to target", async () => {
    const result = await reconcileDirectiveSuperset(admin(), {
      name: "windows-boxes-access-and-full-stop",
      newContent: overlordText,
    });

    const listed = await admin().list();
    const named = listed.filter((d) => d.name === "windows-boxes-access-and-full-stop");
    const active = named.filter((d) => d.is_active !== false);
    const inactive = named.filter((d) => d.is_active === false);

    // (i) old directive is_active:false with a superseded-by tag
    expect(inactive).toHaveLength(1);
    expect(inactive[0]!.content).toBe(klankerText);
    expect(inactive[0]!.tags).toEqual(expect.arrayContaining(["superseded-by:windows-boxes-access-and-full-stop"]));

    // (ii) exactly one ACTIVE windows-boxes-named directive exists post-call
    expect(active).toHaveLength(1);

    // (iii) its content is byte-identical to the independently-seeded target,
    // and it carries a `supersedes:` tag for provenance symmetry.
    expect(active[0]!.content).toBe(overlordText);
    expect(active[0]!.id).toBe(result.createdId);
    expect(active[0]!.tags).toEqual(
      expect.arrayContaining(["supersedes:windows-boxes-access-and-full-stop"]),
    );
    expect(inactive[0]!.id).toBe(result.deactivatedOldIds[0]);
    expect(result.deactivatedOldIds).toHaveLength(1);
    expect(result.reused).toBe(false);
  });

  it("create runs BEFORE deactivate — request order assertion", async () => {
    await reconcileDirectiveSuperset(admin(), {
      name: "windows-boxes-access-and-full-stop",
      newContent: overlordText,
    });
    const mutations = api.seen.filter((r) => r.method === "POST" || r.method === "PATCH");
    expect(mutations[0]!.method).toBe("POST");
    expect(mutations.some((r) => r.method === "PATCH")).toBe(true);
    expect(mutations.findIndex((r) => r.method === "POST")).toBeLessThan(
      mutations.findIndex((r) => r.method === "PATCH"),
    );
  });

  it("a simulated create-failure leaves the ORIGINAL directive untouched and active (redteam-M2.md §6)", async () => {
    api.failCreate = true;
    await expect(
      reconcileDirectiveSuperset(admin(), {
        name: "windows-boxes-access-and-full-stop",
        newContent: overlordText,
      }),
    ).rejects.toThrow();

    const listed = await admin().list();
    const original = listed.find((d) => d.name === "windows-boxes-access-and-full-stop");
    expect(original?.is_active).not.toBe(false);
    expect(original?.content).toBe(klankerText);
    // No orphan copy created either.
    expect(listed.filter((d) => d.name === "windows-boxes-access-and-full-stop")).toHaveLength(1);
  });

  it("is idempotent/recoverable across a deactivate-step failure retry — never leaves two actives, never creates a third copy (M2 redteam M2)", async () => {
    // First call: simulate the deactivate step failing by pre-seeding the
    // bank with the superset copy ALREADY created (content-matching), as if
    // a prior reconcile call created it and then crashed before the
    // deactivate step ran.
    const bank = fixtureBanks();
    bank[BANK]!.push({
      id: "already-created",
      name: "windows-boxes-access-and-full-stop",
      content: overlordText,
      priority: 12,
      is_active: true,
      tags: ["supersedes:windows-boxes-access-and-full-stop"],
    });
    api = await startMockApi(bank);

    const result = await reconcileDirectiveSuperset(admin(), {
      name: "windows-boxes-access-and-full-stop",
      newContent: overlordText,
    });

    // Reused the existing copy — did NOT create a third.
    expect(result.reused).toBe(true);
    expect(result.createdId).toBe("already-created");
    const createRequests = api.seen.filter((r) => r.method === "POST");
    expect(createRequests).toHaveLength(0);

    // Exactly one active windows-boxes-named directive remains; the
    // pre-existing klanker copy (d-4) was deactivated by id.
    const listed = await admin().list();
    const named = listed.filter((d) => d.name === "windows-boxes-access-and-full-stop");
    const active = named.filter((d) => d.is_active !== false);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe("already-created");
    expect(result.deactivatedOldIds).toEqual(["d-4"]);
    expect(listed.find((d) => d.id === "d-4")?.is_active).toBe(false);
  });
});
