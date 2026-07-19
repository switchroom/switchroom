/**
 * Contract pin for #1047 — the gateway's vault-key regex was stricter
 * than the broker's, so canonical slash-namespaced keys like
 * `fatsecret/client_id` couldn't be requested via the in-band
 * approval card flow. Filed by gymbro after hitting
 * VAULT-BROKER-DENIED on `fatsecret/client_id` and being unable to
 * call `vault_request_access` because of the schema regex.
 *
 * Three call sites use the regex:
 *   1. `vault_request_save` execute (telegram-plugin/gateway/gateway.ts ~3549)
 *   2. `vault_request_access` execute (~3633)
 *   3. The rename-the-staged-key text-message handler (~5185)
 *
 * All three must accept the canonical slash-namespaced shape used by
 * production keys: `fatsecret/client_id`, `mff/agent-private-key`,
 * `microsoft/ken-tokens`. The broker itself has no key-shape regex
 * (just `z.string().min(1)` in protocol.ts), so the gateway should
 * mirror that posture — accept what the broker accepts.
 *
 * This is a static-source pin — the regex literal must appear in the
 * gateway source. A runtime test would need a full bot harness;
 * static-source mirrors the convention used elsewhere in this file
 * tree (see jtbd-talk-from-anywhere.test.ts, vault-request-access-tool.test.ts).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// #2996 Phase 5: the callback-query handler families moved verbatim to
// gateway/callback-query-handlers.ts, and the agent-facing card-STAGING
// execute* tool handlers (vault_request_save & co) moved verbatim to
// gateway/card-tool-handlers.ts (#2996 P5-tail); these pins read the gateway
// source COMBINED with those modules so the wiring assertions keep covering
// the same runtime source text.
const gatewaySrc =
  readFileSync(resolve(__dirname, "..", "gateway", "gateway.ts"), "utf-8") +
  "\n" +
  readFileSync(resolve(__dirname, "..", "gateway", "callback-query-handlers.ts"), "utf-8") +
  "\n" +
  readFileSync(resolve(__dirname, "..", "gateway", "card-tool-handlers.ts"), "utf-8") +
  "\n" +
  // P7 PR-8 (#2996): the vault pending-op intercept (incl. the rename-staged-
  // key validation) moved verbatim into gateway/inbound-interceptors.ts.
  readFileSync(resolve(__dirname, "..", "gateway", "inbound-interceptors.ts"), "utf-8");

/** The exported regex literal — what the gateway actually validates against. */
function extractVaultKeyRegex(): RegExp {
  // The shared constant declaration. Anchored on the `VAULT_KEY_REGEX
  // = /` prefix and the `/` immediately before the line terminator
  // (the regex has no flags). The source includes `/` inside the
  // character class, so a greedy match up to end-of-line is the
  // safe extraction strategy.
  const m = gatewaySrc.match(/const\s+VAULT_KEY_REGEX\s*=\s*\/(.+)\/\s*$/m);
  if (!m) throw new Error("VAULT_KEY_REGEX constant not found in gateway.ts");
  return new RegExp(m[1]);
}

/** Either inline literal with `/`, OR a reference to VAULT_KEY_REGEX. */
// `vaultKeyRegex` is the InboundInterceptorDeps field gateway.ts binds to the
// shared VAULT_KEY_REGEX constant (P7 PR-8) — same runtime regex, new name at
// the moved call site.
const ACCEPTS_SLASH = /\[A-Za-z0-9_(\/|\\\/|\.)+-\]|VAULT_KEY_REGEX|vaultKeyRegex/;

