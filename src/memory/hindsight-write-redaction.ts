/**
 * Secret redaction for Hindsight memory WRITES issued from TypeScript.
 *
 * ## Why this module exists
 *
 * Credentials that land in a memory bank are effectively permanent: rows are
 * recalled into future sessions, summarized into mental models, and mirrored
 * into consolidations, so a secret written once keeps resurfacing long after
 * it is rotated. The cheapest place to stop that is intake.
 *
 * The Python plugin has its own chokepoint (`lib/client.py` —
 * `HindsightClient.retain()` plus a `_request()` backstop) and the MCP surface
 * has one in `src/cli/hindsight-mcp-shim.ts` (`toolsCall`). This module is the
 * third and last one: the handful of places in this repo that POST
 * `.../memories` over plain `fetch`, bypassing both.
 *
 * ## Mechanical enforcement, not callsite discipline
 *
 * `scripts/check-hindsight-write-redaction.ts` (wired into `bun lint`) scans
 * `src/` for any file containing a `/memories` write URL and fails unless that
 * file imports {@link redactMemoryWriteBody}. So a NEW direct write path added
 * later breaks lint until it is redacted, rather than silently leaking. That
 * is a guard, not a proof — a caller could import the helper and not call it —
 * but it removes the failure mode that actually happens (someone copies an
 * existing fetch block and never thinks about secrets).
 *
 * ## What is masked
 *
 * Only the free-text fields of each item: `content`, `context`, and every
 * string leaf of `metadata`. Structural fields (`document_id`, `tags`,
 * `observation_scopes`, `async`) are left byte-identical, because they are
 * matched on by reconciliation and watermark logic and a mask there would
 * change behaviour, not just text.
 *
 * A memory whose content redacts to nothing but markers is still POSTed. The
 * alternative — dropping the write — would silently break the durability
 * contract callers rely on (watermark advance), and "a row
 * that says a secret was here" is more useful than a missing row.
 */

import { redact } from "../secret-detect/redact.js";

/** Recursively mask secrets in the string leaves of a JSON value. */
export function redactJsonStrings(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactJsonStrings);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Keys are structural and are never rewritten.
      out[k] = redactJsonStrings(v);
    }
    return out;
  }
  return value;
}

/** Free-text fields of a memory item. Everything else is structural. */
const REDACTED_ITEM_FIELDS = ["content", "context"] as const;

/**
 * Return a copy of a `POST .../memories` request body with credentials
 * masked out of every item's free-text fields.
 *
 * Shape-tolerant on purpose: a body without `items`, or an item that is not
 * an object, is returned unchanged rather than throwing — this sits on a
 * write path where a crash is worse than a pass-through, and the request would
 * be rejected upstream anyway.
 */
export function redactMemoryWriteBody<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const src = body as Record<string, unknown>;
  if (!Array.isArray(src.items)) return body;
  const items = src.items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const row = { ...(item as Record<string, unknown>) };
    for (const field of REDACTED_ITEM_FIELDS) {
      if (typeof row[field] === "string") {
        row[field] = redact(row[field] as string);
      }
    }
    if (row.metadata && typeof row.metadata === "object") {
      row.metadata = redactJsonStrings(row.metadata);
    }
    return row;
  });
  return { ...src, items } as T;
}
