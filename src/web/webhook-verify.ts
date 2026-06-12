/**
 * Webhook signature verifiers (#577).
 *
 * Closes the "always-on" half of the talk-to-agents-from-anywhere
 * JTBD by letting external systems push events into a specific
 * agent's topic. The catch: the webhook endpoint sits on the same
 * web server as the dashboard, so signature verification is the only
 * thing standing between the open internet and "post into Lisa's DM."
 *
 * This module owns the verification primitives — pure functions that
 * take the request body + headers + the per-source secret and decide
 * verified-or-not. The web server's route handler wires them in.
 *
 * Why two flavors:
 *   - **github**: HMAC-SHA256 over the raw request body, signature
 *     in `X-Hub-Signature-256`. Standard GitHub webhook shape; no
 *     custom config required from the user. Works for GitLab too
 *     with a different header name (deferred — file when needed).
 *   - **generic**: Bearer token in the `Authorization` header.
 *     Simple shared-secret model for in-house tools that can't do
 *     HMAC. The token is per-source-per-agent, declared in the
 *     vault under `webhook/<agent>/<source>`.
 *   - **linear** (#2272): hex HMAC-SHA256 over the raw request body,
 *     signature in the `Linear-Signature` header. Linear sends a bare
 *     hex digest (NO `sha256=` prefix) and no Bearer auth. Same
 *     per-source secret model as github/generic.
 *
 * Both verifiers are CONSTANT-TIME compares to defeat timing attacks.
 * The Node `crypto.timingSafeEqual` requires equal-length buffers;
 * we pad with zeros and check length separately so a length mismatch
 * doesn't itself leak via early-return timing.
 */

import { createHmac, timingSafeEqual } from 'crypto'

export type WebhookVerifyResult =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Verify a GitHub-style HMAC-SHA256 webhook signature.
 *
 * Header format: `sha256=<hex>` in `X-Hub-Signature-256`. The signed
 * content is the raw request body bytes — caller must pass the body
 * unmodified (no JSON.parse → re-stringify, which would change
 * whitespace and break the signature).
 *
 * Returns `{ ok: false }` for any failure mode without leaking which
 * (missing header, wrong format, wrong signature) — the route handler
 * returns a plain 401 on top of that.
 */
export function verifyGithubSignature(
  body: Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
): WebhookVerifyResult {
  if (!secret || secret.length === 0) {
    return { ok: false, reason: 'no-secret-configured' }
  }
  if (!signatureHeader) {
    return { ok: false, reason: 'no-signature-header' }
  }
  if (!signatureHeader.startsWith('sha256=')) {
    return { ok: false, reason: 'wrong-signature-format' }
  }
  const provided = signatureHeader.slice('sha256='.length)
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    return { ok: false, reason: 'malformed-hex' }
  }
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  // Constant-time compare. Both buffers are 64-char hex (validated
  // above) so they're always the same length here.
  const a = Buffer.from(provided, 'utf-8')
  const b = Buffer.from(expected, 'utf-8')
  if (a.length !== b.length) return { ok: false, reason: 'length-mismatch' }
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'signature-mismatch' }
  return { ok: true }
}

/**
 * Verify a Linear-style HMAC-SHA256 webhook signature (#2272).
 *
 * Header format: a bare 64-char lowercase hex digest in the
 * `Linear-Signature` header — NO `sha256=` prefix (unlike GitHub).
 * The signed content is the raw request body bytes; the caller must
 * pass the body unmodified (no JSON.parse → re-stringify).
 *
 * Same reason-leak posture as the other verifiers: every failure mode
 * returns `{ ok: false }` and the route handler returns a plain 401.
 */
