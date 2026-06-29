/**
 * Tests for the vault-CLI error parser + renderer (issue #969 P0b).
 */

import { describe, it, expect } from "vitest";
import { parseVaultCliError, renderVaultCliError } from "./vault-error.js";

describe("parseVaultCliError", () => {
  it("classifies VAULT-SANDBOX-CONTEXT", () => {
    const stderr =
      "VAULT-SANDBOX-CONTEXT: direct vault access is unavailable inside an " +
      "agent sandbox. The vault file is not mounted into agent containers; " +
      "only the broker socket is. Run 'switchroom vault init' on the host shell, " +
      "or use a broker-supported operation.";
    const err = parseVaultCliError(stderr);
    expect(err.kind).toBe("sandbox_context");
    // The hint contains 'switchroom vault init' — parser must skip it.
    expect(err.key).toBeUndefined();
  });

  it("classifies VAULT-NEEDS-APPROVAL and extracts the affected key", () => {
    const stderr =
      "VAULT-NEEDS-APPROVAL [unknown_key]: secret 'telegram_bot_token_klanker_20260510' " +
      "does not exist in the vault yet. Agents can rotate existing keys via " +
      "the broker but cannot create new ones; this requires operator approval.";
    const err = parseVaultCliError(stderr);
    expect(err.kind).toBe("needs_approval");
    expect(err.key).toBe("telegram_bot_token_klanker_20260510");
  });

  it("classifies VAULT-BROKER-UNREACHABLE", () => {
    const stderr =
      "VAULT-BROKER-UNREACHABLE: cannot reach vault broker " +
      "(ENOENT: no such file or directory, connect '/run/switchroom/broker/sock'). " +
      "From inside the agent sandbox, direct vault access is not possible.";
    const err = parseVaultCliError(stderr);
    expect(err.kind).toBe("broker_unreachable");
  });

  it("classifies VAULT-BROKER-DENIED and extracts the KEY (not the agent name)", () => {
    // Regression test: the canonical stderr has TWO single-quoted
    // tokens — the agent name and the key name. The parser must pick
    // the key (anchored after "key '") so the rendered host hint
    // suggests granting access to the right key.
    const stderr =
      "VAULT-BROKER-DENIED [DENIED]: agent 'klanker' is not in the allow list for key 'shared_token'";
    const err = parseVaultCliError(stderr);
    expect(err.kind).toBe("broker_denied");
    expect(err.key).toBe("shared_token");
  });

  it("returns 'other' for unrecognised errors", () => {
    const err = parseVaultCliError("Error: something broke\nstack trace …");
    expect(err.kind).toBe("other");
    expect(err.key).toBeUndefined();
  });

  it("handles empty / undefined stderr gracefully", () => {
    expect(parseVaultCliError("").kind).toBe("other");
    expect(parseVaultCliError(undefined as unknown as string).kind).toBe("other");
  });
});

