import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleAdd, scheduleRemove } from "./agent-config-write.js";
import { cronUnitHash } from "../agents/cron-unit-name.js";

let root: string;
let savedEnv: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scw-"));
  savedEnv = process.env.SWITCHROOM_AGENT_NAME;
  process.env.SWITCHROOM_AGENT_NAME = "alice";
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.SWITCHROOM_AGENT_NAME;
  else process.env.SWITCHROOM_AGENT_NAME = savedEnv;
});

describe("scheduleAdd — happy path", () => {
  it("writes cron-<sha12>.yaml and returns the hash + path", () => {
    const r = scheduleAdd({
      cronExpr: "0 9 * * *",
      prompt: "morning standup",
      root,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expected = cronUnitHash("0 9 * * *", "morning standup");
    expect(r.cron_hash).toBe(expected);
    expect(r.slug).toBe(`cron-${expected}`);
    expect(r.would_recreate).toBe(false);
    expect(existsSync(r.path)).toBe(true);
    const content = readFileSync(r.path, "utf-8");
    expect(content).toContain("prompt: morning standup");
  });
});

describe("scheduleAdd — security gates", () => {
  it("rejects overlay write with non-empty secrets (E_OVERLAY_SECRETS_REQUIRES_APPROVAL)", () => {
    const r = scheduleAdd({
      cronExpr: "0 9 * * *",
      prompt: "needs key",
      secrets: ["foo/bar"],
      root,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_OVERLAY_SECRETS_REQUIRES_APPROVAL");
    expect(r.exit).toBe(9);
    // No file should have been written
    const expected = cronUnitHash("0 9 * * *", "needs key");
    expect(existsSync(join(root, "alice", "schedule.d", `cron-${expected}.yaml`))).toBe(false);
  });

  it("rejects too-frequent cron (E_CRON_TOO_FREQUENT)", () => {
    const r = scheduleAdd({
      cronExpr: "* * * * *",
      prompt: "spammy",
      root,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_CRON_TOO_FREQUENT");
    expect(r.exit).toBe(9);
  });

  it("empty secrets array passes through", () => {
    const r = scheduleAdd({
      cronExpr: "0 9 * * *",
      prompt: "ok",
      secrets: [],
      root,
    });
    expect(r.ok).toBe(true);
  });
});

describe("scheduleRemove", () => {
  it("removes by cron_hash", () => {
    const add = scheduleAdd({ cronExpr: "0 9 * * *", prompt: "p", root });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const r = scheduleRemove({ cronHash: add.cron_hash, root });
    expect(r.ok).toBe(true);
    expect(existsSync(add.path)).toBe(false);
  });

  it("removes by name (matches the YAML header comment)", () => {
    const add = scheduleAdd({
      cronExpr: "0 9 * * *",
      prompt: "p",
      name: "morning",
      root,
    });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const r = scheduleRemove({ name: "morning", root });
    expect(r.ok).toBe(true);
  });

  it("returns E_NOT_FOUND for missing target", () => {
    const r = scheduleRemove({ name: "nope", root });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_NOT_FOUND");
  });

  it("requires either name or cron_hash", () => {
    const r = scheduleRemove({ root });
    expect(r.ok).toBe(false);
  });
});

describe("scheduleAdd — reconcile trigger (hot-apply wiring)", () => {
  it("calls reconcile once with the caller agent name on successful add", () => {
    const calls: string[] = [];
    const r = scheduleAdd({
      cronExpr: "0 9 * * *",
      prompt: "morning",
      root,
      reconcile: (agent) => {
        calls.push(agent);
        return { ok: true, changes: [], cronScripts: [] };
      },
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["alice"]);
  });

  it("rolls back the overlay write when reconcile fails, returns E_RECONCILE_FAILED", () => {
    const r = scheduleAdd({
      cronExpr: "0 9 * * *",
      prompt: "boom",
      root,
      reconcile: () => ({ ok: false, error: "scheduler exploded" }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_RECONCILE_FAILED");
    expect(r.exit).toBe(10);
    expect(r.message).toContain("scheduler exploded");
    // The overlay file must be gone (rollback).
    const expected = cronUnitHash("0 9 * * *", "boom");
    expect(
      existsSync(join(root, "alice", "schedule.d", `cron-${expected}.yaml`)),
    ).toBe(false);
  });
});

describe("scheduleRemove — reconcile trigger", () => {
  it("calls reconcile once with the caller agent on successful remove", () => {
    const add = scheduleAdd({ cronExpr: "0 9 * * *", prompt: "p", root });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const calls: string[] = [];
    const r = scheduleRemove({
      cronHash: add.cron_hash,
      root,
      reconcile: (agent) => {
        calls.push(agent);
        return { ok: true, changes: [], cronScripts: [] };
      },
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["alice"]);
  });

  it("restores the deleted overlay file when reconcile fails", () => {
    const add = scheduleAdd({ cronExpr: "0 9 * * *", prompt: "p", root });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const before = readFileSync(add.path, "utf-8");
    const r = scheduleRemove({
      cronHash: add.cron_hash,
      root,
      reconcile: () => ({ ok: false, error: "nope" }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_RECONCILE_FAILED");
    expect(existsSync(add.path)).toBe(true);
    expect(readFileSync(add.path, "utf-8")).toBe(before);
  });
});

describe("scheduleAdd — cross-agent denial", () => {
  it("throws when --agent mismatches the env-pinned identity", () => {
    expect(() => {
      scheduleAdd({ agent: "other-agent", cronExpr: "0 9 * * *", prompt: "p", root });
    }).toThrow(/cross-agent/);
  });
});
