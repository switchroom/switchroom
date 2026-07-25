/**
 * PreToolUse hook for softeria/ms-365-mcp-server write tools —
 * RFC #1873 §8 PR 4.
 *
 * Bundled to `/opt/switchroom/hooks/ms-365-write-pretool.mjs` at build
 * time so it runs inside the agent container with zero relative
 * imports. Mirrors `drive-write-pretool.ts` shape with the weak-
 * metadata simplification (RFC §8 v1).
 *
 * Claude Code PreToolUse contract:
 *   Input:  JSON on stdin — { session_id, tool_name, tool_input, ... }
 *   Output: exit 0 + empty stdout → allow.
 *           exit 0 + JSON `{ decision: "block", reason: "..." }` → block.
 *
 * Flow:
 *   1. Parse stdin. Skip (allow) if tool isn't a gated MS-365 write.
 *   2. Best-effort extract item id + display name + size from tool_input.
 *   3. (Optional) Check kernel for a standing grant at scope
 *      `ms-365:write:<itemId>`. v1: always-prompt — no standing grants.
 *      Skip this check; future PR can add a scope-key skip.
 *   4. Send `request_ms365_approval` to gateway socket.
 *   5. Poll `approval_lookup` until verdict (granted / denied / expired).
 *   6. Granted → allow. Anything else → block.
 *
 * Fail-closed:
 *   - Stdin parse fails → block (Claude Code protocol error — better
 *     to fail closed than allow an unbounded operation)
 *   - Gateway unreachable → block (operator can't see card)
 *   - Kernel unreachable for verdict → block (no way to know decision)
 *   - Timeout / no decision → block
 *
 * Fail-open ONLY when:
 *   - Tool isn't an MS-365 tool at all (wrong `mcp__ms-365__` prefix), or
 *     it's a VERIFIED read-only MS-365 tool (KNOWN_SAFE_MS365_READ_TOOLS).
 *
 * Fail-CLOSED (require approval) — deterministic, not prompt-dependent:
 *   - Any known write tool (GATED_MS365_WRITE_TOOLS).
 *   - Any UNRECOGNIZED `mcp__ms-365__` tool. A renamed or newly-added
 *     softeria write tool that isn't yet in our read allowlist must NOT
 *     sail through — an allowlist gap defaults to "require approval",
 *     never to "allow" (review 2026-07-11, W2 fail-open finding).
 *   - SWITCHROOM_AGENT_NAME missing → block (we can't identify the agent
 *     to gate, so we can't prove the operator approved this write).
 */

import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  loadMicrosoftFromAuthBroker,
  resolveMicrosoftAccountBySlug,
  fetchCalendarEventContext,
  type Ms365AccessHandle,
  type CalendarEventContext,
} from "../ms365/graph-resolve.js";
import {
  readLedger,
  recordOutcome,
  evaluateBatchAdmission,
  countCurrentBatchApplied,
  buildBatchAbortReason,
} from "../ms365/batch-ledger.js";
import {
  evaluateGatedWrite,
  requireOperatorApprovalForWrites,
} from "../vault/approvals/gated-write-policy.js";

// ────────────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────────────

const HOOK_TIMEOUT_MS = 5 * 60 * 1000;
const KERNEL_POLL_INTERVAL_MS = 2000;
const IPC_CONNECT_TIMEOUT_MS = 3000;
const IPC_REPLY_TIMEOUT_MS = 10_000;
const KERNEL_RPC_TIMEOUT_MS = 3000;

const GATEWAY_SOCKET =
  process.env.SWITCHROOM_GATEWAY_SOCKET ??
  (process.env.TELEGRAM_STATE_DIR !== undefined
    ? join(process.env.TELEGRAM_STATE_DIR, "gateway.sock")
    : join(homedir(), ".claude", "channels", "telegram", "gateway.sock"));

const KERNEL_SOCKET =
  process.env.SWITCHROOM_KERNEL_SOCKET ?? "/run/switchroom/kernel/sock";

/**
 * Multi-account-aware MS-365 tool-name matcher. Matches BOTH the bare
 * single-account server key (`mcp__ms-365__<tool>`) AND the per-account
 * multi-account keys (`mcp__ms-365-<slug>__<tool>`), capturing the bare
 * softeria tool name after the LAST `__`.
 *
 * MERGE-BLOCKER (multi-account RFC §2.5): before this, the gate keyed off
 * the literal `mcp__ms-365__` prefix, so every `mcp__ms-365-<slug>__*`
 * write tool sailed through UN-gated (fail-open). The `(-[a-z0-9-]+)?`
 * group closes that.
 */
