/**
 * Tests for the approval card primitive (RFC B §8).
 */

import { describe, it, expect } from "vitest";
import {
  buildApprovalCard,
  parseApprovalCallback,
  ttlMsFromToken,
} from "./approval-card.js";

describe("approval card", () => {
  it("renders the pristine card with default buttons", () => {
    const card = buildApprovalCard({
      request_id: "a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2",
      agent: "klanker",
      scope_humanized: "secret:OPENAI_API_KEY",
      why: "needs to call OpenAI",
    });
    expect(card.text).toContain("klanker");
    expect(card.text).toContain("secret:OPENAI_API_KEY");
    expect(card.text).toContain("needs to call OpenAI");

    // Validate the inline_keyboard structure carries our four callback shapes
    const flat = card.reply_markup.inline_keyboard.flat();
    const datas = flat.map((b) => ("callback_data" in b ? b.callback_data : ""));
    expect(datas).toContain("apv:a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2:once");
    expect(datas).toContain("apv:a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2:deny");
    expect(datas).toContain("apv:a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2:always");
  });

  it("respects offer_always=false and offer_ttl=true", () => {
    const card = buildApprovalCard({
      request_id: "a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2",
      agent: "k",
      scope_humanized: "x",
      offer_always: false,
      offer_ttl: true,
    });
    const datas = card.reply_markup.inline_keyboard
      .flat()
      .map((b) => ("callback_data" in b ? b.callback_data : ""));
    expect(datas).not.toContain("apv:a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2:always");
    expect(datas).toContain("apv:a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2:ttl:1h");
  });

  it("passes < > & literally in agent and scope (markdown, #2669)", () => {
    const card = buildApprovalCard({
      request_id: "deadbeefdeadbeefdeadbeefdeadbeef",
      agent: "<script>",
      scope_humanized: "a&b",
    });
    // < > & are literal in rich markdown. The agent is bolded (no specials
    // here to escape) and the scope rides verbatim in a `code span`.
    expect(card.text).toContain("**<script>**");
    expect(card.text).toContain("`a&b`");
  });

  it("keeps a scope with underscores literal inside the code span (no \\_ leak, #2669)", () => {
    // Regression: escaping inside the code span produced visible backslashes
    // like `secret:OPENAI\_API\_KEY`. The scope must render verbatim.
    const card = buildApprovalCard({
      request_id: "deadbeefdeadbeefdeadbeefdeadbeef",
      agent: "k",
      scope_humanized: "secret:OPENAI_API_KEY",
    });
    expect(card.text).toContain("`secret:OPENAI_API_KEY`");
    expect(card.text).not.toContain("\\_");
  });
});

describe("parseApprovalCallback", () => {
  it("parses every choice variant", () => {
    expect(parseApprovalCallback("apv:a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2:once"))
      .toEqual({ request_id: "a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2", choice: { kind: "once" } });
    expect(parseApprovalCallback("apv:a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2:always"))
      .toEqual({ request_id: "a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2", choice: { kind: "always" } });
    expect(parseApprovalCallback("apv:a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2:deny"))
      .toEqual({ request_id: "a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2", choice: { kind: "deny" } });
    expect(parseApprovalCallback("apv:a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2:ttl:1h"))
      .toEqual({ request_id: "a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2", choice: { kind: "ttl", param: "1h" } });
  });

  it("rejects malformed prefixes and bad ids", () => {
    expect(parseApprovalCallback("perm:more:abc")).toBeNull();
    expect(parseApprovalCallback("apv:NOTHEX12:once")).toBeNull();
    expect(parseApprovalCallback("apv:a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2:bogus")).toBeNull();
    expect(parseApprovalCallback("apv:a3f1b9c2a3f1b9c2a3f1b9c2a3f1b9c2:ttl")).toBeNull();
  });
});

describe("ttlMsFromToken", () => {
  it("parses h and d units", () => {
    expect(ttlMsFromToken("1h")).toBe(60 * 60 * 1000);
    expect(ttlMsFromToken("24h")).toBe(24 * 60 * 60 * 1000);
    expect(ttlMsFromToken("7d")).toBe(7 * 24 * 60 * 60 * 1000);
  });
  it("rejects garbage", () => {
    expect(ttlMsFromToken("0h")).toBeNull();
    expect(ttlMsFromToken("1m")).toBeNull();
    expect(ttlMsFromToken("h")).toBeNull();
  });
});
