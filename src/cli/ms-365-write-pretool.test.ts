/**
 * Tests for ms-365-write-pretool — RFC #1873 §8 PR 4, P1 hotfix (2026-07-13).
 *
 * Pure-function tests for the testable surface. The async main() flow
 * (stdin parse, gateway IPC, kernel poll) is not unit-tested here — it's
 * tested in the gateway handler tests + UAT scenarios.
 *
 * These tests pin the AUTHORITATIVE softeria tool names (harvested from real
 * `mcp__ms-365__*` invocations across the fleet). The prior version pinned
 * conjectured names (`create-event`, `list-files`, …) that never existed
 * upstream; those assertions passed only because `isGatedMs365Tool`
 * fail-closes ANY unknown name, so they actively MASKED Bug 1 (every real
 * read misclassified as a write). The read assertions below use real names
 * and would FAIL against the pre-fix allowlists.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalizeApproverSet } from "../vault/approvals/canonical.js";
import {
  extractMs365Preview,
  GATED_MS365_WRITE_TOOLS,
  KNOWN_SAFE_MS365_READ_TOOLS,
  isGatedMs365Tool,
  isCalendarEventTool,
  extractEventId,
  buildCalendarChanges,
  enrichCalendarPreview,
  loadAllowFrom,
} from "./ms-365-write-pretool.js";

describe("isGatedMs365Tool — real softeria write names (Bug 1: gate)", () => {
  it("GATES real calendar writes", () => {
    expect(isGatedMs365Tool("mcp__ms-365__create-calendar-event")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__update-calendar-event")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__delete-calendar-event")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__cancel-calendar-event")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__accept-calendar-event")).toBe(true);
  });

  it("GATES real mail writes", () => {
    expect(isGatedMs365Tool("mcp__ms-365__update-mail-message")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__delete-mail-message")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__move-mail-message")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__reply-mail-message")).toBe(true);
  });

  it("GATES real OneDrive writes", () => {
    expect(isGatedMs365Tool("mcp__ms-365__upload-file-content")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__create-upload-session")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__delete-onedrive-file")).toBe(true);
  });
});

describe("isGatedMs365Tool — real softeria read names (Bug 1: pass through)", () => {
  // These are the highest-traffic REAL reads. Pre-fix, none were on the
  // allowlist, so every one posted an approval card and then hit Bug 2 →
  // drift_revoked. Post-fix they must pass through WITHOUT a card. Each of
  // these assertions FAILS against the pre-fix (conjectured-name) allowlist.
  it("passes real calendar reads through without a card", () => {
    expect(isGatedMs365Tool("mcp__ms-365__get-calendar-view")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__list-calendars")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__list-calendar-events")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__get-calendar-event")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__list-calendar-view-delta")).toBe(false);
  });

  it("passes real mail reads through without a card", () => {
    expect(isGatedMs365Tool("mcp__ms-365__list-mail-messages")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__get-mail-message")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__list-mail-folders")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__list-mail-attachments")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__get-mailbox-settings")).toBe(false);
  });

  it("passes real OneDrive reads + read-only identity ops through", () => {
    expect(isGatedMs365Tool("mcp__ms-365__get-drive-item")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__download-bytes")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__login")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__verify-login")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__list-accounts")).toBe(false);
  });

  it("passes create-draft-email through (policy: frictionless drafting)", () => {
    // Operator-approved exception: a draft is unsent/reviewable/deletable.
    expect(isGatedMs365Tool("mcp__ms-365__create-draft-email")).toBe(false);
  });
});

describe("isGatedMs365Tool — mutating identity ops must be gated (F1)", () => {
  // Reviewer MEDIUM finding F1: identity ops that CHANGE auth/account state
  // (log out, switch account, remove account) are not read-safe — they must
  // require a card. Only the read-only identity ops stay no-card.
  it("GATES mutating identity ops", () => {
    expect(isGatedMs365Tool("mcp__ms-365__logout")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__select-account")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__remove-account")).toBe(true);
  });

  it("keeps read-only identity ops no-card", () => {
    expect(isGatedMs365Tool("mcp__ms-365__login")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__verify-login")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__list-accounts")).toBe(false);
  });
});

describe("isGatedMs365Tool — structural fail-closed + prefix guards", () => {
  it("returns false for non-ms-365 tools (wrong prefix)", () => {
    expect(isGatedMs365Tool("mcp__google-workspace__upload-file-content")).toBe(false);
    expect(isGatedMs365Tool("Edit")).toBe(false);
    expect(isGatedMs365Tool("Bash")).toBe(false);
  });

  it("returns false for empty / malformed input", () => {
    expect(isGatedMs365Tool("")).toBe(false);
    expect(isGatedMs365Tool("mcp__ms-365__")).toBe(false);
  });

  // ── Fail-closed inversion ────────────────────────────────────────────
  // An UNRECOGNIZED ms-365 tool — a renamed or newly-added upstream tool
  // that isn't on the read allowlist — must REQUIRE approval, not sail
  // through. The allowlist gap defaults to "gate", never to "allow".
  it("GATES an unrecognized ms-365 tool (renamed/new — fail closed)", () => {
    expect(isGatedMs365Tool("mcp__ms-365__put-file")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__patch-calendar-event")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__totally-unknown-tool")).toBe(true);
  });

  it("GATES send-mail / send — explicit gate-and-allow (not silent pass)", () => {
    // send-mail is now on the explicit write set (gate-and-allow): it posts
    // a card the operator can approve, rather than riding fail-closed
    // implicitly. Either way it must be gated, never allowed silently.
    expect(isGatedMs365Tool("mcp__ms-365__send-mail")).toBe(true);
    expect(isGatedMs365Tool("mcp__ms-365__send")).toBe(true);
  });
});

describe("tool-set integrity", () => {
  it("read allowlist never overlaps the gated write set", () => {
    for (const t of KNOWN_SAFE_MS365_READ_TOOLS) {
      expect(GATED_MS365_WRITE_TOOLS.has(t), t).toBe(false);
    }
  });

  it("no send tool is on the read allowlist (writes never read-safe)", () => {
    expect(KNOWN_SAFE_MS365_READ_TOOLS.has("send-mail")).toBe(false);
    expect(KNOWN_SAFE_MS365_READ_TOOLS.has("send")).toBe(false);
  });

  it("write set contains the real calendar/mail write names", () => {
    for (const t of [
      "create-calendar-event",
      "update-calendar-event",
      "delete-calendar-event",
      "update-mail-message",
      "delete-mail-message",
      "send-mail",
    ]) {
      expect(GATED_MS365_WRITE_TOOLS.has(t), t).toBe(true);
    }
  });

  it("write set does NOT contain the old conjectured names", () => {
    // Guard against regressing to the fictional names.
    for (const t of ["create-event", "update-event", "delete-event", "update-message", "delete-message"]) {
      expect(GATED_MS365_WRITE_TOOLS.has(t), t).toBe(false);
    }
  });
});

// ── Bug 2 regression: verdict lookup must pass a NON-EMPTY operator set ──
//
// The kernel's evaluateDecisionRow drift check (src/vault/approvals/kernel.ts)
// compares `canonicalizeApproverSet(current_approver_set)` against the
// decision row's stored canonical. On grant the shared callback records the
// tapper's uid singleton (`[tapper_uid]`). The pre-fix pretool passed `[]`,
// so `canonicalize([]) !== canonicalize([tapper_uid])` ALWAYS → drift branch
// → drift_revoked. Every operator Approve was silently reverted to a deny.
//
// The fix loads the real operator allowFrom via loadAllowFrom(); in the
// single-operator DM case that is `[operator_uid]`, and the tapper IS the
// operator, so the two canonicalize identically → NO drift → grant sticks.
// These tests reproduce that outcome with the REAL kernel canonicalizer.
describe("Bug 2 regression — non-empty approver set makes grant stick", () => {
  let stateDir: string;
  const savedStateDir = process.env.TELEGRAM_STATE_DIR;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ms365-access-"));
  });
  afterEach(() => {
    if (savedStateDir === undefined) delete process.env.TELEGRAM_STATE_DIR;
    else process.env.TELEGRAM_STATE_DIR = savedStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  });

  function writeAccess(allowFrom: string[]): void {
    writeFileSync(join(stateDir, "access.json"), JSON.stringify({ allowFrom }));
    process.env.TELEGRAM_STATE_DIR = stateDir;
  }

  it("loadAllowFrom returns the operator set from access.json", () => {
    writeAccess(["555000111"]);
    expect(loadAllowFrom()).toEqual(["555000111"]);
  });

  it("single-operator: loaded set canonicalizes == the [tapper_uid] record → NO drift (granted)", () => {
    const tapperUid = "555000111"; // what approval-callback records on grant
    writeAccess([tapperUid]);

    const lookupSet = loadAllowFrom(); // what the FIXED pretool passes
    const recordCanonical = canonicalizeApproverSet([tapperUid]);
    const lookupCanonical = canonicalizeApproverSet(lookupSet);

    // Fixed behaviour: sets match → kernel keeps the grant.
    expect(lookupCanonical).toBe(recordCanonical);
  });

  it("the OLD empty-set behaviour would DRIFT-REVOKE against the same record", () => {
    const tapperUid = "555000111";
    // Pre-fix pretool passed [] regardless of access.json.
    const oldLookupCanonical = canonicalizeApproverSet([]);
    const recordCanonical = canonicalizeApproverSet([tapperUid]);
    // Proves the bug: empty set never matches the recorded operator → drift.
    expect(oldLookupCanonical).not.toBe(recordCanonical);
  });

  it("loadAllowFrom returns [] when no operator is paired (fails closed, not open)", () => {
    process.env.TELEGRAM_STATE_DIR = stateDir; // no access.json written
    expect(loadAllowFrom()).toEqual([]);
    // An empty loaded set still can't match the [tapper_uid] record, so an
    // unpaired agent drift-denies — safe, never fail-open.
    expect(canonicalizeApproverSet([])).not.toBe(
      canonicalizeApproverSet(["555000111"]),
    );
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
    expect(extractMs365Preview("mcp__ms-365__create-calendar-event", { eventId: "ev-1" }).itemId).toBe("ev-1");
    expect(extractMs365Preview("mcp__ms-365__update-mail-message", { messageId: "msg-1" }).itemId).toBe("msg-1");
    expect(extractMs365Preview("mcp__ms-365__delete-calendar-event", { id: "x" }).itemId).toBe("x");
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

// ── #3267 Problem 1: Graph-resolved calendar context + diff ────────────────

describe("isCalendarEventTool / extractEventId", () => {
  it("detects calendar-event tools", () => {
    expect(isCalendarEventTool("mcp__ms-365__update-calendar-event")).toBe(true);
    expect(isCalendarEventTool("mcp__ms-365__create-specific-calendar-event")).toBe(true);
    expect(isCalendarEventTool("mcp__ms-365__cancel-calendar-event")).toBe(true);
  });
  it("does not flag non-event calendar / mail / drive tools", () => {
    expect(isCalendarEventTool("mcp__ms-365__create-calendar")).toBe(false);
    expect(isCalendarEventTool("mcp__ms-365__update-mail-message")).toBe(false);
    expect(isCalendarEventTool("mcp__ms-365__upload-file-content")).toBe(false);
    expect(isCalendarEventTool("Edit")).toBe(false);
  });
  it("extracts the event id from common shapes", () => {
    expect(extractEventId({ eventId: "AQ==" })).toBe("AQ==");
    expect(extractEventId({ id: "xyz" })).toBe("xyz");
    expect(extractEventId({})).toBeNull();
    expect(extractEventId(null)).toBeNull();
  });
});

describe("buildCalendarChanges", () => {
  const current = {
    subject: "Standup",
    start: "2026-07-20T09:00:00",
    end: "2026-07-20T09:30:00",
    location: "Room A",
    bodyPreview: "old notes",
  };

  it("diffs only the fields the mutation actually changes (body-only edit)", () => {
    const changes = buildCalendarChanges(
      { eventId: "AQ==", body: { contentType: "HTML", content: "<p>new notes</p>" } },
      current,
    );
    expect(changes).toEqual([
      { field: "body", before: "old notes", after: "new notes" },
    ]);
  });

  it("emits before→after for a location change", () => {
    const changes = buildCalendarChanges({ location: "Room B" }, current);
    expect(changes).toEqual([{ field: "location", before: "Room A", after: "Room B" }]);
  });

  it("skips no-op changes where after === before", () => {
    expect(buildCalendarChanges({ location: "Room A" }, current)).toEqual([]);
  });

  it("works with no current context (before undefined)", () => {
    const changes = buildCalendarChanges({ start: { dateTime: "2026-07-20T10:00:00" } }, null);
    expect(changes).toEqual([{ field: "start", after: "2026-07-20T10:00:00" }]);
  });
});

describe("enrichCalendarPreview — resolves subject + account for a body-only edit", () => {
  it("returns a real subject + account instead of '(unknown)' when Graph resolves", async () => {
    const enrichment = await enrichCalendarPreview(
      "mcp__ms-365__update-calendar-event",
      { eventId: "AQMkADAw==", body: { content: "<p>new</p>" } },
      {
        loadHandle: async () => ({
          access_token: "at-1",
          expires_at: Date.now() + 3_600_000,
          account_email: "ken@example.com",
        }),
        fetchEvent: async () => ({
          subject: "Dentist appointment",
          start: "2026-07-20T09:00:00",
          end: "2026-07-20T09:30:00",
          bodyPreview: "old",
        }),
      },
    );
    // The exact bug: a body-only edit used to fall through to "(unknown)".
    expect(enrichment.itemDisplayName).toBe("Dentist appointment");
    expect(enrichment.accountEmail).toBe("ken@example.com");
    expect(enrichment.eventWhen).toBe("2026-07-20T09:00:00 → 2026-07-20T09:30:00");
    expect(enrichment.changes).toEqual([{ field: "body", before: "old", after: "new" }]);
    expect(enrichment.resolveAttemptedButFailed).toBeUndefined();
  });

  it("is a no-op for non-calendar tools", async () => {
    const e = await enrichCalendarPreview("mcp__ms-365__upload-file-content", {}, {
      loadHandle: async () => {
        throw new Error("should not be called");
      },
    });
    expect(e).toEqual({});
  });

  it("degrades to resolveAttemptedButFailed when the broker is unreachable (never throws)", async () => {
    const e = await enrichCalendarPreview(
      "mcp__ms-365__update-calendar-event",
      { eventId: "AQ==" },
      { loadHandle: async () => null },
    );
    expect(e.resolveAttemptedButFailed).toBe(true);
    expect(e.itemDisplayName).toBeUndefined();
  });

  it("does not throw when the Graph fetch itself rejects", async () => {
    const e = await enrichCalendarPreview(
      "mcp__ms-365__update-calendar-event",
      { eventId: "AQ==", location: "New" },
      {
        loadHandle: async () => ({
          access_token: "at",
          expires_at: Date.now() + 3_600_000,
          account_email: "ken@example.com",
        }),
        fetchEvent: async () => {
          throw new Error("network");
        },
      },
    );
    // Still resolves the account (from the token identity) and the after-value.
    expect(e.accountEmail).toBe("ken@example.com");
    expect(e.changes).toEqual([{ field: "location", after: "New" }]);
  });
});
