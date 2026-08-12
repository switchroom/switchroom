/**
 * `GET /api/sessions/:id/messages` — ordering and pagination, against a REAL
 * turns DB.
 *
 * Separate from `hermes-rest-parity.test.ts` for one reason: that fixture
 * points `SWITCHROOM_AGENTS_DIR` at an empty tmpdir, so every session has zero
 * messages and an assertion about ORDER or about which slice came back passes
 * vacuously there. Ordering and offset windowing are exactly the properties
 * that need real rows, and the turns DB is `bun:sqlite` — hence a bun test
 * (vitest excludes it; see vitest.config.ts). It lives under
 * telegram-plugin/tests/ rather than beside the adapter because that is the only
 * tree the bun CI job walks — `bun test` runs with cwd telegram-plugin/, so a
 * root-level src/ bun test is executed by NEITHER runner
 * (scripts/check-test-runner-coverage.mjs, and the debt list it guards).
 *
 * Upstream contract being asserted (`hermes_cli/web_routers/sessions.py:601-651`
 * at 9da6d455c9e1f2bf74bb9f47766ee9fc52e17bfb):
 *   - messages come back CHRONOLOGICAL within the page;
 *   - `order=oldest` windows from the start, `order=latest` from the end;
 *   - `pagination.returned` is the real row count of that window.
 *
 * The bug each case guards, stated so a future edit cannot weaken it into a
 * code-path check: the adapter read `listTurnsForAgent` (newest-first) and
 * projected it without reversing, so the transcript arrived backwards; and it
 * emitted no `pagination`, which `getAllSessionMessages` (hermes.ts:713-750)
 * reads as "legacy backend, that was everything" and stops paging on.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTurnsDb } from "../registry/turns-schema.js";
import { handleHermesRest, type HermesRestResult } from "../../src/web/hermes-adapter.js";
import type { SwitchroomConfig } from "../../src/config/schema.js";

const AGENT = "alpha";
let agentsDir = "";

const CONFIG = { agents: { [AGENT]: {} } } as unknown as SwitchroomConfig;

/** Seed `n` completed turns with explicit, strictly-increasing start times. */
function seedTurns(n: number) {
  const dir = join(agentsDir, AGENT);
  mkdirSync(dir, { recursive: true });
  const db = openTurnsDb(dir);
  try {
    for (let i = 0; i < n; i++) {
      const ts = 1_700_000_000_000 + i * 1000;
      db.prepare(
        `INSERT INTO turns
           (turn_key, chat_id, thread_id, started_at, ended_at, ended_via,
            user_prompt_preview, assistant_reply_preview, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, 'stop', ?, ?, ?, ?)`,
      ).run(`t${i}`, "chat", ts, ts + 500, `u${i}`, `a${i}`, ts, ts);
    }
  } finally {
    db.close();
  }
}

async function messages(search: string): Promise<Record<string, unknown>> {
  const res = (await handleHermesRest(
    "GET",
    `/api/sessions/${AGENT}/messages`,
    CONFIG,
    search,
  )) as HermesRestResult;
  expect(res).not.toBeNull();
  expect(res.status).toBe(200);
  return res.body as Record<string, unknown>;
}

function contents(body: Record<string, unknown>): string[] {
  return (body.messages as { content: string }[]).map((m) => m.content);
}

beforeEach(() => {
  agentsDir = mkdtempSync(join(tmpdir(), "sr-hermes-msgs-"));
  process.env.SWITCHROOM_AGENTS_DIR = agentsDir;
});

afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
});

test("messages are chronological, not the newest-first order the turns DB reads in", async () => {
  seedTurns(3);
  const body = await messages("?limit=500&offset=0&order=oldest");
  // u0/a0 is the OLDEST turn. Before the fix this list started at u2.
  expect(contents(body)).toEqual(["u0", "a0", "u1", "a1", "u2", "a2"]);
});

test("order=oldest windows from the start and reports what it returned", async () => {
  seedTurns(3);
  const body = await messages("?limit=2&offset=2&order=oldest");
  expect(contents(body)).toEqual(["u1", "a1"]);
  expect(body.pagination).toEqual({ limit: 2, offset: 2, order: "oldest", returned: 2 });
});

test("order=latest windows from the END, still chronological inside the page", async () => {
  seedTurns(3);
  const body = await messages("?limit=3&order=latest");
  expect(contents(body)).toEqual(["a1", "u2", "a2"]);
  expect(body.pagination).toEqual({ limit: 3, offset: 0, order: "latest", returned: 3 });
});

test("paging with the desktop's own loop terminates having read every message once", async () => {
  seedTurns(5); // 10 messages
  // getAllSessionMessages (hermes.ts:713-750): limit=500, order=oldest, advance
  // offset by the page length, stop when the page is short of `limit`.
  const seen: string[] = [];
  let offset = 0;
  for (let guard = 0; guard < 10; guard++) {
    const page = await messages(`?limit=4&offset=${offset}&order=oldest`);
    const pagination = page.pagination as { limit: number };
    seen.push(...contents(page));
    if (contents(page).length === 0 || contents(page).length < pagination.limit) break;
    offset += contents(page).length;
  }
  expect(seen).toEqual(["u0", "a0", "u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4"]);
});

test("an omitted limit defaults to the latest 500, an explicit one defaults to oldest", async () => {
  seedTurns(1);
  expect((await messages("")).pagination).toEqual({
    limit: 500,
    offset: 0,
    order: "latest",
    returned: 2,
  });
  expect((await messages("?limit=10")).pagination).toEqual({
    limit: 10,
    offset: 0,
    order: "oldest",
    returned: 2,
  });
});

test("an unrecognised order is a 400, not a silently-reinterpreted page", async () => {
  seedTurns(1);
  const res = await handleHermesRest(
    "GET",
    `/api/sessions/${AGENT}/messages`,
    CONFIG,
    "?order=sideways",
  );
  expect(res?.status).toBe(400);
});
