/**
 * Microsoft Graph resolution helpers for the MS-365 write-approval hook —
 * fix for issue #3267 (Problem 1).
 *
 * The `ms-365-write-pretool` hook previously rendered the approval card
 * purely from the mutation `tool_input`. For an `update-calendar-event`
 * that edits only body/location, softeria does NOT resend `subject`/`title`,
 * so the card showed `Item: (unknown)`, only the raw opaque Graph id, no
 * account (an unset env var), and no diff — an unverifiable "blind write".
 *
 * This module resolves that opaque id into human-readable context BEFORE the
 * card is rendered: it fetches the event's subject + start/end (and the
 * authenticated account email) from Microsoft Graph, using the SAME
 * auth-broker access-token path the softeria launcher uses
 * (`getCredentials("microsoft")`). It mirrors `src/drive/wrapper-broker.ts` +
 * `src/drive/docs-get.ts` — the working Drive-write precedent.
 *
 * Everything here is BEST-EFFORT and fail-soft: the hook must never crash or
 * wrongly block the write path because Graph was unreachable. Every function
 * returns `null` (or throws a caught error) on failure, and the hook falls
 * back to the prior payload-scrape behaviour with a clear "(unresolved)"
 * marker.
 */

// ────────────────────────────────────────────────────────────────────────
// Auth-broker Microsoft access token
// ────────────────────────────────────────────────────────────────────────

export interface Ms365AccessHandle {
  /** Bearer token for `Authorization: Bearer <token>`. */
  access_token: string;
  /** Unix-ms when this access token expires. */
  expires_at: number;
  /**
   * The authenticated Microsoft account email, as persisted by the broker
   * from the OAuth identity. This is the "Graph identity" the issue asks the
   * card to show instead of the unset `SWITCHROOM_MICROSOFT_ACCOUNT` env var.
   */
  account_email?: string;
}