const MS365_TOOL_RE = /^mcp__ms-365(?:-([a-z0-9-]+))?__(.+)$/;

/**
 * Return the bare softeria tool name if `toolName` is on the MS-365
 * surface (single OR multi-account server key), else null.
 */
export function ms365BareToolName(toolName: string): string | null {
  const m = MS365_TOOL_RE.exec(toolName);
  return m ? m[2] : null;
}

/**
 * Return the per-account MCP-key slug if `toolName` is on a MULTI-account
 * MS-365 server key (`mcp__ms-365-<slug>__<tool>` → `<slug>`), else null
 * (bare single-account key `mcp__ms-365__<tool>`, or not our surface).
 *
 * The slug is what threads the correct account through the enrichment path
 * on a multi-account agent (review 2026-07-17, Finding 1).
 */
export function ms365AccountSlugFromToolName(toolName: string): string | null {
  const m = MS365_TOOL_RE.exec(toolName);
  return m && m[1] ? m[1] : null;
}

/**
 * Gated softeria write tools — AUTHORITATIVE names.
 *
 * Names are the ground-truth softeria `mcp__ms-365__*` tool names,
 * harvested from real invocations across the fleet's agent transcripts
 * (88 distinct names observed) and reconciled in the MS-365 approval
 * design review (2026-07-13). They replace the earlier conjectured names
 * (`create-event`/`update-event`/`update-message`/…) which never existed
 * upstream — softeria names calendar/mail writes as `*-calendar-event`
 * and `*-mail-message`.
 *
 * This set is primarily documentation + an explicit-gate assertion:
 * `isGatedMs365Tool` fail-closes ANY unrecognized `mcp__ms-365__` tool to
 * "require approval" regardless, so a name missing here is still gated.
 * Its load-bearing job is (a) to keep writes and reads from ever
 * overlapping and (b) to make `send-mail` / `send` explicitly gate-and-
 * allow (post a card the operator can approve) rather than riding the
 * fail-closed path implicitly.
 *
 * Fleet config currently enables `mail|calendar` only, but the OneDrive
 * writes are included so the classification stays correct on any agent
 * that enables the drive surface.
 */
export const GATED_MS365_WRITE_TOOLS = new Set<string>([
  // ── Calendar writes ──
  "create-calendar",
  "update-calendar",
  "delete-calendar",
  "create-calendar-event",
  "create-specific-calendar-event",
  "update-calendar-event",
  "update-specific-calendar-event",
  "delete-calendar-event",
  "delete-specific-calendar-event",
  "accept-calendar-event",
  "decline-calendar-event",
  "tentatively-accept-calendar-event",
  "cancel-calendar-event",
  "forward-calendar-event",
  "dismiss-calendar-event-reminder",
  "snooze-calendar-event-reminder",
  "create-my-calendar-permission",
  "update-my-calendar-permission",
  "delete-my-calendar-permission",
  // ── Mail writes ──
  "send-mail",
  "send",
  "update-mail-message",
  "delete-mail-message",
  "move-mail-message",
  "copy-mail-message",
  "reply-mail-message",
  "reply-all-mail-message",
  "forward-mail-message",
  "create-mail-attachment-upload-session",
  "add-mail-attachment",
  "delete-mail-attachment",
  "create-mail-folder",
  "create-mail-child-folder",
  "update-mail-folder",
  "delete-mail-folder",
  "create-mail-rule",
  "update-mail-rule",
  "delete-mail-rule",
  "update-mailbox-settings",
  // ── OneDrive writes (only reachable on agents that enable the drive surface) ──
  "upload-file-content",
  "create-upload-session",
  "create-onedrive-folder",
  "delete-onedrive-file",
  "move-rename-onedrive-item",
  "copy-drive-item",
  "share-drive-item",
  "create-drive-item-share-link",
  "delete-drive-item-permission",
]);

/**
 * VERIFIED read-only softeria tools that are safe to pass through WITHOUT
 * an approval card. This is the fail-closed pivot: `isGatedMs365Tool`
 * gates (requires approval) for any `mcp__ms-365__` tool that is NOT on
 * this allowlist — so a renamed or newly-added upstream WRITE tool defaults
 * to "require approval" rather than sailing through unrecognized.
 *
 * Names are the AUTHORITATIVE softeria read surface (design review
 * 2026-07-13): calendar reads, mail reads, OneDrive reads, and the
 * identity/session control-plane. They replace the earlier conjectured
 * names (`list-files`/`list-events`/`get-message`/`whoami`/… — none of
 * which exist upstream), which caused every REAL read (`get-calendar-view`,
 * `list-mail-messages`, `get-mail-message`, …) to be misclassified as an
 * unrecognized write and posted an approval card (Bug 1).
 *
 * The cost of an omission here is only an extra approval prompt on a read
 * (annoying, safe) — never an ungated write (unsafe).
 */
