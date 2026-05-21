/**
 * Unit tests for `validateConfigEdit` — exercise paths the wire-layer
 * frame cap (64 KB) makes unreachable from the integration test in
 * `config-propose-edit.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateConfigEdit,
  MAX_PATCH_BYTES,
} from "../../src/host-control/config-edit-validator.js";

let tmp: string;
let configPath: string;

const VALID_BASE_YAML =
  "switchroom:\n" +
  "  version: 1\n" +
  "telegram:\n" +
  '  bot_token: "x"\n' +
  '  forum_chat_id: "1"\n' +
  "agents: {}\n";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "validator-unit-"));
  configPath = join(tmp, "switchroom.yaml");
  writeFileSync(configPath, VALID_BASE_YAML);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("validateConfigEdit — oversize cap (defense-in-depth)", () => {
  it("rejects a patch over MAX_PATCH_BYTES with E_PATCH_INVALID_SHAPE", () => {
    // Wire layer caps at 64 KB, but the validator independently
    // enforces 1 MB per RFC §3.2 step 1 in case a future caller
    // bypasses the wire (e.g. an in-process invocation from PR 1c's
    // approval-card handler).
    const big = "x".repeat(MAX_PATCH_BYTES + 100);
    const result = validateConfigEdit({
      configPath,
      targetPath: "/state/config/switchroom.yaml",
      unifiedDiff:
        "--- a/switchroom.yaml\n+++ b/switchroom.yaml\n@@ -1 +1 @@\n-a\n+b\n" +
        big,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("E_PATCH_INVALID_SHAPE");
      expect(result.detail).toMatch(/cap/);
    }
  });

  it("rejects a CRLF patch with E_PATCH_INVALID_SHAPE", () => {
    const crlf =
      "--- a/switchroom.yaml\r\n+++ b/switchroom.yaml\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n";
    const result = validateConfigEdit({
      configPath,
      targetPath: "/state/config/switchroom.yaml",
      unifiedDiff: crlf,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("E_PATCH_INVALID_SHAPE");
      expect(result.detail).toMatch(/LF-only/);
    }
  });
});
