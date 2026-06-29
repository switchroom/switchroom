/**
 * Tests for folder-picker Telegram handlers — RFC E §4.1 wire-up.
 *
 * The handlers are kernel/Drive/grammy-agnostic via injected deps;
 * tests use minimal stub contexts + fake deps.
 */

import { describe, expect, it } from "vitest";
import type { Context } from "grammy";

import { FolderListCache } from "../../src/drive/folder-list.js";
import type { FolderPage } from "../../src/drive/folder-list.js";
import {
  handleFolderPickerCallback,
  handleFoldersCommand,
  type FolderPickerHandlerDeps,
} from "./folder-picker-handler.js";

interface FakeCtx {
  from: { id: number };
  replies: Array<{ text: string; keyboardRows: string[][] }>;
  edits: Array<{ text: string; keyboardRows: string[][] | undefined }>;
  callbackAnswers: Array<{ text?: string }>;
}

function fakeCtx(userId = 12345): { ctx: Context; spy: FakeCtx } {
  const spy: FakeCtx = {
    from: { id: userId },
    replies: [],
    edits: [],
    callbackAnswers: [],
  };
  const ctx = {
    from: spy.from,
    reply: async (text: string, opts?: { reply_markup?: { inline_keyboard?: unknown[][] } }) => {
      const rows = (opts?.reply_markup?.inline_keyboard ?? []) as Array<
        Array<{ text: string }>
      >;
      spy.replies.push({
        text,
        keyboardRows: rows.map((r) => r.map((b) => b.text)),
      });
      return { message_id: 1 };
    },
    editMessageText: async (
      text: string | { markdown: string },
      opts?: { reply_markup?: { inline_keyboard?: unknown[][] } },
    ) => {
      const rows = (opts?.reply_markup?.inline_keyboard ?? []) as Array<
        Array<{ text: string }>
      >;
      // #2669: the rich path passes `{ markdown }`; normalize to the body
      // string so the substring assertions keep working.
      const body = typeof text === "object" && text != null ? text.markdown : text;
      spy.edits.push({
        text: body,
        keyboardRows: opts?.reply_markup
          ? rows.map((r) => r.map((b) => b.text))
          : undefined,
      });
      return true;
    },
    answerCallbackQuery: async (arg?: { text?: string }) => {
      spy.callbackAnswers.push(arg ?? {});
      return true;
    },
  } as unknown as Context;
  return { ctx, spy };
}

interface FakeKernel {
  requests: Array<{ scope: string; action: string }>;
  consumed: string[];
  recorded: Array<{
    request_id: string;
    decision: string;
    approver_set: string[];
  }>;
  nextRequestId: string;
  failRequest?: boolean;
  failConsume?: boolean;
  failRecord?: boolean;
}

function depsFor(args: {
  agentName?: string;
  fetchPage?: FolderPickerHandlerDeps["fetchPage"];
  cache?: FolderListCache;
  kernel?: FakeKernel;
}): { deps: FolderPickerHandlerDeps; kernel: FakeKernel; cache: FolderListCache } {
  const cache = args.cache ?? new FolderListCache({ now: () => 1000 });
  const kernel: FakeKernel = args.kernel ?? {
    requests: [],
    consumed: [],
    recorded: [],
    nextRequestId: "abcdef01",
  };
  const deps: FolderPickerHandlerDeps = {
    agentName: args.agentName ?? "klanker",
    cache,
    fetchPage:
      args.fetchPage ??
      (async () => ({ folders: [{ id: "F1", name: "Work" }] })),
    approvalRequest: async (a) => {
      if (kernel.failRequest) return null;
      kernel.requests.push({ scope: a.scope, action: a.action });
      return { request_id: kernel.nextRequestId };
    },
    approvalConsume: async (id) => {
      if (kernel.failConsume) return false;
      kernel.consumed.push(id);
      return true;
    },
    approvalRecord: async (a) => {
      if (kernel.failRecord) return null;
      kernel.recorded.push({
        request_id: a.request_id,
        decision: a.decision,
        approver_set: a.approver_set,
      });
      return "dec-1";
    },
  };
  return { deps, kernel, cache };
}

