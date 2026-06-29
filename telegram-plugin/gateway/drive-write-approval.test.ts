/**
 * Tests for the Drive-write IPC handler — RFC E §4.2 Cut 2.
 */

import { describe, expect, it } from "vitest";

import type {
  DriveApprovalPostedEvent,
  RequestDriveApprovalMessage,
} from "./ipc-protocol.js";
import {
  type DriveApprovalHandlerDeps,
  handleRequestDriveApproval,
} from "./drive-write-approval.js";
import { RICH_MESSAGE_MAX_CHARS } from "../format.js";

// ────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────

/** Valid DiffPreviewInput shape — matches src/drive/diff-preview.ts. */
function validPreview(): Record<string, unknown> {
  return {
    agentName: "klanker",
    docTitle: "Q3 Strategy Notes",
    fileId: "DOC1",
    mimeType: "application/vnd.google-apps.document",
    resolvedAnchor: {
      op: { kind: "insert_after", paragraphIndex: 4 },
      displayName: "inside section 'Goals' (level 2)",
    },
    metrics: { linesAdded: 5, linesRemoved: 0 },
    mode: "write",
  };
}

interface Spy {
  sent: DriveApprovalPostedEvent[];
  registered: Array<{
    scope: string;
    action: string;
    ttl_ms: number;
    approver_set: string[];
  }>;
  posted: Array<{
    chatId: number | string;
    threadId?: number;
    text: string;
  }>;
  logs: string[];
}

function makeSpy(): Spy {
  return { sent: [], registered: [], posted: [], logs: [] };
}

function deps(overrides: Partial<DriveApprovalHandlerDeps> & { spy: Spy }): DriveApprovalHandlerDeps {
  const spy = overrides.spy;
  return {
    agentName: "klanker",
    loadAllowFrom: () => ["12345"],
    loadTargetChat: () => ({ chatId: 999 }),
    registerApproval: async (args) => {
      spy.registered.push({
        scope: args.scope,
        action: args.action,
        ttl_ms: args.ttl_ms,
        approver_set: args.approver_set,
      });
      return { request_id: "aabbccddaabbccddaabbccddaabbccdd", expires_at_ms: Date.now() + args.ttl_ms };
    },
    postCard: async (args) => {
      spy.posted.push({
        chatId: args.chatId,
        ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
        text: args.text,
      });
      return { messageId: 42 };
    },
    buildCard: () => ({ text: "diff-preview card body", reply_markup: { stub: true } }),
    log: (m) => spy.logs.push(m),
    ...overrides,
  };
}

function clientFor(spy: Spy): { send: (msg: unknown) => void } {
  return {
    send: (msg) => {
      const m = msg as DriveApprovalPostedEvent;
      if (m.type === "drive_approval_posted") spy.sent.push(m);
    },
  };
}

