// Wiring for the Bot API 10.1 rich renderer (parse.ts + render.ts) into the
// live outbound send path.
//
// The renderer (`render/render.ts`, PR #2930) and parser (`render/parse.ts`)
// have full unit coverage but were, until this module, wired into NOTHING —
// no outbound message ever flowed through them. This module is the single
// bridge: the gateway's rich send path (stream-controller.ts) runs the
// assistant's raw markdown through `parse → renderSafe` before it reaches
// `sendRichMessage`, unless the escape hatch below disables it.
//
// Escape hatch — `SWITCHROOM_RICH_RENDER`, default ON:
//   ON BY DEFAULT in every install — an escape hatch, not an opt-in feature,
//   mirroring the send gate's convention (`sendGateEnabledFromEnv` in
//   `send-gate.ts`, default-on since #3153; also `midTurnFloorEnabled`,
//   `SWITCHROOM_RATE_LIMIT_OVERAGE=0`). Enabled unless the var is explicitly
//   set to a falsey/off value (`0`/`false`/`off`/`no`, case-insensitive,
//   trimmed) — per agent via the `env:` block in `switchroom.yaml`
//   (propagated into the container `environment:` by
//   `src/agents/compose.ts`). When disabled, `maybeRenderOutbound` returns
//   the input untouched, so the live send path is byte-for-byte the
//   pre-renderer behaviour (raw transcript markdown to `sendRichMessage`).
//
// Why route through `renderSafe` and not bare `render`:
//   `renderSafe` guarantees the returned body is never a rich-markdown string
//   with a mid-construct cut, and degrades a document it can't safely fit to
//   plain-text mode (structure stripped, content preserved). The send path
//   honours that `mode` — a `plain` result is sent WITHOUT the rich wrapper.

import { parse } from "./parse.js";
import { renderSafe, type RenderResult } from "./render.js";
import { RICH_MESSAGE_MAX_CHARS, splitMarkdownChunks } from "../format.js";

/**
 * The legacy plain-text `sendMessage` / `editMessageText` wire cap (4096
 * UTF-16 units). It does NOT apply to the rich path (`sendRichMessage`, up
 * to `RICH_MESSAGE_MAX_CHARS`), but it DOES apply the moment `renderSafe`
 * degrades a body to `mode: "plain"` — the send path then routes it through
 * the plain `sendMessage` endpoint (see stream-controller `doSend`/`doEdit`).
 * A degraded plain body larger than this is rejected by Telegram with
 * `message is too long`, so `renderOutboundChunks` caps plain pieces here.
 */
export const PLAIN_TEXT_MAX_CHARS = 4096;

/** Parse the `SWITCHROOM_RICH_RENDER` kill-switch value. Default ON; disabled
 *  only by an explicit falsey/off token (`0`/`false`/`off`/`no`,
 *  case-insensitive, trimmed) — the same disable vocabulary as
 *  `sendGateEnabledFromEnv`. Unset, empty, or unrecognised values → ON. Pure
 *  so the default + parsing are unit-testable. */
export function parseRichRenderEnabled(raw: string | undefined): boolean {
  if (raw == null) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/** Is the rich renderer enabled in this process? Reads the env flag live so a
 *  test can set/unset it per-case; defaults ON (escape hatch, not opt-in). */
export function richRenderEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseRichRenderEnabled(env.SWITCHROOM_RICH_RENDER);
}

/** Unconditionally run `text` through `parse → renderSafe` (ignores the flag).
 *  Exposed for tests and callers that have already gated on the flag. */
export function renderOutbound(
  text: string,
  maxLen: number = RICH_MESSAGE_MAX_CHARS,
): RenderResult {
  return renderSafe(parse(text), text, maxLen);
  // #3252 note: the `$…$` currency-math neutraliser (`guardDollarMath`) is NOT
  // applied here. It lives at the single wire seam — `richMessage()` in
  // rich-send.ts — through which EVERY `{ markdown }` send funnels (the
  // reply-tool final answer, the draft-stream previews this renderer feeds,
  // cards, approvals). Applying it there guards every markdown-parsed outbound
  // exactly once (F1), and `plain`-mode degradations correctly bypass it. See
  // dollar-math-guard.ts for the rationale.
}

