/**
 * Tests for ms-365-write-pretool — RFC #1873 §8 PR 4.
 *
 * Pure-function tests for the testable surface. The async main() flow
 * (stdin parse, gateway IPC, kernel poll) is not unit-tested here —
 * it's tested in the gateway handler tests + UAT scenarios in PR 5.
 */

import { describe, expect, it } from "vitest";

import {
  extractMs365Preview,
  GATED_MS365_WRITE_TOOLS,
  KNOWN_SAFE_MS365_READ_TOOLS,
  isGatedMs365Tool,
} from "./ms-365-write-pretool.js";

describe("isGatedMs365Tool", () => {
  it("returns true for known gated tools", () => {
    expect(isGatedMs365Tool("mcp__ms-365__upload-file-content")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__create-upload-session")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__create-event")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__update-event")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__delete-event")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__update-message")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__delete-message")).toBe(true);
  });

  it("returns false for VERIFIED read tools (no gating overhead)", () => {
    expect(isGatedMs365Tool("mcp__ms-365__list-files")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__get-drive-item")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__list-events")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__search-mail")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__download-bytes")).toBe(false);
  });

  it("returns false for non-ms-365 tools (wrong prefix)", () => {
    expect(isGatedMs365Tool("mcp__google-workspace__upload-file-content")).toBe(false);
    expect(isGatedMs365Tool("Edit")).toBe(false);
    expect(isGatedMs365Tool("Bash")).toBe(false);
  });

  it("returns false for empty / malformed input", () => {
    expect(isGatedMs365Tool("")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__")).toBe(false);
  });

  // ── Fail-closed inversion (review 2026-07-11, W2) ────────────────────
  // An unrecognized MS-365 tool — a renamed or newly-added upstream write —
  // must REQUIRE approval, not sail through. The allowlist gap defaults to
  // "gate", never to "allow".
  it("GATES an unrecognized ms-365 tool (renamed/new write — fail closed)", () => {
    // A plausibly-renamed upload tool that isn't in our read allowlist.
    expect(isGatedMs365Tool("mcp__ms-365__upload-file-content-v2")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__put-file")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__patch-event")).toBe(true);
    // A brand-new write surface softeria might add tomorrow.
    expect(isGatedMs365Tool("mcp__ms-365__move-message")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__totally-unknown-tool")).toBe(true);
  });

  it("GATES Mail.Send — a write tool not on the read allowlist (fail closed)", () => {
    // Pre-fix this was deliberately allowed through ("agent shouldn't have
    // the scope at all"), which was exactly the fail-open hole: if the
    // agent ever DID get send access, it bypassed approval. Fail-closed
    // now requires a card for any unrecognized write.
    expect(isGatedMs365Tool("mcp__ms-365__send-mail")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__send-message")).toBe(true);
  });
});

describe("KNOWN_SAFE_MS365_READ_TOOLS — read allowlist integrity", () => {
  it("does not overlap with the gated write set", () => {
    for (const t of KNOWN_SAFE_MS365_READ_TOOLS) {
      expect(GATED_MS365_WRITE_TOOLS.has(t), t).toBe(false);
    }
  });

  it("does not include any send tool (writes never belong on the read allowlist)", () => {
    expect(KNOWN_SAFE_MS365_READ_TOOLS.has("send-mail")).toBe(false);
    expect(KNOWN_SAFE_MS365_READ_TOOLS.has("send-message")).toBe(false);
  });
});

describe("GATED_MS365_WRITE_TOOLS — set integrity", () => {
  it("does not include Mail.Send tools (v1 contract)", () => {
    expect(GATED_MS365_WRITE_TOOLS.has("send-mail")).toBe(false);
    expect(GATED_MS365_WRITE_TOOLS.has("send-message")).toBe(false);
  });

  it("includes all expected v1 write tools", () => {
    const expected = [
      "upload-file-content",
      "create-upload-session",
      "create-event",
      "update-event",
      "delete-event",
      "update-message",
      "delete-message",
    ];
    for (const t of expected) {
      expect(GATED_MS365_WRITE_TOOLS.has(t)).toBe(true);
    }
  });
});

describe("extractMs365Preview", () => {
  it("extracts itemId from common shape `itemId`", () => {
    const r = extractMs365Preview("mcp__ms-365__upload-file-content", {
      itemId: "01ABC",
      fileName: "doc.docx",
    });
    expect(r.itemId).toBe("01ABC");
    expect(r.itemDisplayName).toBe("doc.docx");
  });

  it("falls back through alternate id field names", () => {
    expect(extractMs365Preview("mcp__ms-365__create-event", { eventId: "ev-1" }).itemId).toBe("ev-1");
    expect(extractMs365Preview("mcp__ms-365__update-message", { messageId: "msg-1" }).itemId).toBe("msg-1");
    expect(extractMs365Preview("mcp__ms-365__delete-event", { id: "x" }).itemId).toBe("x");
  });

  it('defaults itemId to "(new)" when no id field is present', () => {
    expect(extractMs365Preview("mcp__ms-365__upload-file-content", {}).itemId).toBe("(new)");
  });

  it("extracts display name from common shapes", () => {
    expect(extractMs365Preview("x", { name: "a" }).itemDisplayName).toBe("a");
    expect(extractMs365Preview("x", { fileName: "b" }).itemDisplayName).toBe("b");
    expect(extractMs365Preview("x", { subject: "Re: meeting" }).itemDisplayName).toBe("Re: meeting");
    expect(extractMs365Preview("x", { title: "All-hands" }).itemDisplayName).toBe("All-hands");
  });

  it('defaults display name to "(unknown)"', () => {
    expect(extractMs365Preview("x", {}).itemDisplayName).toBe("(unknown)");
  });

  it("extracts deep link from common url shapes", () => {
    expect(extractMs365Preview("x", { webUrl: "https://x.com/y" }).deepLink).toBe("https://x.com/y");
    expect(extractMs365Preview("x", { url: "http://abc" }).deepLink).toBe("http://abc");
  });

  it("rejects non-http deep links (best-effort filter for typo'd shapes)", () => {
    expect(extractMs365Preview("x", { webUrl: "/relative" }).deepLink).toBeUndefined();
    expect(extractMs365Preview("x", { webUrl: 42 }).deepLink).toBeUndefined();
  });

  it("extracts size from numeric fields", () => {
    expect(extractMs365Preview("x", { contentSize: 1024 }).sizeBytesAfter).toBe(1024);
    expect(extractMs365Preview("x", { fileSize: 2048 }).sizeBytesAfter).toBe(2048);
  });

  it("derives size from base64 content length when no numeric size field", () => {
    const content = "A".repeat(100); // 100 base64 chars ≈ 75 bytes
    const r = extractMs365Preview("x", { content });
    expect(r.sizeBytesAfter).toBe(75);
  });

  it("handles missing / wrong-typed input defensively", () => {
    expect(extractMs365Preview("x", null).itemId).toBe("(new)");
    expect(extractMs365Preview("x", "not-an-object").itemId).toBe("(new)");
    expect(extractMs365Preview("x", undefined).itemDisplayName).toBe("(unknown)");
  });
});
