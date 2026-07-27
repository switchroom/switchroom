/**
 * TDD-RED-first contract tests for the false-positive class the
 * operator reported on 2026-05-12.
 *
 * Symptom: casual chat that MENTIONS the words "secret", "token",
 * "password", or an ALLCAPS *_KEY/_TOKEN/_SECRET identifier triggers
 * the redaction pipeline as if the user just pasted a real credential
 * — original message gets deleted, ambiguous-card lands, the operator
 * has to dismiss it. Worst case: the operator is asking the agent
 * *about* a secret ("delete the secret I sent yesterday") and gets
 * stuck in a redaction-of-the-question loop.
 *
 * The pre-fix `env_key_value` pattern in patterns.ts:71 is the
 * load-bearing culprit:
 *
 *   /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD))\b\s*[=:]\s*
 *     (["']?)([^\s"'\\]+)\2/g
 *
 * It matches ANY value after `SECRET=` / `TOKEN=` with no entropy
 * gate, no length floor, no shape check on the value. Trivially fires
 * on `SECRET=foo`, `MY_KEY=bar`, even `FATSECRET=hello`.
 *
 * The pre-fix `kv_entropy` pattern in kv-scanner.ts:30 has a 4.0
 * entropy gate which catches some — but `kv_entropy` is the
 * lower-confidence layer and doesn't run when the higher-confidence
 * `env_key_value` already fired. Tightening env_key_value is the
 * right place to land the fix.
 *
 * Each test is the contract: detection MUST NOT fire on the listed
 * input. Failing means the pipeline still flags the input as a hit.
 * The fix adds an entropy + length floor to env_key_value to match
 * the existing kv_entropy precedent.
 */

import { describe, it, expect } from "vitest";
import { detectSecrets } from "../secret-detect/index.js";

describe("secret-detect — does NOT fire on casual mentions of 'secret' / 'token' / 'password'", () => {
  // The "operator asking the agent about a secret" cases.
  // Pre-fix: env_key_value matches "SECRET=" anywhere; these were
  // tripping. Post-fix: entropy + length gate on the value.
  it.each([
    [
      "operator asks for a secret by name",
      "what's my fatsecret token?",
    ],
    [
      "operator references a deleted prior message",
      "please delete that secret you sent earlier",
    ],
    [
      "agent name contains 'secret' as a substring (FatSecret API)",
      "the FatSecret API needs an OAuth token — can you wire it up?",
    ],
    [
      "human language sentence with 'password' as a noun",
      "I keep forgetting my password again",
    ],
    [
      "fragment that mentions an env var by name but no value",
      "the FATSECRET_TOKEN env var is missing",
    ],
    [
      "code-shaped placeholder, value is human-readable English",
      "set FOO_SECRET=hello and try again",
    ],
    [
      "shell example with placeholder value (test fixture style)",
      "run: export OPENAI_API_KEY=sk-yourkey",
    ],
  ])("%s — %j", (_label, text) => {
    const hits = detectSecrets(text);
    expect(
      hits,
      `false positive on ${JSON.stringify(text)} — hits=${JSON.stringify(hits.map((h) => h.matched_text))}`,
    ).toEqual([]);
  });
});

describe("secret-detect — DOES still fire on actually-shaped secrets (regression guard)", () => {
  // After tightening env_key_value, these MUST still be caught.
  // Locking in so a future regex-tightening doesn't over-shoot.
  // Values constructed at runtime so the source file doesn't trip
  // GitHub Push Protection — same pattern as
  // secret-detect-sanctum.test.ts:18 (CLAUDE.md § Secrets in tests).
  const fakeApiKey = `sk-ant-${"a1b2c3d4".repeat(4)}XYZ987`; // sk-ant- + 32 chars
  const fakeBearer = `${"abc123".repeat(8)}.${"def456".repeat(4)}`;
  const fakeRandom = `${"x9zM4kP3qR7sT2vW".repeat(2)}`; // 32 chars, high entropy

  it.each([
    [
      "real-shaped Anthropic API key (anchored prefix path)",
      `export ANTHROPIC_API_KEY=${fakeApiKey}`,
    ],
    [
      "real-shaped Bearer token (anchored Bearer path)",
      `Authorization: Bearer ${fakeBearer}`,
    ],
    [
      "uppercase env_key_value with high-entropy value (must still match)",
      `MYAPP_API_KEY=${fakeRandom}`,
    ],
  ])("%s — %j", (_label, text) => {
    const hits = detectSecrets(text);
    expect(
      hits.length,
      `regression: expected a hit on ${JSON.stringify(text)} but pipeline returned 0`,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("secret-detect — boundary cases that pin the fix's shape", () => {
  it("short low-entropy value after KEY= is NOT flagged", () => {
    // pre-fix: matches; post-fix: filtered by entropy/length gate.
    expect(detectSecrets("MY_API_KEY=foo")).toEqual([]);
  });

  it("English word after KEY= is NOT flagged", () => {
    expect(detectSecrets("MY_TOKEN=hello")).toEqual([]);
  });

  it("long but low-entropy value after KEY= is NOT flagged (repeating chars)", () => {
    // 32 chars but all 'a' — Shannon entropy ~0. Real secrets are
    // dense; this is template/placeholder shape.
    expect(detectSecrets(`MY_KEY=${"a".repeat(32)}`)).toEqual([]);
  });

  it("high-entropy value after KEY= IS flagged (the fix doesn't break detection)", () => {
    // 32 chars of base64-ish noise. Should match.
    const hits = detectSecrets(
      // Build the value via concat to avoid Push-Protection trip on a
      // contiguous secret-shaped literal.
      `MY_API_KEY=${"k" + "9zMpQrT2vBxYuFnGwL8cHj"}`,
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});