/**
 * Kill-switch-gated transform for the live send path.
 *
 *   - enabled (default): returns `parse → renderSafe` output. `mode: "plain"`
 *     signals the caller to send WITHOUT the rich wrapper (oversized/unsafe
 *     content).
 *   - disabled (`SWITCHROOM_RICH_RENDER=0`): returns the input untouched,
 *     `mode: "markdown"` — identical to the pre-renderer behaviour (raw
 *     transcript markdown sent straight to `sendRichMessage`).
 */
export function maybeRenderOutbound(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  maxLen: number = RICH_MESSAGE_MAX_CHARS,
): RenderResult {
  if (!richRenderEnabled(env)) return { text, mode: "markdown", degradations: [] };
  return renderOutbound(text, maxLen);
}

/**
 * Kill-switch-gated, CAP-ENFORCING transform for the live send path.
 *
 * `maybeRenderOutbound` returns ONE `RenderResult` and can only ever fit a
 * body into a single wire message. But `renderSafe`'s markdown re-escaping
 * (GFM-special chars gain a leading `\`) GROWS a chunk: a raw body sized just
 * under `maxLen` can escape PAST it. `renderSafe` handles that by degrading
 * the WHOLE document to `mode: "plain"` (raw source, no rich wrapper) — it
 * never re-splits a multi-block body. The send path then ships that plain
 * body through the 4096-capped `sendMessage` endpoint, so a ~32k plain body
 * is rejected by Telegram (`message is too long`) and the answer is dropped.
 *
 * This function closes that gap: it returns an ARRAY of pieces, EACH of which
 * is guaranteed to fit its own wire cap —
 *   - a `markdown` piece is `<= maxLen` (`renderSafe`'s own guarantee), and
 *   - a `plain` piece is `<= PLAIN_TEXT_MAX_CHARS` (the plain endpoint's cap).
 * Pieces are cut only at `splitMarkdownChunks`' safe boundaries, so a fenced
 * code block or a table row is NEVER bisected. Re-splitting the RAW source and
 * re-rendering each piece also RECOVERS rich formatting the whole-document
 * plain degradation would have thrown away: the smaller pieces individually
 * escape under `maxLen` and come back as `markdown`.
 *
 *   - disabled (`SWITCHROOM_RICH_RENDER=0`):
 *     `[{ text, mode: "markdown", degradations: [] }]` — a single passthrough
 *     piece, identical to `maybeRenderOutbound`.
 *   - enabled (default), body fits: `[renderSafe(...)]` — a single piece,
 *     identical to `maybeRenderOutbound` (byte-for-byte for the common case).
 *   - enabled (default), body oversize: 2+ cap-respecting pieces in send
 *     order.
 */
export function renderOutboundChunks(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  maxLen: number = RICH_MESSAGE_MAX_CHARS,
  plainMax: number = PLAIN_TEXT_MAX_CHARS,
): RenderResult[] {
  if (!richRenderEnabled(env)) {
    return [{ text, mode: "markdown", degradations: [] }];
  }

  const whole = renderOutbound(text, maxLen);
  // `markdown` mode from renderSafe is already `<= maxLen`; a `plain` result
  // that fits the plain cap is a single deliverable piece too. Common case.
  if (whole.mode === "markdown" && whole.text.length <= maxLen) return [whole];
  if (whole.mode === "plain" && whole.text.length <= plainMax) return [whole];

  // Oversize: re-split the RAW source at safe boundaries and re-render each
  // piece. Each sub-piece is `<= maxLen` in raw form, so it usually escapes
  // back under `maxLen` and renders as rich markdown; a piece whose escaped
  // form STILL overflows (or an indivisible plain blob) is emitted as plain,
  // further split to `plainMax` so it fits the plain endpoint.
  const out: RenderResult[] = [];
  for (const rawPiece of splitMarkdownChunks(text, maxLen)) {
    const rendered = renderOutbound(rawPiece, maxLen);
    if (rendered.mode === "markdown" && rendered.text.length <= maxLen) {
      out.push(rendered);
      continue;
    }
    // Plain piece — cap at the plain-endpoint limit. `renderSafe` returned the
    // raw source for a plain result, so split that source (safe boundaries,
    // never bisecting a fence/table) into `<= plainMax` slices.
    for (const plainPiece of splitMarkdownChunks(rendered.text, plainMax)) {
      out.push({ text: plainPiece, mode: "plain", degradations: rendered.degradations });
    }
  }
  // Defensive: a degenerate input that split to nothing still yields one piece.
  return out.length > 0 ? out : [whole];
}
