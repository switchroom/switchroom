/**
 * The four routes the desktop calls with no client-side tolerance, and which
 * switchroom cannot honour.
 *
 * `hermes-rest-parity.test.ts` asserts the CONTRACT floor for these — status in
 * `[200, 422]`, or `200` for the memory GET. That floor is deliberately loose,
 * so it cannot tell an honest refusal from a fabricated one: a `422` with an
 * empty body, or a memory GET answering `{}`, both satisfy it while leaving the
 * desktop with nothing to render. This file pins what is actually IN the answer.
 *
 * Why not just 404 and be done: `isEndpointMissingError`
 * (apps/desktop/src/hermes.ts) only matches 404-shaped responses, and the
 * desktop reads that as "old backend, take the fallback path". A refusal that
 * 404s is therefore indistinguishable from a dead gateway, and the user is told
 * nothing. A 422 with a reason is the same answer the schedule-write branch
 * already gives.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHermesRest, type HermesRestResult } from "./hermes-adapter.js";
import type { SwitchroomConfig } from "../config/schema.js";

const AGENT = "alpha";
const CONFIG = { agents: { [AGENT]: { model: "sonnet" } } } as unknown as SwitchroomConfig;

beforeAll(() => {
  process.env.SWITCHROOM_AGENTS_DIR = mkdtempSync(join(tmpdir(), "sr-hermes-writes-"));
});

function call(method: string, path: string, search = ""): Promise<HermesRestResult | null> {
  return handleHermesRest(method, path, CONFIG, search);
}

/** A refusal the desktop can put in front of a human, not a bare status code. */
async function expectRenderableRefusal(method: string, path: string, search = "") {
  const res = await call(method, path, search);
  expect(res, `${method} ${path} must be answered, not fall through to 404`).not.toBeNull();
  expect(res!.status).toBe(422);
  const error = (res!.body as { error?: unknown }).error;
  expect(typeof error, `${method} ${path} must carry a string reason`).toBe("string");
  // Not merely present — long enough to be a sentence a user can act on, and
  // naming where the real control lives. An empty or one-word `error` renders
  // as a blank toast.
  expect((error as string).length).toBeGreaterThan(40);
  expect(error as string).toMatch(/switchroom\.yaml|vault/i);
}

describe("writes switchroom cannot honour are refused, not 404'd", () => {
  it("DELETE /api/sessions/:id refuses with a reason", async () => {
    await expectRenderableRefusal("DELETE", `/api/sessions/${AGENT}`);
  });

  it("DELETE /api/sessions/:id refuses unknown ids identically (no existence leak)", async () => {
    const known = await call("DELETE", `/api/sessions/${AGENT}`);
    const unknown = await call("DELETE", "/api/sessions/does-not-exist");
    expect(unknown!.status).toBe(known!.status);
    expect(unknown!.body).toEqual(known!.body);
  });

  it("DELETE /api/sessions/:id does not swallow the messages sub-route", async () => {
    // The refusal is anchored on /api/sessions/:id with no trailing segment;
    // a greedy match here would start refusing transcript reads.
    const res = await call("GET", `/api/sessions/${AGENT}/messages`);
    expect(res!.status).toBe(200);
  });

  it("PUT /api/env refuses with a reason", async () => {
    await expectRenderableRefusal("PUT", "/api/env");
  });

  it("PUT /api/env does not disturb the GET the env panel reads", async () => {
    const res = await call("GET", "/api/env");
    expect(res!.status).toBe(200);
  });

  it("PUT /api/memory/providers/:provider/config refuses with a reason", async () => {
    await expectRenderableRefusal(
      "PUT",
      "/api/memory/providers/hindsight/config",
      "?surface=declared",
    );
  });
});

describe("GET /api/memory/providers/:provider/config serves the real declared shape", () => {
  it("answers every field of MemoryProviderConfig, echoing the requested provider", async () => {
    const res = await call(
      "GET",
      "/api/memory/providers/hindsight/config",
      "?surface=declared",
    );
    expect(res!.status).toBe(200);
    // apps/desktop/src/types/hermes.ts:151-156 — {docs_url, fields, label, name}.
    // A fabricated `{}` passes the parity fixture's status-only floor and then
    // crashes provider-config-panel.tsx:81 on `config.fields.length`.
    expect(res!.body).toEqual({
      name: "hindsight",
      label: "hindsight",
      docs_url: "",
      fields: [],
    });
  });

  it("an empty `fields` is the panel's own 'no config surface' signal", async () => {
    // provider-config-panel.tsx:80-82 returns null when fields.length === 0
    // ("Providers without a declared config surface (e.g. builtin) render
    // nothing"). So the pane collapses rather than showing a form that cannot
    // save — which is why a non-empty placeholder field would be a regression.
    const res = await call("GET", "/api/memory/providers/anything/config", "?surface=declared");
    expect((res!.body as { fields: unknown[] }).fields).toEqual([]);
  });

  it("percent-encoded provider names round-trip", async () => {
    const res = await call("GET", "/api/memory/providers/my%20provider/config");
    expect((res!.body as { name: string }).name).toBe("my provider");
  });
});