describe("renderVaultCliError", () => {
  // 2026-05-12: renderer copy migrated from host-CLI suggestions to
  // Telegram-native next-step actions (vault_request_save, /vault
  // audit, /vault broker status). Tests below assert the new copy.
  // The pre-fix pins are documented in
  // tests/jtbd-talk-from-anywhere.test.ts as the closed punch-list
  // items.
  it("renders sandbox_context for verb=set with the vault_request_save tool, surfacing the affected key", () => {
    const out = renderVaultCliError(
      { kind: "sandbox_context", original: "x" },
      { verb: "set", key: "my_key" },
    );
    expect(out.suppressRaw).toBe(true);
    expect(out.html).toMatch(/vault_request_save/);
    expect(out.html).not.toMatch(/Open a host shell/);
    // Reviewer-flagged on #1037: pre-fix test asserted the key
    // appeared in output (so the operator knew which key triggered
    // the card). New copy keeps the key in <code>…</code> form via
    // htmlEscape — assert it.
    expect(out.html).toContain("`my_key`");
  });

  it("renders sandbox_context for verb=set WITHOUT a key (defensive fallback)", () => {
    // The gateway sometimes doesn't have the key in hand (e.g. when
    // the agent's stderr was opaque). Renderer should still produce
    // useful output, not crash or render an empty <code></code>.
    const out = renderVaultCliError(
      { kind: "sandbox_context", original: "x" },
      { verb: "set" },
    );
    expect(out.html).toMatch(/vault_request_save/);
    expect(out.html).not.toContain("``");
  });

  it("renders sandbox_context for verb=get with /vault get", () => {
    const out = renderVaultCliError(
      { kind: "sandbox_context", original: "x" },
      { verb: "get", key: "my_key" },
    );
    expect(out.html).toMatch(/\/vault get/);
    expect(out.html).toMatch(/my_key/);
  });

  it("renders sandbox_context for verb=init with the one-time-host-shell note", () => {
    const out = renderVaultCliError(
      { kind: "sandbox_context", original: "x" },
      { verb: "init" },
    );
    expect(out.html).toMatch(/one-time host-shell|switchroom vault init/);
  });

  it("renders needs_approval naming the live vault_request_save tool (not a 'on the way' stub)", () => {
    const out = renderVaultCliError(
      { kind: "needs_approval", original: "x", key: "telegram_bot_token" },
      { verb: "save" },
    );
    expect(out.suppressRaw).toBe(true);
    expect(out.html).toContain("operator approval required");
    expect(out.html).toContain("`telegram_bot_token`");
    expect(out.html).toMatch(/vault_request_save/);
    expect(out.html).not.toMatch(/on the way/i);
  });

  it("renders broker_unreachable as an honest 'tracked follow-up' instead of a false in-chat promise", () => {
    // Pre-fix (rejected by #1037 reviewer): renderer pointed at
    // `/vault broker status` / `/vault broker restart` — neither
    // command is registered in the gateway dispatcher. Telling the
    // operator to type unregistered commands is worse than the
    // host-CLI punt it was meant to replace.
    //
    // Post-fix: renderer names the in-Telegram follow-up as
    // tracked + unbuilt, and points at the host CLI for now.
    // Honest about the gap until /vault broker {status,restart}
    // actually ships.
    const out = renderVaultCliError(
      { kind: "broker_unreachable", original: "x" },
      { verb: "set" },
    );
    expect(out.suppressRaw).toBe(true);
    expect(out.html).toContain("broker isn't reachable");
    expect(out.html).toMatch(/tracked as a follow-up/i);
    expect(out.html).toMatch(/switchroom vault broker status/);
  });

  it("renders broker_denied pointing at /vault audit one-tap allow + vault_request_access", () => {
    const out = renderVaultCliError(
      { kind: "broker_denied", original: "x", key: "shared_token" },
      { verb: "set" },
    );
    expect(out.suppressRaw).toBe(true);
    expect(out.html).toContain("refused the request");
    expect(out.html).toMatch(/\/vault audit/);
    expect(out.html).toMatch(/vault_request_access/);
    expect(out.html).toContain("shared_token");
  });

  it("prefers verbHint.key over parser-extracted key (verbHint wins for in-Telegram next-step)", () => {
    // The gateway always knows the key the user asked for; rendering
    // must use that over any heuristic extraction so a parser glitch
    // can't surface the wrong key in the in-chat next-step suggestion.
    const out = renderVaultCliError(
      { kind: "broker_denied", original: "x", key: "parser-extracted" },
      { verb: "set", key: "gateway-supplied" },
    );
    expect(out.html).toContain("gateway-supplied");
    expect(out.html).not.toContain("parser-extracted");
  });

  it("returns suppressRaw=false for 'other' so the gateway falls back to a raw pre-block", () => {
    const out = renderVaultCliError({ kind: "other", original: "weird error" }, { verb: "set" });
    expect(out.suppressRaw).toBe(false);
    expect(out.html).toBe("");
  });

  it("keeps the key literal inside the code span (< > stay verbatim, #2669)", () => {
    const out = renderVaultCliError(
      { kind: "needs_approval", original: "x", key: "key<with>html" },
      { verb: "save" },
    );
    // < > are literal in rich markdown and ride verbatim in the `code span`.
    expect(out.html).toContain("`key<with>html`");
  });
});
