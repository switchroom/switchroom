/**
 * Regression proof for `parse_pg_search_index_casts()` — the cast parser the
 * pg_search drift checkers run on every boot (switchroom #4526, WP-pre of the
 * Hindsight 0.9.0 epic #4525).
 *
 * THE DEFECT. `_FIELD_CAST_RE` anchored the field name at `^`:
 *
 *     r"^\"?(?P<field>[A-Za-z_][A-Za-z0-9_$]*)\"?\s*::\s*pdb\.(?P<cast>\S.*)$"
 *
 * That matches the DDL switchroom WRITES — `(bank_id::pdb.literal)` — but not
 * the DDL PostgreSQL REPORTS. `pg_get_indexdef` (and therefore
 * `pg_indexes.indexdef`) re-renders the normalised expression tree, which puts
 * the cast operand in its own parens: `((bank_id)::pdb.literal)`.
 * `_strip_outer_parens` removes only the whole-item pair, leaving
 * `(bank_id)::pdb.literal`, which the `^`-anchored pattern cannot match. The
 * parser therefore dropped every filter column, and
 * `check_pg_search_filter_field_drift` logged
 *
 *     pg_search_filter_field_drift ... missing=['bank_id', 'fact_type']
 *
 * on a perfectly healthy production index — a pure false positive
 * (`paradedb.schema()` lists both fields and `EXPLAIN` shows both predicates
 * pushed inside the ParadeDB scan; nothing was wrong with the index).
 *
 * WHY THE FIXTURE IS REAL CATALOG OUTPUT AND NOT HAND-WRITTEN DDL. The whole
 * bug is that hand-written DDL and catalog-normalised DDL differ. Every
 * existing probe in this directory feeds the parser DDL written by hand in the
 * test, which is why none of them caught this. `tests/fixtures/
 * pg-search-live-indexdef.txt` is therefore verbatim `psql -tA` output,
 * captured read-only from the live fleet on 2026-08-08:
 *
 *     SELECT indexdef FROM pg_indexes
 *      WHERE indexname = 'idx_memory_units_text_search';
 *
 * `guards the fixture against being "fixed"` below fails if anyone rewrites it
 * into the un-normalised form, which would make this whole file vacuous.
 *
 * WHY THIS RUNS EVERYWHERE (no docker, no 6.4GB image). The parser is pure
 * Python with no hindsight imports, so the shipping source is extracted from
 * the Dockerfile's own patch heredocs (never duplicated here) and executed on
 * the host interpreter. The heavier behavioural probes in
 * `hindsight-pg-search-{tokenizer-drift,filter-pushdown}-patch.test.ts` still
 * own the docker-bound end-to-end properties.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIVE_INDEXDEF = readFileSync(
  resolve(root, "tests/fixtures/pg-search-live-indexdef.txt"),
  "utf8",
).trim();

/**
 * Driver: lift the shipping parser out of the Dockerfile and exercise it.
 *
 * Both blocks are needed. The tokenizer-drift block carries the parser and the
 * drift checkers in a `GUARD` string; the filter-pushdown block carries
 * `pg_search_filter_fields`, which `check_pg_search_filter_field_drift` calls
 * to learn which columns `memory_units` must index. Both are located by their
 * unique in-block patch names and pulled out with `ast`, so this test executes
 * the exact bytes that get baked into the image.
 */
