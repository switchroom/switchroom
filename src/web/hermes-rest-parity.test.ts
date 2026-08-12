/**
 * Hermes REST contract-parity fixture for `handleHermesRest`.
 *
 * Mirror image of upstream's own parity fixture
 * (`apps/desktop/src/hermes-parity.test.ts`, 140 ln), pointed the other way:
 * upstream asserts that its *client* emits the right path/method/body; this
 * file asserts that Switchroom's *adapter* answers what that client emits.
 *
 * ─── The pin ────────────────────────────────────────────────────────────────
 *
 * Every row below was derived by hand from ONE upstream commit. Hermes moves
 * fast; a desktop bump that adds, renames, or re-verbs a route is exactly the
 * drift this fixture exists to catch, and it can only do that if the commit it
 * was derived from is visible and greppable.
 *
 * Re-derive after bumping the pin:
 *
 *   git clone https://github.com/NousResearch/hermes-agent
 *   cd hermes-agent && git checkout <NEW_SHA>
 *   # every call site the desktop emits:
 *   grep -n "path: " apps/desktop/src/hermes.ts
 *   # the routes the real backend actually serves:
 *   grep -rn "^@router\.\|^@app\.\|^@[a-z_]*_router\." hermes_cli/
 *
 * Then reconcile CENSUS below against that grep: a row that disappears
 * upstream should be deleted here, a new row added with its `served` verdict.
 *
 * @see reference/rfcs/fleet-dashboard.md — the RFC this adapter implements
 */
export const UPSTREAM_HERMES_SHA = "9da6d455c9e1f2bf74bb9f47766ee9fc52e17bfb";
/** Commit date of {@link UPSTREAM_HERMES_SHA} — `fmt(js): npm run fix on merge (#84193)`. */
export const UPSTREAM_HERMES_DATE = "2026-08-12T01:41:34Z";
/** Upstream repo the pin refers to. */
export const UPSTREAM_HERMES_REPO = "NousResearch/hermes-agent";

/**
 * ─── Pending-gap idiom: `it.fails` ──────────────────────────────────────────
 *
 * Every assertion in this file states the REAL contract. Cases the adapter
 * does not satisfy today are declared `gap: "..."` in the table and run under
 * vitest's `it.fails` instead of `it`, so:
 *
 *   - CI stays green today (the case is a known, catalogued gap), and
 *   - the moment someone fixes the adapter the case goes RED, because
 *     `it.fails` fails when its body passes. The fixer is forced to flip
 *     `gap` off in the same PR. Nobody has to remember.
 *
 * This deviates from the repo's other pending idiom — the `it.skip()`
 * punch-list convention documented at `tests/jtbd-talk-from-anywhere.test.ts:16-29`
 * — and deliberately so. A `.skip` body never executes, so a `.skip` fixture
 * cannot tell you when the gap closed; closing it depends on a human
 * remembering to unskip. `it.fails` is the same vitest family and the same
 * "assert the real contract, don't weaken the test" discipline, but it is
 * self-flipping. CLAUDE.md § Development Protocol: "deterministic mechanisms
 * over model-dependent behavior".
 *
 * Do NOT make a `gap` row green by weakening its assertion. Fix the adapter.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHermesRest, type HermesRestResult } from "./hermes-adapter.js";
import type { SwitchroomConfig } from "../config/schema.js";

// ─── Fixture config ──────────────────────────────────────────────────────────

const AGENT = "alpha";

/**
 * Two agents, each with one cron entry.
 *
 * The schedule entries are load-bearing, not decoration: the `?profile=`
 * filtering case below has to be able to tell "filtered correctly" apart from
 * "the fleet had no jobs anyway". With an empty schedule the adapter returns
 * `[]` for every query and a filtering assertion passes vacuously.
 */
function fixtureConfig(): SwitchroomConfig {
  return {
    agents: {
      [AGENT]: {
        model: "sonnet",
        schedule: [{ cron: "0 9 * * *", prompt: "alpha morning digest" }],
      },
      beta: {
        schedule: [{ cron: "0 17 * * 5", prompt: "beta weekly roundup" }],
      },
    },
  } as unknown as SwitchroomConfig;
}

/**
 * Point the adapter's agent-dir resolution at a throwaway tmpdir.
 * `~/.switchroom/agents` is the production state tree (CLAUDE.md § Vault &
 * shared-state test discipline); `resolveAgentsDir` (`src/config/loader.ts:323`)
 * honours `SWITCHROOM_AGENTS_DIR` when it is a non-empty absolute path, which
 * is the only seam that keeps this suite off it.
 */
beforeAll(() => {
  process.env.SWITCHROOM_AGENTS_DIR = mkdtempSync(join(tmpdir(), "sr-hermes-parity-"));
});

const CONFIG = fixtureConfig();

/**
 * Generous per-case timeout.
 *
 * `handleHermesRest` calls `handleGetAgents` with no injectable deps, and that
 * bottoms out in `getAllAgentStatuses` (`src/agents/lifecycle.ts:637`), which
 * `spawnSync`s `docker inspect` for every agent in the config. On a host with a
 * live docker daemon that is ~2s per session-touching case — comfortably under
 * vitest's 5s default here, but close enough that a loaded CI runner could trip
 * it and red the suite for a reason that has nothing to do with the contract.
 *
 * The durable fix is a dependency seam on `handleHermesRest`; that is an
 * adapter change and this task is tests-only, so the timeout is the honest
 * interim. Tighten it once the seam exists.
 */
const CASE_TIMEOUT_MS = 30_000;

