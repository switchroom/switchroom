/**
 * Folder-picker Telegram handlers — RFC E §4.1 wire-up.
 *
 * Two entry points the gateway dispatcher calls into:
 *
 *   - `handleFoldersCommand(ctx, deps)`        ← `/folders` slash command
 *   - `handleFolderPickerCallback(ctx, data, deps)` ← `drvpick:` callback_query
 *
 * Both are kernel-agnostic — Drive API + approval-kernel + access-token
 * sources are injected via `FolderPickerHandlerDeps` so the handlers
 * are unit-testable without docker / Google / SQLite / grammy in the
 * loop. The gateway construct module wires concrete deps from
 * `src/drive/folder-list.ts`, `src/vault/approvals/client.ts`, and the
 * auth-broker.
 *
 * Operator UX:
 *
 *   1. User types `/folders` in the agent's DM.
 *   2. Gateway fetches the user's top-level Drive folders and posts
 *      a picker card with one row per folder ([Allow] + [Browse]).
 *   3. Tapping [Browse "Work"] drills in — the gateway re-renders the
 *      card in place with the sub-folder list + a [⬅ Back] button.
 *   4. Tapping [✅ Allow "<folder>"] writes a kernel `allow_always`
 *      grant at `doc:gdrive:folder/<id>/**` and edits the card to a
 *      green confirmation.
 *
 * Authorisation: same gate as the rest of the slash commands —
 * `isAuthorizedSender(ctx)` upstream. The handler itself trusts the
 * caller did the gate.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";

import type { FolderListCache, FolderPage } from "../../src/drive/folder-list.js";
import {
  buildFolderPickerCard,
  parseFolderPickerCallback,
  type FolderPickerCallback,
  type FolderPickerCardSpec,
} from "../../src/drive/folder-picker.js";

// ────────────────────────────────────────────────────────────────────────
// Deps — injected by the gateway construct module
// ────────────────────────────────────────────────────────────────────────

export interface FolderPickerHandlerDeps {
  /** Agent slug this gateway instance serves. */
  agentName: string;
  /**
   * Fetch a single folder page from Drive. Production wires this to
   * `fetchFolderPage()` from src/drive/folder-list.ts with the
   * agent's Drive access-token injected. Tests pass a fake.
   */
  fetchPage: (args: {
    parent_id?: string;
    page_token?: string;
  }) => Promise<FolderPage>;
  /**
   * Per-gateway-process folder-list cache. The cache holds the
   * 5-min folder-page payloads AND the short-handle ↔ Drive
   * page-token map used by `[Next ▶]` callbacks.
   */
  cache: FolderListCache;
  /**
   * Build a fresh kernel `request_id` for an upcoming grant. The
   * gateway mints a request right before recording the decision —
   * the kernel's request/consume/record flow is the only path to
   * write an `approval_decisions` row.
   */
  approvalRequest: (args: {
    agent_unit: string;
    scope: string;
    action: string;
    approver_set: string[];
    why?: string | null;
    ttl_ms?: number | null;
  }) => Promise<{ request_id: string } | null>;
  /** Consume the pending request_id so approvalRecord can land the row. */
  approvalConsume: (request_id: string) => Promise<boolean>;
  /** Write the granted decision. */
  approvalRecord: (args: {
    request_id: string;
    decision: "allow_always";
    approver_set: string[];
    granted_by_user_id: number;
    ttl_ms?: number | null;
  }) => Promise<string | null>;
}

// ────────────────────────────────────────────────────────────────────────
// `/folders` entry point
// ────────────────────────────────────────────────────────────────────────

export async function handleFoldersCommand(
  ctx: Context,
  deps: FolderPickerHandlerDeps,
): Promise<void> {
  let page: FolderPage;
  try {
    // First-page hit goes through the cache so a re-issued /folders
    // within 5 min doesn't slam Drive's quota.
    const hit = deps.cache.get(deps.agentName);
    if (hit !== null) {
      page = hit;
    } else {
      page = await deps.fetchPage({});
      deps.cache.set(deps.agentName, page);
    }
  } catch (err) {
    await ctx.reply(
      `Drive folder listing failed: ${describe(err)}. Run \`switchroom drive connect ${deps.agentName}\` if the agent isn't authenticated.`,
    );
    return;
  }

  const card = buildFolderPickerCard({
    agent: deps.agentName,
    page,
    cache: deps.cache,
  });
  await ctx.reply(card.body, { reply_markup: toKeyboard(card) });
}

// ────────────────────────────────────────────────────────────────────────
// `drvpick:` callback entry point
// ────────────────────────────────────────────────────────────────────────

