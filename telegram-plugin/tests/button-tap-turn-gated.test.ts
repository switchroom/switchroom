/**
 * Regression guard — agent-authored inline-keyboard button taps (`agent:`
 * callback_data) are turn-safe (#271 button path, the mid-turn-strand).
 *
 * THE BUG: the `agent:` callback handler delivered the synthesized tap
 * inbound with a bare `ipcServer.sendToAgent` + busy-mark, and buffered
 * ONLY when the bridge was offline (`delivered=false`). It never ran the
 * #1556 turn gate the normal inbound path uses. So a tap landing WHILE a
 * turn was in flight fired the MCP channel notification mid-turn, the
 * unmodified CLI typed it into its TUI composer, and the auto-submit raced
 * turn-completion — the tap stranded in the composer with nothing to rescue
 * it (the buffer only catches bridge-offline). It also skipped the pre-send
 * composer clear and the deliver-until-acked tracking, so a stranded tap was
 * never sweep-redelivered.
 *
 * THE FIX: the tap routes through `deliverButtonTapInbound`, which consults
 * the SAME turn gate (mid-turn → `buffer-until-idle`, flushed at turn-end),
 * clears the composer before sending, and enrols the delivery in the
 * deliver-until-acked queue so the sweep rescues a strand. Bridge-offline
 * still spools + shows the restart notice (unchanged UX).
 *
 * gateway.ts is a large side-effecting module (top-level `bot.on`, ipc
 * server, timers) that can't be imported into a unit test, so this file
 * pins (a) the gate decision for a button tap's shape via the pure gate, and
 * (b) that the handler + helper wire the turn-safe machinery structurally —
 * exactly the strategy `vault-resume-turn-gated.test.ts` uses for the resume
 * synthetics.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decideInboundDelivery } from "../gateway/inbound-delivery-gate.js";
import { shouldTrackDelivery } from "../gateway/inbound-delivery-confirm.js";
import { planBufferedRedelivery } from "../gateway/pending-inbound-buffer.js";
import type { InboundMessage } from "../gateway/ipc-protocol.js";

const gatewaySrc = readFileSync(
  resolve(__dirname, "..", "gateway", "gateway.ts"),
  "utf-8",
);

describe("agent button taps use the turn-gate (mid-turn → buffer)", () => {
  it("a button tap's gate shape buffers mid-turn, delivers when idle", () => {
    // A button tap is never steering and never an interrupt — the exact
    // inputs deliverButtonTapInbound passes to the gate.
    const shape = { isSteering: false as const, isInterrupt: false as const };
    // Tap lands WHILE a turn is in flight → held until claude goes idle
    // (the mid-turn strand the raw sendToAgent used to cause).
    expect(decideInboundDelivery({ ...shape, turnInFlight: true })).toBe(
      "buffer-until-idle",
    );
    // Tap lands at an idle prompt → delivered immediately.
    expect(decideInboundDelivery({ ...shape, turnInFlight: false })).toBe(
      "deliver",
    );
  });

  it("a button tap is enrolled by shouldTrackDelivery (no source, non-empty body)", () => {
    // The tap inbound carries no meta.source and a non-empty
    // `[user tapped button: …]` body, so it IS tracked — the strand it can
    // suffer must be re-deliverable by the sweep.
    expect(
      shouldTrackDelivery({
        isSteering: false,
        isInterrupt: false,
        hasSource: false,
        effectiveText: "[user tapped button: approve_pr_547]",
      }),
    ).toBe(true);
  });

  describe("deliverButtonTapInbound helper", () => {
    const start = gatewaySrc.indexOf(
      "async function deliverButtonTapInbound",
    );
    // Bound the helper body by the next top-level declaration — it carries the
    // gate, composer-clear, send, tracking, and bridge-offline branches.
    const body = gatewaySrc.slice(
      start,
      gatewaySrc.indexOf("const pendingRestarts", start),
    );

    it("exists and is async (composer-clear await)", () => {
      expect(start, "deliverButtonTapInbound helper missing").toBeGreaterThan(0);
      expect(body).toMatch(
        /async function deliverButtonTapInbound\(\s*agent: string,\s*inbound: InboundMessage,\s*\): Promise<ButtonTapDeliveryOutcome>/,
      );
    });

    it("consults the turn gate BEFORE any send, buffering mid-turn", () => {
      const gateIdx = body.indexOf("reserveInboundDelivery(");
      const bufIdx = body.indexOf("pendingInboundBuffer.push(");
      const sendIdx = body.indexOf("ipcServer.sendToAgent(");
      expect(gateIdx, "gate must be consulted").toBeGreaterThan(0);
      expect(sendIdx, "helper must still deliver in the idle branch").toBeGreaterThan(gateIdx);
      // The buffer-until-idle branch buffers BEFORE the send branch — the tap
      // is never delivered mid-turn.
      expect(bufIdx, "must buffer in the mid-turn branch").toBeGreaterThan(gateIdx);
      expect(bufIdx, "buffer-until-idle precedes the send").toBeLessThan(sendIdx);
      expect(body).toMatch(/decision === 'buffer-until-idle'/);
      expect(body).toMatch(/return 'buffered-mid-turn'/);
    });

    it("clears the composer before the send (the marko wedge)", () => {
      const clearIdx = body.indexOf("clearAgentComposer");
      const sendIdx = body.indexOf("ipcServer.sendToAgent(");
      expect(clearIdx, "must import clearAgentComposer").toBeGreaterThan(0);
      expect(clearIdx, "composer clear precedes the send").toBeLessThan(sendIdx);
    });

    it("tracks the delivery so the deliver-until-acked sweep rescues a strand", () => {
      expect(body).toMatch(/DELIVERY_CONFIRM_ENABLED/);
      expect(body).toMatch(/shouldTrackDelivery\(/);
      expect(body).toMatch(/trackDelivery\(deliveryQueue,/);
    });

    it("buffers + spools on bridge-offline (existing behaviour intact)", () => {
      // The idle-branch send missed → the tap is spooled to the
      // pending-inbound buffer for replay. (#2996 P1: the legacy busy-key
      // reservation/release pair was deleted with the claudeBusyKeys set.)
      expect(body).toMatch(/return 'buffered-bridge-offline'/);
      // The bridge-offline buffer push is the LAST push (after the send miss),
      // so it always spools before returning the offline outcome.
      const offlineIdx = body.indexOf("return 'buffered-bridge-offline'");
      const lastBufIdx = body.lastIndexOf("pendingInboundBuffer.push(");
      expect(lastBufIdx).toBeGreaterThan(0);
      expect(lastBufIdx, "spool precedes the offline return").toBeLessThan(offlineIdx);
    });
  });

  describe("the agent: callback handler routes through the helper", () => {
    // #2996 P6: the agent-callback family moved to
    // agent-button-callback-handler.ts (handleAgentButtonCallback); the
    // structural pins now scrape the extracted module. The injected
    // deliverButtonTapInbound + restarting-notice bindings stay in gateway.ts.
    const moduleSrc = readFileSync(
      resolve(__dirname, "..", "gateway", "agent-button-callback-handler.ts"),
      "utf8",
    );
    it("delivers the tap via deliverButtonTapInbound, not a raw sendToAgent", () => {
      const anchor = moduleSrc.indexOf("const agentCb = parseAgentCallback(data)");
      expect(anchor, "agent-callback handler missing").toBeGreaterThan(0);
      const handler = moduleSrc.slice(anchor);
      // The tap is routed through the turn-safe helper...
      expect(handler).toMatch(/await deps\.deliverButtonTapInbound\(selfAgentBtn, inboundMsg\)/);
      // ...and NOT via a raw ungated sendToAgent of the tap inbound (the
      // regressed path that stranded the tap mid-turn).
      expect(handler).not.toMatch(/ipcServer\.sendToAgent\(selfAgentBtn, inboundMsg\)/);
      // The gateway binding still wires the real helper.
      expect(gatewaySrc).toMatch(/deliverButtonTapInbound,/);
    });

    it("still shows the restart notice only on bridge-offline", () => {
      const handler = moduleSrc;
      // The restart notice is gated on the bridge-offline outcome — a mid-turn
      // buffered tap must NOT nag the user (it will be actioned at idle).
      expect(handler).toMatch(/btnOutcome === 'buffered-bridge-offline'/);
      // The notice text + verb live in the gateway's injected binding.
      expect(gatewaySrc).toMatch(/button-tap-restarting-notice/);
    });

    it("preserves the ack toast and single-use keyboard strip (UX unchanged)", () => {
      const anchor = moduleSrc.indexOf("const agentCb = parseAgentCallback(data)");
      const handler = moduleSrc.slice(anchor);
      // Ack toast fires FIRST (before delivery) so the tap always registers…
      const ackIdx = handler.indexOf("answerCallbackQuery({ text: ackText })");
      const deliverIdx = handler.indexOf("deliverButtonTapInbound(");
      expect(ackIdx, "ack toast must fire").toBeGreaterThan(0);
      expect(ackIdx, "ack toast fires before delivery").toBeLessThan(deliverIdx);
      // …and the single-use keyboard strip still runs after.
      expect(handler).toMatch(/keyboardIsSingleUse\(metaForMessage\)/);
      expect(handler).toMatch(/editMessageReplyMarkup/);
    });
  });

  describe("flush-path anti-storm guard (trackRedeliveredInbound)", () => {
    it("skips tracking an id-less button tap, mirroring the immediate path", () => {
      // The immediate path (deliverButtonTapInbound) refuses to enrol a tap
      // without a real meta.message_id — the `enqueue` ack could never match
      // it, so the never-drop sweep would re-fire until TTL. A tap that
      // buffered mid-turn and flushed through trackRedeliveredInbound must be
      // skipped by the SAME rule, or the storm exists on one path only.
      const start = gatewaySrc.indexOf("function trackRedeliveredInbound");
      expect(start, "trackRedeliveredInbound missing").toBeGreaterThan(0);
      const body = gatewaySrc.slice(
        start,
        gatewaySrc.indexOf("\n}", start) + 2,
      );
      // The guard: button_callback-tagged AND no meta.message_id → return
      // before trackDelivery.
      const guardIdx = body.indexOf("merged.meta?.button_callback === 'true'");
      const trackIdx = body.indexOf("trackDelivery(");
      expect(guardIdx, "button-tap message_id guard missing").toBeGreaterThan(0);
      expect(guardIdx, "guard must precede trackDelivery").toBeLessThan(trackIdx);
      expect(body).toMatch(
        /merged\.meta\.message_id == null \|\| merged\.meta\.message_id === ''/,
      );
    });
  });
});

describe("buffered button taps never merge with adjacent user messages", () => {
  const userMsg = (text: string, ts: number): InboundMessage => ({
    type: "inbound",
    chatId: "c1",
    messageId: ts,
    user: "u",
    userId: 42,
    ts,
    text,
    meta: { chat_id: "c1", user: "u", user_id: "42", ts: String(ts) },
  });
  // A tap inbound as the agent: callback handler builds it — same chat/user
  // as the surrounding texts, no meta.source, button_callback tagged.
  const tapMsg = (raw: string, ts: number): InboundMessage => ({
    type: "inbound",
    chatId: "c1",
    messageId: ts,
    user: "u",
    userId: 42,
    ts,
    text: `[user tapped button: ${raw}]`,
    meta: {
      chat_id: "c1",
      message_id: String(ts),
      user: "u",
      user_id: "42",
      ts: String(ts),
      button_callback: "true",
      button_callback_data: raw,
      button_text: "Approve",
    },
  });

  it("a mid-turn tap buffered between user texts delivers individually", () => {
    // Without the exclusion, the source-less tap merged with the adjacent
    // texts and mergeRun kept only the anchor (last) message's meta —
    // silently dropping button_callback_data/button_text whenever a text was
    // last. The agent then saw the human-readable tap line without the
    // machine-readable payload.
    const plan = planBufferedRedelivery([
      userMsg("first", 1),
      tapMsg("approve_pr_547", 2),
      userMsg("second", 3),
    ]);
    expect(plan.map((p) => p.merged.text)).toEqual([
      "first",
      "[user tapped button: approve_pr_547]",
      "second",
    ]);
    // The tap keeps its full button meta intact.
    const tap = plan[1]!.merged;
    expect(tap.meta.button_callback).toBe("true");
    expect(tap.meta.button_callback_data).toBe("approve_pr_547");
    expect(tap.meta.button_text).toBe("Approve");
  });

  it("a tap followed by a user text does not merge (text-last would drop the payload)", () => {
    const plan = planBufferedRedelivery([
      tapMsg("hold", 1),
      userMsg("also do the thing", 2),
    ]);
    expect(plan).toHaveLength(2);
    expect(plan[0]!.merged.meta.button_callback_data).toBe("hold");
  });

  it("plain user texts still merge around the exclusion (no regression)", () => {
    const plan = planBufferedRedelivery([userMsg("a", 1), userMsg("b", 2)]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.merged.text).toBe("a\nb");
  });
});