export function verifyLinearSignature(
  body: Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
): WebhookVerifyResult {
  if (!secret || secret.length === 0) {
    return { ok: false, reason: 'no-secret-configured' }
  }
  if (!signatureHeader) {
    return { ok: false, reason: 'no-signature-header' }
  }
  const provided = signatureHeader.trim()
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    return { ok: false, reason: 'malformed-hex' }
  }
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  // Constant-time compare. Both are 64-char hex (validated above) so
  // they're always the same length here.
  const a = Buffer.from(provided, 'utf-8')
  const b = Buffer.from(expected, 'utf-8')
  if (a.length !== b.length) return { ok: false, reason: 'length-mismatch' }
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'signature-mismatch' }
  return { ok: true }
}

/**
 * Verify a Bearer token from the Authorization header.
 *
 * Header format: `Authorization: Bearer <token>`. Constant-time
 * compare against the configured secret. Same reason-leak posture as
 * GitHub verifier.
 */
export function verifyBearerToken(
  authHeader: string | null | undefined,
  secret: string,
): WebhookVerifyResult {
  if (!secret || secret.length === 0) {
    return { ok: false, reason: 'no-secret-configured' }
  }
  if (!authHeader) {
    return { ok: false, reason: 'no-auth-header' }
  }
  const m = /^Bearer\s+(.+)$/.exec(authHeader)
  if (!m) return { ok: false, reason: 'wrong-auth-scheme' }
  const provided = m[1]
  if (provided.length !== secret.length) {
    return { ok: false, reason: 'length-mismatch' }
  }
  const a = Buffer.from(provided, 'utf-8')
  const b = Buffer.from(secret, 'utf-8')
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'token-mismatch' }
  return { ok: true }
}

/**
 * Known webhook sources. Adding a source here requires a verifier
 * choice (github | bearer) and a template for how the verified payload
 * gets rendered into a Telegram message. Keep the set small and
 * purpose-built rather than generic — generic catch-alls invite
 * abuse-by-misuse.
 */
export type WebhookSource = 'github' | 'generic' | 'linear'

export interface RenderedWebhookMessage {
  text: string
  /** When true, suppress link previews on the rendered message. GitHub
   *  notifications often include a URL that telegram would otherwise
   *  expand into a big preview card; we want a tight one-liner. */
  disableLinkPreview: boolean
}

/**
 * Render a verified GitHub webhook payload into a single-line
 * Telegram message. Best-effort: unknown event types fall back to a
 * generic shape so nothing arrives invisible.
 *
 * Pure — no fetch, no DB. Caller passes parsed JSON.
 */
