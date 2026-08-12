/**
 * `GET /api/cron/jobs?profile=` — the scoping, in both directions.
 *
 * The parity fixture pins the miss (an unknown profile must return `[]`) and
 * the unfiltered read (the whole fleet's schedule). Neither catches the
 * over-correction that a naive "any ?profile= means filter" implementation
 * makes: the desktop's cron panel passes the ACTIVE profile
 * (apps/desktop/src/hermes.ts:1381-1389), which for switchroom is `default` —
 * so filtering that one out would empty the panel in normal use while both
 * fixture cases stayed green.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHermesRest } from "./hermes-adapter.js";
import type { SwitchroomConfig } from "../config/schema.js";

const CONFIG = {
  agents: {
    alpha: { schedule: [{ cron: "0 9 * * *", prompt: "alpha morning digest" }] },
    beta: { schedule: [{ cron: "0 17 * * 5", prompt: "beta weekly roundup" }] },
  },
} as unknown as SwitchroomConfig;

beforeAll(() => {
  process.env.SWITCHROOM_AGENTS_DIR = mkdtempSync(join(tmpdir(), "sr-hermes-cron-"));
});

async function jobs(search: string): Promise<unknown[]> {
  const res = await handleHermesRest("GET", "/api/cron/jobs", CONFIG, search);
  expect(res!.status).toBe(200);
  return res!.body as unknown[];
}

describe("GET /api/cron/jobs profile scoping", () => {
  it("returns the fleet's schedule when no profile is given", async () => {
    expect((await jobs("")).length).toBe(2);
  });

  it("returns the fleet's schedule for the profile switchroom actually reports", async () => {
    // /api/profiles/active answers {active: 'default'}. That profile owns
    // everything; filtering it out would blank the panel in the ONLY
    // configuration a real desktop ever sends.
    expect((await jobs("?profile=default")).length).toBe(2);
    expect((await jobs("?profile=")).length).toBe(2);
  });

  it("returns nothing for a profile switchroom does not have", async () => {
    expect(await jobs("?profile=__no_such_profile__")).toEqual([]);
  });
});
