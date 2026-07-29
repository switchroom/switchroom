/**
 * Two engines, one behaviour — the TypeScript half.
 *
 * Agent memory is written from BOTH languages: the vendored Hindsight plugin
 * retains from Python (`vendor/hindsight-memory/scripts/lib/client.py`), while
 * the MCP shim, the handoff mirror and the profile CLI write from TypeScript.
 * If the two redactors drift, a credential blocked on one path sails through
 * the other, and nothing goes red — the fork is silent by construction.
 *
 * Two mechanisms stop that, and this file is half of the second:
 *
 *   1. ONE pattern table. `vendor/hindsight-memory/scripts/lib/secret_patterns.json`
 *      is GENERATED from `telegram-plugin/secret-detect/patterns.ts` and
 *      byte-compared by `scripts/check-secret-pattern-parity.ts` in `bun lint`.
 *   2. ONE behaviour contract. `lib/secret_redaction_vectors.json` is asserted
 *      here AND by `vendor/hindsight-memory/scripts/tests/test_secret_redact.py`.
 *      The imperative gates (entropy floors, placeholder suppression, the
 *      memorable-password character-class rule) are hand-ported and cannot be
 *      generated, so they are pinned by shared expected OUTPUT instead.
 *
 * Also covers the two detection gaps this write-path work closed: connection-
 * string passwords and human-memorable passwords.
 *
 * Every credential-shaped literal here is synthetic.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { redact } from "../secret-detect/redact.js";
import { scanDbUris, DB_URI_RULE_ID } from "../secret-detect/db-uri.js";
import {
  looksLikeMemorablePassword,
  scanMemorablePasswords,
} from "../secret-detect/kv-scanner.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VECTORS_PATH = join(
  repoRoot,
  "vendor/hindsight-memory/scripts/lib/secret_redaction_vectors.json",
);

type Vector = { name: string; input: string; expected: string };
const vectors = (
  JSON.parse(readFileSync(VECTORS_PATH, "utf-8")) as { vectors: Vector[] }
).vectors;

describe("shared TS/Python redaction vectors", () => {
  it("carries a non-trivial contract", () => {
    // A shrinking vector file would silently weaken the cross-language
    // guarantee; the Python suite asserts the same floor.
    expect(vectors.length).toBeGreaterThanOrEqual(20);
  });

  for (const vector of vectors) {
    it(vector.name, () => {
      expect(redact(vector.input)).toBe(vector.expected);
    });
  }
});

describe("connection-string credentials (gap 1)", () => {
  it("masks the password of a non-http scheme URI", () => {
    // url-redact.ts only ever matched http/https/ws/wss/ftp, so a
    // `postgres://` DSN — the single most common way a production password
    // reaches a chat log — was stored verbatim.
    const password = "Hunter" + "Two99";
    const out = redact("dsn postgres://appuser:" + password + "@db.internal:5432/prod");
    expect(out).not.toContain(password);
    expect(out).toContain(`[REDACTED:${DB_URI_RULE_ID}]`);
    // Everything diagnostically useful survives.
    expect(out).toContain("appuser");
    expect(out).toContain("db.internal:5432/prod");
  });

  it("ignores a URI with no credentials", () => {
    expect(scanDbUris("postgres://db.internal:5432/prod")).toEqual([]);
  });

  it("is idempotent over an already-masked DSN", () => {
    const once = redact("postgres://u:" + "Pineapple" + "Roof8" + "@h/d");
    expect(redact(once)).toBe(once);
  });
});

describe("human-memorable passwords (gap 2)", () => {
  it("masks a family-name style password behind a password label", () => {
    // The kv-scanner's 4.0-bits entropy floor is tuned for random tokens; a
    // memorable password scores well under it, so `password: <words>` was
    // never a hit.
    const password = "Fluffy" + "Barnaby" + "1998";
    const out = redact("wifi password: " + password);
    expect(out).not.toContain(password);
    expect(out).toContain("[REDACTED:memorable_password]");
  });

  it("accepts the ` is ` phrasing and prefixed identifiers", () => {
    expect(scanMemorablePasswords("the password is Mango" + "TreeHouse77")).toHaveLength(1);
    expect(scanMemorablePasswords("db_password=Rutherford" + "2024x")).toHaveLength(1);
  });

  it("does NOT fire on prose or placeholders", () => {
    // False positives here corrupt stored conversation irreversibly, so the
    // rule requires >= 2 character classes: single-class English words are out.
    for (const prose of [
      "The password policy requires rotation every 90 days.",
      "the password is rotated quarterly",
      "password: ${DB_PASSWORD}",
      "password=<your-password-here>",
      "password: vault:postgres/app_password",
      "password: [REDACTED:memorable_password]",
    ]) {
      expect(redact(prose)).toBe(prose);
    }
  });

  it("classifies candidate values by character-class breadth", () => {
    expect(looksLikeMemorablePassword("Fluffy" + "Barnaby" + "1998")).toBe(true);
    expect(looksLikeMemorablePassword("rotated")).toBe(false); // too short + 1 class
    expect(looksLikeMemorablePassword("quarterly")).toBe(false); // 1 class
    expect(looksLikeMemorablePassword("aaaaaaaaaa1A")).toBe(false); // <4 distinct chars
    expect(looksLikeMemorablePassword("${SOME_VAR}")).toBe(false);
  });
});