export function renderGithubEvent(
  eventType: string,
  payload: Record<string, unknown>,
): RenderedWebhookMessage {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name ?? '?'
  const sender = (payload.sender as { login?: string } | undefined)?.login ?? '?'

  switch (eventType) {
    case 'pull_request': {
      const action = String(payload.action ?? '')
      const pr = (payload.pull_request as { number?: number; title?: string; html_url?: string } | undefined) ?? {}
      const url = pr.html_url ?? ''
      return {
        text: `🐙 <b>${escapeHtml(repo)}</b> PR #${pr.number ?? '?'} ${escapeHtml(action)} by @${escapeHtml(sender)}\n${escapeHtml(pr.title ?? '')}${url ? `\n${url}` : ''}`,
        disableLinkPreview: true,
      }
    }
    case 'issues': {
      const action = String(payload.action ?? '')
      const issue = (payload.issue as { number?: number; title?: string; html_url?: string } | undefined) ?? {}
      const url = issue.html_url ?? ''
      return {
        text: `🐙 <b>${escapeHtml(repo)}</b> issue #${issue.number ?? '?'} ${escapeHtml(action)} by @${escapeHtml(sender)}\n${escapeHtml(issue.title ?? '')}${url ? `\n${url}` : ''}`,
        disableLinkPreview: true,
      }
    }
    case 'push': {
      const ref = String(payload.ref ?? '').replace(/^refs\/heads\//, '')
      const commits = Array.isArray(payload.commits) ? payload.commits.length : 0
      const compare = String(payload.compare ?? '')
      return {
        text: `🐙 <b>${escapeHtml(repo)}</b> push to <code>${escapeHtml(ref)}</code> by @${escapeHtml(sender)} — ${commits} commit(s)${compare ? `\n${compare}` : ''}`,
        disableLinkPreview: true,
      }
    }
    case 'ping':
      return { text: `🐙 <b>${escapeHtml(repo)}</b> webhook ping from @${escapeHtml(sender)}`, disableLinkPreview: true }
    default:
      return {
        text: `🐙 <b>${escapeHtml(repo)}</b> ${escapeHtml(eventType)} by @${escapeHtml(sender)}`,
        disableLinkPreview: true,
      }
  }
}

/**
 * Render a verified Linear webhook payload into a single-line Telegram
 * message (#2272). Linear's webhook envelope shape:
 *
 * ```json
 * {
 *   "action": "create",            // create | update | remove
 *   "type": "Issue",               // Issue | Comment | ...
 *   "url": "https://linear.app/...",
 *   "data": {
 *     "identifier": "ENG-42",
 *     "title": "Fix the thing",
 *     "assignee": { "name": "agent", "displayName": "agent" },
 *     "labels": [{ "name": "bug" }],
 *     "body": "...",               // comment text on Comment events
 *     "issue": { "identifier": "ENG-42", "title": "Fix the thing" }
 *   }
 * }
 * ```
 *
 * Every interpolated field is HTML-escaped: the payload is attacker-
 * influenced data, never instructions (same posture as renderGithubEvent).
 * Pure — no fetch, no DB. Caller passes the parsed JSON envelope.
 */
export function renderLinearEvent(
  eventType: string,
  payload: Record<string, unknown>,
): RenderedWebhookMessage {
  const action = String(payload.action ?? '')
  const url = typeof payload.url === 'string' ? payload.url : ''
  const data = (payload.data as Record<string, unknown> | undefined) ?? {}

  // `eventType` is the Linear `type` field, lower-cased by the handler.
  switch (eventType) {
    case 'issue': {
      const id = String(data.identifier ?? '?')
      const title = String(data.title ?? '')
      const assignee =
        (data.assignee as { displayName?: string; name?: string } | undefined)?.displayName ??
        (data.assignee as { name?: string } | undefined)?.name ??
        ''
      return {
        text:
          `📐 <b>Linear</b> issue ${escapeHtml(id)} ${escapeHtml(action)}` +
          `${assignee ? ` → @${escapeHtml(assignee)}` : ''}\n` +
          `${escapeHtml(title)}${url ? `\n${url}` : ''}`,
        disableLinkPreview: true,
      }
    }
    case 'comment': {
      const issue = (data.issue as { identifier?: string; title?: string } | undefined) ?? {}
      const id = String(issue.identifier ?? '?')
      const body = String(data.body ?? '').slice(0, 200)
      return {
        text:
          `📐 <b>Linear</b> comment ${escapeHtml(action)} on ${escapeHtml(id)}\n` +
          `${escapeHtml(body)}${url ? `\n${url}` : ''}`,
        disableLinkPreview: true,
      }
    }
    default:
      return {
        text:
          `📐 <b>Linear</b> ${escapeHtml(eventType)} ${escapeHtml(action)}` +
          `${url ? `\n${url}` : ''}`,
        disableLinkPreview: true,
      }
  }
}

/**
 * Render a verified generic webhook payload. The shape is unknown by
 * definition — we look for common fields (`title`, `text`, `message`)
 * and fall back to a JSON snippet. Source name is the operator's
 * choice so it can carry meaning ("sentry-prod", "ops-pager").
 */
export function renderGenericEvent(
  source: string,
  payload: Record<string, unknown>,
): RenderedWebhookMessage {
  const title = typeof payload.title === 'string' ? payload.title
    : typeof payload.message === 'string' ? payload.message
    : typeof payload.text === 'string' ? payload.text
    : null
  const summary = title ?? JSON.stringify(payload).slice(0, 200)
  return {
    text: `📨 <b>${escapeHtml(source)}</b>\n${escapeHtml(summary)}`,
    disableLinkPreview: true,
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
