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
  assertSelfScopedAllowEdit,
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

describe("assertSelfScopedAllowEdit — non-admin always-allow boundary", () => {
  const base = (gymbroTools?: string) =>
    "switchroom:\n" +
    "  version: 1\n" +
    "agents:\n" +
    "  gymbro:\n" +
    '    persona: "lifting coach"\n' +
    (gymbroTools ?? "") +
    "  clerk:\n" +
    '    persona: "office"\n';

  it("ALLOWS adding a rule to the caller's own tools.allow", () => {
    const before = base();
    const after = base("    tools:\n      allow:\n        - mcp__perplexity__search\n");
    expect(assertSelfScopedAllowEdit(before, after, "gymbro")).toEqual({ ok: true });
  });

  it("ALLOWS appending to an existing own allow-list", () => {
    const before = base("    tools:\n      allow:\n        - Edit\n");
    const after = base(
      "    tools:\n      allow:\n        - Edit\n        - mcp__perplexity__search\n",
    );
    expect(assertSelfScopedAllowEdit(before, after, "gymbro")).toEqual({ ok: true });
  });

  it("REJECTS adding a rule to a DIFFERENT agent's allow-list", () => {
    const before = base();
    const after =
      "switchroom:\n" +
      "  version: 1\n" +
      "agents:\n" +
      "  gymbro:\n" +
      '    persona: "lifting coach"\n' +
      "  clerk:\n" +
      '    persona: "office"\n' +
      "    tools:\n      allow:\n        - Bash\n";
    const r = assertSelfScopedAllowEdit(before, after, "gymbro");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/outside agents\.gymbro\.tools\.allow/);
  });

  it("REJECTS changing a non-allow field on the caller's own agent", () => {
    const before = base();
    const after = base('    model: "claude-opus-4-8"\n');
    const r = assertSelfScopedAllowEdit(before, after, "gymbro");
    expect(r.ok).toBe(false);
  });

  it("REJECTS removing an existing rule from the caller's own allow-list", () => {
    const before = base(
      "    tools:\n      allow:\n        - Edit\n        - Bash\n",
    );
    const after = base("    tools:\n      allow:\n        - Edit\n");
    const r = assertSelfScopedAllowEdit(before, after, "gymbro");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/removes existing allow rule "Bash"/);
  });

  it("REJECTS widening a cascade default (defaults.allowed_tools)", () => {
    const before = base();
    const after =
      "switchroom:\n" +
      "  version: 1\n" +
      "defaults:\n" +
      "  allowed_tools:\n" +
      "    - mcp__perplexity__search\n" +
      "agents:\n" +
      "  gymbro:\n" +
      '    persona: "lifting coach"\n' +
      "  clerk:\n" +
      '    persona: "office"\n';
    const r = assertSelfScopedAllowEdit(before, after, "gymbro");
    expect(r.ok).toBe(false);
  });

  it("denies (does not throw) on unparseable config", () => {
    const r = assertSelfScopedAllowEdit(": : :\n  - [", "agents: {}\n", "gymbro");
    expect(r.ok).toBe(false);
  });
});
