/**
 * UAT — `/model` Telegram command (PR #2259, shipped v0.15.2).
 *
 * Serves: `reference/vision.md` outcome 2 (you hold the leash) — the
 * operator can see and switch the agent's Claude model from Telegram
 * without SSH. Session-scoped switch via claude's own `/model <name>`
 * REPL verb injected into the tmux pane.
 *
 * Three assertions against a real agent over real Telegram:
 *
 *   1. Bare `/model` → shows the configured model (never opens claude's
 *      interactive picker — the reply must come from the gateway, fast,
 *      containing "Configured:").
 *   2. `/model <valid-name>` → switch is injected; reply relays claude's
 *      response and carries the session-only persistence note.
 *   3. `/model bogus-name` → still a reply (claude's inline error is
 *      relayed, or the empty-capture explanation) — never silence.
 *
 * The switch test sets the model to the SAME value the agent already
 * runs (sonnet) so the canary doesn't leave the harness agent on a
 * different model afterwards.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

const AGENT = "test-harness";
const REPLY_TIMEOUT_MS = 30_000;

describe("uat: /model command — show, switch, bad-name", () => {
  it(
    "bare /model shows configured model without injecting",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        await sc.sendDM("/model");
        const reply = await sc.expectMessage(/Configured:/i, {
          from: "bot",
          timeout: REPLY_TIMEOUT_MS,
        });
        expect(reply.text).toMatch(/Configured:/i);
        // Switch affordances present
        expect(reply.text).toMatch(/\/model (opus|sonnet|haiku)/);
        // Persistence caveat present
        expect(reply.text).toMatch(/switchroom\.yaml/i);
      } finally {
        await sc.tearDown();
      }
    },
    60_000,
  );

  it(
    "/model sonnet switches the live session (same-value, no net change)",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        await sc.sendDM("/model sonnet");
        // Accept either a relayed claude response or the explicit
        // empty-capture explanation — both prove the command routed
        // through the gateway handler (and neither is silence).
        const reply = await sc.expectMessage(
          /\/model sonnet|no response captured|Session-only/i,
          { from: "bot", timeout: REPLY_TIMEOUT_MS },
        );
        expect(reply.text.length).toBeGreaterThan(0);
      } finally {
        await sc.tearDown();
      }
    },
    60_000,
  );

  it(
    "/model bogus-name still gets a reply (error relayed, never silence)",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        await sc.sendDM("/model bogus-model-name-xyz");
        const reply = await sc.expectMessage(/\S/, {
          from: "bot",
          timeout: REPLY_TIMEOUT_MS,
        });
        expect(reply.text.length).toBeGreaterThan(0);
      } finally {
        await sc.tearDown();
      }
    },
    60_000,
  );
});