export const KNOWN_SAFE_MS365_READ_TOOLS = new Set<string>([
  // ── Calendar reads ──
  "list-calendars",
  "get-calendar-view",
  "get-specific-calendar-view",
  "list-calendar-events",
  "list-specific-calendar-events",
  "get-calendar-event",
  "get-specific-calendar-event",
  "list-calendar-event-instances",
  "list-calendar-events-delta",
  "list-calendar-view-delta",
  "list-my-calendar-permissions",
  // ── Mail reads ──
  "list-mail-messages",
  "get-mail-message",
  "get-mail-message-mime",
  "list-mail-folders",
  "list-mail-child-folders",
  "list-mail-folder-messages",
  "list-mail-folder-messages-delta",
  "list-mail-attachments",
  "list-mail-rules",
  "get-mail-tips",
  "get-mailbox-settings",
  // Deliberate policy exception (operator-approved 2026-07-13): creating a
  // mail DRAFT is no-card. A draft is unsent, reviewable, and deletable —
  // reversible by nature — so frictionless drafting is the low-friction
  // default while SENDING stays gated. This is NOT an oversight: only the
  // send/reply/forward-SEND tools carry irreversible external effect and
  // remain in GATED_MS365_WRITE_TOOLS.
  "create-draft-email",
  // ── OneDrive reads (present on agents that enable the drive surface) ──
  "get-drive-item",
  "get-drive-root-item",
  "download-bytes",
  "list-drives",
  "list-folder-files",
  "search-onedrive-files",
  "get-drive-delta",
  // ── Identity / session — READ-ONLY ops only (no card) ──
  // Reviewer finding F1: ops that MUTATE auth/account state (logout,
  // select-account, remove-account) are NOT read-safe — they fall through
  // to the fail-closed gate and require a card. Only genuinely read-only
  // identity ops belong here.
  "login",
  "verify-login",
  "list-accounts",
]);

/**
 * Should this tool require an operator approval card before it runs?
 *
 * Fail-CLOSED classification:
 *   - Not an `mcp__ms-365__` tool → false (not our surface; another hook
 *     or the base permission system owns it).
 *   - A verified read-only tool (KNOWN_SAFE_MS365_READ_TOOLS) → false.
 *   - Everything else on the `mcp__ms-365__` surface (known writes AND any
 *     unrecognized / renamed tool) → true (gate).
 */
export function isGatedMs365Tool(toolName: string): boolean {
  const bare = ms365BareToolName(toolName);
  // Not an MS-365 tool (single or multi-account) → not our surface.
  if (bare === null) return false;
  // Degenerate prefix-only name — not a real tool invocation.
  if (bare.length === 0) return false;
  // Verified read-only tools pass through without a card.
  if (KNOWN_SAFE_MS365_READ_TOOLS.has(bare)) return false;
  // Known write OR unrecognized MS-365 tool → require approval (fail-closed).
  return true;
}

// ────────────────────────────────────────────────────────────────────────
// Operator allowFrom discovery
// ────────────────────────────────────────────────────────────────────────

/**
 * Read the operator allowFrom set from `access.json` inside the agent
 * container. Mirrors `drive-write-pretool.ts:loadAllowFrom()` — the WORKING
 * Drive path — verbatim in mechanism.
 *
 * This is the fix for Bug 2: the verdict lookup previously passed `[]` as the
 * `current_approver_set`, which the kernel's `evaluateDecisionRow` drift check
 * compared against the decision row's canonical set (`[tapper_uid]`). `[] ≠
 * [tapper_uid]` → drift branch → `drift_revoked`, so EVERY operator Approve
 * was silently reverted to a deny. Passing the real operator set (which, in
 * the single-operator DM case, canonicalizes identically to `[tapper_uid]`)
 * makes the grant stick — exactly as it does for Drive.
 *
 * `access.json` lives at `<TELEGRAM_STATE_DIR>/access.json` inside the agent
 * container. The homedir fallback only kicks in for host-side invocations
 * (tests, debug tools). If no operator is paired the list is empty — the poll
 * then can't match the `[tapper_uid]` record and fails closed (safe).
 */