describe("handleFoldersCommand", () => {
  it("posts a picker card with the top-level folders", async () => {
    const { ctx, spy } = fakeCtx();
    const { deps } = depsFor({});
    await handleFoldersCommand(ctx, deps);
    expect(spy.replies).toHaveLength(1);
    expect(spy.replies[0]?.text).toContain("📁");
    expect(spy.replies[0]?.text).toContain("1 folder");
    // Two folder rows ([Allow] + [Browse]) plus nav row.
    expect(spy.replies[0]?.keyboardRows.length).toBeGreaterThanOrEqual(3);
  });

  it("hits the cache on a re-issued /folders within TTL", async () => {
    const { ctx, spy } = fakeCtx();
    let fetches = 0;
    const { deps } = depsFor({
      fetchPage: async () => {
        fetches += 1;
        return { folders: [{ id: "F1", name: "Work" }] };
      },
    });
    await handleFoldersCommand(ctx, deps);
    await handleFoldersCommand(ctx, deps);
    expect(fetches).toBe(1);
    expect(spy.replies).toHaveLength(2);
  });

  it("surfaces a Drive failure as a friendly error message (no crash)", async () => {
    const { ctx, spy } = fakeCtx();
    const { deps } = depsFor({
      fetchPage: async () => {
        throw new Error("HTTP 401");
      },
    });
    await handleFoldersCommand(ctx, deps);
    expect(spy.replies[0]?.text).toContain("Drive folder listing failed");
    expect(spy.replies[0]?.text).toContain("HTTP 401");
  });
});

describe("handleFolderPickerCallback — refusal cases", () => {
  it("rejects a malformed callback", async () => {
    const { ctx, spy } = fakeCtx();
    const { deps } = depsFor({});
    await handleFolderPickerCallback(ctx, "not-a-drvpick-callback", deps);
    expect(spy.callbackAnswers[0]?.text).toMatch(/malformed/);
    expect(spy.edits).toEqual([]);
  });

  it("refuses callbacks for a different agent (path-scoped guard)", async () => {
    const { ctx, spy } = fakeCtx();
    const { deps } = depsFor({ agentName: "klanker" });
    await handleFolderPickerCallback(ctx, "drvpick:grant:clerk:F1", deps);
    expect(spy.callbackAnswers[0]?.text).toMatch(/this gateway serves 'klanker'/);
    expect(spy.edits).toEqual([]);
  });
});

