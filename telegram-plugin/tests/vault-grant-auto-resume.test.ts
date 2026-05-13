/**
 * Contract pin for #1052 — agent auto-resumes after operator approves
 * a vault_request_access card.
 *
 * Pre-fix: agent called vault_request_access → tool returned ack →
 * agent's turn ended ("waiting for approval"). Operator approved later
 * → grant minted → BUT the agent did nothing because its turn was
 * already over. Operator had to send a fresh message to kick the
 * agent back into action.
 *
 * Fix: after successful mint (via passphrase-attestation broker call
 * + token-write), the gateway injects a synthetic InboundMessage into
 * the agent's bridge via `ipcServer.sendToAgent`. The bridge sees it
 * as a normal channel event (with meta.source="vault_grant_approved"
 * for distinct rendering) and starts a new turn. Re-uses the existing
 * inject_inbound primitive that cron has used since #890+.
 *
 * This file pins the call site so a future refactor can't quietly
 * drop the injection.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const gatewaySrc = readFileSync(
  resolve(__dirname, "..", "gateway", "gateway.ts"),
  "utf-8",
);

function extractPerformBlock(): string {
  const start = gatewaySrc.indexOf("async function performVaultAccessApproval");
  if (start < 0) throw new Error("performVaultAccessApproval not found");
  const restAfter = gatewaySrc.slice(start + 1);
  const endRel = restAfter.indexOf("\nasync function ");
  return gatewaySrc.slice(start, start + 1 + (endRel >= 0 ? endRel : restAfter.length));
}

describe("performVaultAccessApproval injects a synthetic inbound on success (#1052)", () => {
  const block = extractPerformBlock();

  it("calls ipcServer.sendToAgent AFTER successful mint + token-write", () => {
    // fails when: the auto-resume injection gets dropped. Pre-fix
    // operator had to message the agent again to resume the task —
    // the injection is the load-bearing wiring.
    expect(block, "missing ipcServer.sendToAgent call").toMatch(/ipcServer\.sendToAgent\(/);
    // Must run AFTER the mint-success path (i.e., after the
    // `result.kind === 'error'` early-return guard).
    const errorReturn = block.indexOf("result.kind === 'error'");
    const sendIdx = block.indexOf("ipcServer.sendToAgent(");
    expect(errorReturn).toBeGreaterThan(0);
    expect(sendIdx, "sendToAgent must come AFTER the error-return early exit").toBeGreaterThan(errorReturn);
  });

  it("delegates inbound construction to buildVaultGrantApprovedInbound", () => {
    // PR #1168 extracted the InboundMessage literals (meta.source,
    // user, userId, meta.{agent,key,scope,grant_id,stage_id,operator_id})
    // into `gateway/vault-grant-inbound-builders.ts`. The shape itself
    // is now pinned by `vault-grant-inbound-builders.test.ts` against
    // the builder directly. What this test still pins is the call-site
    // contract: `performVaultAccessApproval` must keep wiring to the
    // builder — a regression that inlines or replaces the builder
    // would silently drop the meta fields downstream filters rely on.
    expect(block).toMatch(/buildVaultGrantApprovedInbound\(/);
  });

  it("logs delivery outcome to stderr for forensics", () => {
    // Mirrors the cron inject_inbound logging at gateway.ts:2470 so
    // ops can confirm an injection actually delivered (vs the agent's
    // bridge being down).
    expect(block).toMatch(/vault_grant_approved injection[\s\S]*delivered/);
  });
});
