/**
 * DIFFERENTIAL test — run BOTH redaction engines over the same corpus and
 * compare their output byte for byte.
 *
 * Why this file exists (#3982 adversarial review, BLOCKER 1 + MAJOR 4):
 *
 * The write-path work shipped two anti-fork mechanisms and neither could
 * see the fork that actually existed.
 *
 *   1. `check-secret-pattern-parity` byte-compares the generated table
 *      against `patterns.ts`. It proves the pattern SOURCES are equal —
 *      and the sources WERE equal. Identical source is not identical
 *      behaviour: Python `re` treats `\b` / `\w` / `\d` and `re.I`
 *      case-folding as UNICODE-aware for `str` patterns, JavaScript
 *      `RegExp` without the `u` flag treats them as ASCII-only. Every
 *      generated rule is `\b`-anchored, so a synthetic `sk-ant-`-shaped
 *      key written next to Japanese, Chinese, Russian or accented-Latin
 *      text was masked by TypeScript and stored VERBATIM by Python.
 *      CJK has no word spacing, so "token abutting a non-ASCII letter"
 *      is the ordinary case, not an exotic one.
 *   2. `secret_redaction_vectors.json` pins BEHAVIOUR — but every vector
 *      it shipped with exercised only the two hand-written imperative
 *      rules. Zero vectors touched any of the ~60 GENERATED patterns, so
 *      the whole generated table had no behavioural coverage at all.
 *
 * Fixed vectors are still the primary contract (they pin what the output
 * should BE, which a differential test cannot). This file adds the thing
 * neither mechanism had: a machine-generated corpus, wide enough to cover
 * combinations nobody thought to write down, run through both engines
 * with the outputs compared. A future semantic divergence — a new
 * shorthand class, an `re.I` folding difference, a `\s` definition
 * mismatch — fails HERE without anyone having predicted it.
 *
 * The Python half runs in a real `python3` subprocess importing the
 * shipped `lib/secret_redact.py`. That is deliberate: an in-process
 * re-implementation would be a third engine, and a third engine can fork
 * too.
 *
 * Every credential-shaped literal is synthetic, assembled at runtime, and
 * never echoed into an assertion message — divergences are reported by
 * family + neighbour codepoint only.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { redact } from "../secret-detect/redact.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY_SCRIPTS_DIR = join(repoRoot, "vendor", "hindsight-memory", "scripts");

/**
 * Read a JSON array of strings on stdin, write the redacted array on
 * stdout. Nothing is printed to stdout except the JSON, so a stray
 * warning cannot be mistaken for output.
 */
const PY_DRIVER = [
  "import json,sys",
  "sys.path.insert(0, sys.argv[1])",
  "from lib.secret_redact import redact",
  "data = json.load(sys.stdin)",
  "sys.stdout.write(json.dumps([redact(s) for s in data]))",
].join("\n");