describe("handleFolderPickerCallback — navigation", () => {
  it("enter drills into a sub-folder (cache miss → fetchPage with parent_id)", async () => {
    const { ctx, spy } = fakeCtx();
    const fetched: string[] = [];
    const { deps } = depsFor({
      fetchPage: async ({ parent_id }) => {
        fetched.push(parent_id ?? "<top>");
        return { folders: [{ id: "SUB1", name: "Q3" }] };
      },
    });
    await handleFolderPickerCallback(ctx, "drvpick:enter:klanker:F1", deps);
    expect(fetched).toEqual(["F1"]);
    expect(spy.edits[0]?.text).toContain("/F1");
    expect(spy.callbackAnswers[0]).toEqual({});
  });

  it("back returns to the named parent level", async () => {
    const { ctx, spy } = fakeCtx();
    const fetched: string[] = [];
    const { deps } = depsFor({
      fetchPage: async ({ parent_id }) => {
        fetched.push(parent_id ?? "<top>");
        return { folders: [] };
      },
    });
    await handleFolderPickerCallback(ctx, "drvpick:back:klanker:PARENT1", deps);
    expect(fetched).toEqual(["PARENT1"]);
  });

  it("back to top-of-Drive (empty parent_id) fetches the top page", async () => {
    const { ctx, spy } = fakeCtx();
    const fetched: Array<string | undefined> = [];
    const { deps } = depsFor({
      fetchPage: async ({ parent_id }) => {
        fetched.push(parent_id);
        return { folders: [] };
      },
    });
    await handleFolderPickerCallback(ctx, "drvpick:back:klanker:", deps);
    expect(fetched).toEqual([undefined]);
  });

  it("refresh bypasses cache (forceRefresh)", async () => {
    const cache = new FolderListCache({ now: () => 1000 });
    cache.set("klanker", { folders: [{ id: "STALE", name: "S" }] });
    let fetches = 0;
    const { ctx, spy } = fakeCtx();
    const { deps } = depsFor({
      cache,
      fetchPage: async () => {
        fetches += 1;
        return { folders: [{ id: "FRESH", name: "F" }] };
      },
    });
    await handleFolderPickerCallback(ctx, "drvpick:refresh:klanker:", deps);
    expect(fetches).toBe(1);
    expect(spy.edits[0]?.text).toContain("📁");
  });

  it("open resolves a page-token handle back to the real Drive token", async () => {
    const cache = new FolderListCache({ now: () => 1000 });
    const handle = cache.registerPageToken("klanker", "REAL_DRIVE_TOKEN_120_CHARS_XXXXXX");
    const { ctx, spy } = fakeCtx();
    let observedToken: string | undefined;
    const { deps } = depsFor({
      cache,
      fetchPage: async ({ page_token }) => {
        observedToken = page_token;
        return { folders: [{ id: "F2", name: "Page 2" }] };
      },
    });
    await handleFolderPickerCallback(
      ctx,
      `drvpick:open:klanker::${handle}`,
      deps,
    );
    expect(observedToken).toBe("REAL_DRIVE_TOKEN_120_CHARS_XXXXXX");
    // The folder name lands in the [Allow / Browse] keyboard rows,
    // not the body line.
    const flat = spy.edits[0]?.keyboardRows.flat() ?? [];
    expect(flat.some((b) => b.includes("Page 2"))).toBe(true);
  });
});

describe("handleFolderPickerCallback — grant", () => {
  it("records the grant via the three-step kernel call and confirms in-place", async () => {
    const { ctx, spy } = fakeCtx(99999);
    const { deps, kernel } = depsFor({});
    await handleFolderPickerCallback(ctx, "drvpick:grant:klanker:F1", deps);
    expect(kernel.requests).toEqual([
      { scope: "doc:gdrive:folder/F1/**", action: "read" },
    ]);
    expect(kernel.consumed).toEqual(["abcdef01"]);
    expect(kernel.recorded).toEqual([
      {
        request_id: "abcdef01",
        decision: "allow_always",
        approver_set: ["99999"],
      },
    ]);
    expect(spy.edits[0]?.text).toContain("✅ Granted klanker");
    expect(spy.edits[0]?.text).toContain("doc:gdrive:folder/F1/**");
    expect(spy.edits[0]?.text).toContain("/approvals revoke dec-1");
    // Confirmation keyboard has Open-in-Drive URL.
    expect(spy.edits[0]?.keyboardRows[0]).toEqual(["📖 Open in Drive"]);
    expect(spy.callbackAnswers[0]?.text).toBe("Allowed");
  });

  it("surfaces each kernel failure step with a clear toast", async () => {
    for (const failure of [
      { failRequest: true, msg: /request failed/ },
      { failConsume: true, msg: /consume failed/ },
      { failRecord: true, msg: /record failed/ },
    ] as const) {
      const { ctx, spy } = fakeCtx();
      const kernel: FakeKernel = {
        requests: [],
        consumed: [],
        recorded: [],
        nextRequestId: "abcdef01",
        ...failure,
      };
      const { deps } = depsFor({ kernel });
      await handleFolderPickerCallback(ctx, "drvpick:grant:klanker:F1", deps);
      expect(spy.callbackAnswers[0]?.text).toMatch(failure.msg);
      expect(spy.edits).toEqual([]); // no confirmation edit on failure
    }
  });

  it("refuses when ctx.from is missing (no user id)", async () => {
    const { ctx, spy } = fakeCtx(0);
    const { deps } = depsFor({});
    await handleFolderPickerCallback(ctx, "drvpick:grant:klanker:F1", deps);
    expect(spy.callbackAnswers[0]?.text).toMatch(/user id/);
  });
});
