/**
 * Behavioural proof for the pg_search BM25 filter-field pushdown patch
 * (switchroom epic #4474, phase P4 / #4478).
 *
 * THE DEFECT (upstream, at the pinned digest): the ParadeDB BM25 index is
 * built over `(id, text, context[, text_signals])` only. Every recall keyword
 * arm filters on `bank_id = $n AND fact_type = '...'`, but because those two
 * columns are not in the index, ParadeDB cannot push the predicates into the
 * Tantivy scan — it degrades them to a post-scoring `heap_filter` inside the
 * custom scan. The BM25 arm therefore scores the WHOLE table and discards
 * almost everything afterwards. Measured on an 800k-row corpus: 171,517
 * shared buffer hits per arm uncorrected vs 405 corrected (423x), and the
 * uncorrected index is 2-10x SLOWER than the native tsvector+GIN comparator.
 *
 * THE FIX: append `(bank_id::pdb.literal), (fact_type::pdb.literal)` to the
 * index column list. Pushdown then happens automatically from the plain SQL
 * `WHERE` — no query change is needed, which is why `engine/sql/postgresql.py`
 * is deliberately NOT patched.
 *
 * The `literal` tokenizer is hard-coded and independent of the configured text
 * tokenizer: equality pushdown requires the whole column value to be a single
 * token, so a stemmed / ngram / lindera cast on a filter column would silently
 * stop the `=` predicate matching anything at all. Property 4 below is the
 * regression guard for exactly that.
 *
 * The six properties proved here:
 *   1. A FRESH install (the real `5a366d414dce_initial_schema` migration)
 *      creates the index WITH the literal-cast filter columns.
 *   2. A REBUILD that preserves a hand-built tokenizer (the real
 *      `a2b3c4d5e6f7_add_text_signals_column` migration) re-emits them too —
 *      a rebuild must never silently un-do the pushdown fix.
 *   3. The same holds on the honour-config rebuild branch.
 *   4. The filter cast NEVER follows the configured text tokenizer.
 *   5. The boot path REPORTS an index that lost the filter fields (log only —
 *      repairing on the boot path is the C2 fail-closed window), and does not
 *      false-alarm on a correct index or an unrelated table.
 *   6. It never raises and never re-emits an unsafe cast, on any hostile
 *      indexdef — it runs on every boot.
 *
 * The patch block is extracted from the Dockerfile itself rather than
 * duplicated here, so this test cannot drift from what actually ships. It
 * applies it by `docker exec` (not `docker build`) so it runs on daemons
 * without buildx, and it never touches the production `switchroom-hindsight`
 * container. No database is required: the DDL is observed as emitted SQL.
 *
 * SKIP DISCIPLINE: identical to `hindsight-pg-search-tokenizer-drift-patch.test.ts`.
 * Locally, with no docker or no cached image, this skips (never pull a 6.4GB
 * third-party image onto a dev box). In CI the `hindsight-probe` job pulls the
 * pinned digest and sets SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1, under which an
 * unavailable docker/image is a HARD FAILURE, never a green skip. Both runs
 * assert a `PROBE_EXECUTED` sentinel so a probe that dies early can never be
 * mistaken for a pass.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { execFileAsync } from "./_exec-async.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(
  resolve(root, "docker/Dockerfile.hindsight"),
  "utf8",
);

const RUN_ID = randomUUID();
const TEST_PHASE = "hindsight-pg-search-filter-pushdown-patch";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/**
 * The patches this file proves, named by their unique in-block markers.
 *
 * Two blocks, in Dockerfile order: the pushdown block installs the filter-field
 * helpers and the fresh-install create site; the tokenizer-drift block owns the
 * rebuild path and must re-emit the filter columns on BOTH of its branches.
 * Property 2 and 3 fail if either is applied without the other, which is the
 * point of applying them together here.
 */
const PATCH_NAMES = [
  "pg_search filter-field pushdown",
  "pg_search tokenizer-drift guard",
];

