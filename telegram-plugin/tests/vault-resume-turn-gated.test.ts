/**
 * Regression guard — vault/secret RESUME synthetics are turn-gated
 * (the clerk `hotdoc/credentials` mid-turn-strand, 2026-06-14).
 *
 * THE BUG: when an operator approved a vault grant (or provided a
 * secret, or completed a save) WHILE the agent's grant-requesting turn
 * was still finishing, the gateway did a raw `ipcServer.sendToAgent` of
 * the resume synthetic. The socket write succeeded (`delivered=true`)
 * but claude was mid-turn, so the channel notification was typed into
 * its TUI composer and stranded by the turn-completion race (#1556).
 * The pending-inbound buffer never rescued it (it only catches
 * `delivered=false`), so the agent sat idle until the operator manually
 * poked it.
 *
 * Live proof (clerk, 2026-06-13 22:10:57):
 *   22:10:57.098  vault_grant_approved injection delivered=true
 *   22:10:57.277  turn_end #14081 finalAnswer=true   (still mid-turn!)
 *   22:12:57.713  inbound msg=14085 → turnStart       (operator poke, 2m later)
 *
 * THE FIX: every resume synthetic goes through
 * `deliverResumeSyntheticOrBuffer`, which consults the SAME
 * `decideInboundDelivery` gate the Telegram handleInbound path uses —
 * mid-turn → `buffer-until-idle` (flushed cleanly at turn-end). This
 * file pins (a) the gate decision for a resume synthetic's
 * shape, and (b) that no resume callsite regressed to a raw
 * `ipcServer.sendToAgent`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decideInboundDelivery } from "../gateway/inbound-delivery-gate.js";

const gatewaySrc = readFileSync(
  resolve(__dirname, "..", "gateway", "gateway.ts"),
  "utf-8",
);

describe("resume synthetics use the turn-gate (mid-turn → buffer)", () => {
  it("a resume synthetic's gate shape buffers mid-turn, delivers when idle", () => {
    // A resume synthetic is never steering and never an interrupt — the
    // exact inputs deliverResumeSyntheticOrBuffer passes to the gate.
    const shape = { isSteering: false as const, isInterrupt: false as const };
    expect(decideInboundDelivery({ ...shape, turnInFlight: true })).toBe(
      "buffer-until-idle",
    );
    expect(decideInboundDelivery({ ...shape, turnInFlight: false })).toBe(
      "deliver",
    );
  });

  it("the helper exists and gates on decideInboundDelivery before sending", () => {
    const start = gatewaySrc.indexOf(
      "function deliverResumeSyntheticOrBuffer",
    );
    expect(start, "deliverResumeSyntheticOrBuffer helper missing").toBeGreaterThan(0);
    const body = gatewaySrc.slice(start, start + 900);
    // Gate consulted...
    expect(body).toMatch(/decideInboundDelivery\(/);
    // ...and the buffer-until-idle branch buffers BEFORE any send.
    const gateIdx = body.indexOf("decideInboundDelivery(");
    const bufferIdx = body.indexOf("pendingInboundBuffer.push(");
    const sendIdx = body.indexOf("ipcServer.sendToAgent(");
    expect(gateIdx).toBeGreaterThan(0);
    expect(bufferIdx, "must buffer in the helper").toBeGreaterThan(gateIdx);
    expect(sendIdx, "must still deliver in the idle branch").toBeGreaterThan(gateIdx);
    expect(bufferIdx, "buffer-until-idle branch precedes the send branch").toBeLessThan(sendIdx);
  });

  it("no resume synthetic is sent via a raw ungated ipcServer.sendToAgent", () => {
    // Every *_approved/_denied, secret_provided/_declined,
    // vault_save_completed/_failed/_discarded resume must route through
    // the helper. A raw sendToAgent of one of these named inbound vars
    // would reintroduce the mid-turn strand. The ONLY ipcServer.sendToAgent
    // referencing these synthetics should be inside the helper itself
    // (which sends a generic `synthetic` param), so none of the named
    // resume vars may appear as a raw sendToAgent argument.
    const rawResumeSends = [
      ...gatewaySrc.matchAll(
        /ipcServer\.sendToAgent\([^,]+,\s*(denyInbound|discardInbound|failInbound|okInbound)\)/g,
      ),
    ];
    expect(
      rawResumeSends.map((m) => m[1]),
      "resume synthetic sent via raw sendToAgent — must use deliverResumeSyntheticOrBuffer",
    ).toEqual([]);
  });
});
