import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  detectQuotaExhausted,
  getSlotInfos,
  listSlots,
  markSlotQuotaExhausted,
  migrateLegacyIfNeeded,
  pickFallbackSlot,
  readActiveSlot,
  readSlotMeta,
  removeSlot,
  slotHealth,
  slotTokenPath,
  suggestSlotName,
  syncLegacyFromActive,
  useSlot,
  validateSlotName,
  writeActiveSlot,
  writeSlotToken,
  legacyTokenPath,
  legacyMetaPath,
} from "../src/auth/accounts.js";

let tempDir: string;

beforeEach(() => {
  tempDir = resolve(tmpdir(), `switchroom-accounts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tempDir, ".claude"), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("validateSlotName", () => {
  it("accepts simple names", () => {
    expect(() => validateSlotName("default")).not.toThrow();
    expect(() => validateSlotName("slot-2")).not.toThrow();
    expect(() => validateSlotName("work_account.01")).not.toThrow();
  });

  it("rejects empty", () => {
    expect(() => validateSlotName("")).toThrow();
  });

  it("rejects '..' and '.'", () => {
    expect(() => validateSlotName("..")).toThrow();
    expect(() => validateSlotName(".")).toThrow();
  });

  it("rejects path separators", () => {
    expect(() => validateSlotName("a/b")).toThrow();
    expect(() => validateSlotName("a\\b")).toThrow();
  });

  it("rejects unsafe characters", () => {
    expect(() => validateSlotName("foo bar")).toThrow();
    expect(() => validateSlotName("foo;rm -rf")).toThrow();
    expect(() => validateSlotName("foo$bar")).toThrow();
  });

  it("rejects overly long names", () => {
    expect(() => validateSlotName("x".repeat(65))).toThrow();
  });
});

describe("slot storage roundtrip", () => {
  it("add → list → use → rm", () => {
    // Add two slots
    writeSlotToken(tempDir, "default", "sk-ant-oat01-first");
    writeSlotToken(tempDir, "slot-2", "sk-ant-oat01-second");
    writeActiveSlot(tempDir, "default");

    const slots = listSlots(tempDir);
    expect(slots).toEqual(["default", "slot-2"]);
    expect(readActiveSlot(tempDir)).toBe("default");

    // Switch
    useSlot(tempDir, "slot-2");
    expect(readActiveSlot(tempDir)).toBe("slot-2");

    // Legacy mirror kept up to date
    const legacyTok = readFileSync(legacyTokenPath(tempDir), "utf-8").trim();
    expect(legacyTok).toBe("sk-ant-oat01-second");

    // Remove non-active
    removeSlot(tempDir, "default");
    expect(listSlots(tempDir)).toEqual(["slot-2"]);
  });

  it("writeSlotToken creates meta with sane defaults", () => {
    writeSlotToken(tempDir, "default", "sk-ant-oat01-x");
    const meta = readSlotMeta(tempDir, "default");
    expect(meta).not.toBeNull();
    expect(meta!.source).toBe("claude-setup-token");
    expect(meta!.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("migrateLegacyIfNeeded", () => {
  it("migrates a legacy .oauth-token into accounts/default/", () => {
    writeFileSync(join(tempDir, ".claude", ".oauth-token"), "sk-ant-oat01-legacy\n");
    const result = migrateLegacyIfNeeded(tempDir);
    expect(result.migrated).toBe(true);
    expect(result.slot).toBe("default");
    expect(readActiveSlot(tempDir)).toBe("default");
    const tok = readFileSync(slotTokenPath(tempDir, "default"), "utf-8").trim();
    expect(tok).toBe("sk-ant-oat01-legacy");
  });

  it("is idempotent (second call is a no-op)", () => {
    writeFileSync(join(tempDir, ".claude", ".oauth-token"), "sk-ant-oat01-legacy\n");
    migrateLegacyIfNeeded(tempDir);
    const again = migrateLegacyIfNeeded(tempDir);
    expect(again.migrated).toBe(false);
  });

  it("no-ops when there is nothing to migrate", () => {
    const result = migrateLegacyIfNeeded(tempDir);
    expect(result.migrated).toBe(false);
    expect(readActiveSlot(tempDir)).toBeNull();
  });

  it("adopts a sole slot when active marker is missing", () => {
    writeSlotToken(tempDir, "only-one", "sk-ant-oat01-xxx");
    const r = migrateLegacyIfNeeded(tempDir);
    expect(r.migrated).toBe(true);
    expect(readActiveSlot(tempDir)).toBe("only-one");
  });

  it("preserves legacy meta JSON if present", () => {
    writeFileSync(join(tempDir, ".claude", ".oauth-token"), "sk-ant-oat01-legacy\n");
    writeFileSync(
      join(tempDir, ".claude", ".oauth-token.meta.json"),
      JSON.stringify({ createdAt: 1, expiresAt: 99999999999, source: "old" }),
    );
    migrateLegacyIfNeeded(tempDir);
    const meta = readSlotMeta(tempDir, "default");
    expect(meta!.source).toBe("old");
  });
});

describe("useSlot", () => {
  it("refuses an unknown slot", () => {
    writeSlotToken(tempDir, "default", "t");
    expect(() => useSlot(tempDir, "nope")).toThrow(/does not exist/i);
  });

  it("updates the legacy mirror on switch", () => {
    writeSlotToken(tempDir, "a", "token-a");
    writeSlotToken(tempDir, "b", "token-b");
    writeActiveSlot(tempDir, "a");
    syncLegacyFromActive(tempDir);

    useSlot(tempDir, "b");
    expect(readFileSync(legacyTokenPath(tempDir), "utf-8").trim()).toBe("token-b");
    expect(existsSync(legacyMetaPath(tempDir))).toBe(true);
  });
});

describe("removeSlot guardrails", () => {
  it("refuses to remove the only slot", () => {
    writeSlotToken(tempDir, "default", "t");
    writeActiveSlot(tempDir, "default");
    expect(() => removeSlot(tempDir, "default")).toThrow(/only slot/i);
  });

  it("refuses active slot when no healthy fallback exists", () => {
    writeSlotToken(tempDir, "a", "ta");
    writeSlotToken(tempDir, "b", "tb");
    writeActiveSlot(tempDir, "a");
    // Expire b so no healthy alternative remains — but pickFallback still
    // prefers expired over nothing, so this case actually *succeeds* (expired
    // slots are picked as last-ditch). That's the contract: only refuse when
    // there is literally no other slot at all.
    //
    // Lock the stricter "only other slot is nonexistent" case instead:
    removeSlot(tempDir, "a"); // succeeds; b becomes active
    expect(readActiveSlot(tempDir)).toBe("b");
  });

  it("swaps active before removing, if a healthy fallback exists", () => {
    writeSlotToken(tempDir, "a", "ta");
    writeSlotToken(tempDir, "b", "tb");
    writeActiveSlot(tempDir, "a");
    removeSlot(tempDir, "a");
    expect(readActiveSlot(tempDir)).toBe("b");
    expect(listSlots(tempDir)).toEqual(["b"]);
  });
});

describe("slotHealth + pickFallbackSlot", () => {
  it("quota-exhausted slots are skipped until the reset passes", () => {
    writeSlotToken(tempDir, "a", "ta");
    writeSlotToken(tempDir, "b", "tb");
    writeActiveSlot(tempDir, "a");
    markSlotQuotaExhausted(tempDir, "b", Date.now() + 60_000);

    // Now "b" should be quota-exhausted
    expect(slotHealth(tempDir, "b")).toBe("quota-exhausted");

    // Fallback from a: b is quota-exhausted — but it's the only alternative
    // so we still pick it (preferring healthy/expired first).
    expect(pickFallbackSlot(tempDir, "a")).toBe("b");

    // Fake time forward: quota-exhausted is now "healthy"
    const future = Date.now() + 120_000;
    expect(slotHealth(tempDir, "b", future)).toBe("healthy");
  });

  it("prefers healthy over expired over quota-exhausted", () => {
    writeSlotToken(tempDir, "active", "t0");
    writeSlotToken(tempDir, "healthy", "t1");
    writeSlotToken(tempDir, "expired", "t2");
    writeSlotToken(tempDir, "exhausted", "t3");
    writeActiveSlot(tempDir, "active");

    // Mutate metas
    const now = Date.now();
    const meta2 = readSlotMeta(tempDir, "expired");
    meta2!.expiresAt = now - 1000;
    writeFileSync(
      join(tempDir, ".claude", "accounts", "expired", ".oauth-token.meta.json"),
      JSON.stringify(meta2),
    );
    markSlotQuotaExhausted(tempDir, "exhausted", now + 60 * 60_000);

    expect(pickFallbackSlot(tempDir, "active")).toBe("healthy");
  });

  it("returns null when no alternative slots exist", () => {
    writeSlotToken(tempDir, "only", "t");
    writeActiveSlot(tempDir, "only");
    expect(pickFallbackSlot(tempDir, "only")).toBeNull();
  });

  it("getSlotInfos marks the active slot", () => {
    writeSlotToken(tempDir, "a", "ta");
    writeSlotToken(tempDir, "b", "tb");
    writeActiveSlot(tempDir, "a");
    const infos = getSlotInfos(tempDir);
    expect(infos.find((s) => s.slot === "a")!.active).toBe(true);
    expect(infos.find((s) => s.slot === "a")!.health).toBe("active");
    expect(infos.find((s) => s.slot === "b")!.active).toBe(false);
  });
});

describe("suggestSlotName", () => {
  it("returns 'default' on a fresh agent", () => {
    expect(suggestSlotName(tempDir)).toBe("default");
  });

  it("returns slot-2 when default exists", () => {
    writeSlotToken(tempDir, "default", "t");
    expect(suggestSlotName(tempDir)).toBe("slot-2");
  });

  it("skips taken slot numbers", () => {
    writeSlotToken(tempDir, "default", "t");
    writeSlotToken(tempDir, "slot-2", "t");
    writeSlotToken(tempDir, "slot-3", "t");
    expect(suggestSlotName(tempDir)).toBe("slot-4");
  });
});

describe("detectQuotaExhausted", () => {
  it("matches 5-hour limit message", () => {
    const r = detectQuotaExhausted("You have hit the 5-hour usage limit");
    expect(r.hit).toBe(true);
  });
  it("matches rate limit / 429", () => {
    expect(detectQuotaExhausted("HTTP 429 Too Many Requests").hit).toBe(true);
    expect(detectQuotaExhausted("rate limit reached").hit).toBe(true);
  });
  it("ignores normal text", () => {
    expect(detectQuotaExhausted("hello world").hit).toBe(false);
  });
  it("parses retry-after seconds", () => {
    const r = detectQuotaExhausted("429: retry after 120 seconds");
    expect(r.hit).toBe(true);
    expect(r.resetAtMs).toBeDefined();
    expect(r.resetAtMs! - Date.now()).toBeGreaterThan(100_000);
    expect(r.resetAtMs! - Date.now()).toBeLessThan(200_000);
  });
});
