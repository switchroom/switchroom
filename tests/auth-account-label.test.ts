import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  getSlotInfos,
  readSlotMeta,
  setSlotLabel,
  writeSlotToken,
} from "../src/auth/accounts.js";

let agentDir: string;

beforeEach(() => {
  agentDir = resolve(
    tmpdir(),
    `switchroom-label-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(agentDir, ".claude"), { recursive: true });
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("setSlotLabel", () => {
  it("attaches a label to an existing slot", () => {
    writeSlotToken(agentDir, "default", "sk-ant-oat01-xxx");
    setSlotLabel(agentDir, "default", "ken@example.com");
    expect(readSlotMeta(agentDir, "default")?.accountLabel).toBe(
      "ken@example.com",
    );
  });

  it("trims whitespace", () => {
    writeSlotToken(agentDir, "default", "sk-ant-oat01-xxx");
    setSlotLabel(agentDir, "default", "  ken@example.com  ");
    expect(readSlotMeta(agentDir, "default")?.accountLabel).toBe(
      "ken@example.com",
    );
  });

  it("clears the label when given undefined or empty", () => {
    writeSlotToken(agentDir, "default", "sk-ant-oat01-xxx");
    setSlotLabel(agentDir, "default", "ken@example.com");
    setSlotLabel(agentDir, "default", undefined);
    expect(readSlotMeta(agentDir, "default")?.accountLabel).toBeUndefined();
    setSlotLabel(agentDir, "default", "ken@example.com");
    setSlotLabel(agentDir, "default", "  ");
    expect(readSlotMeta(agentDir, "default")?.accountLabel).toBeUndefined();
  });

  it("creates a meta file when absent", () => {
    // No prior writeSlotToken — slot meta doesn't exist yet.
    setSlotLabel(agentDir, "default", "ken@example.com");
    const meta = readSlotMeta(agentDir, "default");
    expect(meta?.accountLabel).toBe("ken@example.com");
    expect(meta?.source).toBe("unknown");
  });

  it("rejects invalid slot names", () => {
    expect(() => setSlotLabel(agentDir, "../etc", "x")).toThrow();
  });
});

describe("writeSlotToken preserves label across reauth", () => {
  it("keeps accountLabel when the token is rewritten", () => {
    writeSlotToken(agentDir, "default", "sk-ant-oat01-aaa");
    setSlotLabel(agentDir, "default", "ken@example.com");
    // Simulate a reauth — token changes, meta gets rewritten.
    writeSlotToken(agentDir, "default", "sk-ant-oat01-bbb");
    expect(readSlotMeta(agentDir, "default")?.accountLabel).toBe(
      "ken@example.com",
    );
  });

  it("does not synthesize a label when none was set", () => {
    writeSlotToken(agentDir, "default", "sk-ant-oat01-xxx");
    expect(readSlotMeta(agentDir, "default")?.accountLabel).toBeUndefined();
  });
});

describe("getSlotInfos exposes the label", () => {
  it("includes accountLabel when set", () => {
    writeSlotToken(agentDir, "default", "sk-ant-oat01-aaa");
    writeSlotToken(agentDir, "secondary", "sk-ant-oat01-bbb");
    setSlotLabel(agentDir, "default", "primary@example.com");
    const infos = getSlotInfos(agentDir);
    const primary = infos.find((s) => s.slot === "default");
    const secondary = infos.find((s) => s.slot === "secondary");
    expect(primary?.accountLabel).toBe("primary@example.com");
    expect(secondary?.accountLabel).toBeUndefined();
  });
});