export async function handleFolderPickerCallback(
  ctx: Context,
  data: string,
  deps: FolderPickerHandlerDeps,
): Promise<void> {
  const parsed = parseFolderPickerCallback(data);
  if (parsed === null) {
    await ctx.answerCallbackQuery({ text: "malformed picker callback" });
    return;
  }

  // Path-scoped agent guard — the picker callback names an agent in
  // the data string. A gateway running for agent `klanker` MUST
  // refuse callbacks meant for `clerk` (defense in depth on top of
  // the per-agent socket isolation; relevant if a card from one
  // agent's topic somehow leaks into another).
  if (parsed.agent !== deps.agentName) {
    await ctx.answerCallbackQuery({
      text: `card is for agent '${parsed.agent}', this gateway serves '${deps.agentName}'`,
    });
    return;
  }

  switch (parsed.kind) {
    case "open":
      await renderPage(ctx, deps, {
        parent_id: parsed.parent_id,
        page_token_handle: parsed.page_token_handle,
        forceRefresh: false,
      });
      break;
    case "enter":
      await renderPage(ctx, deps, {
        parent_id: parsed.folder_id,
        forceRefresh: false,
      });
      break;
    case "back":
      // RFC §4.1: tapping Back returns to the parent level. The
      // callback payload carries the parent we're returning TO
      // (empty string = top of Drive). The current breadcrumb
      // chain is rebuilt by the card builder — we just need the
      // target parent id.
      await renderPage(ctx, deps, {
        parent_id: parsed.parent_id,
        forceRefresh: false,
      });
      break;
    case "refresh":
      await renderPage(ctx, deps, {
        parent_id: parsed.parent_id,
        forceRefresh: true,
      });
      break;
    case "grant":
      await recordGrantAndConfirm(ctx, deps, parsed);
      break;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Sub-handlers
// ────────────────────────────────────────────────────────────────────────

async function renderPage(
  ctx: Context,
  deps: FolderPickerHandlerDeps,
  args: {
    parent_id?: string;
    page_token_handle?: string;
    forceRefresh: boolean;
  },
): Promise<void> {
  let page: FolderPage;
  try {
    // Page-token handles bypass cache by design — they target a
    // specific subsequent page that's not held in the first-page
    // cache slot. Resolve the handle BEFORE attempting cache.
    const resolved =
      args.page_token_handle !== undefined
        ? deps.cache.getPageToken(deps.agentName, args.page_token_handle)
        : null;

    if (resolved !== null) {
      page = await deps.fetchPage({
        parent_id: args.parent_id,
        page_token: resolved,
      });
    } else if (
      !args.forceRefresh &&
      args.page_token_handle === undefined
    ) {
      const hit = deps.cache.get(deps.agentName, args.parent_id);
      if (hit !== null) {
        page = hit;
      } else {
        page = await deps.fetchPage({ parent_id: args.parent_id });
        deps.cache.set(deps.agentName, page, args.parent_id);
      }
    } else {
      // forceRefresh OR a handle that's expired ([↻ Refresh] / stale).
      page = await deps.fetchPage({ parent_id: args.parent_id });
      deps.cache.set(deps.agentName, page, args.parent_id);
    }
  } catch (err) {
    await ctx.answerCallbackQuery({ text: `Drive error: ${describe(err)}` });
    return;
  }

  const card = buildFolderPickerCard({
    agent: deps.agentName,
    page,
    ...(args.parent_id !== undefined && args.parent_id.length > 0
      ? { parent: { id: args.parent_id, name: args.parent_id } }
      : {}),
    cache: deps.cache,
  });
  try {
    await ctx.editMessageText(card.body, { reply_markup: toKeyboard(card) });
  } catch {
    // Card may have been edited/deleted under us — operator can
    // re-issue /folders to start over.
  }
  await ctx.answerCallbackQuery({});
}

async function recordGrantAndConfirm(
  ctx: Context,
  deps: FolderPickerHandlerDeps,
  parsed: Extract<FolderPickerCallback, { kind: "grant" }>,
): Promise<void> {
  const granted_by_user_id = ctx.from?.id ?? 0;
  if (granted_by_user_id === 0) {
    await ctx.answerCallbackQuery({ text: "missing user id" });
    return;
  }

  const scope = `doc:gdrive:folder/${parsed.folder_id}/**`;
  const action = "read";

  // Three-step kernel call: request → consume → record. The kernel
  // requires the request-id chain even for operator-driven grants
  // (no direct-record op as of the v0.10 schema). All three round-
  // trips are UDS to the local kernel — no user-visible latency.
  const requested = await deps.approvalRequest({
    agent_unit: deps.agentName,
    scope,
    action,
    approver_set: [String(granted_by_user_id)],
    why: `folder picker grant via /folders`,
  });
  if (requested === null) {
    await ctx.answerCallbackQuery({ text: "kernel request failed" });
    return;
  }

  const consumed = await deps.approvalConsume(requested.request_id);
  if (!consumed) {
    await ctx.answerCallbackQuery({ text: "kernel consume failed" });
    return;
  }

  const decisionId = await deps.approvalRecord({
    request_id: requested.request_id,
    decision: "allow_always",
    approver_set: [String(granted_by_user_id)],
    granted_by_user_id,
    ttl_ms: null,
  });
  if (decisionId === null) {
    await ctx.answerCallbackQuery({ text: "kernel record failed" });
    return;
  }

  const confirmText =
    `✅ Granted ${deps.agentName} access to folder ${parsed.folder_id}\n` +
    `Scope: \`${scope}\`\n` +
    `Revoke with: \`/approvals revoke ${decisionId}\``;

  // Keep an [Open in Drive] URL button on the confirmation so the
  // operator can verify which folder they granted.
  const kb = new InlineKeyboard().url(
    "📖 Open in Drive",
    `https://drive.google.com/drive/folders/${parsed.folder_id}`,
  );
  try {
    await ctx.editMessageText({ markdown: confirmText }, {
      reply_markup: kb,
    });
  } catch {
    // Best-effort.
  }
  await ctx.answerCallbackQuery({ text: "Allowed" });
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function toKeyboard(spec: FolderPickerCardSpec): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let r = 0; r < spec.rows.length; r++) {
    const row = spec.rows[r]!;
    for (const btn of row) {
      kb.text(btn.text, btn.callback_data);
    }
    if (r < spec.rows.length - 1) kb.row();
  }
  return kb;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