export function loadAllowFrom(): string[] {
  const stateDir =
    process.env.TELEGRAM_STATE_DIR ??
    join(homedir(), ".claude", "channels", "telegram");
  const accessPath = join(stateDir, "access.json");
  try {
    const raw = readFileSync(accessPath, "utf8");
    const j = JSON.parse(raw) as { allowFrom?: unknown };
    if (Array.isArray(j.allowFrom)) {
      return (j.allowFrom as unknown[]).filter(
        (s): s is string => typeof s === "string",
      );
    }
  } catch {
    /* not paired or no access file */
  }
  return [];
}

// ────────────────────────────────────────────────────────────────────────
// stdin parse
// ────────────────────────────────────────────────────────────────────────

interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseHookInput(): HookInput | null {
  const raw = readStdin();
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as HookInput;
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Preview extraction — best-effort from tool_input shape
// ────────────────────────────────────────────────────────────────────────

export interface Ms365PreviewExtract {
  itemId: string;
  itemDisplayName: string;
  deepLink?: string;
  sizeBytesAfter?: number;
}

/** A single before→after change surfaced on the card. */
export interface Ms365Change {
  field: string;
  before?: string;
  after?: string;
}

/**
 * Enrichment produced by resolving a calendar event's opaque Graph id into
 * human-readable context. All fields optional — a failed/partial resolve
 * simply omits what it couldn't fetch.
 */
export interface Ms365CalendarEnrichment {
  /** Resolved event subject (overrides the payload-scraped display name). */
  itemDisplayName?: string;
  /** "start → end" human string for the card's `When:` line. */
  eventWhen?: string;
  /** Authenticated Microsoft account email (from the broker identity). */
  accountEmail?: string;
  /** Structural before→after diff for the fields the mutation changes. */
  changes?: Ms365Change[];
  /**
   * True when we attempted Graph resolution but it failed (broker/network) —
   * lets the caller mark the account as "(unresolved)" rather than
   * "(unknown)" so the operator can tell "couldn't reach Graph" from
   * "never tried".
   */
  resolveAttemptedButFailed?: boolean;
}

/**
 * Is this a calendar-EVENT tool whose opaque id is worth resolving to a
 * subject + start/end via Graph? (Calendar/permission tools that don't act on
 * a single event id are excluded — nothing to resolve.)
 */
export function isCalendarEventTool(toolName: string): boolean {
  const bare = ms365BareToolName(toolName);
  if (bare === null) return false;
  return bare.includes("calendar-event");
}

/**
 * Extract the calendar event id from a tool_input. softeria uses `eventId`
 * (and, for specific-calendar variants, still `eventId`); we also accept `id`.
 */
export function extractEventId(toolInput: unknown): string | null {
  const o =
    toolInput && typeof toolInput === "object"
      ? (toolInput as Record<string, unknown>)
      : {};
  for (const k of ["eventId", "id", "event_id"]) {
    if (typeof o[k] === "string" && (o[k] as string).length > 0) {
      return o[k] as string;
    }
  }
  return null;
}

/** Normalise a possibly-HTML/object body field to a short plain-text string. */
function bodyToText(v: unknown): string | undefined {
  if (typeof v === "string") {
    return v.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || undefined;
  }
  if (v && typeof v === "object") {
    const content = (v as { content?: unknown }).content;
    if (typeof content === "string") return bodyToText(content);
  }
  return undefined;
}

function dateTimeField(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (v && typeof v === "object") {
    const dt = (v as { dateTime?: unknown }).dateTime;
    if (typeof dt === "string" && dt.length > 0) return dt;
  }
  return undefined;
}

function locationField(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (v && typeof v === "object") {
    const dn = (v as { displayName?: unknown }).displayName;
    if (typeof dn === "string" && dn.length > 0) return dn;
  }
  return undefined;
}

function shorten(s: string, n = 120): string {
  // Collapse control whitespace so Graph-sourced values (subject/location/body)
  // can't smuggle newlines into the plain-text card as fake labelled lines
  // (#3267 review Finding 2). Defence in depth — the card renderer's truncate()
  // sanitises again at render time.
  const oneLine = s.replace(/[\r\n\t]+/g, " ").trim();
  return oneLine.length <= n ? oneLine : oneLine.slice(0, n - 1) + "…";
}

/**
 * Build the structural before→after diff for a calendar update by comparing
 * the mutation `tool_input` (the "after" — only changed fields present) against
 * the event's current Graph state (the "before"). Pure.
 */
export function buildCalendarChanges(
  toolInput: unknown,
  current: CalendarEventContext | null,
): Ms365Change[] {
  const o =
    toolInput && typeof toolInput === "object"
      ? (toolInput as Record<string, unknown>)
      : {};
  const changes: Ms365Change[] = [];

  const pushIfChanged = (field: string, before?: string, after?: string) => {
    if (after === undefined) return;
    if (before !== undefined && before === after) return;
    changes.push({
      field,
      before: before !== undefined ? shorten(before) : undefined,
      after: shorten(after),
    });
  };

  if ("subject" in o || "title" in o) {
    const after =
      typeof o.subject === "string"
        ? o.subject
        : typeof o.title === "string"
          ? o.title
          : undefined;
    pushIfChanged("subject", current?.subject, after);
  }
  if ("start" in o) {
    pushIfChanged("start", current?.start, dateTimeField(o.start));
  }
  if ("end" in o) {
    pushIfChanged("end", current?.end, dateTimeField(o.end));
  }
  if ("location" in o) {
    pushIfChanged("location", current?.location, locationField(o.location));
  }
  if ("body" in o || "bodyPreview" in o) {
    const after = bodyToText(o.body ?? o.bodyPreview);
    pushIfChanged("body", current?.bodyPreview, after);
  }
  return changes;
}

export interface EnrichCalendarDeps {
  /**
   * Load the Graph access handle for a specific account. The `account`
   * argument is the email resolved from the tool-name slug — threading it
   * is what makes the card enrich against the RIGHT mailbox on a
   * multi-account agent (Finding 1). `undefined` → single-account
   * back-compat (broker derives the sole account from config).
   */
  loadHandle?: (account?: string) => Promise<Ms365AccessHandle | null>;
  /**
   * Resolve the per-account slug (from the tool name) back to an account
   * email. Injectable for tests; defaults to the broker inventory match.
   */
  resolveAccount?: (slug: string | null) => Promise<string | null>;
  fetchEvent?: (args: {
    accessToken: string;
    eventId: string;
  }) => Promise<CalendarEventContext | null>;
}

/**
 * Resolve a calendar event's opaque Graph id into human-readable card context
 * (subject, when, account) and a before→after diff. Best-effort and fail-soft:
 * NEVER throws — on any failure returns `{ resolveAttemptedButFailed: true }`
 * (or partial context) so the hook falls back cleanly without blocking.
 */
export async function enrichCalendarPreview(
  toolName: string,
  toolInput: unknown,
  deps: EnrichCalendarDeps = {},
): Promise<Ms365CalendarEnrichment> {
  if (!isCalendarEventTool(toolName)) return {};
  const loadHandle =
    deps.loadHandle ??
    ((account?: string) =>
      loadMicrosoftFromAuthBroker(
        account !== undefined ? { account } : {},
      ));
  const resolveAccount =
    deps.resolveAccount ??
    ((slug: string | null) => resolveMicrosoftAccountBySlug(slug));
  const fetchEvent =
    deps.fetchEvent ??
    ((a: { accessToken: string; eventId: string }) =>
      fetchCalendarEventContext(a));

  // Multi-account agents key each binding as `mcp__ms-365-<slug>__*`. Resolve
  // the slug back to the account email so the broker returns THAT mailbox's
  // token — not the account-less back-compat `bindings[0]` (Finding 1). On a
  // single-account (bare) key the slug is null → account stays undefined and
  // the broker derives the sole configured account.
  const slug = ms365AccountSlugFromToolName(toolName);
  let account: string | undefined;
  try {
    account = (await resolveAccount(slug)) ?? undefined;
  } catch {
    account = undefined;
  }

  let handle: Ms365AccessHandle | null;
  try {
    handle = await loadHandle(account);
  } catch {
    return { resolveAttemptedButFailed: true };
  }
  if (!handle) return { resolveAttemptedButFailed: true };

  const out: Ms365CalendarEnrichment = {};
  if (handle.account_email) out.accountEmail = handle.account_email;

  const eventId = extractEventId(toolInput);
  let current: CalendarEventContext | null = null;
  if (eventId) {
    try {
      current = await fetchEvent({
        accessToken: handle.access_token,
        eventId,
      });
    } catch {
      current = null;
    }
  }

  if (current?.subject) out.itemDisplayName = current.subject;
  if (current?.start || current?.end) {
    out.eventWhen = `${current.start ?? "?"} → ${current.end ?? "?"}`;
  }

  const changes = buildCalendarChanges(toolInput, current);
  if (changes.length > 0) out.changes = changes;

  // Resolution "succeeded" if we got an account or any event context. If we
  // got a token but Graph gave us nothing (deleted event, permission gap),
  // mark it as attempted-but-failed for the account marker.
  if (!out.accountEmail && !current) out.resolveAttemptedButFailed = true;
  return out;
}

/**
 * Best-effort extract the preview-shape fields from softeria's
 * tool_input. softeria's exact param names vary per tool — we look for
 * the common shapes and fall through to "(unknown)" defaults.
 *
 * **This is pure heuristics**. UAT in PR 5 validates against actual
 * tool_input shapes; if a tool's params don't match these patterns,
 * the card shows "(unknown)" for the field — the operator can still
 * make a decision based on tool name + agent rationale, just without
 * the item-level context.
 */
export function extractMs365Preview(
  toolName: string,
  toolInput: unknown,
): Ms365PreviewExtract {
  const o = (toolInput && typeof toolInput === "object")
    ? (toolInput as Record<string, unknown>)
    : {};

  // itemId common shapes: itemId, item_id, id, driveItemId, eventId, messageId
  let itemId = "(new)";
  for (const k of ["itemId", "item_id", "id", "driveItemId", "eventId", "messageId", "message_id"]) {
    if (typeof o[k] === "string" && (o[k] as string).length > 0) {
      itemId = o[k] as string;
      break;
    }
  }

  // Display name shapes: name, fileName, file_name, displayName, subject, title
  let itemDisplayName = "(unknown)";
  for (const k of ["name", "fileName", "file_name", "displayName", "subject", "title"]) {
    if (typeof o[k] === "string" && (o[k] as string).length > 0) {
      itemDisplayName = o[k] as string;
      break;
    }
  }

  // Deep link shapes: webUrl, web_url, url, link
  let deepLink: string | undefined;
  for (const k of ["webUrl", "web_url", "url", "link"]) {
    if (typeof o[k] === "string" && (o[k] as string).startsWith("http")) {
      deepLink = o[k] as string;
      break;
    }
  }

  // Size shapes: contentSize, content_size, fileSize, size (for upload tools)
  let sizeBytesAfter: number | undefined;
  for (const k of ["contentSize", "content_size", "fileSize", "size"]) {
    if (typeof o[k] === "number" && Number.isFinite(o[k])) {
      sizeBytesAfter = o[k] as number;
      break;
    }
  }
  // For inline base64-encoded content, derive size from the encoded
  // string length. Approximate (off by 0/1/2 bytes depending on `=`
  // padding) — accurate enough for the operator's card. Surfaced as
  // "approx N bytes" downstream if we ever care to be exact.
  if (sizeBytesAfter === undefined && typeof o.content === "string") {
    const len = (o.content as string).length;
    sizeBytesAfter = Math.floor((len * 3) / 4);
  }

  return { itemId, itemDisplayName, deepLink, sizeBytesAfter };
}

// ────────────────────────────────────────────────────────────────────────
// IPC — gateway + kernel
// ────────────────────────────────────────────────────────────────────────

interface IpcOk { ok: true; value: unknown }
interface IpcErr { ok: false; reason: string }
type IpcResult = IpcOk | IpcErr;

async function sendGatewayRequest(
  socket: string,
  payload: Record<string, unknown>,
  matchType: string,
  correlationId: string,
): Promise<IpcResult> {
  return new Promise((resolve) => {
    const conn = createConnection(socket);
    let buf = "";
    const cleanup = () => {
      try {
        conn.destroy();
      } catch {
        /* ignore */
      }
    };
    const replyTimer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: "gateway reply timeout" });
    }, IPC_REPLY_TIMEOUT_MS);
    const connectTimer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: "gateway connect timeout" });
    }, IPC_CONNECT_TIMEOUT_MS);

    conn.once("error", (err) => {
      clearTimeout(replyTimer);
      clearTimeout(connectTimer);
      resolve({ ok: false, reason: `gateway: ${err.message}` });
    });
    conn.once("connect", () => {
      clearTimeout(connectTimer);
      conn.write(JSON.stringify(payload) + "\n");
    });
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      while (true) {
        const lineEnd = buf.indexOf("\n");
        if (lineEnd === -1) break;
        const line = buf.slice(0, lineEnd);
        buf = buf.slice(lineEnd + 1);
        try {
          const parsed = JSON.parse(line) as {
            type?: string;
            correlationId?: string;
          };
          if (
            parsed?.type === matchType &&
            parsed?.correlationId === correlationId
          ) {
            clearTimeout(replyTimer);
            cleanup();
            resolve({ ok: true, value: parsed });
            return;
          }
        } catch {
          /* drop malformed line; keep reading */
        }
      }
    });
  });
}