describe("vault-key regex accepts canonical slash-namespaced keys (#1047)", () => {
  it("vault_request_save validation includes '/' in the charclass", () => {
    // Anchor on the unique error message so a refactor that moves
    // the validation can still be located.
    const ix = gatewaySrc.indexOf("vault_request_save: key must match");
    expect(ix, "could not find vault_request_save key error message").toBeGreaterThan(0);
    const window = gatewaySrc.slice(Math.max(0, ix - 400), ix);
    expect(
      window,
      "vault_request_save validation should accept '/' (e.g. fatsecret/client_id)",
    ).toMatch(ACCEPTS_SLASH);
  });

  it("vault_request_access validation includes '/' in the charclass", () => {
    const ix = gatewaySrc.indexOf("vault_request_access: key must match");
    expect(ix, "could not find vault_request_access key error message").toBeGreaterThan(0);
    const window = gatewaySrc.slice(Math.max(0, ix - 400), ix);
    expect(
      window,
      "vault_request_access validation should accept '/' (e.g. fatsecret/client_id)",
    ).toMatch(ACCEPTS_SLASH);
  });

  it("rename-staged-key validation includes '/' in the charclass", () => {
    // The rename handler for the [✏️ Rename] button on a
    // vault_request_save card. If this stays strict, operators can't
    // rename a staged key to a canonical namespaced form.
    const ix = gatewaySrc.indexOf("Key must match");
    expect(ix, "could not find rename validation error message").toBeGreaterThan(0);
    const window = gatewaySrc.slice(Math.max(0, ix - 400), ix);
    expect(
      window,
      "rename handler should accept '/' (e.g. fatsecret/client_id)",
    ).toMatch(ACCEPTS_SLASH);
  });

  it("/vault audit one-tap Allow callback validation includes '/' in the charclass", () => {
    // Reviewer-caught oversight on #1049: the
    // handleVaultRecentDenialCallback handler (#969 P2b) validates
    // the keyName parsed from the inline-button callback_data with
    // its own copy of the key regex. Without this site updated, the
    // exact bug from #1047 — operator opens /vault audit on a
    // denied `fatsecret/client_id`, taps [Allow] — would surface
    // "Invalid key name" even though the agent-initiated card flow
    // works.
    const ix = gatewaySrc.indexOf("'Invalid key name'");
    expect(ix, "could not find /vault audit Invalid key name error").toBeGreaterThan(0);
    const window = gatewaySrc.slice(Math.max(0, ix - 400), ix);
    expect(
      window,
      "/vault audit one-tap allow should accept '/' (e.g. fatsecret/client_id)",
    ).toMatch(ACCEPTS_SLASH);
  });

  it("user-facing rename error message names the slash as allowed", () => {
    // The visible error text guides the operator on what's allowed.
    // If we widened the regex but didn't update the message, the
    // operator is told `/` is disallowed even though it isn't.
    // The VAULT_KEY_REGEX_LABEL string is the canonical user-visible
    // hint and includes the `/` shape.
    const m = gatewaySrc.match(/const\s+VAULT_KEY_REGEX_LABEL\s*=\s*"([^"]+)"/);
    expect(m, "VAULT_KEY_REGEX_LABEL constant not found").not.toBeNull();
    expect(m![1], "label must mention '/' as allowed").toMatch(/\//);
  });
});

describe("vault-key regex: regression guards (the fix doesn't break the original shape)", () => {
  // Anchored to the live VAULT_KEY_REGEX constant declaration so the
  // test runs the same regex the gateway runs. A breaking refactor
  // (typo, accidental tightening) fails loudly here.
  const re = extractVaultKeyRegex();

  it.each([
    ["telegram_bot_token", true, "underscores + lowercase"],
    ["MY_TOKEN", true, "uppercase + underscore"],
    ["api.key", true, "dot namespace"],
    ["fatsecret/client_id", true, "slash namespace (the bug)"],
    ["fatsecret/credentials", true, "slash namespace"],
    ["mff/agent-private-key", true, "slash namespace with hyphen"],
    ["microsoft/ken-tokens", true, "slash namespace from issue"],
    ["k", true, "single char"],
    ["a".repeat(200), true, "max length"],
    ["", false, "empty rejected"],
    ["a".repeat(201), false, "over-length rejected"],
    ["key with space", false, "space rejected"],
    ['key"with"quotes', false, "quotes rejected"],
    ["key\nwith\nnewlines", false, "newlines rejected"],
  ] as const)("VAULT_KEY_REGEX: %s — should %s (%s)", (input, expected) => {
    expect(re.test(input), `${JSON.stringify(input)} (${expected ? "accept" : "reject"})`).toBe(expected);
  });
});
