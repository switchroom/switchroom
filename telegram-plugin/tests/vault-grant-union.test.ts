/**
 * Static-source contract pin for the grant-union behavior shipped to
 * fix #1051's silent-token-overwrite bug class.
 *
 * The bug: when an operator approved a vault_request_access card for
 * key A and then later approved a second card for key B, the second
 * mint OVERWROTE the agent's `.vault-token` file with a single-key
 * grant. Both grants existed in the broker DB but the agent could
 * only authenticate against the most-recent one — `vault get keyA`
 * after the second approval returned VAULT-BROKER-DENIED.
 *
 * Fix: before minting, the gateway lists the agent's existing
 * non-expired grants (using the new passphrase-attested list_grants
 * path) and unions their keys with the new key. The fresh grant
 * covers OLD ∪ NEW; the old grant ages out via TTL.
 *
 * This file pins the wiring at the call site so a future refactor
 * can't silently drop the union step.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// #2996 Phase 5: the callback-query handler families moved verbatim to
// gateway/callback-query-handlers.ts; these pins read the gateway source
// COMBINED with that module so the wiring assertions keep covering the
// same runtime source text.
const gatewaySrc =
  readFileSync(resolve(__dirname, "..", "gateway", "gateway.ts"), "utf-8") +
  "\n" +
  readFileSync(resolve(__dirname, "..", "gateway", "callback-query-handlers.ts"), "utf-8") +
  "\n" +
  // P7 PR-8 (#2996): vault pending-op intercept moved to inbound-interceptors.ts.
  readFileSync(resolve(__dirname, "..", "gateway", "inbound-interceptors.ts"), "utf-8");

function extractPerformBlock(): string {
  const start = gatewaySrc.indexOf("async function performVaultAccessApproval");
  if (start < 0) throw new Error("performVaultAccessApproval not found");
  // Bound the block by the next top-level `async function` keyword.
  const restAfter = gatewaySrc.slice(start + 1);
  const endRel = restAfter.indexOf("\nasync function ");
  return gatewaySrc.slice(start, start + 1 + (endRel >= 0 ? endRel : restAfter.length));
}

describe("performVaultAccessApproval unions keys with the agent's existing grant (#1051)", () => {
  const block = extractPerformBlock();

  it("calls listGrantsViaBroker BEFORE mintGrantViaBroker", () => {
    // fails when: a refactor drops the list step. Without it the
    // mint covers only [pending.key] and OVERWRITES the agent's
    // .vault-token, stranding the previous approval's grant from
    // the agent's perspective.
    const listIdx = block.indexOf("listGrantsViaBroker(");
    const mintIdx = block.indexOf("mintGrantViaBroker(");
    expect(listIdx, "listGrantsViaBroker call missing in performVaultAccessApproval").toBeGreaterThan(0);
    expect(mintIdx, "mintGrantViaBroker call missing").toBeGreaterThan(0);
    expect(listIdx, "list MUST happen BEFORE mint").toBeLessThan(mintIdx);
  });

  it("forwards an attestation to listGrantsViaBroker (#1115 follow-up: passphrase OR posture)", () => {
    // The non-admin agent socket needs operator-attestation to call
    // list_grants (#1051's broker-side gate widening). Pre-#1115-
    // follow-up this had to be the operator passphrase. Post-fix the
    // gateway threads either `{ passphrase }` or
    // `{ attest_via_posture: true }` via `brokerAuthOpts`, depending
    // on whether the operator typed the passphrase or the host is
    // running telegram-id posture. The call must forward the auth
    // opts object intact.
    const listMatch = block.match(/listGrantsViaBroker\([^)]+\)/);
    expect(listMatch, "listGrantsViaBroker call shape").not.toBeNull();
    expect(listMatch![0], "attestation MUST be forwarded (brokerAuthOpts)").toMatch(/brokerAuthOpts/);
  });

  it("unions existing key_allow with the new key before minting", () => {
    // Pin the union semantics. The mint call must pass a Set-like
    // union of existing keys + new key, not just [pending.key].
    expect(block).toMatch(/key_allow/);
    expect(block).toMatch(/new Set/);
    // The Set MUST be seeded from the existing grant's keys.
    expect(block).toMatch(/existingReadKeys|active\[0\]/);
  });

  it("includes write_allow union for write-scope requests", () => {
    // Mirror the read-side union for write scope.
    expect(block).toMatch(/write_allow/);
    expect(block).toMatch(/writeKeys\.add|writeKeys\.size/);
  });

  it("concurrent Approve taps queue into a single pending-op (#1051)", () => {
    // Without the queue, a second Approve tap before the operator
    // types their passphrase OVERWRITES the first stage's pending
    // op — the first card's grant never mints. The new shape has
    // `items: [...]` so a second tap APPENDS, and the text-handler
    // drains every queued stage off one passphrase entry.
    //
    // Anchor on the producer site inside handleVaultRequestAccessCallback.
    const callbackHandler =
      gatewaySrc
        .split("async function handleVaultRequestAccessCallback")[1]
        ?.split("\nasync function ")[0] ?? "";
    // The producer reads any existing pending op, and APPENDS to
    // items[] rather than overwriting.
    expect(callbackHandler).toMatch(/pendingVaultOps\.get\(pending\.chat_id\)/);
    // `items` declared (either as `items: [...]` literal or `const items = ...`).
    expect(callbackHandler).toMatch(/\bitems\b/);
    expect(callbackHandler).toMatch(/passphrase-for-access-approve/);

    // The consumer (text-handler) loops over items. Anchor on the
    // unique consumer code (the `else if` branch that handles a
    // passphrase reply), not the type-discriminator string itself —
    // the latter appears in the PendingVaultOp type definition too,
    // so a naive split lands on the wrong slice.
    const textHandlerIdx = gatewaySrc.indexOf("else if (pendingVault.kind === 'passphrase-for-access-approve')");
    expect(textHandlerIdx, "text-handler consumer branch not found").toBeGreaterThan(0);
    const textHandler = gatewaySrc.slice(textHandlerIdx, textHandlerIdx + 3000);
    expect(textHandler, "text-handler MUST iterate items").toMatch(/for\s*\(\s*const\s+item\s+of\s+pendingVault\.items/);
    // Each iteration looks up the staged access (sibling-stage may
    // have been denied / expired between tap and passphrase reply).
    expect(textHandler).toMatch(/pendingVaultRequestAccesses\.get\(item\.stageId\)/);
  });

  it("gracefully proceeds with single-key mint when listGrants fails", () => {
    // Non-blocker: if listGrants returns unreachable/error, the
    // gateway should STILL mint the new grant (without union) so
    // the operator's tap-to-approve doesn't get blocked on a
    // transient broker issue. Documented intent.
    expect(block).toMatch(/list\.kind === 'ok'/);
    // A comment explaining the fallback behavior must be present so
    // a future reader knows the gracefully-degraded path is
    // intentional.
    // The comment is split across multiple // lines, so collapse
    // whitespace + comment prefixes before matching.
    const flattened = block.replace(/\n\s*\/\/\s*/g, " ");
    expect(flattened).toMatch(/(without union|edge case|fall.?back|fail closed|degrade)/i);
  });
});