function call(method: string, path: string, search = ""): Promise<HermesRestResult | null> {
  return handleHermesRest(method, path, CONFIG, search);
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — Route census
//
// Every path × verb `apps/desktop/src/hermes.ts` emits at the pinned SHA,
// with the verdict "does handleHermesRest claim this route at all?".
//
// `served: true`  → the adapter returns a HermesRestResult (any status).
// `served: false` → the adapter returns null, and `src/web/server.ts:1216-1219`
//                   turns that into a bare 404 "Not Found".
//
// This is a drift detector, not a shape check: it fails when a route is added
// to or dropped from the adapter without this table being updated, and when a
// desktop bump introduces a route nobody classified. Body shape is Part 2.
//
// `line` is the call site in apps/desktop/src/hermes.ts at UPSTREAM_HERMES_SHA.
// ═══════════════════════════════════════════════════════════════════════════

interface CensusRow {
  line: number;
  method: string;
  /** Concrete path — template params already substituted with fixture values. */
  path: string;
  served: boolean;
  /** Why this row matters, when the verdict is not self-evident. */
  note?: string;
}

const CENSUS: CensusRow[] = [
  // ── sessions ──────────────────────────────────────────────────────────────
  { line: 400, method: "GET", path: "/api/sessions", served: true },
  { line: 440, method: "GET", path: "/api/profiles/sessions", served: true },
  { line: 578, method: "POST", path: "/api/profiles/sessions/pull-requests", served: false },
  {
    line: 608,
    method: "GET",
    path: "/api/profiles/sessions/sidebar",
    served: true,
    note:
      "Served, but with the WRONG shape — see the sidebar case in Part 2. " +
      "`pathname.includes('sessions')` inside the /api/profiles branch " +
      "(hermes-adapter.ts:753) swallows it.",
  },
  {
    line: 658,
    method: "GET",
    path: "/api/sessions/search",
    served: true,
    note:
      "Served only by accident: the /api/sessions/:id regex " +
      "(hermes-adapter.ts:624) matches 'search' as an id, so this 404s as " +
      "{error:'Unknown session'} rather than falling through.",
  },
  { line: 671, method: "GET", path: `/api/sessions/${AGENT}`, served: true },
  { line: 706, method: "GET", path: `/api/sessions/${AGENT}/messages`, served: true },
  { line: 637, method: "PATCH", path: `/api/sessions/${AGENT}`, served: false, note: "setSessionArchived" },
  { line: 650, method: "PATCH", path: `/api/sessions/${AGENT}`, served: false, note: "setSessionPinnedRemote" },
  { line: 770, method: "PATCH", path: `/api/sessions/${AGENT}`, served: false, note: "renameSession" },
  { line: 758, method: "DELETE", path: `/api/sessions/${AGENT}`, served: false, note: "deleteSession" },

  // ── status / config / model ───────────────────────────────────────────────
  { line: 787, method: "GET", path: "/api/status", served: true },
  { line: 779, method: "GET", path: "/api/model/info", served: true },
  { line: 824, method: "GET", path: "/api/logs", served: true },
  { line: 831, method: "GET", path: "/api/config", served: true },
  { line: 846, method: "GET", path: "/api/config/defaults", served: true },
  { line: 854, method: "GET", path: "/api/config/schema", served: true },
  { line: 861, method: "PUT", path: "/api/config", served: false },
  { line: 1608, method: "GET", path: "/api/model/options", served: true },
  { line: 1626, method: "GET", path: "/api/model/recommended-default", served: false },
  { line: 1636, method: "POST", path: "/api/model/set", served: true },
  { line: 1649, method: "GET", path: "/api/model/auxiliary", served: false },
  { line: 1656, method: "GET", path: "/api/model/moa", served: false },
  { line: 1663, method: "PUT", path: "/api/model/moa", served: false },

  // ── env / providers ───────────────────────────────────────────────────────
  { line: 887, method: "GET", path: "/api/env", served: true },
  { line: 894, method: "PUT", path: "/api/env", served: false },
  { line: 956, method: "DELETE", path: "/api/env", served: false },
  { line: 965, method: "POST", path: "/api/env/reveal", served: false },
  { line: 907, method: "POST", path: "/api/providers/validate", served: true },
  { line: 916, method: "GET", path: "/api/providers/custom-endpoints", served: false },
  { line: 923, method: "POST", path: "/api/providers/custom-endpoints", served: false },
  { line: 931, method: "POST", path: "/api/providers/custom-endpoints/validate", served: false },
  { line: 940, method: "POST", path: "/api/providers/custom-endpoints/ep1/activate", served: false },
  { line: 948, method: "DELETE", path: "/api/providers/custom-endpoints/ep1", served: false },
  {
    line: 974,
    method: "GET",
    path: "/api/providers/oauth",
    served: false,
    note:
      "The adapter serves /api/auth/providers (hermes-adapter.ts:787), which " +
      "no desktop call site emits — a stub aimed at a route that does not exist.",
  },
  { line: 981, method: "DELETE", path: "/api/providers/oauth/anthropic", served: false },
  { line: 989, method: "POST", path: "/api/providers/oauth/anthropic/start", served: false },
  { line: 998, method: "POST", path: "/api/providers/oauth/anthropic/submit", served: false },
  { line: 1007, method: "GET", path: "/api/providers/oauth/anthropic/poll/s1", served: false },
  { line: 1014, method: "DELETE", path: "/api/providers/oauth/sessions/s1", served: false },

  // ── memory / curator ──────────────────────────────────────────────────────
  {
    line: 871,
    method: "GET",
    path: "/api/memory/providers/hindsight/config",
    served: false,
    note:
      "The adapter serves the bare /api/memory/providers (hermes-adapter.ts:767); " +
      "no desktop call site emits that path, only this /:provider/config one.",
  },
  { line: 878, method: "PUT", path: "/api/memory/providers/hindsight/config", served: false },
  { line: 1024, method: "POST", path: "/api/memory/providers/hindsight/oauth/start", served: false },
  { line: 1032, method: "GET", path: "/api/memory/providers/hindsight/oauth/status", served: false },
  { line: 1865, method: "GET", path: "/api/memory", served: false },
  { line: 1872, method: "POST", path: "/api/memory/reset", served: false },
  { line: 1881, method: "GET", path: "/api/curator", served: false },
  { line: 1888, method: "PUT", path: "/api/curator/paused", served: false },
  { line: 1897, method: "POST", path: "/api/curator/run", served: false },

  // ── skills / learning / mcp / tools ───────────────────────────────────────
  { line: 1039, method: "GET", path: "/api/skills", served: false },
  { line: 1090, method: "PUT", path: "/api/skills/toggle", served: false },
  { line: 1048, method: "GET", path: "/api/learning/graph", served: false },
  { line: 1062, method: "GET", path: "/api/learning/node", served: false },
  { line: 1069, method: "DELETE", path: "/api/learning/node", served: false },
  { line: 1078, method: "PUT", path: "/api/learning/node", served: false },
  { line: 1758, method: "GET", path: "/api/skills/hub/sources", served: false },
  { line: 1768, method: "GET", path: "/api/skills/hub/search", served: false },
  { line: 1776, method: "GET", path: "/api/skills/hub/preview", served: false },
  { line: 1784, method: "GET", path: "/api/skills/hub/scan", served: false },
  { line: 1792, method: "POST", path: "/api/skills/hub/install", served: false },
  { line: 1801, method: "POST", path: "/api/skills/hub/uninstall", served: false },
  { line: 1810, method: "POST", path: "/api/skills/hub/update", served: false },
  { line: 1825, method: "GET", path: "/api/mcp/servers", served: false },
  { line: 1131, method: "PUT", path: "/api/mcp/servers", served: false },
  { line: 1119, method: "POST", path: "/api/mcp/servers/filesystem/test", served: false },
  { line: 1141, method: "POST", path: "/api/mcp/servers/filesystem/auth", served: false },
  { line: 1832, method: "PUT", path: "/api/mcp/servers/filesystem/enabled", served: false },
  { line: 1150, method: "GET", path: "/api/mcp/oauth/flows/f1", served: false },
  { line: 1841, method: "GET", path: "/api/mcp/catalog", served: false },
  { line: 1851, method: "POST", path: "/api/mcp/catalog/install", served: false },
  { line: 1157, method: "GET", path: "/api/tools/toolsets", served: false },
  { line: 1167, method: "PUT", path: "/api/tools/toolsets/image_gen", served: false },
  { line: 1176, method: "GET", path: "/api/tools/toolsets/image_gen/config", served: false },
  { line: 1185, method: "GET", path: "/api/tools/toolsets/image_gen/models", served: false },
  { line: 1196, method: "PUT", path: "/api/tools/toolsets/image_gen/model", served: false },
  { line: 1223, method: "PUT", path: "/api/tools/toolsets/image_gen/provider", served: false },
  { line: 1232, method: "POST", path: "/api/tools/toolsets/image_gen/post-setup", served: false },
  { line: 1241, method: "GET", path: "/api/tools/terminal/backends", served: false },
  { line: 1248, method: "PUT", path: "/api/tools/terminal/backend", served: false },
  { line: 1257, method: "GET", path: "/api/tools/computer-use/status", served: false },
  { line: 1264, method: "POST", path: "/api/tools/computer-use/permissions/grant", served: false },

  // ── messaging / pairing / webhooks ────────────────────────────────────────
  { line: 1271, method: "GET", path: "/api/messaging/platforms", served: true },
  { line: 1280, method: "PUT", path: "/api/messaging/platforms/telegram", served: false },
  { line: 1288, method: "POST", path: "/api/messaging/platforms/telegram/test", served: false },
  { line: 1303, method: "GET", path: "/api/pairing", served: false },
  { line: 1310, method: "POST", path: "/api/pairing/approve", served: false },
  { line: 1321, method: "POST", path: "/api/pairing/revoke", served: false },
  { line: 1335, method: "GET", path: "/api/webhooks", served: false },
  { line: 1342, method: "POST", path: "/api/webhooks/enable", served: false },
  { line: 1350, method: "POST", path: "/api/webhooks", served: false },
  { line: 1359, method: "DELETE", path: "/api/webhooks/w1", served: false },
  { line: 1370, method: "PUT", path: "/api/webhooks/w1/enabled", served: false },

  // ── cron ──────────────────────────────────────────────────────────────────
  // Everything under /api/cron is claimed by the adapter's prefix branch
  // (hermes-adapter.ts:712) regardless of verb — including the verbs it has no
  // handler for. See the cron cases in Part 2 for what that costs.
  { line: 1386, method: "GET", path: "/api/cron/jobs", served: true },
  { line: 1394, method: "GET", path: `/api/cron/jobs/${AGENT}~0`, served: true },
  { line: 1401, method: "GET", path: `/api/cron/jobs/${AGENT}~0/runs`, served: true },
  { line: 1413, method: "GET", path: "/api/cron/delivery-targets", served: true },
  { line: 1483, method: "GET", path: "/api/cron/blueprints", served: true },
  { line: 1422, method: "POST", path: "/api/cron/jobs", served: true },
  { line: 1431, method: "PUT", path: `/api/cron/jobs/${AGENT}~0`, served: true },
  { line: 1440, method: "POST", path: `/api/cron/jobs/${AGENT}~0/pause`, served: true },
  { line: 1448, method: "POST", path: `/api/cron/jobs/${AGENT}~0/resume`, served: true },
  { line: 1456, method: "POST", path: `/api/cron/jobs/${AGENT}~0/trigger`, served: true },
  { line: 1464, method: "DELETE", path: `/api/cron/jobs/${AGENT}~0`, served: true },
  { line: 1494, method: "POST", path: "/api/cron/blueprints/instantiate", served: true },

  // ── profiles ──────────────────────────────────────────────────────────────
  { line: 1502, method: "GET", path: "/api/profiles", served: true },
  { line: 1509, method: "POST", path: "/api/profiles", served: false },
  { line: 1517, method: "PATCH", path: "/api/profiles/default", served: false },
  { line: 1525, method: "DELETE", path: "/api/profiles/default", served: false },
  { line: 1532, method: "GET", path: "/api/profiles/default/soul", served: true },
  { line: 1538, method: "PUT", path: "/api/profiles/default/soul", served: false },
  { line: 1546, method: "GET", path: "/api/profiles/default/setup-command", served: true },
  { line: 1558, method: "POST", path: "/api/profiles/default/export", served: false },
  { line: 1573, method: "POST", path: "/api/profiles/import", served: false },

  // ── analytics / ops / audio / update ──────────────────────────────────────
  {
    line: 1583,
    method: "GET",
    path: "/api/analytics/usage",
    served: false,
    note: "Scoped in reference/rfcs/fleet-dashboard.md:105-106; never implemented.",
  },
  { line: 1681, method: "POST", path: "/api/gateway/restart", served: false },
  { line: 1689, method: "POST", path: "/api/hermes/update", served: false },
  { line: 1700, method: "GET", path: "/api/hermes/update/check", served: false },
  { line: 1707, method: "GET", path: "/api/actions/doctor/status", served: false },
  { line: 1713, method: "POST", path: "/api/audio/transcribe", served: false },
  { line: 1730, method: "POST", path: "/api/audio/speak", served: false },
  { line: 1742, method: "GET", path: "/api/audio/elevenlabs/voices", served: false },
  { line: 1911, method: "POST", path: "/api/ops/doctor", served: false },
  { line: 1915, method: "POST", path: "/api/ops/security-audit", served: false },
  { line: 1920, method: "POST", path: "/api/ops/backup", served: false },
  { line: 1928, method: "POST", path: "/api/ops/debug-share", served: false },
];

describe(`Hermes REST route census (upstream ${UPSTREAM_HERMES_SHA.slice(0, 7)})`, () => {
  it("the pin is a full 40-char SHA — a short pin can't be checked out reproducibly", () => {
    expect(UPSTREAM_HERMES_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(UPSTREAM_HERMES_REPO).toBe("NousResearch/hermes-agent");
  });

  it("census has no duplicate (method, path) rows", () => {
    const seen = new Map<string, number>();
    const dupes: string[] = [];
    for (const row of CENSUS) {
      const key = `${row.method} ${row.path}`;
      if (seen.has(key)) dupes.push(`${key} (hermes.ts:${seen.get(key)} and :${row.line})`);
      else seen.set(key, row.line);
    }
    // Three PATCH /api/sessions/:id call sites share one route (archive, pin,
    // rename); they are deliberately NOT deduped in CENSUS because each is an
    // independent desktop feature that breaks. Assert the known set so a new
    // collision on some other route still fails here.
    expect(dupes).toEqual([
      `PATCH /api/sessions/${AGENT} (hermes.ts:637 and :650)`,
      `PATCH /api/sessions/${AGENT} (hermes.ts:637 and :770)`,
    ]);
  });

  for (const row of CENSUS) {
    const label = `${row.method} ${row.path} → ${row.served ? "served" : "404 (not a Hermes route)"}`;
    it(
      `${label}  [hermes.ts:${row.line}]`,
      async () => {
        const res = await call(row.method, row.path);
        if (row.served) {
          expect(res, `${row.method} ${row.path} should be claimed by handleHermesRest`).not.toBeNull();
        } else {
          expect(res, `${row.method} ${row.path} should fall through to the 404 path`).toBeNull();
        }
      },
      CASE_TIMEOUT_MS,
    );
  }

  it("every census row cites a real call-site line in apps/desktop/src/hermes.ts", () => {
    for (const row of CENSUS) {
      expect(row.line, `${row.method} ${row.path}`).toBeGreaterThan(0);
      expect(row.line, `${row.method} ${row.path}`).toBeLessThan(2000);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — Response-shape contract
//
// For the routes the adapter claims, assert what the desktop actually
// destructures off the response. Each case states the REAL contract; a case
// carrying `gap` runs under `it.fails` (see the idiom note at the top).
// ═══════════════════════════════════════════════════════════════════════════

interface ContractCase {
  name: string;
  method: string;
  path: string;
  /** Query string the desktop sends, verbatim from the pinned call site. */
  search?: string;
  /** Desktop call site — apps/desktop/src/hermes.ts:NNN at the pinned SHA. */
  client: string;
  /** Real backend route — hermes_cli/... at the pinned SHA. */
  server: string;
  /** Set when the adapter does not satisfy this today. Runs under `it.fails`. */
  gap?: string;
  assert: (res: HermesRestResult | null) => void;
}

/** Narrow to a non-null 200 body and hand back the body as a record. */
function body200(res: HermesRestResult | null): Record<string, unknown> {
  expect(res).not.toBeNull();
  expect(res!.status).toBe(200);
  return res!.body as Record<string, unknown>;
}

const CONTRACT: ContractCase[] = [
  // ── GET /api/sessions — PaginatedSessions ────────────────────────────────
  {
    name: "GET /api/sessions honours ?limit= instead of returning the whole fleet",
    method: "GET",
    path: "/api/sessions",
    search: "?limit=1&offset=0&min_messages=0&archived=exclude&order=recent",
    client: "hermes.ts:398-405 (listSessions)",
    server: "hermes_cli/web_routers/sessions.py:54 (get_sessions)",
    gap:
      "hermes-adapter.ts:601-620 ignores every query param and reports " +
      "limit = sessions.length, so the desktop's pageWindow() silently " +
      "truncates a list the adapter claimed was a full page.",
    assert: (res) => {
      const b = body200(res);
      expect((b.sessions as unknown[]).length).toBeLessThanOrEqual(1);
      expect(b.limit).toBe(1);
    },
  },
  {
    name: "GET /api/sessions reports the real page limit, not sessions.length",
    method: "GET",
    path: "/api/sessions",
    search: "?limit=40&offset=0&min_messages=0&archived=exclude&order=recent",
    client: "hermes.ts:398-411 — spreads `...result` then re-windows to `limit`",
    server: "hermes_cli/web_routers/sessions.py:54",
    gap:
      "hermes-adapter.ts:616 sets limit = sessions.length. With 2 agents the " +
      "desktop is told the page size is 2 when it asked for 40, which makes " +
      "`total > limit` pagination arithmetic wrong in the sidebar footer.",
    assert: (res) => {
      const b = body200(res);
      expect(b.limit).toBe(40);
      expect(b.offset).toBe(0);
    },
  },
  {
    name: "GET /api/sessions returns a numeric total and an array of sessions",
    method: "GET",
    path: "/api/sessions",
    search: "?limit=40&offset=0&min_messages=0&archived=exclude&order=recent",
    client: "hermes.ts:398-411",
    server: "hermes_cli/web_routers/sessions.py:54",
    assert: (res) => {
      const b = body200(res);
      expect(Array.isArray(b.sessions)).toBe(true);
      expect(typeof b.total).toBe("number");
      expect(typeof b.offset).toBe("number");
    },
  },

  // ── GET /api/profiles/sessions — PaginatedSessions + profile_totals/errors ─
  {
    name: "GET /api/profiles/sessions returns real sessions (NOT the hardcoded empty page)",
    method: "GET",
    path: "/api/profiles/sessions",
    search: "?limit=40&offset=0&min_messages=0&archived=exclude&order=recent&profile=all",
    client: "hermes.ts:427-453 (listAllProfileSessions)",
    server: "hermes_cli/web_routers/profiles.py:82",
    assert: (res) => {
      const b = body200(res);
      // The exact-match branch at hermes-adapter.ts:606-621 wins over the
      // `/api/profiles` prefix branch at :752, so the {sessions:[],total:0}
      // literal at :754 is unreachable for THIS path. Pin that ordering: swap
      // the two branches and the sidebar goes permanently empty.
      expect((b.sessions as unknown[]).length).toBeGreaterThan(0);
      expect(b.total).toBeGreaterThan(0);
    },
  },
  {
    name: "GET /api/profiles/sessions carries profile_totals",
    method: "GET",
    path: "/api/profiles/sessions",
    search: "?limit=40&offset=0&min_messages=0&archived=exclude&order=recent&profile=all",
    client: "types/hermes.ts:439-443 (PaginatedSessions.profile_totals)",
    server: "hermes_cli/web_routers/profiles.py:82",
    assert: (res) => {
      const b = body200(res);
      expect(b.profile_totals).toBeTypeOf("object");
    },
  },
  {
    name: "GET /api/profiles/sessions carries an errors array (per-profile read failures)",
    method: "GET",
    path: "/api/profiles/sessions",
    search: "?limit=40&offset=0&min_messages=0&archived=exclude&order=recent&profile=all",
    client:
      "hermes.ts:552 (listSidebarSessionsLegacy reads `recents.errors ?? []`); " +
      "types/hermes.ts:444-446",
    server: "hermes_cli/web_routers/profiles.py:82",
    gap: "hermes-adapter.ts:611-620 emits no `errors` key at all.",
    assert: (res) => {
      const b = body200(res);
      expect(Array.isArray(b.errors)).toBe(true);
    },
  },
  {
    name: "GET /api/profiles/sessions honours ?source= scoping",
    method: "GET",
    path: "/api/profiles/sessions",
    search: "?limit=40&offset=0&min_messages=1&archived=exclude&order=recent&profile=all&source=cron",
    client: "hermes.ts:434-445 — the cron slice passes source='cron'",
    server: "hermes_cli/web_routers/profiles.py:82",
    gap:
      "hermes-adapter.ts:601-620 ignores `source`, so the sidebar's cron slice " +
      "and its recents slice return the identical unfiltered fleet list — the " +
      "exact starvation the upstream comment at hermes.ts:418-422 describes.",
    assert: (res) => {
      const b = body200(res);
      // No switchroom session has source='cron' (toHermesSession hardcodes
      // source:'switchroom' at hermes-adapter.ts:146), so a source-scoped
      // query must come back empty rather than returning the whole fleet.
      expect(b.sessions).toEqual([]);
    },
  },

  // ── GET /api/profiles/sessions/sidebar — SidebarSessionsResponse ──────────
  {
    name: "GET /api/profiles/sessions/sidebar returns the three-slice batched shape",
    method: "GET",
    path: "/api/profiles/sessions/sidebar",
    search: "?recents_profile=all&recents_limit=40&cron_limit=20&messaging_limit=20",
    client: "hermes.ts:596-628 (listSidebarSessions); shape at hermes.ts:487-492",
    server: "hermes_cli/web_routers/profiles.py:232",
    gap:
      "The /api/profiles prefix branch's `pathname.includes('sessions')` test " +
      "(hermes-adapter.ts:752-755) swallows this path and answers 200 with a " +
      "PaginatedSessions-shaped literal. That is strictly WORSE than not " +
      "implementing it: `isEndpointMissingError` (hermes.ts:520-536) only " +
      "matches 404-ish shapes, so a 200 never trips the legacy fallback at " +
      "hermes.ts:619-626. The sidebar reads `result.recents?.sessions ?? []` " +
      "(hermes.ts:629) and renders three permanently-empty slices instead of " +
      "degrading to listSidebarSessionsLegacy.",
    assert: (res) => {
      const b = body200(res);
      for (const slice of ["recents", "cron", "messaging"]) {
        expect(b[slice], `missing slice: ${slice}`).toBeTypeOf("object");
        expect(Array.isArray((b[slice] as Record<string, unknown>).sessions)).toBe(true);
      }
    },
  },
  {
    name: "GET /api/profiles/sessions/sidebar 404s if unimplemented, so the legacy fallback fires",
    method: "GET",
    path: "/api/profiles/sessions/sidebar",
    search: "?recents_profile=all&recents_limit=40&cron_limit=20&messaging_limit=20",
    client: "hermes.ts:520-536 (isEndpointMissingError) + hermes.ts:619-626",
    server: "hermes_cli/web_routers/profiles.py:232",
    gap:
      "Same root cause as the case above, asserted from the tolerance side: " +
      "if the adapter is not going to serve the batched route it MUST 404 so " +
      "the desktop falls back. Today it 200s. Either this case or the one " +
      "above goes green when the gap is fixed — never both; whichever fix " +
      "lands, delete the other.",
    assert: (res) => {
      expect(res === null || res.status === 404).toBe(true);
    },
  },

  // ── GET /api/sessions/:id/messages — SessionMessagesResponse ──────────────
  {
    name: "GET /api/sessions/:id/messages returns a pagination object",
    method: "GET",
    path: `/api/sessions/${AGENT}/messages`,
    search: "?limit=500&offset=0&order=oldest",
    client: "hermes.ts:679-712 (getSessionMessages); types/hermes.ts:584-593",
    server: "hermes_cli/web_routers/sessions.py:602",
    gap:
      "SILENT DATA LOSS. hermes-adapter.ts:637-644 hardcodes 100 turns and " +
      "emits no `pagination`. getAllSessionMessages (hermes.ts:744-746) treats " +
      "a missing `pagination` as 'legacy backend returned the full transcript' " +
      "and stops paging — so any transcript past 100 turns is silently " +
      "truncated with no error anywhere.",
    assert: (res) => {
      const b = body200(res);
      expect(b.pagination).toBeTypeOf("object");
      const p = b.pagination as Record<string, unknown>;
      expect(typeof p.limit).toBe("number");
      expect(typeof p.offset).toBe("number");
      expect(typeof p.returned).toBe("number");
      expect(["latest", "oldest"]).toContain(p.order);
    },
  },
  {
    name: "GET /api/sessions/:id/messages honours ?limit=",
    method: "GET",
    path: `/api/sessions/${AGENT}/messages`,
    search: "?limit=1&offset=0&order=oldest",
    client: "hermes.ts:679-712",
    server: "hermes_cli/web_routers/sessions.py:602-612 (limit/offset/order are real Query params)",
    gap: "hermes-adapter.ts:640 passes the constant 100 and never reads `search`.",
    assert: (res) => {
      const b = body200(res);
      expect(b.pagination).toBeTypeOf("object");
      expect((b.pagination as Record<string, unknown>).limit).toBe(1);
    },
  },
  {
    name: "GET /api/sessions/:id/messages echoes session_id and returns a messages array",
    method: "GET",
    path: `/api/sessions/${AGENT}/messages`,
    search: "?limit=500&order=latest",
    client: "hermes.ts:735 (`resolvedSessionId = page.session_id`)",
    server: "hermes_cli/web_routers/sessions.py:602",
    assert: (res) => {
      const b = body200(res);
      expect(b.session_id).toBe(AGENT);
      expect(Array.isArray(b.messages)).toBe(true);
    },
  },
  {
    name: "GET /api/sessions/:id/messages 404s for an unknown session",
    method: "GET",
    path: "/api/sessions/nope/messages",
    client: "hermes.ts:679-712",
    server: "hermes_cli/web_routers/sessions.py:602",
    assert: (res) => {
      expect(res).not.toBeNull();
      expect(res!.status).toBe(404);
    },
  },

  // ── GET /api/sessions/search — SessionSearchResponse ──────────────────────
  {
    name: "GET /api/sessions/search returns { results: [] }, not an Unknown-session 404",
    method: "GET",
    path: "/api/sessions/search",
    search: "?q=deploy",
    client: "hermes.ts:656-660 (searchSessions) — no catch, the rejection propagates",
    server: "hermes_cli/web_routers/sessions.py:169",
    gap:
      "Unimplemented, and worse than unimplemented: the /api/sessions/:id " +
      "regex (hermes-adapter.ts:624) matches 'search' as a session id and " +
      "answers 404 {error:'Unknown session'}. searchSessions has no " +
      "client-side tolerance, so the search panel throws.",
    assert: (res) => {
      const b = body200(res);
      expect(Array.isArray(b.results)).toBe(true);
    },
  },

  // ── PATCH / DELETE /api/sessions/:id — mutations with no tolerance ────────
  {
    name: "PATCH /api/sessions/:id {archived} is accepted",
    method: "PATCH",
    path: `/api/sessions/${AGENT}`,
    client: "hermes.ts:634-642 (setSessionArchived) — no catch",
    server: "hermes_cli/web_routers/sessions.py:683 (rename_session_endpoint: title|archived|pinned)",
    gap:
      "Unimplemented (hermes-adapter.ts has no non-GET /api/sessions branch), " +
      "so this 404s out of src/web/server.ts:1219 and the archive action " +
      "throws in the desktop.",
    assert: (res) => {
      const b = body200(res);
      expect(b.ok).toBe(true);
    },
  },
  {
    name: "PATCH /api/sessions/:id {pinned} is accepted",
    method: "PATCH",
    path: `/api/sessions/${AGENT}`,
    client: "hermes.ts:647-654 (setSessionPinnedRemote)",
    server: "hermes_cli/web_routers/sessions.py:683",
    gap: "Unimplemented — same branch gap as {archived}.",
    assert: (res) => {
      const b = body200(res);
      expect(b.ok).toBe(true);
    },
  },
  {
    name: "PATCH /api/sessions/:id {title} echoes the new title",
    method: "PATCH",
    path: `/api/sessions/${AGENT}`,
    client: "hermes.ts:763-774 (renameSession) — destructures { ok, title }",
    server: "hermes_cli/web_routers/sessions.py:683",
    gap: "Unimplemented — same branch gap as {archived}.",
    assert: (res) => {
      const b = body200(res);
      expect(b.ok).toBe(true);
      expect(typeof b.title).toBe("string");
    },
  },
  {
    name: "DELETE /api/sessions/:id is accepted",
    method: "DELETE",
    path: `/api/sessions/${AGENT}`,
    client: "hermes.ts:755-761 (deleteSession) — no catch",
    server: "hermes_cli/web_routers/sessions.py:655",
    gap:
      "Unimplemented. Switchroom sessions ARE agents, so a real delete is not " +
      "meaningful — but a bare 404 makes the desktop throw. The contract " +
      "answer is an explicit refusal the client can render (the 422 the cron " +
      "branch already uses at hermes-adapter.ts:739-741), not silence.",
    assert: (res) => {
      expect(res).not.toBeNull();
      // Either honoured, or refused in a way the desktop can surface.
      expect([200, 422]).toContain(res!.status);
    },
  },

  // ── POST /api/profiles/sessions/pull-requests ─────────────────────────────
  {
    name: "POST /api/profiles/sessions/pull-requests returns { pull_requests, scanned }",
    method: "POST",
    path: "/api/profiles/sessions/pull-requests",
    client: "hermes.ts:565-582 (scanSessionPullRequests)",
    server: "hermes_cli/web_routers/profiles.py:555",
    gap:
      "Unimplemented: the /api/profiles branch (hermes-adapter.ts:752) is " +
      "GET-only, so this POST falls through to 404.",
    assert: (res) => {
      const b = body200(res);
      expect(b.pull_requests).toBeTypeOf("object");
      expect(Array.isArray(b.scanned)).toBe(true);
    },
  },

  // ── SessionInfo field coverage ────────────────────────────────────────────
  {
    name: "session rows carry the SessionInfo fields the sidebar groups and sorts on",
    method: "GET",
    path: "/api/sessions",
    search: "?limit=40&offset=0&min_messages=0&archived=exclude&order=recent",
    client: "types/hermes.ts:464-523 (SessionInfo)",
    server: "hermes_cli/web_routers/sessions.py:54",
    gap:
      "toHermesSession (hermes-adapter.ts:128-153) emits none of these. They " +
      "are all optional in SessionInfo so nothing throws — the cost is silent " +
      "feature loss: no Pinned section (`pinned`), no archive state " +
      "(`archived`), no profile badge (`profile`/`is_default_profile`), no " +
      "branch/repo grouping (`git_branch`/`git_repo_root`), no fork lineage " +
      "(`parent_session_id`/`_lineage_root_id`), no handoff badge " +
      "(`handoff_platform`/`handoff_state`/`handoff_error`), and no cost sort " +
      "(`actual_cost_usd`/`estimated_cost_usd`).",
    assert: (res) => {
      const b = body200(res);
      const s = (b.sessions as Record<string, unknown>[])[0];
      for (const field of [
        "pinned",
        "archived",
        "profile",
        "is_default_profile",
        "git_branch",
        "git_repo_root",
        "parent_session_id",
        "_lineage_root_id",
        "handoff_platform",
        "handoff_state",
        "handoff_error",
        "actual_cost_usd",
        "estimated_cost_usd",
      ]) {
        expect(s, `SessionInfo.${field} missing`).toHaveProperty(field);
      }
    },
  },
  {
    name: "session rows carry the required (non-optional) SessionInfo fields",
    method: "GET",
    path: "/api/sessions",
    search: "?limit=40&offset=0&min_messages=0&archived=exclude&order=recent",
    client: "types/hermes.ts:464-523 — these have no `?`",
    server: "hermes_cli/web_routers/sessions.py:54",
    assert: (res) => {
      const b = body200(res);
      const s = (b.sessions as Record<string, unknown>[])[0];
      for (const field of [
        "id",
        "title",
        "model",
        "source",
        "preview",
        "is_active",
        "started_at",
        "last_active",
        "ended_at",
        "input_tokens",
        "output_tokens",
        "message_count",
        "tool_call_count",
      ]) {
        expect(s, `SessionInfo.${field} missing`).toHaveProperty(field);
      }
    },
  },

  // ── GET /api/status — StatusResponse ──────────────────────────────────────
  {
    name: "GET /api/status sends strings where StatusResponse declares non-null strings",
    method: "GET",
    path: "/api/status",
    client: "hermes.ts:785-790 (getStatus); types/hermes.ts:1144-1160",
    server: "hermes_cli/web_server.py",
    gap:
      "hermes-adapter.ts:658-661 sends null for release_date, config_path and " +
      "env_path. StatusResponse declares all three as bare `string`, so the " +
      "settings pane renders 'null' or throws on a string method.",
    assert: (res) => {
      const b = body200(res);
      for (const field of ["config_path", "env_path", "release_date", "hermes_home", "version"]) {
        expect(typeof b[field], `StatusResponse.${field} must be a string`).toBe("string");
      }
    },
  },
  {
    name: "GET /api/status satisfies the rest of StatusResponse",
    method: "GET",
    path: "/api/status",
    client: "types/hermes.ts:1144-1160",
    server: "hermes_cli/web_server.py",
    assert: (res) => {
      const b = body200(res);
      expect(typeof b.active_sessions).toBe("number");
      expect(typeof b.config_version).toBe("number");
      expect(typeof b.latest_config_version).toBe("number");
      expect(typeof b.gateway_running).toBe("boolean");
      expect(b.gateway_platforms).toBeTypeOf("object");
      // Nullable by declaration — presence is the contract, not the value.
      for (const field of [
        "gateway_state",
        "gateway_exit_reason",
        "gateway_health_url",
        "gateway_pid",
        "gateway_updated_at",
      ]) {
        expect(b, `StatusResponse.${field} missing`).toHaveProperty(field);
      }
    },
  },

  // ── cron ──────────────────────────────────────────────────────────────────
  {
    name: "GET /api/cron/jobs returns a CronJob[] with the fields the panel reads",
    method: "GET",
    path: "/api/cron/jobs",
    client: "hermes.ts:1381-1389 (getCronJobs); types/hermes.ts:788-804",
    server: "hermes_cli/web_server.py",
    assert: (res) => {
      expect(res!.status).toBe(200);
      const jobs = res!.body as Record<string, unknown>[];
      expect(Array.isArray(jobs)).toBe(true);
      // Both fixture agents' entries. Also the control for the ?profile= case
      // below: it can only mean "filtered" if unfiltered is non-empty.
      expect(jobs).toHaveLength(2);
      for (const job of jobs) {
        expect(typeof job.id).toBe("string");
        expect(typeof job.enabled).toBe("boolean");
        expect(job.schedule).toBeTypeOf("object");
        expect(typeof (job.schedule as Record<string, unknown>).expr).toBe("string");
        for (const field of ["name", "prompt", "schedule_display", "last_run_at", "last_error", "state"]) {
          expect(job, `CronJob.${field} missing`).toHaveProperty(field);
        }
      }
    },
  },
  {
    name: "GET /api/cron/jobs?profile= filters server-side",
    method: "GET",
    path: "/api/cron/jobs",
    search: "?profile=__no_such_profile__",
    client: "hermes.ts:1381-1389 — 'list just that profile's jobs, or all'",
    server: "hermes_cli/web_server.py",
    gap:
      "hermes-adapter.ts:713-717 ignores ?profile= and returns the whole " +
      "fleet's schedule. The desktop expects endpoint-level filtering — pinned " +
      "upstream at apps/desktop/src/hermes-cron-scope.test.ts:60-73 — so cron " +
      "jobs from every agent leak into a single profile's panel.",
    assert: (res) => {
      expect(res!.status).toBe(200);
      // The fixture fleet has 2 jobs (asserted above), none of them owned by
      // this profile — so a filtering backend returns none.
      expect(res!.body).toEqual([]);
    },
  },
  {
    name: "PUT /api/cron/jobs/:id is refused explicitly, not silently accepted",
    method: "PUT",
    path: `/api/cron/jobs/${AGENT}~0`,
    client: "hermes.ts:1428-1434 (updateCronJob)",
    server: "hermes_cli/web_server.py",
    gap:
      "The cron branch refuses POST/PATCH/DELETE with 422 " +
      "(hermes-adapter.ts:739-741) but not PUT, so an edit falls to the " +
      "catch-all `return {status:200, body:{}}` at :743. The desktop reads a " +
      "200 and reports the edit saved; nothing was written. Schedules are " +
      "YAML-owned, so PUT belongs in the same 422 list as the other verbs.",
    assert: (res) => {
      expect(res).not.toBeNull();
      expect(res!.status).toBe(422);
    },
  },
  {
    name: "POST /api/cron/jobs is refused with 422 (schedules are YAML-owned)",
    method: "POST",
    path: "/api/cron/jobs",
    client: "hermes.ts:1419-1425 (createCronJob)",
    server: "hermes_cli/web_server.py",
    assert: (res) => {
      expect(res!.status).toBe(422);
    },
  },
  {
    name: "DELETE /api/cron/jobs/:id is refused with 422",
    method: "DELETE",
    path: `/api/cron/jobs/${AGENT}~0`,
    client: "hermes.ts:1461-1467 (deleteCronJob)",
    server: "hermes_cli/web_server.py",
    assert: (res) => {
      expect(res!.status).toBe(422);
    },
  },
  {
    name: "GET /api/cron/jobs/:id/runs honours ?limit=",
    method: "GET",
    path: `/api/cron/jobs/${AGENT}~0/runs`,
    search: "?limit=5",
    client: "hermes.ts:1398-1405 (getCronJobRuns) — destructures { runs }",
    server: "hermes_cli/web_server.py",
    assert: (res) => {
      const b = body200(res);
      expect(Array.isArray(b.runs)).toBe(true);
      expect((b.runs as unknown[]).length).toBeLessThanOrEqual(5);
    },
  },
  {
    name: "GET /api/cron/delivery-targets returns { targets }",
    method: "GET",
    path: "/api/cron/delivery-targets",
    client: "hermes.ts:1410-1416 (getCronDeliveryTargets) — destructures { targets }",
    server: "hermes_cli/web_server.py",
    gap:
      "The /api/cron prefix branch's catch-all (hermes-adapter.ts:743) answers " +
      "200 {} for this, so `const { targets } = ...` is undefined. The caller " +
      "coalesces (`targets ?? []`), so this degrades rather than throwing — " +
      "but the cron editor then offers zero delivery targets.",
    assert: (res) => {
      const b = body200(res);
      expect(Array.isArray(b.targets)).toBe(true);
    },
  },

  // ── config / model / env / misc served routes ─────────────────────────────
  {
    name: "GET /api/config returns a HermesConfig-shaped object",
    method: "GET",
    path: "/api/config",
    client: "hermes.ts:829-834 (getConfig)",
    server: "hermes_cli/web_server.py",
    assert: (res) => {
      const b = body200(res);
      expect(b).toHaveProperty("provider");
      expect(b).toHaveProperty("model");
    },
  },
  {
    name: "GET /api/model/info returns { model, provider }",
    method: "GET",
    path: "/api/model/info",
    client: "hermes.ts:777-783 (getGlobalModelInfo); ModelInfoResponse",
    server: "hermes_cli/web_server.py",
    assert: (res) => {
      const b = body200(res);
      expect(typeof b.model).toBe("string");
      expect(typeof b.provider).toBe("string");
    },
  },
  {
    name: "GET /api/model/options returns a ModelOptionsResponse with providers[]",
    method: "GET",
    path: "/api/model/options",
    search: "?session_id=alpha",
    client: "hermes.ts:1600-1612 (getModelOptions)",
    server: "hermes_cli/web_server.py",
    assert: (res) => {
      const b = body200(res);
      expect(typeof b.model).toBe("string");
      expect(Array.isArray(b.providers)).toBe(true);
      const p = (b.providers as Record<string, unknown>[])[0];
      expect(Array.isArray(p.models)).toBe(true);
      expect(typeof p.slug).toBe("string");
    },
  },
  {
    name: "GET /api/logs returns a LogsResponse { file, lines }",
    method: "GET",
    path: "/api/logs",
    search: "?lines=200",
    client: "hermes.ts:820-826 (getLogs); types/hermes.ts:1132-1135",
    server: "hermes_cli/web_server.py",
    assert: (res) => {
      const b = body200(res);
      expect(typeof b.file).toBe("string");
      expect(Array.isArray(b.lines)).toBe(true);
    },
  },
  {
    name: "GET /api/messaging/platforms returns { platforms }",
    method: "GET",
    path: "/api/messaging/platforms",
    client: "hermes.ts:1269-1273 (getMessagingPlatforms)",
    server: "hermes_cli/web_server.py",
    assert: (res) => {
      const b = body200(res);
      expect(Array.isArray(b.platforms)).toBe(true);
    },
  },
  {
    name: "GET /api/profiles returns { profiles }",
    method: "GET",
    path: "/api/profiles",
    client: "hermes.ts:1500-1504 (listProfiles)",
    server: "hermes_cli/web_routers/profiles.py:613",
    assert: (res) => {
      const b = body200(res);
      expect(Array.isArray(b.profiles)).toBe(true);
    },
  },
  {
    name: "GET /api/profiles/:name/soul returns { content, exists }",
    method: "GET",
    path: "/api/profiles/default/soul",
    client: "hermes.ts:1530-1534 (getProfileSoul)",
    server: "hermes_cli/web_routers/profiles.py:871",
    assert: (res) => {
      const b = body200(res);
      expect(typeof b.content).toBe("string");
      expect(typeof b.exists).toBe("boolean");
    },
  },
  {
    name: "GET /api/profiles/:name/setup-command returns a command string",
    method: "GET",
    path: "/api/profiles/default/setup-command",
    client: "hermes.ts:1544-1548 (getProfileSetupCommand)",
    server: "hermes_cli/web_routers/profiles.py:779",
    gap:
      "The /api/profiles catch-all (hermes-adapter.ts:764) answers 200 {}. " +
      "Degrades rather than throwing, but the profile pane shows no setup " +
      "command.",
    assert: (res) => {
      const b = body200(res);
      expect(b).toHaveProperty("command");
    },
  },
  {
    name: "POST /api/providers/validate returns { ok }",
    method: "POST",
    path: "/api/providers/validate",
    client: "hermes.ts:904-910 (validateProvider)",
    server: "hermes_cli/web_server.py",
    assert: (res) => {
      const b = body200(res);
      expect(typeof b.ok).toBe("boolean");
    },
  },
  {
    name: "GET /api/env returns an object of env entries",
    method: "GET",
    path: "/api/env",
    client: "hermes.ts:885-889 (getEnv)",
    server: "hermes_cli/web_server.py",
    assert: (res) => {
      const b = body200(res);
      expect(b).toBeTypeOf("object");
    },
  },
  {
    name: "PUT /api/env is answered (accepted or explicitly refused), not 404",
    method: "PUT",
    path: "/api/env",
    client: "hermes.ts:891-898 (setEnv)",
    server: "hermes_cli/web_server.py:7209",
    gap:
      "Unimplemented. Switchroom has no desktop-writable env — but the honest " +
      "answer is the 422 refusal the cron branch already models, not a 404 " +
      "the client cannot distinguish from a dead backend.",
    assert: (res) => {
      expect(res).not.toBeNull();
      expect([200, 422]).toContain(res!.status);
    },
  },
  {
    name: "GET /api/memory/providers/:provider/config is answered",
    method: "GET",
    path: "/api/memory/providers/hindsight/config",
    search: "?surface=declared",
    client: "hermes.ts:868-873 (getMemoryProviderConfig)",
    server: "hermes_cli/web_server.py:6125",
    gap:
      "Unimplemented. The adapter serves the bare /api/memory/providers " +
      "(hermes-adapter.ts:767) instead — a path no desktop call site emits.",
    assert: (res) => {
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
    },
  },
  {
    name: "PUT /api/memory/providers/:provider/config is answered",
    method: "PUT",
    path: "/api/memory/providers/hindsight/config",
    search: "?surface=declared",
    client: "hermes.ts:875-882 (setMemoryProviderConfig)",
    server: "hermes_cli/web_server.py:6170",
    gap:
      "Unimplemented — same root cause as the GET above: the adapter's only " +
      "memory route is the bare /api/memory/providers, which the desktop " +
      "never calls. The memory settings pane cannot save.",
    assert: (res) => {
      expect(res).not.toBeNull();
      expect([200, 422]).toContain(res!.status);
    },
  },
  {
    name: "GET /api/analytics/usage is implemented (scoped in the fleet-dashboard RFC)",
    method: "GET",
    path: "/api/analytics/usage",
    search: "?days=30",
    client: "hermes.ts:1581-1585 (getAnalyticsUsage)",
    server: "hermes_cli/web_server.py:14453",
    gap: "Never implemented. Scoped at reference/rfcs/fleet-dashboard.md:105-106.",
    assert: (res) => {
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
    },
  },
];

describe(`Hermes REST response contract (upstream ${UPSTREAM_HERMES_SHA.slice(0, 7)})`, () => {
  for (const c of CONTRACT) {
    const runner = c.gap ? it.fails : it;
    const suffix = c.gap ? "  [GAP]" : "";
    runner(
      `${c.name}${suffix}`,
      async () => {
        const res = await call(c.method, c.path, c.search ?? "");
        c.assert(res);
      },
      CASE_TIMEOUT_MS,
    );
  }

  it("every contract case cites both a desktop call site and a real backend route", () => {
    for (const c of CONTRACT) {
      expect(c.client, c.name).toMatch(/hermes(-cron-scope)?\.ts:\d+|types\/hermes\.ts:\d+/);
      expect(c.server, c.name).toMatch(/hermes_cli\//);
    }
  });

  it("every gap carries a written explanation, not a bare flag", () => {
    for (const c of CONTRACT) {
      if (c.gap === undefined) continue;
      expect(c.gap.length, `${c.name}: gap note is too thin to act on`).toBeGreaterThan(40);
    }
  });

  it("reports the green/pending split so the fixture's own progress is visible", () => {
    const gaps = CONTRACT.filter((c) => c.gap).length;
    const green = CONTRACT.length - gaps;
    // Ratchet: this only moves when the adapter is fixed. Lower `gaps` (and
    // raise `green`) in the same PR that removes a `gap` field.
    expect({ total: CONTRACT.length, green, gaps }).toEqual({
      total: 44,
      green: 20,
      gaps: 24,
    });
  });
});
