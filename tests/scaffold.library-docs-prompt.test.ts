/**
 * Guards the PROMPT half of the context7 fleet default.
 *
 * Wiring an MCP server is not the same as using it: webkite shipped to
 * every agent and sat at near-zero calls because nothing in the system
 * prompt named a trigger condition. So the capability's contract here is
 * two-sided — the server in `.mcp.json` (covered by
 * `scaffold.test.ts` / `scaffold.integration-registry.test.ts`) AND the
 * guidance block in `~/.switchroom/fleet/switchroom-invariants.md`,
 * which is the file every agent reads via `--add-dir`. If the guidance
 * silently drops out, the change reverts to "provisioned and unused"
 * with no other visible symptom — which is exactly what this file
 * exists to catch.
 */

import { describe, expect, it } from "vitest";

import { renderFleetInvariants } from "../src/agents/scaffold.js";

describe("fleet invariants — library-docs (context7) guidance", () => {
  it("renders the library-docs block", () => {
    const out = renderFleetInvariants();
    expect(out).toContain(
      "## Library and framework docs — look them up, don't recall them",
    );
  });

  it("does NOT duplicate the trigger/negative-scope text the server already ships", () => {
    // Verified against the live server on 2026-07-26: context7's MCP
    // `initialize` response carries an `instructions` field that already
    // states the trigger ("even when you think you know the answer"),
    // the negative scope (refactoring / business logic / code review /
    // general concepts) and the prefer-over-web-search rule. Claude Code
    // delivers a server's `instructions` even when its TOOLS are
    // tool-search-deferred — confirmed in-fleet: `webkite` and
    // `perplexity` carry no `alwaysLoad` under ENABLE_TOOL_SEARCH=true
    // and both servers' instructions still appear in the running agent's
    // system prompt. So restating any of it here is prompt-prefix cost
    // for zero information, on every agent, every turn. This test is the
    // ratchet against it creeping back.
    const out = renderFleetInvariants();
    const block = out.slice(
      out.indexOf("## Library and framework docs"),
      out.indexOf("## Secrets in the vault"),
    );
    expect(block).not.toContain("Trigger condition");
    expect(block).not.toMatch(/\*\*Don't\*\* reach for it/);
    expect(block).not.toContain("Prefer context7 over a web search");
  });

  it("tells the agent to DECLARE a failed lookup — including an ERROR, not just an empty result", () => {
    // The whole point of the change is preventing a silent
    // answer-from-training-memory. A guidance block that only handles
    // "context7 has no entry" leaves the likeliest failure — a
    // transport error or a 429 — routing straight back to the failure
    // mode. The anonymous free tier is rate-limited per source IP and
    // every agent on this host shares one IP, so 429 is an expected
    // condition, not a hypothetical.
    const out = renderFleetInvariants();
    expect(out).toContain("**The call errors.**");
    expect(out).toContain("429");
    expect(out).toContain("**No entry.**");
    // ...and the rule that binds both cases.
    expect(out).toMatch(/never a licence to\nanswer from memory/);
    expect(out).toContain("mark it unverified");
  });

  it("stays true for an agent that is OPTED OUT of context7", () => {
    // renderFleetInvariants() takes no arguments and renders ONE
    // fleet-wide file read by every agent via `--add-dir` — there is no
    // per-agent variant. So an agent with `mcp_servers.context7: false`
    // reads this exact text. It must therefore say what to do when the
    // tools are absent, rather than instructing an agent to call tools
    // it does not have.
    const out = renderFleetInvariants();
    expect(out).toContain("this block does not apply to\nyou");
    expect(out).toContain("check your actual tool list rather than assuming");
    // ...and names the fallback that IS available to an opted-out agent.
    expect(out).toContain("webkite_read");
  });

  it("acknowledges that context7's tools are tool-search-deferred", () => {
    // buildToolSearchEnvVars() sets ENABLE_TOOL_SEARCH=true, which
    // force-defers every MCP tool without `alwaysLoad` — and the
    // context7 entry sets none. Guidance that names the tools as though
    // they were already loaded invites the model to read the first
    // call's schema-fetch round-trip as breakage and give up.
    const out = renderFleetInvariants();
    expect(out).toContain("tool-search-deferred");
    expect(out).toContain("That is normal, not an error");
  });

  it("names the REAL context7 tool ids", () => {
    // Same bug class as the `delete_memory` vs `delete_document`
    // regression guarded in scaffold.memory-prompt.test.ts: guidance
    // that names a tool the server doesn't expose makes the model call
    // a nonexistent tool and silently give up. Verified against the
    // live server on 2026-07-26 (tools/list → exactly these two).
    const out = renderFleetInvariants();
    expect(out).toContain("mcp__context7__resolve-library-id");
    expect(out).toContain("mcp__context7__query-docs");
    // Common wrong name lifted from Context7's older npm README.
    expect(out).not.toContain("get-library-docs");
  });

  it("documents the per-agent opt-out that actually exists", () => {
    // The block tells agents `mcp_servers.context7: false` turns it off.
    // That string must match the key resolveContext7McpEntry gates on,
    // or the guidance is instructions for a switch that does nothing.
    const out = renderFleetInvariants();
    expect(out).toContain("`mcp_servers.context7: false`");
  });

  it("warns that queries leave the host to a public third-party endpoint", () => {
    // The guidance actively pushes agents toward an external service.
    // Without an explicit hygiene rule, "look the docs up" invites
    // pasting private repo/service names or proprietary source into a
    // public API as the query argument.
    const out = renderFleetInvariants();
    expect(out).toContain("**Query hygiene:**");
    expect(out).toContain("never private identifiers");
  });

  it("keeps the web-fetch block — context7 supplements webkite, not replaces it", () => {
    const out = renderFleetInvariants();
    expect(out).toContain("## Fetching from the web");
    expect(out).toContain("webkite_search");
  });
});
