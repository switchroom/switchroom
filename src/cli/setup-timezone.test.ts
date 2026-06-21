/**
 * #2483 — writeDetectedTimezone (the setup-wizard detect-and-write step).
 *
 * Pins the four install-time branches:
 *   (a) detected a real non-UTC zone → write switchroom.timezone verbatim
 *   (b) detected UTC + interactive   → prompt, validate, write the answer
 *   (c) detected UTC + interactive, empty answer → NO write + loud warn
 *   (d) detected UTC + headless      → NO write + one loud warn, no hang
 *
 * Uses a real temp file (read-mutate-write is part of the contract) with
 * injected detect()/prompt() so the test never touches the host /etc or a
 * live TTY. Synthetic config only — no PII/secrets.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

// Mock the vault module so importing setup.ts (which statically imports
// vault-broker.js → broker/server.ts → grants-db.ts → bun:sqlite, plus
// dynamic-imports vault.ts) doesn't transitively load bun:sqlite — vitest
// doesn't ship the bun:sqlite shim. Mirrors tests/setup.test.ts. None of
// these are reached by writeDetectedTimezone, so a bare stub is enough.
vi.mock("../vault/vault.js", () => ({
  openVault: vi.fn(),
  createVault: vi.fn(),
  setStringSecret: vi.fn(),
  getStringSecret: vi.fn(),
}));
vi.mock("./vault-broker.js", () => ({
  promptPassphrase: vi.fn(),
}));

import { writeDetectedTimezone } from "./setup.js";

const FRESH_CONFIG = `switchroom:
  version: 1
  agents_dir: ~/.switchroom/agents
telegram:
  bot_token: "vault:telegram-bot-token"
  forum_chat_id: "0"
agents:
  assistant:
    topic_name: "Assistant"
`;

let dir: string;
let cfgPath: string;
let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

function tzOf(): string | undefined {
  return parse(readFileSync(cfgPath, "utf-8")).switchroom.timezone;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sr-tz-"));
  cfgPath = join(dir, "switchroom.yaml");
  writeFileSync(cfgPath, FRESH_CONFIG);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  logSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe("writeDetectedTimezone (#2483)", () => {
  it("(a) writes the detected zone when detection is a real non-UTC zone", async () => {
    const promptCalls: string[] = [];
    await writeDetectedTimezone(
      cfgPath,
      /* nonInteractive */ false,
      () => "Australia/Melbourne",
      async (q) => {
        promptCalls.push(q);
        return "";
      },
    );
    expect(tzOf()).toBe("Australia/Melbourne");
    // never prompts when detection already gave a real zone
    expect(promptCalls).toEqual([]);
  });

  it("(b) interactive UTC → prompts, validates, and writes the answer", async () => {
    await writeDetectedTimezone(
      cfgPath,
      false,
      () => "UTC",
      async () => "Asia/Tokyo",
    );
    expect(tzOf()).toBe("Asia/Tokyo");
  });

  it("(b') interactive UTC → invalid answer is NOT written, warns instead", async () => {
    await writeDetectedTimezone(
      cfgPath,
      false,
      () => "UTC",
      async () => "EST", // three-letter alias — rejected by the validator
    );
    expect(tzOf()).toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });

  it("(c) interactive UTC → empty answer skips the write + warns once", async () => {
    await writeDetectedTimezone(
      cfgPath,
      false,
      () => "UTC",
      async () => "   ", // whitespace-only ⟹ declined
    );
    expect(tzOf()).toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("(d) headless UTC → never writes, emits one loud stderr line, no hang", async () => {
    let prompted = false;
    await writeDetectedTimezone(
      cfgPath,
      /* nonInteractive */ true,
      () => "UTC",
      async () => {
        prompted = true; // the headless path must NOT prompt (would hang in CI)
        return "Asia/Tokyo";
      },
    );
    expect(tzOf()).toBeUndefined();
    expect(prompted).toBe(false);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toMatch(/UTC/);
  });

  it("never persists UTC even when headless and detection is UTC", async () => {
    await writeDetectedTimezone(cfgPath, true, () => "UTC");
    expect(readFileSync(cfgPath, "utf-8")).not.toMatch(/timezone:\s*UTC/);
  });

  it("headless with a real detected zone writes it without prompting", async () => {
    await writeDetectedTimezone(cfgPath, true, () => "Europe/London");
    expect(tzOf()).toBe("Europe/London");
  });
});
