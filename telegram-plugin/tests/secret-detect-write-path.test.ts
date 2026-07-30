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
    expect(vectors.length).toBeGreaterThanOrEqual(50);
  });

  it("covers the GENERATED pattern table, not just the imperative gates", () => {
    // #3982 review, MAJOR 4: every vector originally shipped exercised
    // only `db_uri_password`, `memorable_password` and `redact_urls` —
    // the two hand-ported rules plus the URL pass. Nothing touched any of
    // the ~60 GENERATED patterns, which is precisely why a Unicode
    // word-boundary fork inside them shipped past a green CI.
    for (const marker of [
      "[REDACTED:anthropic_api_key]",
      "[REDACTED:jwt]",
      "[REDACTED:aws_access_key]",
      "[REDACTED:pem_private_key]",
      "[REDACTED:bearer_auth_header]",
      "[REDACTED:basic_auth_header]",
    ]) {
      expect(
        vectors.some((v) => v.expected.includes(marker)),
        `no vector pins ${marker}`,
      ).toBe(true);
    }
    // ...and several must sit ADJACENT to non-ASCII text, which is where
    // the two regex engines actually disagreed.
    const nonAsciiPositives = vectors.filter(
      (v) =>
        /[^\u0000-\u007f]/.test(v.input) && v.expected.includes("[REDACTED"),
    );
    expect(nonAsciiPositives.length).toBeGreaterThanOrEqual(4);
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

  it("masks a password containing an unencoded @ in FULL", () => {
    // #3982 review, MAJOR 3. The original pattern excluded `@` from the
    // password class so the match stopped at the FIRST `@`, which stored
    // 9 of 11 password bytes in clear AND leaked the length of the
    // masked prefix. Unencoded `@` in a pasted DSN is common.
    const password = "p" + "@" + "ssW0rd123";
    const out = redact("postgres://appuser:" + password + "@db.internal:5432/prod");
    expect(out).toBe(
      "postgres://appuser:[REDACTED:db_uri_password]@db.internal:5432/prod",
    );
    // No 4+ byte fragment of the password survives — the shipped code
    // stored `ssW0rd123`, which this catches. (Shorter fragments would
    // collide with the surviving port/host bytes.)
    for (let i = 0; i + 4 <= password.length; i++) {
      expect(out).not.toContain(password.slice(i, i + 4));
    }
  });

  it("stops at the authority terminator, not at the next @ on the line", () => {
    const out = redact(
      "mysql://root:" + "t0psecretpw" + "@db.internal/app then mail ops@example.com",
    );
    expect(out).toBe(
      "mysql://root:[REDACTED:db_uri_password]@db.internal/app then mail ops@example.com",
    );
  });

  it("masks each DSN separately in a comma-joined list", () => {
    // Adversarial case for the MAJOR-3 fix: the password class now
    // INCLUDES `@`, so greedy matching backs off to the LAST `@`. The
    // hazard that introduces is one match swallowing two DSNs and hiding
    // the first host. It does not — `/` terminates the authority, so the
    // first URI's path ends the first match.
    const a = "Ab" + "3xQ" + "9zK";
    const b = "Zt" + "7wM" + "2vR";
    const out = redact(
      "postgres://u1:" + a + "@h1.internal:5432/a,postgres://u2:" + b + "@h2.internal:5432/b",
    );
    expect(out).toBe(
      "postgres://u1:[REDACTED:db_uri_password]@h1.internal:5432/a," +
        "postgres://u2:[REDACTED:db_uri_password]@h2.internal:5432/b",
    );
  });

  it("does not run a password past a query or fragment delimiter", () => {
    const pw = "Ab" + "3xQ" + "9zK";
    expect(redact("mysql://u:" + pw + "@host/db?opt=x@y")).toBe(
      "mysql://u:[REDACTED:db_uri_password]@host/db?opt=x@y",
    );
    expect(redact("redis://u:" + pw + "@host#frag@z")).toBe(
      "redis://u:[REDACTED:db_uri_password]@host#frag@z",
    );
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

  it("does NOT fire on prose that ENDS the sentence", () => {
    // #3982 review, BLOCKER 2. The value class is `[^\s"']`, so the
    // sentence terminator was captured INTO the value and the `.` itself
    // supplied the second character class the gate asks for. Every string
    // below redacted as a credential on the shipped code — and
    // sentence-final is the most common position for these words, so the
    // suite's original "mid-sentence" cases were tests chosen to pass.
    //
    // The cost was not just noise: "Ken confirmed the password is
    // unchanged." stored as "…the password is [REDACTED:...]", which
    // INVERTS the meaning for every later recall.
    for (const prose of [
      "The password is required.",
      "The password is incorrect.",
      "The password is unchanged.",
      "The password is different.",
      "The password is protected.",
      "Ken confirmed the password is unchanged.",
      "password: required, minimum twelve characters, mixed case",
      "The passphrase is unchanged; rotate it next quarter.",
    ]) {
      expect(redact(prose)).toBe(prose);
    }
  });

  it("still masks a real password that ends a sentence, punctuation included", () => {
    const password = "Mango" + "TreeHouse77";
    const out = redact("The wifi password is " + password + ".");
    expect(out).toBe("The wifi password is [REDACTED:memorable_password]");
    expect(out).not.toContain(password);
  });

  it("does not leak the last byte of a password that ends in punctuation", () => {
    // Masking only the punctuation-stripped core would leave a real
    // trailing `!` in clear.
    const password = "Fluffy" + "Barnaby" + "1998!";
    const out = redact("password: " + password);
    expect(out).toBe("password: [REDACTED:memorable_password]");
  });

  it("classifies candidate values by character-class breadth", () => {
    expect(looksLikeMemorablePassword("Fluffy" + "Barnaby" + "1998")).toBe(true);
    expect(looksLikeMemorablePassword("rotated")).toBe(false); // too short + 1 class
    expect(looksLikeMemorablePassword("quarterly")).toBe(false); // 1 class
    expect(looksLikeMemorablePassword("required.")).toBe(false); // punctuation != a class
    expect(looksLikeMemorablePassword("unchanged.")).toBe(false);
    expect(looksLikeMemorablePassword("incorrect,")).toBe(false);
    expect(looksLikeMemorablePassword("aaaaaaaaaa1A")).toBe(false); // <4 distinct chars
    expect(looksLikeMemorablePassword("${SOME_VAR}")).toBe(false);
  });
});

describe("inert values are not credentials (MAJOR 5)", () => {
  // The inert-value list existed before #3982's review but applied ONLY
  // to the new memorable_password rule, so LETTER CASE decided whether a
  // vault reference survived: the ALL-CAPS spelling matched
  // `env_key_value` and was destroyed, the lowercase one matched
  // `memorable_password` and survived. A vault key NAME is exactly what
  // switchroom wants an agent to remember, and `src/cli/memory.ts`
  // prints a "credential-shaped text was replaced" warning each time —
  // so the false positives were also training operators to ignore it.
  it("preserves placeholders and references regardless of case", () => {
    for (const line of [
      "POSTGRES_PASSWORD: vault:pg/password",
      "postgres_password: vault:pg/password",
      "ANTHROPIC_API_KEY: vault:anthropic/api_key",
      "PASSWORD: ${DB_PASSWORD}",
      "password: ${DB_PASSWORD}",
      "API_TOKEN=%API_TOKEN%",
      "JWT_SECRET=<generate-with-openssl-rand>",
      "DB_PASSWORD=changeme-in-production",
      "const API_KEY = process.env.ANTHROPIC_API_KEY",
      '{"token": "the bearer token to use"}',
      "--token <value>   the API token",
    ]) {
      expect(redact(line)).toBe(line);
    }
  });

  it("still masks a REAL value in the same slots", () => {
    // The gate must not become a way to smuggle a credential through.
    const token = "zQ7x" + "Vb2n" + "Kd9w" + "Rt4y";
    for (const line of [
      "POSTGRES_PASSWORD: " + token,
      "ANTHROPIC_API_KEY=" + token,
      '{"token": "' + token + '"}',
      "--token " + token,
    ]) {
      expect(redact(line)).not.toContain(token);
    }
  });
});

describe("authorization headers (MAJOR 6)", () => {
  it("masks a lowercased bearer header (HTTP/2 wire form)", () => {
    const token = "AAAABBBB" + "CCCCDDDD" + "EEEEFFFF";
    for (const line of [
      "Authorization: Bearer " + token,
      "authorization: bearer " + token,
      "AUTHORIZATION: BEARER " + token,
    ]) {
      const out = redact(line);
      expect(out).not.toContain(token);
      expect(out).toContain("[REDACTED:bearer_auth_header]");
    }
  });

  it("masks a Basic header — base64 is an encoding, not a cipher", () => {
    const creds = "YWxpY2U6" + "c3VwZXJzZWNyZXQ=";
    for (const line of [
      "Authorization: Basic " + creds,
      "authorization: basic " + creds,
    ]) {
      const out = redact(line);
      expect(out).not.toContain(creds);
      expect(out).toContain("[REDACTED:basic_auth_header]");
    }
  });

  it("does not fire on the WORD bearer in prose", () => {
    const prose = "ask the bearer of the token to rotate it";
    expect(redact(prose)).toBe(prose);
  });
});
