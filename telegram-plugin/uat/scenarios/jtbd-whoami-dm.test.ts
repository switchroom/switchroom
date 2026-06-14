/**
 * UAT — `/whoami` (#2341): the operator's read-only view of THIS
 * agent's sandbox (same data the agent's `config whoami` MCP tool and
 * the `switchroom config whoami` host CLI report). Read-only, like
 * `/version`; mutates nothing.
 *
 * Verified live on test-harness v0.15.21. Self-skips green on an
 * unwired host.
 */
import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const AGENT = "test-harness";

describe("uat: /whoami shows the agent sandbox card", () => {
  it(
    "renders tier, model, tools, MCP, and powers",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        await sc.sendDM("/whoami");
        // Header: "👤 <agent> · <tier>"
        const reply = await sc.expectMessage(/👤\s*test-harness/i, {
          from: "bot",
          timeout: 30_000,
        });
        // The card's load-bearing fields — proves whoami resolved the
        // sandbox (tier/model/tools/mcp/powers), not just echoed a stub.
        expect(reply.text).toMatch(/Model:/i);
        expect(reply.text).toMatch(/Tools:/i);
        expect(reply.text).toMatch(/Powers:/i);
        // Tier marker present in the header (standard / admin / root).
        expect(reply.text).toMatch(/·\s*(standard|admin|root)/i);
      } finally {
        await sc.tearDown();
      }
    },
    60_000,
  );
});
