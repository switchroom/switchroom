/**
 * The optional `SessionInfo` fields — that the VALUES are true, not just present.
 *
 * The parity fixture asserts `toHaveProperty` for each field, which any value
 * satisfies. That distinction matters most for cost: `actual_cost_usd: 0` would
 * satisfy the fixture and then sort every switchroom session to the top of a
 * cost-ordered list as if it were free-and-measured, rather than unmeasured.
 * `null` is the truthful "unknown".
 *
 * It also pins the type contract: `archived`, `pinned`, `profile` and
 * `is_default_profile` are the only four of these declared WITHOUT `| null`
 * (apps/desktop/src/types/hermes.ts:464-523), so those four must never be null
 * — the same class of bug as the `GET /api/status` nulls.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHermesRest } from "./hermes-adapter.js";
import type { SwitchroomConfig } from "../config/schema.js";

const AGENT = "alpha";
const CONFIG = { agents: { [AGENT]: { model: "sonnet" } } } as unknown as SwitchroomConfig;

beforeAll(() => {
  process.env.SWITCHROOM_AGENTS_DIR = mkdtempSync(join(tmpdir(), "sr-hermes-sessioninfo-"));
});

/** Fields the type declares without `| null`. */
const NON_NULLABLE = ["pinned", "archived", "profile", "is_default_profile"] as const;

/** Fields that are `null | T` and have no switchroom concept behind them. */
const NULL_VALUED = [
  "git_branch",
  "git_repo_root",
  "parent_session_id",
  "_lineage_root_id",
  "handoff_platform",
  "handoff_state",
  "handoff_error",
  "actual_cost_usd",
  "estimated_cost_usd",
] as const;

async function firstSession(): Promise<Record<string, unknown>> {
  const res = await handleHermesRest("GET", "/api/sessions", CONFIG, "");
  expect(res!.status).toBe(200);
  const rows = (res!.body as { sessions: Record<string, unknown>[] }).sessions;
  expect(rows.length).toBeGreaterThan(0);
  return rows[0];
}

describe("SessionInfo optional fields", () => {
  it("the four non-nullable fields carry real values, never null", async () => {
    const s = await firstSession();
    for (const field of NON_NULLABLE) {
      expect(s[field], `SessionInfo.${field} is declared without | null`).not.toBeNull();
    }
    expect(s.pinned).toBe(false);
    expect(s.archived).toBe(false);
    expect(s.profile).toBe("default");
    expect(s.is_default_profile).toBe(true);
  });

  it("profile matches the one /api/profiles/active reports", async () => {
    const active = await handleHermesRest("GET", "/api/profiles/active", CONFIG, "");
    const s = await firstSession();
    expect(s.profile).toBe((active!.body as { active: string }).active);
  });

  it("fields with no switchroom concept are null, not zero-valued", async () => {
    const s = await firstSession();
    for (const field of NULL_VALUED) {
      expect(s[field], `SessionInfo.${field}`).toBeNull();
    }
    // Stated separately because this is the one that changes UI behaviour:
    // 0 would sort as "measured and free" in a cost-ordered list.
    expect(s.actual_cost_usd).not.toBe(0);
    expect(s.estimated_cost_usd).not.toBe(0);
  });

  it("the single-session route carries the same fields as the list route", async () => {
    const res = await handleHermesRest("GET", `/api/sessions/${AGENT}`, CONFIG, "");
    const s = (res!.body as { session: Record<string, unknown> }).session;
    for (const field of [...NON_NULLABLE, ...NULL_VALUED]) {
      expect(s, `SessionInfo.${field} missing on /api/sessions/:id`).toHaveProperty(field);
    }
  });
});
