/**
 * Open-in-Drive deep-link builders — RFC E §4.3.
 *
 * Pure functions that turn a Drive file's id + mimeType into the canonical
 * "open this in Drive" URL. Used by the approval kernel to render the
 * `[ 📖 Open in Drive ]` inline-keyboard button on every approval card
 * that names a doc, on grant-confirmation cards, and on suggestion-write
 * approvals (where the URL also carries the discussion-thread id so the
 * link lands on the proposed edit specifically).
 *
 * No new auth needed — these are the same shareable URLs the user would
 * copy from Drive's "Share" dialog.
 *
 * Phase 1a ships the URL builders + tests. Wiring them onto the actual
 * approval-card inline-keyboard rows lives in the kernel/gateway code
 * (separate PR — touches `src/vault/approvals/kernel.ts` and
 * `telegram-plugin/gateway/gateway.ts` approval-card builders, both
 * substantial enough to warrant their own change).
 */

/**
 * Drive file mime types that have first-class web UIs. Other mime types
 * (PDFs, images, .docx, etc.) get the generic `/file/d/<id>/view` URL.
 */
export type DriveDocKind = "doc" | "spreadsheet" | "presentation" | "form" | "drawing" | "file";

/**
 * Map a Google Workspace mime type string to a DriveDocKind. Returns
 * "file" (the generic viewer) for anything we don't recognize as a
 * first-class Workspace doc.
 */
export function classifyMimeType(mimeType: string | undefined): DriveDocKind {
  if (!mimeType) return "file";
  switch (mimeType) {
    case "application/vnd.google-apps.document":
      return "doc";
    case "application/vnd.google-apps.spreadsheet":
      return "spreadsheet";
    case "application/vnd.google-apps.presentation":
      return "presentation";
    case "application/vnd.google-apps.form":
      return "form";
    case "application/vnd.google-apps.drawing":
      return "drawing";
    default:
      return "file";
  }
}

export interface OpenInDriveOptions {
  /**
   * Drive file id — the bare id, no slashes. Anything that looks like
   * a URL or contains a slash is rejected (defense against an agent
   * passing a crafted URL through to the inline-keyboard button text).
   */
  fileId: string;
  /**
   * mimeType from Drive's `files.get` response. Determines which
   * web-UI base we hit. Falls back to the generic file viewer if
   * unknown.
   */
  mimeType?: string;
  /**
   * Optional discussion-thread id — for suggestion-write approvals
   * where Drive exposes a discussion thread for the proposed edit.
   * Renders as `?disco=<id>` so the link lands on the suggestion
   * specifically (RFC E §4.3 last sub-bullet). Validated same shape
   * as fileId.
   */
  discussionId?: string;
}

/**
 * Build the canonical open-in-Drive URL for a file. Throws on any
 * input that doesn't pass the strict-id check (no slashes, no spaces,
 * no URL fragments) — these strings end up rendered as inline-keyboard
 * button URLs and need to be incapable of carrying smuggled paths or
 * query strings the agent didn't authorize.
 */
export function openInDriveUrl(options: OpenInDriveOptions): string {
  validateDriveId(options.fileId, "fileId");
  if (options.discussionId !== undefined) {
    validateDriveId(options.discussionId, "discussionId");
  }
  const base = baseUrlFor(classifyMimeType(options.mimeType), options.fileId);
  if (options.discussionId !== undefined) {
    // `?disco=<id>` is Drive's documented discussion-thread anchor.
    // We append it as a query string so it survives the Workspace
    // app's URL handlers on iOS/Android (fragments are sometimes
    // dropped by the deep-link router).
    return `${base}?disco=${encodeURIComponent(options.discussionId)}`;
  }
  return base;
}

function baseUrlFor(kind: DriveDocKind, fileId: string): string {
  switch (kind) {
    case "doc":
      return `https://docs.google.com/document/d/${fileId}/edit`;
    case "spreadsheet":
      return `https://docs.google.com/spreadsheets/d/${fileId}/edit`;
    case "presentation":
      return `https://docs.google.com/presentation/d/${fileId}/edit`;
    case "form":
      return `https://docs.google.com/forms/d/${fileId}/edit`;
    case "drawing":
      return `https://docs.google.com/drawings/d/${fileId}/edit`;
    case "file":
      return `https://drive.google.com/file/d/${fileId}/view`;
  }
}

/**
 * Drive file ids are URL-safe base64-ish strings (alnum + `-_`). They
 * don't contain `/`, `?`, `#`, `:`, whitespace, or any URL syntax.
 * Anything else is either a smuggled URL fragment or a typo — reject
 * up front.
 *
 * We're permissive on length (Drive's id length isn't fixed) but
 * strict on character set.
 */
function validateDriveId(id: string, fieldName: string): void {
  if (id.length === 0) {
    throw new Error(`Drive ${fieldName} must not be empty`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(
      `Drive ${fieldName} '${id.slice(0, 30)}${id.length > 30 ? "…" : ""}' contains invalid characters. Expected base64-url-safe (alphanumerics + - + _).`,
    );
  }
}

/**
 * Convenience builder for the common "render an inline-keyboard
 * button on an approval card" case. Returns the {text, url} pair the
 * Telegram bot library expects. Phase 1a callers (gateway approval-
 * card builders) construct InlineKeyboardButton objects directly from
 * this; the literal `📖 Open in Drive` text matches the RFC E §4.3
 * mockup.
 */
export function openInDriveButton(
  options: OpenInDriveOptions,
): { text: string; url: string } {
  return {
    text: "📖 Open in Drive",
    url: openInDriveUrl(options),
  };
}
