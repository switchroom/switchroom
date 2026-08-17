/**
 * Unit suite for the UAT allowlist add/remove helper. Runs under `bun test`
 * (this tree is vitest-excluded) via the `uat/flip/` entry in
 * telegram-plugin/scripts/bun-test-ci.sh.
 *
 * Everything is hermetic: a tmp `agentsDir` is built per-test and torn down,
 * and the clock is injected so `expiresAt`/`--expired` are deterministic. No
 * real ~/.switchroom is touched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addToAllowlist,
  removeFromAllowlist,
  sweepAllowlist,
  runAllowlistCli,
  accessFilePath,
  receiptPath,
  DEFAULT_TTL_MS,
  type AllowlistReceipt,
} from "./allowlist.js";

let agentsDir: string;
let root: string;

function seedAccess(agent: string, obj: unknown): void {
  const p = accessFilePath(agentsDir, agent);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

function readAccess(agent: string): Record<string, unknown> {
  return JSON.parse(readFileSync(accessFilePath(agentsDir, agent), "utf8"));
}

function readReceipt(agent: string): AllowlistReceipt {
  return JSON.parse(readFileSync(receiptPath(agentsDir, agent), "utf8"));
}

function mkAgentDir(agent: string): void {
  mkdirSync(join(agentsDir, agent, "telegram"), { recursive: true });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sr-uat-allowlist-"));
  agentsDir = join(root, "agents");
  mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("addToAllowlist", () => {
  it("appends the id, preserves sibling keys, and writes a receipt first", () => {
    seedAccess("ziggy", {
      dmPolicy: "allowlist",
      allowFrom: ["111"],
      groups: { "-100": { allowFrom: ["222"] } },
      voice_in: true,
    });
    const now = Date.parse("2026-08-18T00:00:00.000Z");
    const r = addToAllowlist("ziggy", "999", { agentsDir, now: () => now });

    expect(r.added).toBe(true);
    expect(r.preexisting).toBe(false);

    const access = readAccess("ziggy");
    expect(access.allowFrom).toEqual(["111", "999"]);
    // sibling keys survive the whole-object rewrite.
    expect(access.groups).toEqual({ "-100": { allowFrom: ["222"] } });
    expect(access.voice_in).toBe(true);
    expect(access.dmPolicy).toBe("allowlist");

    const rcpt = readReceipt("ziggy");
    expect(rcpt).toMatchObject({ agent: "ziggy", userId: "999", preexisting: false });
    expect(rcpt.addedAt).toBe("2026-08-18T00:00:00.000Z");
    expect(Date.parse(rcpt.expiresAt) - now).toBe(DEFAULT_TTL_MS);
  });

  it("creates access.json when none exists yet", () => {
    mkAgentDir("newbie");
    const r = addToAllowlist("newbie", "42", { agentsDir });
    expect(r.added).toBe(true);
    expect(readAccess("newbie").allowFrom).toEqual(["42"]);
  });

  it("is a no-op with preexisting:true when the id is already allowlisted", () => {
    seedAccess("ziggy", { allowFrom: ["999"] });
    const r = addToAllowlist("ziggy", "999", { agentsDir });
    expect(r.added).toBe(false);
    expect(r.preexisting).toBe(true);
    // access.json unchanged; receipt records preexisting so revert won't strip it.
    expect(readAccess("ziggy").allowFrom).toEqual(["999"]);
    expect(readReceipt("ziggy").preexisting).toBe(true);
  });

  it("a second add is a no-op preserving the original receipt", () => {
    seedAccess("ziggy", { allowFrom: [] });
    const first = addToAllowlist("ziggy", "999", { agentsDir, now: () => 1000 });
    const second = addToAllowlist("ziggy", "999", { agentsDir, now: () => 5000 });
    expect(first.added).toBe(true);
    expect(second.added).toBe(false);
    // original addedAt preserved (not re-stamped to 5000).
    expect(readReceipt("ziggy").addedAt).toBe(new Date(1000).toISOString());
  });
});

describe("removeFromAllowlist", () => {
  it("reverts an id the UAT added and clears the receipt", () => {
    seedAccess("ziggy", { allowFrom: ["111"] });
    addToAllowlist("ziggy", "999", { agentsDir });
    expect(readAccess("ziggy").allowFrom).toEqual(["111", "999"]);

    const r = removeFromAllowlist("ziggy", { agentsDir });
    expect(r.reverted).toBe(true);
    expect(r.receiptCleared).toBe(true);
    expect(readAccess("ziggy").allowFrom).toEqual(["111"]);
    expect(existsSync(receiptPath(agentsDir, "ziggy"))).toBe(false);
  });

  it("does NOT strip a preexisting id, but clears the receipt", () => {
    seedAccess("ziggy", { allowFrom: ["999"] });
    addToAllowlist("ziggy", "999", { agentsDir }); // preexisting
    const r = removeFromAllowlist("ziggy", { agentsDir });
    expect(r.reverted).toBe(false);
    expect(r.reason).toBe("preexisting");
    expect(r.receiptCleared).toBe(true);
    expect(readAccess("ziggy").allowFrom).toEqual(["999"]);
    expect(existsSync(receiptPath(agentsDir, "ziggy"))).toBe(false);
  });

  it("no-ops with no-receipt when there is nothing to revert", () => {
    seedAccess("ziggy", { allowFrom: ["111"] });
    const r = removeFromAllowlist("ziggy", { agentsDir });
    expect(r.reverted).toBe(false);
    expect(r.reason).toBe("no-receipt");
    expect(readAccess("ziggy").allowFrom).toEqual(["111"]);
  });

  it("is idempotent — a second remove after revert is a no-op", () => {
    seedAccess("ziggy", { allowFrom: [] });
    addToAllowlist("ziggy", "999", { agentsDir });
    removeFromAllowlist("ziggy", { agentsDir });
    const second = removeFromAllowlist("ziggy", { agentsDir });
    expect(second.reverted).toBe(false);
    expect(second.reason).toBe("no-receipt");
  });

  it("handles a receipt whose id was already manually removed", () => {
    seedAccess("ziggy", { allowFrom: [] });
    addToAllowlist("ziggy", "999", { agentsDir });
    // someone else stripped the id out of band.
    seedAccess("ziggy", { allowFrom: [] });
    const r = removeFromAllowlist("ziggy", { agentsDir });
    expect(r.reverted).toBe(false);
    expect(r.reason).toBe("not-present");
    expect(r.receiptCleared).toBe(true);
  });
});

describe("sweepAllowlist", () => {
  it("reverts every agent's receipt and is idempotent on a clean second pass", () => {
    seedAccess("a", { allowFrom: [] });
    seedAccess("b", { allowFrom: ["7"] });
    addToAllowlist("a", "999", { agentsDir });
    addToAllowlist("b", "888", { agentsDir });

    const first = sweepAllowlist({ agentsDir });
    expect(first.map((r) => r.agent).sort()).toEqual(["a", "b"]);
    expect(first.every((r) => r.reverted)).toBe(true);
    expect(readAccess("a").allowFrom).toEqual([]);
    expect(readAccess("b").allowFrom).toEqual(["7"]);

    const second = sweepAllowlist({ agentsDir });
    expect(second).toEqual([]);
  });

  it("with expiredOnly, leaves un-expired receipts alone", () => {
    seedAccess("a", { allowFrom: [] });
    seedAccess("b", { allowFrom: [] });
    const t0 = Date.parse("2026-08-18T00:00:00.000Z");
    addToAllowlist("a", "111", { agentsDir, now: () => t0, ttlMs: 1000 });
    addToAllowlist("b", "222", { agentsDir, now: () => t0, ttlMs: 60 * 60 * 1000 });

    // 2s later: a's receipt (ttl 1s) is expired, b's (ttl 1h) is not.
    const swept = sweepAllowlist({ agentsDir, expiredOnly: true, now: () => t0 + 2000 });
    expect(swept.map((r) => r.agent)).toEqual(["a"]);
    expect(readAccess("a").allowFrom).toEqual([]);
    // b untouched.
    expect(readAccess("b").allowFrom).toEqual(["222"]);
    expect(existsSync(receiptPath(agentsDir, "b"))).toBe(true);
  });

  it("returns empty on a missing agents dir", () => {
    expect(sweepAllowlist({ agentsDir: join(root, "nope") })).toEqual([]);
  });
});

describe("runAllowlistCli", () => {
  it("add then remove --sweep round-trips to zero residue", () => {
    seedAccess("ziggy", { allowFrom: ["1"] });
    expect(runAllowlistCli(["add", "ziggy", "999", "--agents-dir", agentsDir])).toBe(0);
    expect(readAccess("ziggy").allowFrom).toEqual(["1", "999"]);

    expect(runAllowlistCli(["remove", "--sweep", "--agents-dir", agentsDir])).toBe(0);
    expect(readAccess("ziggy").allowFrom).toEqual(["1"]);
    expect(existsSync(receiptPath(agentsDir, "ziggy"))).toBe(false);
  });

  it("add without a userId is a usage error (exit 1)", () => {
    expect(runAllowlistCli(["add", "ziggy", "--agents-dir", agentsDir])).toBe(1);
  });

  it("unknown command is exit 1; bare invocation is exit 0", () => {
    expect(runAllowlistCli(["frobnicate"])).toBe(1);
    expect(runAllowlistCli([])).toBe(0);
  });
});
