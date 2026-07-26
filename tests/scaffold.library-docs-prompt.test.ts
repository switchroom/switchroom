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

  it("names a concrete trigger condition, not just the tool's existence", () => {
    // The webkite lesson: a block that only describes what a tool IS
    // produces zero calls. These are the checkable triggers.
    const out = renderFleetInvariants();
    expect(out).toContain("**Trigger condition — reach for context7 when:**");
    expect(out).toContain("function signature");
    // ...and an explicit negative scope, so agents don't burn a
    // round-trip on every general programming question.
    expect(out).toMatch(/\*\*Don't\*\* reach for it/);
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
