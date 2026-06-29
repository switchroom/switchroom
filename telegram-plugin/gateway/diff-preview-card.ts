/**
 * Telegram renderer for the diff-preview approval card — RFC E §4.2.
 *
 * Takes a `DiffPreview` (output of `src/drive/diff-preview.ts`) plus the
 * two pre-registered approval-kernel request ids — one for the suggest
 * scope, one for the write scope — and emits a `BuiltApprovalCard`
 * (HTML body + grammy InlineKeyboard).
 *
 * Why two request ids? The card surfaces both "Apply as suggestion"
 * and "Apply directly" buttons; each one grants a different kernel
 * scope (`doc:gdrive:suggest:<id>` vs `doc:gdrive:write:<id>`). The
 * upstream caller (the MCP-tool wrapper, or whoever's posting the
 * card) registers BOTH up front with `approval_request`, then passes
 * both ids into this renderer. The user taps one; the other expires
 * naturally on the kernel side.
 *
 * Each action button reuses the existing `apv:<request_id>:once`
 * callback shape so the generic kernel handler at
 * `approval-callback.ts` records the grant without surface-specific
 * routing. The "✅ once" semantics line up with the diff-preview's
 * single-shot "do this edit now" intent.
 */

import { InlineKeyboard } from "grammy";
import type { DiffPreview } from "../../src/drive/diff-preview.js";

export interface BuiltDiffPreviewCard {
  text: string;
  reply_markup: InlineKeyboard;
}

export interface DiffPreviewCardInput {
  preview: DiffPreview;
  /**
   * Kernel request id pre-registered for `doc:gdrive:suggest:<doc_id>`.
   * Required — the suggest path is the RFC's default. When undefined
   * the renderer throws (an "approval card with no Apply button"
   * isn't a coherent UX).
   */
  suggestRequestId: string;
  /**
   * Kernel request id pre-registered for `doc:gdrive:write:<doc_id>`.
   * Optional — when omitted, the "⚠ Apply directly" button is hidden
   * (used for `gdrive_suggest_edit` callers that don't want to offer
   * the direct-write escalation at all). When `preview.buttons` has
   * an `apply_directly` entry but this is omitted, the button is
   * dropped silently.
   */
  writeRequestId?: string;
}

/**
 * 8-hex request id shape — same regex the kernel uses (RFC B §6.1).
 * Defense in depth — a malformed request id would render an invalid
 * callback_data that the dispatcher rejects, but we'd rather fail
 * loudly at build time.
 */
const REQUEST_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Fragility-guard from B2 review: the `create_doc` prep helper
 * synthesises a "pending-create" placeholder fileId because the
 * doc doesn't exist yet. `validateDriveId` happily accepts the
 * literal "pending-create" string (it's alnum + `-`), so a naive
 * Open-in-Drive button would emit a broken link. The renderer
 * detects the sentinel and drops the open-in-drive row instead of
 * rendering a dead link.
 */
const PENDING_FILE_ID_SENTINEL = "pending-create";

export function buildDiffPreviewCard(
  input: DiffPreviewCardInput,
): BuiltDiffPreviewCard {
  if (!REQUEST_ID_RE.test(input.suggestRequestId)) {
    throw new Error(
      `buildDiffPreviewCard: suggestRequestId must be 32 hex chars (got '${input.suggestRequestId}')`,
    );
  }
  if (input.writeRequestId !== undefined && !REQUEST_ID_RE.test(input.writeRequestId)) {
    throw new Error(
      `buildDiffPreviewCard: writeRequestId must be 32 hex chars (got '${input.writeRequestId}')`,
    );
  }

  const preview = input.preview;

  // Body: title + every diff-preview line in order, HTML-escaped.
  // The 📍 + line-count rows are surfaced verbatim — they're
  // wrapper-attested and the agent has no input into their content.
  const bodyLines: string[] = [];
  bodyLines.push(`**${escapeHtml(preview.title)}**`);
  for (const line of preview.lines) {
    bodyLines.push(escapeHtml(line.text));
  }
  const text = bodyLines.join("\n");

  const kb = new InlineKeyboard();

  // Layout per RFC E §4.2 mockup:
  //   row 1: [ 📖 Open in Drive ]  [ ✅ Apply as suggestion ]
  //   row 2: [ ⚠ Apply directly ]   [ 🚫 Cancel ]
  //
  // Buttons whose `action` doesn't match a known shape are dropped
  // silently — the diff-preview builder is the source of truth for
  // which buttons exist; the renderer just maps them to callbacks.
  const ROW_BREAK_AFTER: Array<DiffPreview["buttons"][number]["action"]> = [
    "apply_suggestion",
  ];
  // `DiffPreview` doesn't carry the original mode, so infer from the
  // button set: in suggest mode the builder always emits both
  // `apply_suggestion` and `apply_directly`; in write mode it emits
  // only `apply_directly`. The renderer drops `apply_directly` when
  // a writeRequestId wasn't provided AND a suggestion path exists
  // — caller chose to offer only Suggesting.
  const offeringSuggestion = preview.buttons.some(
    (b) => b.action === "apply_suggestion",
  );
  const droppedDirectly =
    offeringSuggestion && input.writeRequestId === undefined;

  const isPendingFileId =
    preview.audit.wrapperAttested.fileId === PENDING_FILE_ID_SENTINEL;

  let rowStarted = false;
  const breakRow = () => {
    if (rowStarted) {
      kb.row();
      rowStarted = false;
    }
  };

  for (const btn of preview.buttons) {
    switch (btn.action) {
      case "open_in_drive": {
        if (isPendingFileId) break; // drop sentinel-URL buttons
        if (typeof btn.url !== "string" || btn.url.length === 0) break;
        kb.url(btn.text, btn.url);
        rowStarted = true;
        break;
      }
      case "apply_suggestion": {
        kb.text(btn.text, `apv:${input.suggestRequestId}:once`);
        rowStarted = true;
        break;
      }
      case "apply_directly": {
        if (droppedDirectly) break;
        const id = input.writeRequestId ?? input.suggestRequestId;
        kb.text(btn.text, `apv:${id}:once`);
        rowStarted = true;
        break;
      }
      case "cancel": {
        kb.text(btn.text, `apv:${input.suggestRequestId}:deny`);
        rowStarted = true;
        break;
      }
    }
    if (ROW_BREAK_AFTER.includes(btn.action)) breakRow();
  }

  return { text, reply_markup: kb };
}

function escapeHtml(s: string): string {
  return s.replace(/([\\`*_~=\[\]|])/g, "\\$1");
}