function msgFor(overrides: Partial<RequestDriveApprovalMessage> = {}): RequestDriveApprovalMessage {
  return {
    type: "request_drive_approval",
    correlationId: "corr-1",
    agentName: "klanker",
    preview: validPreview(),
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Happy path
// ────────────────────────────────────────────────────────────────────────

describe("handleRequestDriveApproval — happy path", () => {
  it("registers the kernel request + posts the card + replies success", async () => {
    const spy = makeSpy();
    await handleRequestDriveApproval(clientFor(spy), msgFor(), deps({ spy }));
    expect(spy.registered).toHaveLength(1);
    expect(spy.registered[0]).toEqual({
      scope: "doc:gdrive:write:DOC1",
      action: "write",
      ttl_ms: 5 * 60 * 1000,
      approver_set: ["12345"],
    });
    expect(spy.posted).toHaveLength(1);
    expect(spy.posted[0]?.chatId).toBe(999);
    expect(spy.sent).toHaveLength(1);
    expect(spy.sent[0]).toMatchObject({
      type: "drive_approval_posted",
      correlationId: "corr-1",
      ok: true,
      requestId: "aabbccddaabbccddaabbccddaabbccdd",
    });
    expect(spy.sent[0]?.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it("threads threadId through to postCard when targetChat has one", async () => {
    const spy = makeSpy();
    await handleRequestDriveApproval(
      clientFor(spy),
      msgFor(),
      deps({ spy, loadTargetChat: () => ({ chatId: 999, threadId: 7 }) }),
    );
    expect(spy.posted[0]?.threadId).toBe(7);
  });

  it("respects a caller-supplied ttlMs (within clamp)", async () => {
    const spy = makeSpy();
    await handleRequestDriveApproval(
      clientFor(spy),
      msgFor({ ttlMs: 90_000 }),
      deps({ spy }),
    );
    expect(spy.registered[0]?.ttl_ms).toBe(90_000);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Refusals
// ────────────────────────────────────────────────────────────────────────

describe("handleRequestDriveApproval — refusals", () => {
  it("refuses cross-agent requests", async () => {
    const spy = makeSpy();
    await handleRequestDriveApproval(
      clientFor(spy),
      msgFor({ agentName: "clerk" }),
      deps({ spy }),
    );
    expect(spy.registered).toEqual([]);
    expect(spy.sent[0]?.ok).toBe(false);
    expect(spy.sent[0]?.reason).toMatch(/serves 'klanker'/);
  });

  it("refuses malformed preview payloads", async () => {
    const spy = makeSpy();
    await handleRequestDriveApproval(
      clientFor(spy),
      msgFor({ preview: { junk: true } }),
      deps({ spy }),
    );
    expect(spy.registered).toEqual([]);
    expect(spy.sent[0]?.ok).toBe(false);
    expect(spy.sent[0]?.reason).toMatch(/invalid preview/);
  });

  it("refuses when no operator allowFrom is configured", async () => {
    const spy = makeSpy();
    await handleRequestDriveApproval(
      clientFor(spy),
      msgFor(),
      deps({ spy, loadAllowFrom: () => [] }),
    );
    expect(spy.sent[0]?.ok).toBe(false);
    expect(spy.sent[0]?.reason).toMatch(/allowFrom/);
  });

  it("refuses when no target chat is available", async () => {
    const spy = makeSpy();
    await handleRequestDriveApproval(
      clientFor(spy),
      msgFor(),
      deps({ spy, loadTargetChat: () => null }),
    );
    expect(spy.sent[0]?.ok).toBe(false);
    expect(spy.sent[0]?.reason).toMatch(/target chat/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Failure modes
// ────────────────────────────────────────────────────────────────────────

describe("handleRequestDriveApproval — downstream failures", () => {
  it("kernel approval_request failure → ok:false with diagnostic reason", async () => {
    const spy = makeSpy();
    await handleRequestDriveApproval(
      clientFor(spy),
      msgFor(),
      deps({ spy, registerApproval: async () => null }),
    );
    expect(spy.posted).toEqual([]); // card not posted
    expect(spy.sent[0]?.ok).toBe(false);
    expect(spy.sent[0]?.reason).toMatch(/kernel approval_request/);
  });

  it("card build throw → ok:false (caught + reported)", async () => {
    const spy = makeSpy();
    await handleRequestDriveApproval(
      clientFor(spy),
      msgFor(),
      deps({
        spy,
        buildCard: () => {
          throw new Error("invalid request id");
        },
      }),
    );
    expect(spy.posted).toEqual([]);
    expect(spy.sent[0]?.ok).toBe(false);
    expect(spy.sent[0]?.reason).toMatch(/card build failed/);
  });

  it("Telegram sendMessage failure → ok:false", async () => {
    const spy = makeSpy();
    await handleRequestDriveApproval(
      clientFor(spy),
      msgFor(),
      deps({ spy, postCard: async () => null }),
    );
    expect(spy.sent[0]?.ok).toBe(false);
    expect(spy.sent[0]?.reason).toMatch(/sendMessage failed/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// TTL clamping
// ────────────────────────────────────────────────────────────────────────

describe("handleRequestDriveApproval — TTL clamping", () => {
  it("clamps below-min TTL up to the minimum", async () => {
    const spy = makeSpy();
    await handleRequestDriveApproval(
      clientFor(spy),
      msgFor({ ttlMs: 1000 }),
      deps({ spy }),
    );
    expect(spy.registered[0]?.ttl_ms).toBe(30_000); // min default
  });

  it("clamps above-max TTL down to the maximum", async () => {
    const spy = makeSpy();
    await handleRequestDriveApproval(
      clientFor(spy),
      msgFor({ ttlMs: 999_999_999 }),
      deps({ spy }),
    );
    expect(spy.registered[0]?.ttl_ms).toBe(30 * 60 * 1000); // max default
  });

  it("uses the configured default when ttlMs is undefined", async () => {
    const spy = makeSpy();
    await handleRequestDriveApproval(clientFor(spy), msgFor(), deps({ spy }));
    expect(spy.registered[0]?.ttl_ms).toBe(5 * 60 * 1000);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Oversize-body fit (#1767)
// ────────────────────────────────────────────────────────────────────────

describe("handleRequestDriveApproval — oversize card body fit (#1767)", () => {
  it("truncates the rendered text under the rich-message cap before posting", async () => {
    const spy = makeSpy();
    // buildCard returns a body well past the rich-message wire cap
    // (RICH_MESSAGE_MAX_CHARS, 32768 post-#2669 — simulates a docTitle /
    // anchor / summary whose escape inflated past the limit). Handler must
    // shrink it before postCard.
    const giantText =
      "<b>Title</b>\n" +
      "x".repeat(RICH_MESSAGE_MAX_CHARS + 4000);
    expect(giantText.length).toBeGreaterThan(RICH_MESSAGE_MAX_CHARS);
    await handleRequestDriveApproval(
      clientFor(spy),
      msgFor(),
      deps({
        spy,
        buildCard: () => ({ text: giantText, reply_markup: { stub: true } }),
      }),
    );
    expect(spy.posted).toHaveLength(1);
    expect(spy.posted[0]!.text.length).toBeLessThanOrEqual(RICH_MESSAGE_MAX_CHARS);
    expect(spy.posted[0]!.text).toContain("preview truncated");
    // Card was successfully posted → ok:true response went back.
    expect(spy.sent[0]?.ok).toBe(true);
    // The log line surfaces the truncation event.
    expect(
      spy.logs.some((l) => l.includes("oversize-truncated")),
    ).toBe(true);
  });

  it("does not touch the body when it already fits", async () => {
    const spy = makeSpy();
    const small = "<b>Small</b>\nline 1\nline 2";
    await handleRequestDriveApproval(
      clientFor(spy),
      msgFor(),
      deps({
        spy,
        buildCard: () => ({ text: small, reply_markup: { stub: true } }),
      }),
    );
    expect(spy.posted[0]!.text).toBe(small);
    expect(
      spy.logs.some((l) => l.includes("oversize-truncated")),
    ).toBe(false);
  });

  it("post failure after truncation surfaces a structured reason", async () => {
    const spy = makeSpy();
    const giantText =
      "<b>Title</b>\n" + "x".repeat(RICH_MESSAGE_MAX_CHARS + 4000);
    await handleRequestDriveApproval(
      clientFor(spy),
      msgFor(),
      deps({
        spy,
        buildCard: () => ({ text: giantText, reply_markup: { stub: true } }),
        postCard: async () => null,
      }),
    );
    expect(spy.sent[0]?.ok).toBe(false);
    expect(spy.sent[0]?.reason).toMatch(/oversize-body truncation/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Always responds (no path drops the response)
// ────────────────────────────────────────────────────────────────────────

describe("handleRequestDriveApproval — invariant: always sends a reply", () => {
  it("every refusal path emits exactly one drive_approval_posted event", async () => {
    const cases: Array<Partial<DriveApprovalHandlerDeps> | "cross-agent" | "bad-preview"> = [
      "cross-agent",
      "bad-preview",
      { loadAllowFrom: () => [] },
      { loadTargetChat: () => null },
      { registerApproval: async () => null },
      { postCard: async () => null },
    ];
    for (const c of cases) {
      const spy = makeSpy();
      const msg =
        c === "cross-agent"
          ? msgFor({ agentName: "clerk" })
          : c === "bad-preview"
            ? msgFor({ preview: { bad: true } })
            : msgFor();
      const dep =
        c === "cross-agent" || c === "bad-preview"
          ? deps({ spy })
          : deps({ spy, ...c });
      await handleRequestDriveApproval(clientFor(spy), msg, dep);
      expect(spy.sent).toHaveLength(1);
    }
  });
});