/** All `RUN python3 - <<'PYEOF' ... PYEOF` heredocs, in Dockerfile order. */
function allBlocks(): string[] {
  return [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
}

/**
 * The patch blocks under test, in Dockerfile order (the pushdown block defines
 * the helpers the drift block's rebuild calls, so order is load-bearing).
 */
function patchBlocks(): string[] {
  const blocks = allBlocks();
  const picked: string[] = [];
  for (const name of PATCH_NAMES) {
    const hits = blocks.filter((b) => b.includes(name));
    if (hits.length !== 1) {
      throw new Error(
        `Dockerfile.hindsight contains ${hits.length} "${name}" RUN blocks ` +
          `(expected exactly 1) — if the patch was deliberately removed, delete ` +
          `this test with it.`,
      );
    }
    picked.push(hits[0]);
  }
  // Preserve Dockerfile order regardless of PATCH_NAMES ordering.
  return blocks.filter((b) => picked.includes(b));
}

/**
 * Python probe. Exits 0 only when all six properties above hold; prints the
 * offending assertions otherwise.
 *
 * Deliberately asserts OUTCOMES: properties 1-3 run the REAL shipping
 * migrations against a fake alembic boundary and read back the DDL they emit,
 * rather than grepping the patched source.
 */
const PROBE = String.raw`
import importlib.util
import json
import os
import sys

failures = []


def fail(msg):
    failures.append(msg)


os.environ["HINDSIGHT_API_TEXT_SEARCH_EXTENSION"] = "pg_search"
os.environ.pop("HINDSIGHT_API_TEXT_SEARCH_EXTENSION_PG_SEARCH_TOKENIZER", None)

INIT_MIG = "/app/api/hindsight_api/alembic/versions/5a366d414dce_initial_schema.py"
SIGNALS_MIG = "/app/api/hindsight_api/alembic/versions/a2b3c4d5e6f7_add_text_signals_column.py"

STEM = "simple('stemmer=english', 'stopwords_language=english')"

# A hand-built "Variant B" index as it appears in pg_indexes.indexdef: stemmed,
# and with NO filter fields — i.e. exactly the live production shape #4478 is
# about to correct.
LIVE_STEMMED = (
    "CREATE INDEX idx_memory_units_text_search ON public.memory_units USING bm25 "
    "(id, (text::pdb.%s), (context::pdb.%s)) WITH (key_field='id')" % (STEM, STEM)
)
# An expressible drift: the rebuild resolves this one in favour of config.
LIVE_ICU = (
    "CREATE INDEX idx_memory_units_text_search ON public.memory_units USING bm25 "
    "(id, (text::pdb.icu), (context::pdb.icu)) WITH (key_field='id')"
)
CORRECTED = (
    "CREATE INDEX idx_memory_units_text_search ON public.memory_units USING bm25 "
    "(id, text, context, text_signals, (bank_id::pdb.literal), (fact_type::pdb.literal)) "
    "WITH (key_field='id')"
)


# --- fakes at the alembic boundary ONLY ---------------------------------------
class _Result:
    def __init__(self, value):
        self._value = value

    def scalar(self):
        # The initial-schema migration probes pg_extension with .scalar();
        # a truthy answer means "the configured extension is installed".
        return 1 if self._value is None else self._value

    def fetchone(self):
        return (1,)


class _Bind:
    dialect = type("_Dialect", (), {"name": "postgresql"})()

    def __init__(self, indexdef):
        self.indexdef = indexdef

    def execute(self, statement, params=None):
        return _Result(self.indexdef)

    def exec_driver_sql(self, statement, params=None):
        return _Result(self.indexdef)


class _Recorder:
    def __init__(self, calls, name):
        self.calls = calls
        self.name = name

    def __call__(self, *args, **kwargs):
        self.calls.append(self.name)


class FakeOp:
    def __init__(self, indexdef=None):
        self.sql = []
        self.calls = []
        self._bind = _Bind(indexdef)

    def execute(self, statement):
        self.sql.append(" ".join(str(statement).split()))

    def get_bind(self):
        return self._bind

    def __getattr__(self, name):
        # create_table / create_index / add_column ... are structural DDL this
        # probe does not read; swallow them so the real upgrade() can run.
        return _Recorder(self.__dict__.setdefault("calls", []), name)


class _FakeConfig:
    def get_main_option(self, name, default=None):
        return None


class FakeContext:
    config = _FakeConfig()


def load_migration(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def bm25_ddl(path, name, indexdef=None):
    """Run the REAL migration's _pg_upgrade and return the bm25 CREATE INDEX."""
    mod = load_migration(path, name)
    fake = FakeOp(indexdef)
    mod.op = fake
    mod.context = FakeContext()
    mod._pg_upgrade()
    created = [
        s
        for s in fake.sql
        if s.upper().startswith("CREATE INDEX") and "USING bm25" in s
    ]
    if len(created) != 1:
        fail(
            "%s emitted %d bm25 CREATE INDEX statements (expected 1): %s"
            % (name, len(created), created)
        )
        return ""
    return created[0]


FILTER_CASTS = ("(bank_id::pdb.literal)", "(fact_type::pdb.literal)")


def assert_pushdown(label, ddl):
    for cast in FILTER_CASTS:
        if cast not in ddl:
            fail(
                "NO FILTER PUSHDOWN (%s): %s missing from the index, so every "
                "BM25 arm scores the whole table and filters on the heap -> %s"
                % (label, cast, ddl)
            )


# --- 1. a FRESH install indexes the filter fields ------------------------------
fresh_ddl = bm25_ddl(INIT_MIG, "sr_probe_initial_schema")
print("FRESH_DDL", fresh_ddl)
assert_pushdown("fresh install", fresh_ddl)
if "key_field='id'" not in fresh_ddl:
    fail("fresh install lost key_field='id': " + fresh_ddl)

# --- 2. a preserve-observed REBUILD re-emits them ------------------------------
preserve_ddl = bm25_ddl(SIGNALS_MIG, "sr_probe_text_signals_a", LIVE_STEMMED)
print("PRESERVE_DDL", preserve_ddl)
assert_pushdown("preserve-observed rebuild", preserve_ddl)
if "stemmer=english" not in preserve_ddl:
    fail("the pushdown fix regressed the #4474/C1 stemmer preservation: " + preserve_ddl)
if "text_signals" not in preserve_ddl:
    fail("rebuild lost text_signals — the migration's own purpose: " + preserve_ddl)

# --- 3. an honour-config REBUILD re-emits them too -----------------------------
config_ddl = bm25_ddl(SIGNALS_MIG, "sr_probe_text_signals_b", LIVE_ICU)
print("CONFIG_DDL", config_ddl)
assert_pushdown("honour-config rebuild", config_ddl)

try:
    import hindsight_api._pg_search as pgs
except Exception as exc:  # pragma: no cover - import cannot fail in the image
    pgs = None
    fail("could not import hindsight_api._pg_search: %r" % (exc,))

filter_fields = getattr(pgs, "pg_search_filter_fields", None) if pgs else None
if filter_fields is None:
    fail(
        "NO FILTER-FIELD MAP: nothing declares that memory_units' bank_id/fact_type "
        "must be indexed, so the BM25 arm's WHERE can never be pushed down"
    )
else:
    if tuple(filter_fields("memory_units")) != ("bank_id", "fact_type"):
        fail("memory_units filter fields are %r" % (filter_fields("memory_units"),))
    # Scoped to the one table that actually has a BM25 search arm.
    for other in ("reflections", "memory_links", "", None):
        if filter_fields(other):
            fail("filter fields claimed for %r, which has no BM25 search arm" % (other,))
    # Schema-qualified and quoted names resolve to the same table.
    if tuple(filter_fields('public."MEMORY_UNITS"')) != ("bank_id", "fact_type"):
        fail("schema-qualified/quoted table name did not resolve to memory_units")

# --- 4. the filter cast NEVER follows the configured text tokenizer ------------
build = getattr(pgs, "pg_search_bm25_columns", None) if pgs else None
if build is not None and filter_fields is not None:
    for tok in ("ngram(2,3)", "icu", "jieba", "lindera(japanese)", "simple", None):
        cols = build("id", ("text", "context"), tok, filter_fields("memory_units"))
        for cast in FILTER_CASTS:
            if cast not in cols:
                fail(
                    "with tokenizer %r the filter column is not literal-cast: %r — "
                    "a non-literal filter column makes the equality predicate match NOTHING"
                    % (tok, cols)
                )
    print("NGRAM_COLS", build("id", ("text",), "ngram(2,3)", filter_fields("memory_units")))
    # Callers that pass no filter fields must be byte-identical to upstream.
    if build("id", ("text", "context"), "icu") != "id, (text::pdb.icu), (context::pdb.icu)":
        fail("the default (no filter fields) column build diverged from upstream")

# --- 5. the boot path REPORTS a live index that lost the filter fields ---------
check = getattr(pgs, "check_pg_search_filter_field_drift", None) if pgs else None
if check is None:
    fail(
        "NO FILTER-FIELD DRIFT DETECTOR: an index that cannot push bank_id/fact_type "
        "down is adopted silently and the 423x buffer amplification is invisible"
    )
else:
    record = check(LIVE_STEMMED, "memory_units", index_name="idx")
    if not record:
        fail("drift detector returned nothing for an index with NO filter fields")
    else:
        print("DRIFT_RECORD", json.dumps(record, default=str, sort_keys=True))
        if sorted(record.get("missing_filter_fields") or []) != ["bank_id", "fact_type"]:
            fail("drift record does not name both missing filter fields: %r" % (record,))

    wrongly = check(
        "CREATE INDEX i ON public.memory_units USING bm25 "
        "(id, text, (bank_id::pdb.icu), (fact_type::pdb.literal)) WITH (key_field='id')",
        "memory_units",
        index_name="idx",
    )
    if not wrongly or (wrongly.get("wrongly_tokenized_filter_fields") or []) != ["bank_id"]:
        fail("a non-literal bank_id cast was not reported as drift: %r" % (wrongly,))

    # no false alarms
    if check(CORRECTED, "memory_units", index_name="idx") is not None:
        fail("drift reported for an index that already carries both filter fields")
    if check(LIVE_STEMMED, "reflections", index_name="idx") is not None:
        fail("drift reported for a table with no BM25 search arm")

# --- 6. it never raises and never re-emits an unsafe cast ----------------------
HOSTILE = [
    None,
    "",
    "not an index definition at all",
    "CREATE INDEX i ON t USING gin (search_vector)",
    "CREATE INDEX i ON public.memory_units USING bm25 (id, (text::pdb.simple('unterminated",
    "CREATE INDEX i ON public.memory_units USING bm25 (",
    "CREATE INDEX i ON public.memory_units USING bm25 "
    "(id, (bank_id::pdb.simple('a'); DROP TABLE x --')) WITH (key_field='id')",
]
rebuild_cols = getattr(pgs, "pg_search_rebuild_bm25_columns", None) if pgs else None
if check is not None and rebuild_cols is not None:
    for hostile in HOSTILE:
        for table in ("memory_units", "t", None):
            try:
                check(hostile, table, index_name="i")
            except Exception as exc:
                fail(
                    "filter-field drift detector RAISED on (%r, %r): %r — this runs "
                    "on the every-boot path" % (hostile, table, exc)
                )
            try:
                out = rebuild_cols(
                    hostile, "id", ("text", "context"), "", table=table, index_name="i"
                )
            except Exception as exc:
                fail("rebuild builder RAISED on (%r, %r): %r" % (hostile, table, exc))
            else:
                if ";" in out or "--" in out:
                    fail(
                        "rebuild builder re-emitted an unsafe cast from %r: %r"
                        % (hostile, out)
                    )

print("FAILURES", json.dumps(failures))
print("PROBE_EXECUTED")
sys.exit(1 if failures else 0)
`;

function hasDocker(): boolean {
  try {
    execSync("docker version --format '{{.Server.Version}}'", {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function hasImage(ref: string): boolean {
  try {
    execSync(`docker image inspect ${ref}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * CI marker. When set, this suite MUST really execute — an absent docker or
 * an absent upstream image becomes a hard failure instead of a green skip.
 * `.github/workflows/docker-e2e.yml` sets it after pulling the pinned digest.
 */
const REQUIRED = process.env.SWITCHROOM_REQUIRE_HINDSIGHT_PROBE === "1";

const dockerOk = hasDocker();
const imageOk = dockerOk && hasImage(UPSTREAM_IMAGE);

type ProbeResult = { status: number; stdout: string };

/** Run the probe in a throwaway container, optionally patching first. */
async function runProbe(patched: boolean): Promise<ProbeResult> {
  const name = `sr-hs-pgspush-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
    0,
    8,
  )}`;
  try {
    await execFileAsync("docker", [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        `switchroom.test=${TEST_PHASE}`,
        "--label",
        `switchroom.test.run=${RUN_ID}`,
        "--user",
        "root",
        "--network",
        "none",
        UPSTREAM_IMAGE,
        "sleep",
        "300",
      ]);

    if (patched) {
      for (const block of patchBlocks()) {
        // The block is self-verifying: it asserts its upstream anchors exist
        // exactly once each and re-asserts the result, so a non-zero exit here
        // means upstream drifted and the patch must be re-authored.
        await execFileAsync("docker", ["exec", "-i", name, "python3", "-"], { input: block });
      }
    }

    const res = await execFileAsync("docker", ["exec", "-i", "-w", "/app/api", name, "/app/api/.venv/bin/python", "-"], { input: PROBE });
    return { status: 0, stdout: res.stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return {
      status: err.status ?? -1,
      stdout: (err.stdout ?? "").toString(),
    };
  } finally {
    try {
      await execFileAsync("docker", ["rm", "-f", name]);
    } catch {
      /* already gone */
    }
  }
}

describe("Dockerfile.hindsight pg_search filter-pushdown probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("extracts exactly the two patch blocks it claims to prove, in Dockerfile order", () => {
    const picked = patchBlocks();
    expect(picked).toHaveLength(2);
    // The pushdown block defines the helpers the drift block's rebuild calls.
    expect(picked[0]).toContain(PATCH_NAMES[0]);
    expect(picked[1]).toContain(PATCH_NAMES[1]);
  });

  it("hard-fails rather than skipping when CI demands a real run", () => {
    if (!REQUIRED) {
      // Local/dev path: skipping is legitimate (never pull a 6.4GB image onto
      // a dev box), but it must be visible rather than silent.
      expect(
        REQUIRED,
        "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE is unset — the behavioural probe " +
          "is advisory here. CI's hindsight-probe job sets it after pulling " +
          `${UPSTREAM_IMAGE}.`,
      ).toBe(false);
      return;
    }
    expect(
      dockerOk,
      "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but the docker daemon is unreachable",
    ).toBe(true);
    expect(
      imageOk,
      `SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but ${UPSTREAM_IMAGE} is not present ` +
        "locally — the workflow must pull the pinned digest before running this suite",
    ).toBe(true);
  });
});

describe.skipIf(!dockerOk || !imageOk)(
  "Dockerfile.hindsight pg_search filter-pushdown patch changes real behaviour",
  () => {
    afterAll(() => {
      // Label-scoped teardown belt (never an unlabelled bulk removal).
      try {
        const ids = execSync(
          `docker ps -aq --filter label=switchroom.test.run=${RUN_ID}`,
          { encoding: "utf8" },
        )
          .split("\n")
          .filter(Boolean);
        if (ids.length) {
          execFileSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
        }
      } catch {
        /* nothing to clean */
      }
    });

    it("unpatched upstream is RED — the shipping migrations build an index that cannot push bank_id/fact_type down", async () => {
      const { status, stdout } = await runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // The defect, driven: a fresh install indexes only (id, text, context).
      expect(stdout).toMatch(
        /FRESH_DDL .*USING bm25 \(id, text, context\) WITH \(key_field='id'\)/,
      );
      expect(stdout).toContain("NO FILTER PUSHDOWN (fresh install)");
      expect(stdout).toContain("NO FILTER-FIELD MAP");
      expect(stdout).toContain("NO FILTER-FIELD DRIFT DETECTOR");
    }, 240_000);

    it("upstream + the baked patch blocks is GREEN on all six properties", async () => {
      const { status, stdout } = await runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      // 1. fresh install carries the literal-cast filter columns.
      expect(stdout).toMatch(
        /FRESH_DDL .*USING bm25 \(id, text, context, \(bank_id::pdb\.literal\), \(fact_type::pdb\.literal\)\)/,
      );
      // 2. the preserve-observed rebuild keeps BOTH the #4474/C1 stemmer and
      //    the #4478 filter columns.
      expect(stdout).toMatch(
        /PRESERVE_DDL .*text_signals::pdb\.simple.*\(bank_id::pdb\.literal\), \(fact_type::pdb\.literal\)/,
      );
      // 3. the honour-config rebuild does too.
      expect(stdout).toMatch(
        /CONFIG_DDL .*\(bank_id::pdb\.literal\), \(fact_type::pdb\.literal\)/,
      );
      // 4. an ngram text tokenizer does not leak onto the filter columns.
      expect(stdout).toContain(
        "NGRAM_COLS id, (text::pdb.ngram(2,3)), (bank_id::pdb.literal), (fact_type::pdb.literal)",
      );
      // 5. the loss is named, not merely repaired.
      expect(stdout).toMatch(
        /DRIFT_RECORD .*"missing_filter_fields": \["bank_id", "fact_type"\]/,
      );
    }, 240_000);
  },
);