const DRIVER = String.raw`
import ast
import json
import re
import sys

dockerfile = open(sys.argv[1]).read()
indexdef = open(sys.argv[2]).read().strip()

blocks = re.findall(r"^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$", dockerfile, re.M)


def block(name):
    hits = [b for b in blocks if name in b]
    assert len(hits) == 1, "%d %r blocks (expected 1)" % (len(hits), name)
    return hits[0]


def guard_string(src, var):
    for node in ast.parse(src).body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == var:
            return node.value.value
    raise AssertionError("no %s assignment in patch block" % var)


def patch_replacement(src, rel):
    """The third (replacement) argument of the first patch(rel, ...) call."""
    for node in ast.walk(ast.parse(src)):
        if (
            isinstance(node, ast.Call)
            and getattr(node.func, "id", "") == "patch"
            and node.args
            and getattr(node.args[0], "value", None) == rel
        ):
            return node.args[2].value
    raise AssertionError("no patch(%r, ...) call in patch block" % rel)


pushdown = patch_replacement(block("pg_search filter-field pushdown"), "_pg_search.py")
guard = guard_string(block("pg_search tokenizer-drift guard"), "GUARD")

# The three names _pg_search.py already imports at module scope (the drift patch
# adds "logging" itself); everything else the guard needs it defines.
ns = {}
exec(
    compile(
        "import logging\nimport re\nfrom collections.abc import Sequence\n"
        + pushdown
        + "\n"
        + guard,
        "<Dockerfile.hindsight pg_search source>",
        "exec",
    ),
    ns,
)

parse = ns["parse_pg_search_index_casts"]
drift = ns["check_pg_search_filter_field_drift"]

out = {"casts": parse(indexdef)}

out["drift_live"] = drift(
    indexdef, "memory_units", index_name="idx_memory_units_text_search"
)

# A genuinely degraded index — same normalised spelling, fact_type absent — must
# still be reported, so the fix cannot be "make the checker never fire".
degraded = indexdef.replace(", ((fact_type)::pdb.literal)", "")
record = drift(degraded, "memory_units", index_name="idx_memory_units_text_search")
out["drift_degraded"] = None if record is None else {
    k: v for k, v in record.items() if k in ("missing_filter_fields", "index")
}

# The hand-written spelling (what switchroom's own DDL emits, pre-normalisation)
# must keep parsing — this is a widening, not a swap.
out["casts_handwritten"] = parse(
    "CREATE INDEX i ON public.memory_units USING bm25 "
    "(id, (text::pdb.simple('stemmer=english')), (bank_id::pdb.literal)) "
    "WITH (key_field=id)"
)

# It runs on the every-boot path: malformed input returns, never raises. The
# unbalanced entries also prove the paren-wrapped alternative is matched as a
# real pair rather than with optional parens.
hostile = [
    None,
    "",
    "not an index definition at all",
    "CREATE INDEX i ON t USING gin (search_vector)",
    "CREATE INDEX i ON t USING bm25 (id, ((text)::pdb.simple('unterminated",
    "CREATE INDEX i ON t USING bm25 (id, ((bank_id::pdb.literal)) WITH (key_field=id)",
    "CREATE INDEX i ON t USING bm25 (id, (bank_id)::pdb.literal) WITH (key_field=id)",
]
out["hostile"] = []
for item in hostile:
    try:
        out["hostile"].append({"ok": True, "casts": parse(item)})
    except Exception as exc:
        out["hostile"].append({"ok": False, "error": repr(exc)})

print(json.dumps(out, default=str))
`;

interface DriverOutput {
  casts: Record<string, string> | null;
  drift_live: unknown;
  drift_degraded: { missing_filter_fields?: string[]; index?: string } | null;
  casts_handwritten: Record<string, string> | null;
  hostile: { ok: boolean; casts?: unknown; error?: string }[];
}

const result: DriverOutput = (() => {
  const stdout = execFileSync(
    "python3",
    [
      "-",
      resolve(root, "docker/Dockerfile.hindsight"),
      resolve(root, "tests/fixtures/pg-search-live-indexdef.txt"),
    ],
    { input: DRIVER, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  return JSON.parse(stdout) as DriverOutput;
})();

describe("pg_search cast parser against REAL pg_get_indexdef output (#4526)", () => {
  it("guards the fixture against being 'fixed' into hand-written DDL", () => {
    // The catalog's normalised spelling — parens around the cast operand — is
    // the entire subject of this file. Rewriting the fixture to
    // `(bank_id::pdb.literal)` would make every assertion below pass against
    // the buggy parser.
    expect(LIVE_INDEXDEF).toContain("((bank_id)::pdb.literal)");
    expect(LIVE_INDEXDEF).toContain("((fact_type)::pdb.literal)");
    expect(LIVE_INDEXDEF).toMatch(/USING bm25 \(/);
  });

  it("parses every indexed field, including the paren-wrapped filter columns", () => {
    // Before the fix this returned only the four un-cast columns; bank_id and
    // fact_type were silently dropped.
    expect(result.casts).toEqual({
      id: "",
      text: "",
      context: "",
      text_signals: "",
      bank_id: "literal",
      fact_type: "literal",
    });
  });

  it("reports NO filter-field drift for the healthy live index", () => {
    // This is the false positive: `pg_search_filter_field_drift
    // idx_memory_units_text_search missing=['bank_id', 'fact_type']` logged on
    // an index that carries both.
    expect(result.drift_live).toBeNull();
  });

  it("still reports drift when a filter field is genuinely absent", () => {
    expect(result.drift_degraded).not.toBeNull();
    expect(result.drift_degraded?.missing_filter_fields).toEqual(["fact_type"]);
  });

  it("keeps parsing the un-normalised spelling switchroom's own DDL emits", () => {
    expect(result.casts_handwritten).toEqual({
      id: "",
      text: "simple('stemmer=english')",
      bank_id: "literal",
    });
  });

  it("never raises on malformed or unbalanced index definitions", () => {
    for (const outcome of result.hostile) {
      expect(outcome.error ?? null, `parser raised: ${outcome.error}`).toBeNull();
      expect(outcome.ok).toBe(true);
    }
  });
});
