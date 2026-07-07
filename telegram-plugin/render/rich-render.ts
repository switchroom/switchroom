// Flag-gated wiring for the Bot API 10.1 rich renderer (parse.ts + render.ts)
// into the live outbound send path.
//
// The renderer (`render/render.ts`, PR #2930) and parser (`render/parse.ts`)
// have full unit coverage but were, until this module, wired into NOTHING —
// no outbound message ever flowed through them. This module is the single,
// feature-flagged bridge: the gateway's rich send path (stream-controller.ts)
// runs the assistant's raw markdown through `parse → renderSafe` before it
// reaches `sendRichMessage`, but ONLY when the flag is on.
//
// Feature flag — `SWITCHROOM_RICH_RENDER`, default OFF:
//   Mirrors the `SWITCHROOM_VISIBLE_ANSWER_STREAM` convention
//   (`answer-stream-flag.ts`): an env var read at runtime, default off, opted
//   in PER AGENT via the `env:` block in `switchroom.yaml` (propagated into
//   the container `environment:` by `src/agents/compose.ts`). When off,
//   `maybeRenderOutbound` returns the input untouched, so the live send path
//   is byte-for-byte unchanged — no agent's behaviour moves until an operator
//   explicitly flips the flag for a specific agent. Accepts `1/true/on/yes`.
//
// Why route through `renderSafe` and not bare `render`:
//   `renderSafe` guarantees the returned body is never a rich-markdown string
//   with a mid-construct cut, and degrades a document it can't safely fit to
//   plain-text mode (structure stripped, content preserved). The send path
//   honours that `mode` — a `plain` result is sent WITHOUT the rich wrapper.

import { parse } from "./parse.js";
import { renderSafe, type RenderResult } from "./render.js";
import { RICH_MESSAGE_MAX_CHARS } from "../format.js";

/** Parse the `SWITCHROOM_RICH_RENDER` flag value. Default OFF; accepts the
 *  same truthy tokens as the other switchroom env flags. Pure so the default
 *  + parsing are unit-testable. */
export function parseRichRenderEnabled(raw: string | undefined): boolean {
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** Is the rich renderer enabled in this process? Reads the env flag live so a
 *  test can set/unset it per-case; defaults OFF. */
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
}

/**
 * Flag-gated transform for the live send path.
 *
 *   - flag OFF (default): returns the input untouched, `mode: "markdown"` —
 *     identical to the pre-existing behaviour (raw transcript markdown sent
 *     straight to `sendRichMessage`). No behavioural change for any agent.
 *   - flag ON: returns `parse → renderSafe` output. `mode: "plain"` signals
 *     the caller to send WITHOUT the rich wrapper (oversized/unsafe content).
 */
export function maybeRenderOutbound(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  maxLen: number = RICH_MESSAGE_MAX_CHARS,
): RenderResult {
  if (!richRenderEnabled(env)) return { text, mode: "markdown" };
  return renderOutbound(text, maxLen);
}
