/**
 * TDD-RED-first contract for the silent-delete-failure class the
 * operator reported on 2026-05-12.
 *
 * Symptom: "🔒 captured a secret. we deleted it from chat" lands as
 * a reply, but the raw secret-bearing message remains visible in
 * chat history. The operator only finds out by scrolling, after
 * the secret has already been screen-shot / cached / synced to
 * other devices.
 *
 * Root cause: every secret-detect call site that invokes
 * `bot.api.deleteMessage(chat_id, msgId)` does it via a raw
 * `try { … } catch { … }` block that silently swallows the error
 * (or, at best, logs to stderr — invisible to the operator). The
 * gateway already has a `deleteSensitiveMessage(chat_id, msgId,
 * reason)` helper that does the right thing — try delete, surface
 * loudly on failure with an in-chat warning naming the message id
 * the operator must delete manually. The four secret-detect sites
 * weren't migrated when that helper was added (#44).
 *
 * The fix is mechanical: replace each `try { bot.api.deleteMessage
 * } catch { }` in the secret-detect path with
 * `deleteSensitiveMessage`. That's what this test pins.
 *
 * Failing means: at least one secret-detect path still has a raw
 * `bot.api.deleteMessage` call wrapped in a swallow-catch — a
 * regression of the silent-failure bug.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const gatewaySrc = readFileSync(
  resolve(__dirname, "..", "gateway", "gateway.ts"),
  "utf-8",
);

/** Slice the gateway source between two anchor strings. */
function sliceBetween(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  if (start < 0) return "";
  const end = src.indexOf(to, start);
  return src.slice(start, end > 0 ? end : src.length);
}

describe("secret-detect — delete failures must NOT be silently swallowed (2026-05-12)", () => {
  // The secret-detect block lives inside `handleInbound`. It runs
  // through several branches:
  //   - passphrase cached + high-confidence hit (stored path)
  //   - passphrase cached + Channel-B auth-flow fallback
  //   - no-passphrase deferred path
  //   - pipeline-error fail-closed path
  //
  // Each branch deletes the raw message. None of them may use the
  // raw `bot.api.deleteMessage` pattern wrapped in a swallow-catch
  // — they must all route through `deleteSensitiveMessage` which
  // surfaces failures via stderr + in-chat warning.

  const secretDetectBlock = sliceBetween(
    gatewaySrc,
    "FAIL-CLOSED: if the pipeline throws",
    "Status reaction controller",
  );

  it("the secret-detect block exists and is non-trivial (anchor sanity)", () => {
    // fails when: the anchors above are renamed/moved. If this fails,
    // update the anchors AND audit the other assertions in this file
    // to make sure they still target the secret-detect path.
    expect(secretDetectBlock.length).toBeGreaterThan(500);
  });

  it("no raw `bot.api.deleteMessage` calls inside the secret-detect block", () => {
    // fails when: a code site reverts to the raw API call (which
    // swallows on failure). All deletes here MUST route through the
    // shared helper.
    expect(secretDetectBlock).not.toMatch(/bot\.api\.deleteMessage/);
  });

  it("every delete in the secret-detect block goes through deleteSensitiveMessage", () => {
    // The block currently performs deletes for four distinct cases
    // (stored / auth-flow-fallback / deferred / pipeline-error). All
    // four MUST land here.
    //
    // fails when: a refactor extracts one of the branches into a
    // helper that doesn't use deleteSensitiveMessage, OR when a new
    // branch is added without the helper. Either way the contract
    // breaks.
    const callMatches = secretDetectBlock.match(/deleteSensitiveMessage\s*\(/g) ?? [];
    expect(
      callMatches.length,
      `expected ≥3 deleteSensitiveMessage calls inside the secret-detect block; got ${callMatches.length}`,
    ).toBeGreaterThanOrEqual(3);
  });

  it("no swallow-catch pattern around delete calls in the secret-detect block", () => {
    // The legacy pattern: `try { await bot.api.deleteMessage(...) } catch {}`
    // OR `try { ... } catch { /* swallow */ }`. The helper handles
    // failure surfacing, so call sites should NOT wrap the helper
    // in another silencing catch.
    //
    // fails when: a refactor wraps the helper call in `try { ... } catch {}`
    // for "robustness" — which would re-introduce the silent-failure
    // class this PR exists to close.
    expect(secretDetectBlock).not.toMatch(/try\s*\{[^}]*deleteSensitiveMessage[^}]*\}\s*catch\s*\{\s*\}/s);
    // Also forbid the raw `try { bot.api.deleteMessage ... } catch {}` shape.
    expect(secretDetectBlock).not.toMatch(/try\s*\{[^}]*bot\.api\.deleteMessage[^}]*\}\s*catch/s);
  });
});

describe("secret-detect — deleteSensitiveMessage helper retains its 'surface failures' contract", () => {
  // The fix only works if the helper itself surfaces failures.
  // Pin the helper's load-bearing behavior so a future refactor
  // can't quietly turn it into a silent-catch.
  const helperBody = sliceBetween(
    gatewaySrc,
    "async function deleteSensitiveMessage",
    "function getCommandArgs",
  );

  it("helper logs to stderr on delete failure", () => {
    expect(helperBody).toMatch(/process\.stderr\.write/);
    expect(helperBody).toMatch(/SECURITY:.*FAILED/);
  });

  it("helper posts an in-chat warning naming the leaked message id", () => {
    // The warning is the only signal a mobile-only operator gets —
    // stderr is invisible to them. Pinning the in-chat surface as
    // the load-bearing piece. Post-#2669 the warning ships via the
    // rich-message path (sendRichMessage).
    expect(helperBody).toMatch(/sendRichMessage|sendMessage/);
    expect(helperBody).toMatch(/delete message.*manually|delete it manually|manually/i);
  });
});
