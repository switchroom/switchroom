/**
 * Unit tests for `promoteAccountForAgent` — the pure YAML helper that
 * moves a label to position 0 of `agents.<agent>.auth.accounts:`.
 *
 * Why these specific cases: the helper is the source of truth for what
 * "primary preservation + promotion" mean to the cascade, and is shared
 * by the CLI verb + the Telegram dashboard's `⤴ Promote` flow. Cover
 * the head/middle/tail/missing/empty/already-primary branches so a
 * future refactor can't silently change the contract.
 */

import { describe, expect, it } from "vitest";
import {
  appendAccountToAgent,
  getAccountsForAgent,
  promoteAccountForAgent,
} from "../src/cli/auth-accounts-yaml.js";

const seed = `
version: 1
agents:
  fresh:
    topic_name: Fresh
  one:
    auth:
      accounts: [pixsoul@gmail.com]
  many:
    auth:
      accounts:
        - pixsoul@gmail.com
        - me@kenthompson.com.au
        - ken.thompson@outlook.com.au
`;

describe("promoteAccountForAgent", () => {
  it("moves a middle entry to position 0", () => {
    const next = promoteAccountForAgent(seed, "many", "me@kenthompson.com.au");
    expect(getAccountsForAgent(next, "many")).toEqual([
      "me@kenthompson.com.au",
      "pixsoul@gmail.com",
      "ken.thompson@outlook.com.au",
    ]);
  });

  it("moves a tail entry to position 0", () => {
    const next = promoteAccountForAgent(
      seed,
      "many",
      "ken.thompson@outlook.com.au",
    );
    expect(getAccountsForAgent(next, "many")).toEqual([
      "ken.thompson@outlook.com.au",
      "pixsoul@gmail.com",
      "me@kenthompson.com.au",
    ]);
  });

  it("returns the input byte-identical when the label is already primary", () => {
    // The CLI uses byte-equality (before === after) to decide whether to
    // rewrite the file + restart-hint. parseDocument round-trips can
    // normalize whitespace, so the helper short-circuits explicitly
    // when no movement is needed. Pin that contract.
    const next = promoteAccountForAgent(seed, "many", "pixsoul@gmail.com");
    expect(next).toBe(seed);
  });

  it("throws when the label is not enabled on the agent", () => {
    expect(() =>
      promoteAccountForAgent(seed, "many", "not-enabled@example.com"),
    ).toThrowError(/not enabled/);
  });

  it("throws when the agent has no auth.accounts list yet", () => {
    expect(() =>
      promoteAccountForAgent(seed, "fresh", "pixsoul@gmail.com"),
    ).toThrowError(/no auth\.accounts list/);
  });

  it("throws when the agent is not declared", () => {
    expect(() =>
      promoteAccountForAgent(seed, "ghost", "pixsoul@gmail.com"),
    ).toThrowError(/not declared/);
  });

  it("preserves the relative order of other entries when promoting", () => {
    // me@ → primary; the relative order of the remaining two should be
    // [pixsoul, ken] — i.e. unchanged from the original list, not
    // re-shuffled.
    const next = promoteAccountForAgent(seed, "many", "me@kenthompson.com.au");
    const list = getAccountsForAgent(next, "many");
    expect(list.indexOf("pixsoul@gmail.com")).toBeLessThan(
      list.indexOf("ken.thompson@outlook.com.au"),
    );
  });

  it("composes with appendAccountToAgent — append-then-promote == single-step promote", () => {
    // Real CLI flow: an operator runs `auth enable <new>` (append) then
    // `auth promote <new>`. Pin that the helpers compose the way callers
    // assume: the post-append-then-promote list is the same as
    // [<new>, …existing] in original order.
    const appended = appendAccountToAgent(seed, "one", "new@example.com");
    const promoted = promoteAccountForAgent(appended, "one", "new@example.com");
    expect(getAccountsForAgent(promoted, "one")).toEqual([
      "new@example.com",
      "pixsoul@gmail.com",
    ]);
  });

  it("works with email-shaped labels containing @ and +", () => {
    const yaml = `
version: 1
agents:
  alpha:
    auth:
      accounts:
        - pixsoul@gmail.com
        - ken+work@example.com
`;
    const next = promoteAccountForAgent(yaml, "alpha", "ken+work@example.com");
    expect(getAccountsForAgent(next, "alpha")).toEqual([
      "ken+work@example.com",
      "pixsoul@gmail.com",
    ]);
  });
});
