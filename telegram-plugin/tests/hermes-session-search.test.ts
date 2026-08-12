/**
 * `GET /api/sessions/search` — that it actually SEARCHES.
 *
 * `hermes-rest-parity.test.ts` can only assert the contract floor here
 * (`Array.isArray(results)`), because it points `SWITCHROOM_AGENTS_DIR` at an
 * empty tmpdir: with no turns anywhere, "found the right rows", "found nothing
 * for a miss" and "hardcoded `{results: []}`" are indistinguishable. A
 * hardcoded empty list would pass that floor forever, and an always-200 empty
 * body is the exact bug class the desktop cannot detect —
 * `isEndpointMissingError` only matches 404s.
 *
 * So this file seeds a real turns registry (`bun:sqlite`, hence a bun test —
 * vitest excludes it; it lives under telegram-plugin/tests/ because that is the
 * only tree the bun CI job walks) and asserts the discriminating outcomes:
 * a query that should hit, hits; a query that should miss, misses.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTurnsDb } from "../registry/turns-schema.js";
import { handleHermesRest, type HermesRestResult } from "../../src/web/hermes-adapter.js";
import type { SwitchroomConfig } from "../../src/config/schema.js";

const CONFIG = {
  agents: { alpha: { model: "sonnet" }, beta: {} },
} as unknown as SwitchroomConfig;

let agentsDir = "";

function seed(agent: string, rows: { user: string; assistant: string }[]) {
  const dir = join(agentsDir, agent);
  mkdirSync(dir, { recursive: true });
  const db = openTurnsDb(dir);
  try {
    rows.forEach((r, i) => {
      const ts = 1_700_000_000_000 + i * 1000;
      db.prepare(
        `INSERT INTO turns
           (turn_key, chat_id, thread_id, started_at, ended_at, ended_via,
            user_prompt_preview, assistant_reply_preview, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, 'stop', ?, ?, ?, ?)`,
      ).run(`${agent}-t${i}`, "chat", ts, ts + 500, r.user, r.assistant, ts, ts);
    });
  } finally {
    db.close();
  }
}

type Result = {
  session_id: string;
  lineage_root: string;
  snippet: string;
  role: string | null;
  source: string | null;
  model: string | null;
  session_started: number | null;
};

async function search(query: string): Promise<Result[]> {
  const res = (await handleHermesRest(
    "GET",
    "/api/sessions/search",
    CONFIG,
    query,
  )) as HermesRestResult;
  expect(res).not.toBeNull();
  // The pre-fix behaviour: the /api/sessions/:id regex matched "search" as an
  // id and answered 404 {error:'Unknown session'}, which threw the panel.
  expect(res.status).toBe(200);
  return (res.body as { results: Result[] }).results;
}

beforeEach(() => {
  agentsDir = mkdtempSync(join(tmpdir(), "sr-hermes-search-"));
  process.env.SWITCHROOM_AGENTS_DIR = agentsDir;
});

afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
});

test("a session-id match comes back, with role null and the id as its own lineage root", async () => {
  const results = await search("?q=alph");
  expect(results.map((r) => r.session_id)).toEqual(["alpha"]);
  expect(results[0].role).toBeNull();
  expect(results[0].lineage_root).toBe("alpha");
});

test("a message-content match comes back tagged with the role it matched on", async () => {
  seed("alpha", [{ user: "deploy the gateway", assistant: "done" }]);
  seed("beta", [{ user: "unrelated", assistant: "also unrelated" }]);

  const onUser = await search("?q=deploy");
  expect(onUser.map((r) => r.session_id)).toEqual(["alpha"]);
  expect(onUser[0].role).toBe("user");
  expect(onUser[0].snippet).toBe("deploy the gateway");

  const onAssistant = await search("?q=also%20unrelated");
  expect(onAssistant.map((r) => r.session_id)).toEqual(["beta"]);
  expect(onAssistant[0].role).toBe("assistant");
  expect(onAssistant[0].snippet).toBe("also unrelated");
});

test("a query that matches nothing returns nothing — not the whole fleet", async () => {
  seed("alpha", [{ user: "deploy the gateway", assistant: "done" }]);
  // The discriminating case: a stub returning every session, and a stub
  // returning none, are told apart only by running both this and the hit above.
  expect(await search("?q=zzz-no-such-token")).toEqual([]);
});

test("an empty or whitespace query is short-circuited, not treated as match-everything", async () => {
  seed("alpha", [{ user: "deploy", assistant: "done" }]);
  expect(await search("?q=")).toEqual([]);
  expect(await search("?q=%20%20")).toEqual([]);
  expect(await search("")).toEqual([]);
});

test("one row per session even when several turns match", async () => {
  seed("alpha", [
    { user: "deploy one", assistant: "ok" },
    { user: "deploy two", assistant: "ok" },
    { user: "deploy three", assistant: "ok" },
  ]);
  const results = await search("?q=deploy");
  expect(results.length).toBe(1);
  expect(results[0].session_id).toBe("alpha");
});

test("?limit= caps the result set", async () => {
  seed("alpha", [{ user: "shared token", assistant: "ok" }]);
  seed("beta", [{ user: "shared token", assistant: "ok" }]);
  expect((await search("?q=shared&limit=1")).length).toBe(1);
  expect((await search("?q=shared")).length).toBe(2);
});

test("id matches are ordered ahead of content matches", async () => {
  // beta matches by id; alpha only by content. Upstream surfaces direct
  // session-id hits first (sessions.py:169-383) and the panel relies on it.
  seed("alpha", [{ user: "beta is mentioned here", assistant: "ok" }]);
  const results = await search("?q=beta");
  expect(results.map((r) => r.session_id)).toEqual(["beta", "alpha"]);
  expect(results[0].role).toBeNull();
  expect(results[1].role).toBe("user");
});