async function rpcKernel(payload: Record<string, unknown>): Promise<IpcResult> {
  return new Promise((resolve) => {
    const conn = createConnection(KERNEL_SOCKET);
    let buf = "";
    const cleanup = () => {
      try {
        conn.destroy();
      } catch {
        /* ignore */
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: "kernel rpc timeout" });
    }, KERNEL_RPC_TIMEOUT_MS);
    conn.once("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `kernel: ${err.message}` });
    });
    conn.once("connect", () => {
      conn.write(JSON.stringify(payload) + "\n");
    });
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lineEnd = buf.indexOf("\n");
      if (lineEnd === -1) return;
      const line = buf.slice(0, lineEnd);
      clearTimeout(timer);
      cleanup();
      try {
        resolve({ ok: true, value: JSON.parse(line) });
      } catch (err) {
        resolve({ ok: false, reason: `kernel parse: ${String(err)}` });
      }
    });
  });
}

/**
 * Poll the verdict for the SPECIFIC request_id this hook registered.
 *
 * We correlate by request_id, NOT by scope: two concurrent MS-365 writes
 * can share a scope (e.g. `ms-365:write:(new)` for two new-file uploads),
 * and a scope-keyed lookup would let one write's approval satisfy the
 * other's gate — a fail-open mis-attribution. `approval_lookup_by_request`
 * resolves the nonce by request_id and returns only that request's own
 * decision. (review 2026-07-11, W2 verdict-correlation finding.)
 */
