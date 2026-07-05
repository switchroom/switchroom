/**
 * Sparse chat-legible memory (#2849, hindsight Phase 4) — DM UAT.
 *
 * Serves the `remember-across-sessions` job. When the interactive session
 * stores a new standing directive, ONE terse line must surface in the
 * originating chat: `📌 remembered: "<directive>"`. It's a REAL message
 * (sendMessage, not a draft/reaction) so mtcute can observe it. The line
 * is sparse + material-only — ordinary recall never surfaces one — and is
 * ON by default (kill-switch SWITCHROOM_MEMORY_LEGIBILITY=0).
 *
 * This scenario asks the agent to persist an explicit standing rule via
 * the create_directive tool, then asserts the 📌 remembered line appears
 * from the bot in the DM.
 *
 * Note: the model must actually call `mcp__hindsight__create_directive`.
 * The prompt names the tool + the rule verbatim to make the tool call
 * deterministic. Requires the test-harness agent running an image that
 * includes #2849.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const REMEMBER_PROMPT =
  `Persist this as a standing directive using the ` +
  `mcp__hindsight__create_directive tool, with the directive content set ` +
  `to exactly: "Always greet me as Captain at the start of a reply". ` +
  `Name the directive "greeting-captain". After creating it, send a brief ` +
  `one-line confirmation.`;

// The legibility line: `📌 remembered: "<directive body, truncated>"`.
const REMEMBERED_RE = /📌\s*remembered/i;

describe("uat: sparse chat-legible memory — remembered line (#2849)", () => {
  it(
    "surfaces a 📌 remembered line in the DM when a directive is created",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        await sc.sendDM(REMEMBER_PROMPT);

        // The 📌 remembered line — a real bot message in this DM. May arrive
        // alongside/near the agent's confirmation reply; generous budget for
        // the tool round-trip + transcript flush.
        const line = await sc.expectMessage(REMEMBERED_RE, {
          from: "bot",
          timeout: 90_000,
        });
        console.log(
          `[memory-legibility UAT] remembered line (id=${line.messageId}): ${JSON.stringify(line.text)}`,
        );
        expect(line.messageId).toBeGreaterThan(0);
        // The directive body should ride along in the line.
        expect(line.text).toMatch(/Captain/i);
      } finally {
        await sc.tearDown();
      }
    },
    180_000,
  );
});