function pythonRedactAll(inputs: string[]): string[] {
  const out = execFileSync("python3", ["-c", PY_DRIVER, PY_SCRIPTS_DIR], {
    input: JSON.stringify(inputs),
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out) as string[];
}

// ─── Corpus ───────────────────────────────────────────────────────────

/** One synthetic credential per family the generated table claims to cover. */
const FILL = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJ";
const FAMILIES: Record<string, string> = {
  anthropic_api_key: "sk-" + "ant-" + "api03-" + FILL,
  openai_api_key: "sk-" + FILL + "KKKK",
  github_pat: "ghp_" + FILL.slice(0, 36),
  aws_access_key: "AKIA" + FILL.slice(0, 16),
  google_api_key: "AIza" + FILL.slice(0, 35),
  slack_token: "xoxb-" + "111111111111" + "-" + FILL.slice(0, 24),
  jwt: "eyJ" + "AAAABBBBCCCC" + "." + "DDDDEEEEFFFF" + "." + "GGGGHHHHIIII",
  telegram_bot_token: "1234567" + ":" + FILL.slice(0, 30),
  laravel_sanctum_token: "17|" + FILL,
  env_key_value: "API_TOKEN=" + "zQ7x" + "Vb2n" + "Kd9w" + "Rt4y",
  bearer_header: "Authorization: Bearer " + FILL.slice(0, 24),
  basic_header: "Authorization: Basic " + "YWxpY2U6" + "c3VwZXJzZWNyZXQ=",
  db_uri: "postgres://appuser:" + "LmN0pQrS7t" + "@db.internal:5432/prod",
  memorable_password: "wifi password: " + "Fluffy" + "Barnaby" + "1998",
};

/**
 * Neighbour characters placed immediately before and after the
 * credential. The non-ASCII entries are the whole point: they are where
 * `\b` means different things in the two engines. The whitespace entries
 * cover the OPPOSITE hazard — JS `\s` is Unicode-aware without `/u`, so
 * a naive `re.ASCII` port would fork on the SEPARATOR instead.
 */
const NEIGHBOURS = [
  "",
  " ",
  "\n",
  "\t",
  ".",
  ",",
  ")",
  '"',
  "'",
  "-",
  "_",
  "/",
  "é", // é  — accented Latin
  "к", // к  — Cyrillic
  "中", // 中 — CJK (no word spacing: the ordinary case)
  "あ", // あ — Japanese kana
  "ก", // ก — Thai
  "ω", // ω — Greek
  " ", // NBSP        — JS \s matches, ASCII \s does not
  "　", // ideographic space — same
  "﻿", // BOM         — same
  "K", // K (Kelvin sign) — re.I folds this to 'k' in Unicode mode
  "ſ", // ſ (long s)      — re.I folds this to 's' in Unicode mode
];

/** Prose that must survive both engines untouched. */
const NEGATIVES = [
  "The password is required.",
  "The password is incorrect.",
  "Ken confirmed the password is unchanged.",
  "password: required, minimum twelve characters, mixed case",
  "POSTGRES_PASSWORD: vault:pg/password",
  "postgres_password: vault:pg/password",
  "PASSWORD: ${DB_PASSWORD}",
  "JWT_SECRET=<generate-with-openssl-rand>",
  "ANTHROPIC_API_KEY: vault:anthropic/api_key",
  "const API_KEY = process.env.ANTHROPIC_API_KEY",
  "--token <value>   the API token",
  '{"token": "the bearer token to use"}',
  "I told him the answer was probably Gandalf the Grey.",
  "他のパスワードは安全です。",
];

interface Case {
  text: string;
  family: string;
  pre: string;
  post: string;
  /**
   * True when the neighbours leave the rule's `\b` anchors intact, i.e.
   * when a hit is EXPECTED. An empty neighbour glues the credential to
   * the surrounding `note`/`end` filler and a `_` is itself a word
   * character, so `noteAKIA…` is legitimately not a token in EITHER
   * engine — those cases still have to AGREE, but they must not be
   * asserted to mask.
   */
  anchored: boolean;
}

const isWordChar = (s: string) => /^[A-Za-z0-9_]$/.test(s);

function buildCorpus(): Case[] {
  const cases: Case[] = [];
  for (const [family, value] of Object.entries(FAMILIES)) {
    for (const pre of NEIGHBOURS) {
      for (const post of NEIGHBOURS) {
        // `note` / `end` supply the effective neighbour when the slot is
        // empty.
        const anchored =
          !isWordChar(pre === "" ? "e" : pre) &&
          !isWordChar(post === "" ? "e" : post);
        cases.push({
          text: `note${pre}${value}${post}end`,
          family,
          pre,
          post,
          anchored,
        });
      }
    }
  }
  for (const text of NEGATIVES) {
    cases.push({ text, family: "negative", pre: "", post: "", anchored: false });
  }
  return cases;
}

/** `U+0041` style, so a failure message never carries secret bytes. */
function cp(s: string): string {
  if (s === "") return "none";
  return `U+${s.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("TS and Python redactors agree (differential)", () => {
  const corpus = buildCorpus();
  const tsOut = corpus.map((c) => redact(c.text));
  const pyOut = pythonRedactAll(corpus.map((c) => c.text));

  it("covers every credential family across a wide neighbour matrix", () => {
    // A shrinking corpus would silently weaken the guarantee.
    expect(corpus.length).toBeGreaterThanOrEqual(1000);
    expect(Object.keys(FAMILIES).length).toBeGreaterThanOrEqual(14);
  });

  it("produces byte-identical output for every case", () => {
    const divergences = corpus
      .map((c, i) => ({ c, i }))
      .filter(({ i }) => tsOut[i] !== pyOut[i])
      .map(({ c, i }) => ({
        family: c.family,
        pre: cp(c.pre),
        post: cp(c.post),
        // Booleans only — never the text.
        tsMasked: tsOut[i]!.includes("[REDACTED"),
        pyMasked: pyOut[i]!.includes("[REDACTED"),
      }));
    expect(divergences).toEqual([]);
  });

  it("never lets one engine store a credential the other masked", () => {
    // The asymmetric half of the fork, stated as its own outcome: this is
    // the assertion that would have gone red on the shipped code.
    const leaks = corpus
      .map((c, i) => ({ c, i }))
      .filter(
        ({ c, i }) =>
          c.family !== "negative" &&
          !pyOut[i]!.includes("[REDACTED") &&
          tsOut[i]!.includes("[REDACTED"),
      )
      .map(({ c }) => ({ family: c.family, pre: cp(c.pre), post: cp(c.post) }));
    expect(leaks).toEqual([]);
  });

  it("masks the credential in both engines for every anchored case", () => {
    const anchored = corpus
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.anchored);
    // Sanity: the anchored subset must still be the bulk of the matrix,
    // otherwise the filter above could silently hollow this out.
    expect(anchored.length).toBeGreaterThanOrEqual(600);
    const missed = anchored
      .filter(
        ({ i }) =>
          !(tsOut[i]!.includes("[REDACTED") && pyOut[i]!.includes("[REDACTED")),
      )
      .map(({ c }) => ({ family: c.family, pre: cp(c.pre), post: cp(c.post) }));
    expect(missed).toEqual([]);
  });

  it("leaves prose untouched in both engines", () => {
    for (const [i, c] of corpus.entries()) {
      if (c.family !== "negative") continue;
      expect(tsOut[i]).toBe(c.text);
      expect(pyOut[i]).toBe(c.text);
    }
  });
});