async function approvalLookupByRequest(
  agentUnit: string,
  requestId: string,
  approverSet: string[],
): Promise<{ state?: string; origin?: "agent" | "operator" } | null> {
  const res = await rpcKernel({
    v: 1,
    op: "approval_lookup_by_request",
    agent_unit: agentUnit,
    request_id: requestId,
    current_approver_set: approverSet,
  });
  if (!res.ok) return null;
  const value = res.value as {
    state?: string;
    decision?: { origin?: unknown } | null;
  };
  // Surface the server-stamped provenance alongside the state: `state`
  // alone cannot distinguish an operator tap from a decision this agent
  // recorded for itself (see gated-write-policy.ts).
  const o = value.decision?.origin;
  return {
    state: value.state,
    origin: o === "operator" || o === "agent" ? o : undefined,
  };
}

/** Read once at hook start — the gate must not change mid-poll. */
const REQUIRE_OPERATOR_ORIGIN = requireOperatorApprovalForWrites();

// ────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────

function fail(reason: string): never {
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: `ms-365 write blocked: ${reason}`,
    }),
  );
  process.exit(0);
}

function allow(): never {
  process.exit(0);
}

async function main(): Promise<void> {
  const input = parseHookInput();
  if (!input) fail("malformed stdin");

  const toolName = input.tool_name;
  if (typeof toolName !== "string" || !isGatedMs365Tool(toolName)) {
    // Not a gated tool — allow through.
    allow();
  }

  const agentName = process.env.SWITCHROOM_AGENT_NAME;
  if (!agentName) {
    // No agent identity — we can't register/correlate an approval for a
    // known-write path, so we can't prove the operator authorized it.
    // Fail CLOSED (review 2026-07-11, W2). The write is already confirmed
    // gated at this point (isGatedMs365Tool returned true above).
    fail("SWITCHROOM_AGENT_NAME unset — cannot identify agent to gate write");
  }

  const extract = extractMs365Preview(toolName, input.tool_input);

  // ── Problem 2: batch admission ──────────────────────────────────────────
  // If an earlier op in this same recent batch already lapsed/aborted, refuse
  // the remaining ops UP FRONT (before posting a card or mutating) with a
  // distinct "grant lapsed, N applied — stop and reconcile" signal, instead of
  // dribbling further partial application + re-prompts. Fail-soft: a
  // missing/corrupt ledger admits the op (a first write is never blocked by
  // this).
  const now = Date.now();
  const admission = evaluateBatchAdmission({
    entries: readLedger(now).entries,
    now,
  });
  if (!admission.admit) {
    fail(buildBatchAbortReason(admission.appliedInBatch));
  }

  // ── Problem 1: resolve opaque Graph id → human-readable card context ─────
  // For calendar-event tools, resolve the event's subject + start/end and the
  // authenticated account from Graph BEFORE rendering the card, rather than
  // scraping the mutation payload (which omits unchanged fields). Best-effort
  // and fail-soft — enrichCalendarPreview never throws.
  let enrichment: Ms365CalendarEnrichment = {};
  try {
    enrichment = await enrichCalendarPreview(toolName, input.tool_input);
  } catch {
    enrichment = { resolveAttemptedButFailed: true };
  }

  const accountEmail =
    enrichment.accountEmail ??
    process.env.SWITCHROOM_MICROSOFT_ACCOUNT ??
    (enrichment.resolveAttemptedButFailed ? "(unresolved)" : "(unknown)");

  const itemDisplayName =
    enrichment.itemDisplayName ?? extract.itemDisplayName;

  const preview = {
    agentName,
    toolName,
    itemId: extract.itemId,
    itemDisplayName,
    accountEmail,
    deepLink: extract.deepLink,
    sizeBytesAfter: extract.sizeBytesAfter,
    eventWhen: enrichment.eventWhen,
    changes: enrichment.changes,
    // No agentRationale yet — softeria doesn't pass one, and we
    // don't have a sidecar channel for the agent to supply it.
  };

  const correlationId = randomBytes(16).toString("hex");
  const requestResult = await sendGatewayRequest(
    GATEWAY_SOCKET,
    {
      type: "request_ms365_approval",
      correlationId,
      agentName,
      preview,
      ttlMs: HOOK_TIMEOUT_MS,
    },
    "ms365_approval_posted",
    correlationId,
  );

  if (!requestResult.ok) fail(requestResult.reason);
  const response = requestResult.value as {
    ok: boolean;
    requestId?: string;
    expiresAtMs?: number;
    reason?: string;
  };
  if (!response.ok || !response.requestId) {
    fail(response.reason ?? "gateway returned ok=false");
  }

  const requestId = response.requestId;
  const deadline = response.expiresAtMs ?? Date.now() + HOOK_TIMEOUT_MS;
  // Correlate strictly by the request_id we just registered — not by scope
  // (concurrent same-scope writes would otherwise cross-attribute verdicts).
  // Pass the REAL operator allowFrom set (Bug 2 fix): the kernel's
  // evaluateDecisionRow drift check compares this against the decision row's
  // canonical set. Passing `[]` (the old bug) always drifted → drift_revoked,
  // so no Approve ever stuck. Mirror the working Drive pretool and pass the
  // loaded allowFrom.
  const approverSet = loadAllowFrom();
  const ledgerEntry = { tool: toolName, itemId: extract.itemId };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, KERNEL_POLL_INTERVAL_MS));
    const lookup = await approvalLookupByRequest(agentName, requestId, approverSet);
    if (!lookup) continue;
    const state = lookup.state;
    // Shared classifier — the same unit-tested function both Drive gate
    // sites use, so the provenance rule cannot be present in one hook and
    // missing in the other.
    const action = evaluateGatedWrite(
      { state: state ?? null, origin: lookup.origin },
      REQUIRE_OPERATOR_ORIGIN,
    );
    if (action.kind === "allow") {
      // Record the applied write so a later op that lapses can report an
      // accurate "N of the batch already applied" count.
      recordOutcome(Date.now(), { ...ledgerEntry, outcome: "applied" });
      allow();
    }
    if (action.kind === "block") {
      // Granted but not operator-verified — fail closed immediately
      // rather than poll to the deadline on a decision we will never
      // accept.
      fail(action.reason);
    }
    if (state === "expired" || state === "drift_revoked") {
      // Grant lapsed (TTL elapsed / approver drift) — NOT an intentional deny.
      // If earlier ops in THIS batch already applied, this is the mid-batch
      // partial-application case (#3267 Problem 2): mark the batch aborted so
      // the REMAINING identical ops are refused up front, and give the agent a
      // distinct "N of the batch applied — stop and reconcile" signal. A lone
      // lapse with nothing applied in this batch (or only unrelated earlier
      // writes) is just a timeout — don't suppress.
      const t = Date.now();
      const applied = countCurrentBatchApplied(readLedger(t).entries, t);
      if (applied > 0) {
        recordOutcome(t, {
          ...ledgerEntry,
          outcome: "aborted",
          appliedInBatch: applied,
        });
        fail(buildBatchAbortReason(applied));
      }
      fail(`operator ${state}`);
    }
    if (state === "denied") {
      // An explicit Deny is a deliberate per-op decision — it must NOT suppress
      // later, unrelated writes, so we don't write a batch-abort entry here.
      fail("operator denied");
    }
  }
  fail("approval timed out");
}

// Only invoke main() when run as a script — not when imported by tests.
// The hook is bundled by scripts/build.mjs into a standalone .mjs that
// IS run as a script in the agent container; the gating below is
// satisfied by bun's bundler exposing `import.meta.main` (true at
// entrypoint, false on imports). At test-import time the predicate is
// false so main() doesn't fire (and hang on readFileSync(0)).
if ((import.meta as { main?: boolean }).main) {
  main().catch((err) => {
    const m = err instanceof Error ? err.message : String(err);
    fail(`hook error: ${m}`);
  });
}
