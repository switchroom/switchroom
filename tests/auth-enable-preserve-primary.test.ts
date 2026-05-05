/**
 * Unit tests for the per-agent primary-preserving fanout helper used by
 * `switchroom auth enable`. Polish for the bug discovered while wiring
 * three accounts onto every agent — each `enable` was overwriting the
 * runtime active credentials with the just-added account, even when the
 * existing primary should have remained active.
 *
 * The fix: `enable` appends to `auth.accounts:` (the YAML-list head is
 * the primary, fallbacks follow) and fans out whatever the post-append
 * FIRST entry is — i.e. the existing primary when adding a fallback,
 * the just-added label when this is the agent's first account.
 */

import { describe, it, expect } from "vitest";
import { groupAgentsByPrimaryAccount } from "../src/cli/auth-accounts.js";
import { appendAccountToAgent } from "../src/cli/auth-accounts-yaml.js";

const baseYaml = `
version: 1
agents:
  fresh:
    topic_name: Fresh
  primary-set:
    topic_name: Existing
    auth:
      accounts: [pixsoul@gmail.com]
  multi:
    topic_name: Multi
    auth:
      accounts: [pixsoul@gmail.com, me@kenthompson.com.au]
`;

describe("groupAgentsByPrimaryAccount", () => {
  it("returns empty map when no agents are passed", () => {
    expect(groupAgentsByPrimaryAccount(baseYaml, [], "fallback")).toEqual(
      new Map(),
    );
  });

  it("groups a single agent with no existing accounts under the new label", () => {
    const yaml = appendAccountToAgent(baseYaml, "fresh", "new@example.com");
    const groups = groupAgentsByPrimaryAccount(
      yaml,
      ["fresh"],
      "new@example.com",
    );
    expect(groups.size).toBe(1);
    expect(groups.get("new@example.com")).toEqual(["fresh"]);
  });

  it("groups a single agent with existing primary under the EXISTING primary, not the new label", () => {
    // Operator runs `auth enable me@kenthompson.com.au primary-set` —
    // primary-set already has pixsoul@gmail.com first. The fix means
    // we fan out pixsoul (preserve), not me@kenthompson (the new
    // fallback). primary-set's runtime active stays on pixsoul.
    const yaml = appendAccountToAgent(
      baseYaml,
      "primary-set",
      "me@kenthompson.com.au",
    );
    const groups = groupAgentsByPrimaryAccount(
      yaml,
      ["primary-set"],
      "me@kenthompson.com.au",
    );
    expect(groups.size).toBe(1);
    expect(groups.get("pixsoul@gmail.com")).toEqual(["primary-set"]);
    expect(groups.get("me@kenthompson.com.au")).toBeUndefined();
  });

  it("groups multi-agent enable correctly: each agent gets its own primary", () => {
    // Operator runs `auth enable new@example.com fresh primary-set
    // multi` (or the `all` keyword). Three distinct outcomes:
    //   - fresh has no accounts pre-append → new@example.com is primary
    //   - primary-set has pixsoul → pixsoul stays primary, new@ is
    //     fallback
    //   - multi already has pixsoul + me@ → pixsoul stays primary, new@
    //     becomes a third fallback
    let yaml = baseYaml;
    yaml = appendAccountToAgent(yaml, "fresh", "new@example.com");
    yaml = appendAccountToAgent(yaml, "primary-set", "new@example.com");
    yaml = appendAccountToAgent(yaml, "multi", "new@example.com");

    const groups = groupAgentsByPrimaryAccount(
      yaml,
      ["fresh", "primary-set", "multi"],
      "new@example.com",
    );

    expect(groups.size).toBe(2);
    expect(groups.get("new@example.com")).toEqual(["fresh"]);
    // Both pre-existing-primary agents share pixsoul as their primary.
    expect(groups.get("pixsoul@gmail.com")?.sort()).toEqual([
      "multi",
      "primary-set",
    ]);
  });

  it("falls back to defaultLabel when an agent's account list is somehow empty post-append", () => {
    // Defensive — `appendAccountToAgent` always leaves at least the
    // just-added label, so this is the "yaml mutation lost the entry"
    // failure mode. Should never regress to leaving the agent
    // unauthenticated; falling back to the just-enabled label is the
    // safe choice.
    const groups = groupAgentsByPrimaryAccount(
      baseYaml, // unmutated — `fresh` has no auth.accounts yet
      ["fresh"],
      "new@example.com",
    );
    expect(groups.get("new@example.com")).toEqual(["fresh"]);
  });

  it("preserves spawn order within a primary group", () => {
    // The fanout helper later iterates this list to call
    // `agent restart` — order matters for the operator-visible
    // restart sequence (rolling-restart settle gate considers each
    // in turn). Pin the order so a refactor of the Map iteration
    // doesn't silently shuffle agents.
    let yaml = baseYaml;
    yaml = appendAccountToAgent(yaml, "primary-set", "new@example.com");
    yaml = appendAccountToAgent(yaml, "multi", "new@example.com");
    const groups = groupAgentsByPrimaryAccount(
      yaml,
      ["multi", "primary-set"],
      "new@example.com",
    );
    // Iteration order matches input order.
    expect(groups.get("pixsoul@gmail.com")).toEqual(["multi", "primary-set"]);
  });

  it("works with email-shaped labels (regex parity test for v0.6.7+)", () => {
    // Sanity: groupAgentsByPrimaryAccount doesn't need to validate
    // labels itself — it just looks them up — but pin that it
    // tolerates email-shape labels through the YAML round-trip.
    let yaml = `
version: 1
agents:
  alpha:
    auth:
      accounts: [pixsoul@gmail.com, ken+work@example.com]
`;
    yaml = appendAccountToAgent(yaml, "alpha", "ken.thompson@outlook.com.au");
    const groups = groupAgentsByPrimaryAccount(
      yaml,
      ["alpha"],
      "ken.thompson@outlook.com.au",
    );
    expect(groups.get("pixsoul@gmail.com")).toEqual(["alpha"]);
  });
});