export interface LoadMicrosoftFromAuthBrokerOptions {
  /** Override the broker socket path (tests pass a tmp socket). */
  socketPath?: string;
  /**
   * The Microsoft account (email) to resolve credentials for. On a
   * multi-account agent this MUST be threaded so the broker returns the
   * token for the RIGHT mailbox — otherwise the account-less back-compat
   * branch returns `bindings[0]`'s token and the card enriches against the
   * wrong account (review 2026-07-17, Finding 1). Omitted → single-account
   * back-compat (broker derives the sole account from config).
   */
  account?: string;
  /**
   * If the broker's credentials expire within this many ms, treat them as
   * unusable and return null (caller degrades gracefully). Default 60_000.
   */
  refreshWindowMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Pull a Microsoft Graph access token (+ authenticated account email) from the
 * auth-broker. Mirrors `loadFromAuthBroker` (Google) but for the `microsoft`
 * provider and the `microsoftOauth` credentials shape.
 *
 * Fail-soft: returns `null` when the broker is unreachable, denies access, is
 * missing credentials, or the token is expired/near-expiry. NEVER throws for
 * the "can't resolve" cases — the caller must degrade gracefully, not block.
 */
export async function loadMicrosoftFromAuthBroker(
  options: LoadMicrosoftFromAuthBrokerOptions = {},
): Promise<Ms365AccessHandle | null> {
  const now = (options.now ?? Date.now)();
  const refreshWindowMs = options.refreshWindowMs ?? 60_000;

  // Lazy-import so this module (and the bundled hook) only drags the broker
  // client in when the Graph-resolution path actually runs.
  const { withAuthBrokerClient, AuthBrokerUnreachableError, AuthBrokerError } =
    await import("../auth/broker/client.js");

  let result: { account: string; credentials: unknown; expiresAt?: number };
  try {
    result = await withAuthBrokerClient(
      async (client) => {
        return (await client.getCredentials("microsoft", options.account)) as {
          account: string;
          credentials: unknown;
          expiresAt?: number;
        };
      },
      options.socketPath !== undefined ? { socket: options.socketPath } : undefined,
    );
  } catch (err) {
    // Broker unreachable, ACL-denied, or any other broker error → degrade.
    // We do NOT distinguish here: for card enrichment, "couldn't resolve" is
    // the only outcome that matters, and it must never block the write.
    if (
      err instanceof AuthBrokerUnreachableError ||
      err instanceof AuthBrokerError
    ) {
      return null;
    }
    return null;
  }

  const creds = result.credentials as {
    microsoftOauth?: {
      accessToken?: string;
      expiresAt?: number;
      accountEmail?: string;
    };
  };
  const accessToken = creds.microsoftOauth?.accessToken;
  const expiresAt = result.expiresAt ?? creds.microsoftOauth?.expiresAt;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  if (typeof expiresAt !== "number") return null;
  if (expiresAt <= now + refreshWindowMs) return null;

  return {
    access_token: accessToken,
    expires_at: expiresAt,
    account_email: creds.microsoftOauth?.accountEmail,
  };
}

/** Options for {@link resolveMicrosoftAccountBySlug}. */
export interface ResolveAccountBySlugOptions {
  /** Override the broker socket path (tests pass a tmp socket). */
  socketPath?: string;
  /**
   * Injectable account inventory (tests). Defaults to the broker's
   * `list-microsoft-accounts`. Returns candidate account emails.
   */
  listAccounts?: () => Promise<string[]>;
}

/**
 * Map a per-account MCP-key slug (`ms-365-<slug>` → `<slug>`) back to the
 * Microsoft account email it was derived from, by recomputing
 * `microsoftAccountSlug` over the broker's account inventory and matching.
 *
 * This is how the write-approval hook threads the CORRECT account on a
 * multi-account agent: the invoking tool name (`mcp__ms-365-<slug>__*`)
 * carries the slug, and we resolve it to an email to pass to
 * `getCredentials("microsoft", account)` (review 2026-07-17, Finding 1).
 *
 * Fail-soft: returns `null` when the broker is unreachable, no slug is
 * given (single-account back-compat), or nothing matches — the caller then
 * falls back to the account-less broker path. The broker's per-agent ACL
 * still applies downstream, so a slug that resolves to an account the agent
 * isn't bound to is rejected there (never a silent cross-account leak).
 */
export async function resolveMicrosoftAccountBySlug(
  slug: string | null | undefined,
  options: ResolveAccountBySlugOptions = {},
): Promise<string | null> {
  if (!slug) return null;
  const { microsoftAccountSlug } = await import(
    "../config/microsoft-workspace-acl.js"
  );

  let accounts: string[];
  try {
    if (options.listAccounts) {
      accounts = await options.listAccounts();
    } else {
      const { withAuthBrokerClient } = await import("../auth/broker/client.js");
      accounts = await withAuthBrokerClient(
        async (client) => {
          const data = (await client.listMicrosoftAccounts()) as {
            accounts?: Array<{ account?: string }>;
          };
          return (data.accounts ?? [])
            .map((a) => a.account)
            .filter((a): a is string => typeof a === "string");
        },
        options.socketPath !== undefined ? { socket: options.socketPath } : undefined,
      );
    }
  } catch {
    return null;
  }

  for (const account of accounts) {
    if (microsoftAccountSlug(account) === slug) return account;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Microsoft Graph — calendar event context
// ────────────────────────────────────────────────────────────────────────

export type FetchImpl = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_TIMEOUT_MS = 4000;

export interface CalendarEventContext {
  /** Event subject/title — the human-readable name for the card. */
  subject?: string;
  /** ISO 8601 start dateTime (Graph `start.dateTime`). */
  start?: string;
  /** ISO 8601 end dateTime (Graph `end.dateTime`). */
  end?: string;
  /** Free-text location display name. */
  location?: string;
  /** Short text preview of the current body — used for the before→after diff. */
  bodyPreview?: string;
}

function defaultFetch(): FetchImpl | null {
  const f = (globalThis as { fetch?: unknown }).fetch;
  return typeof f === "function" ? (f as FetchImpl) : null;
}

async function graphGet(
  path: string,
  accessToken: string,
  fetchImpl?: FetchImpl,
): Promise<unknown | null> {
  const doFetch = fetchImpl ?? defaultFetch();
  if (!doFetch) return null;
  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), GRAPH_TIMEOUT_MS)
    : null;
  try {
    const res = await doFetch(`${GRAPH_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: controller?.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve a calendar event's human-readable context from Graph. Best-effort:
 * returns `null` on any failure (no token, network error, non-2xx, missing
 * fetch). NEVER throws.
 *
 * `$select` is scoped to the fields the card needs so the request stays cheap
 * and doesn't pull the full event body.
 */
export async function fetchCalendarEventContext(args: {
  accessToken: string;
  eventId: string;
  fetchImpl?: FetchImpl;
}): Promise<CalendarEventContext | null> {
  const { accessToken, eventId, fetchImpl } = args;
  if (!eventId) return null;
  const path = `/me/events/${encodeURIComponent(
    eventId,
  )}?$select=subject,start,end,location,bodyPreview`;
  const body = (await graphGet(path, accessToken, fetchImpl)) as {
    subject?: unknown;
    start?: { dateTime?: unknown };
    end?: { dateTime?: unknown };
    location?: { displayName?: unknown };
    bodyPreview?: unknown;
  } | null;
  if (!body || typeof body !== "object") return null;

  const out: CalendarEventContext = {};
  if (typeof body.subject === "string" && body.subject.length > 0) {
    out.subject = body.subject;
  }
  if (typeof body.start?.dateTime === "string") out.start = body.start.dateTime;
  if (typeof body.end?.dateTime === "string") out.end = body.end.dateTime;
  if (
    typeof body.location?.displayName === "string" &&
    body.location.displayName.length > 0
  ) {
    out.location = body.location.displayName;
  }
  if (typeof body.bodyPreview === "string" && body.bodyPreview.length > 0) {
    out.bodyPreview = body.bodyPreview;
  }
  // If Graph returned an event with none of the fields we care about, treat
  // it as an unresolved miss rather than an empty "success".
  if (Object.keys(out).length === 0) return null;
  return out;
}
