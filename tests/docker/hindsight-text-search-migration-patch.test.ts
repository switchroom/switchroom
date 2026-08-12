/**
 * Behavioural proof for the text-search backend migration-path fix (#4506)
 * that `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight
 * image.
 *
 * `dockerfile-hindsight-bakes.test.ts` pins the *shape* of that patch block
 * (grep-on-file, runs everywhere). This file proves the *outcome*: it runs the
 * same probe against unpatched upstream (which must be RED) and against
 * upstream + the patch block applied (which must be GREEN on every property).
 *
 * THE DEFECTS, all OBSERVED in a rehearsal against a clone of this fleet's
 * 801,792-row `memory_units` (switchroom-hindsight v0.20.14), following the
 * operator runbook that `docker/hindsight-entrypoint.sh` documented at the
 * time:
 *
 *  1. THE TRAPDOOR. `ensure_text_search_extension` decides "does the schema
 *     match the configured backend" on the (column, index) PAIR, then raises
 *     whenever a mismatched table has rows. A database whose text-search INDEX
 *     had been dropped while `search_vector` survived therefore raised on
 *     EVERY backend — including the one already in use. Held CONSTANT at
 *     pg_search, the rehearsal got, verbatim:
 *       RuntimeError: Cannot change text search extension from pg_textsearch
 *       to pg_search: the following tables contain data:
 *       memory_units(801792 rows).
 *     The database booted on no backend at all, and the error's own "set it
 *     back" advice could not work. The old runbook told operators to create
 *     exactly that state.
 *  2. NOBODY CREATES THE EXTENSION. `provision_pg_search()` stages the .so +
 *     control/sql files and deliberately does not touch the DB; the pg_search
 *     branch of the migration went straight to CREATE INDEX and died with
 *     `InvalidSchemaName: schema "pdb" does not exist`. The pgroonga branch
 *     already did the right thing.
 *  3. THE SECOND TABLE IS NEVER RECONCILED. `tables_to_check` names
 *     `reflections`, renamed to `mental_models` by alembic `t5o6p7q8r9s0`, so
 *     it matches nothing and that table keeps whatever index it had.
 *  4. THE ERROR MISREPORTS THE BACKEND. With `column=text, index=None` there
 *     is no index to read, yet it asserted `pg_textsearch` — and told the
 *     operator to DELETE FROM a table that does not exist.
 *  5. THE GUARD MUST STILL PROTECT A REAL LOSSY SWITCH. pg_search -> native on
 *     populated tables recreates `search_vector` EMPTY, and nothing backfills
 *     it (it is written only on INSERT), so that must still be refused. A
 *     "fix" that merely deleted the guard would pass 1-4 while silently making
 *     every existing row unsearchable.
 *  6. AN INDEX-ONLY REBUILD MUST NOT DISCARD A POPULATED COLUMN. Upstream's
 *     reconcile loop drops `search_vector` unconditionally, which is safe only
 *     while (1) makes an index-only rebuild unreachable.
 *  7. THE PRODUCTION SHAPE ITSELF. (1)-(6) each isolate one defect; none of
 *     them is the migration the operator procedure actually performs — a
 *     populated `memory_units` carrying a tsvector column under a live GIN
 *     index, flipped to pg_search. (2) is that shape at zero rows and (3) is
 *     it on the 43-row `mental_models`, so the row-count arm of the guard was
 *     never exercised on the real table. S7 covers it end to end at the
 *     fleet's actual row count, and pins the ORDER of the repair — stale index
 *     before its column, CREATE EXTENSION before the BM25 build that needs the
 *     `pdb` schema — plus the #4478 filter-pushdown fast fields on the
 *     rebuilt index.
 *
 * The probe drives the REAL shipping `ensure_text_search_extension` with a
 * fake ONLY at the SQLAlchemy boundary (`create_engine` / `to_libpq_url`): the
 * fake connection answers the introspection reads and records the DDL the
 * function actually emits. Nothing in it greps the patched source, and no
 * database is required.
 *
 * The patch block is extracted from the Dockerfile itself rather than
 * duplicated here, so this test cannot drift from what ships. It applies it by
 * `docker exec` (not `docker build`) so it runs on daemons without buildx, and
 * it never touches the production `switchroom-hindsight` container.
 *
 * SKIP DISCIPLINE: identical to
 * `hindsight-pg-search-tokenizer-drift-patch.test.ts`. Locally, with no docker
 * or no cached image, this skips (never pull a multi-GB third-party image onto
 * a dev box). In CI the probe job pulls the pinned digest and sets
 * SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1, under which an unavailable docker or
 * image is a HARD FAILURE, never a green skip. Both runs assert a
 * `PROBE_EXECUTED` sentinel so a probe that dies early can never be mistaken
 * for a pass.
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
const TEST_PHASE = "hindsight-text-search-migration-patch";

/** The pinned upstream image, read from the Dockerfile so it cannot drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/** The patch this file proves, named by its unique in-block marker. */
const PATCH_NAME = "text-search backend migration path";

/**
 * PREREQUISITES, applied first, in Dockerfile order. Both earlier blocks edit
 * `migrations.py` and this block's anchors are written against their output —
 * a real ordering dependency in the Dockerfile, so the probe reproduces it
 * rather than pretending the block is standalone. Their own assertions live in
 * `hindsight-pg-search-filter-pushdown-patch.test.ts` and
 * `hindsight-pg-search-tokenizer-drift-patch.test.ts`.
 */
const PREREQ_PATCH_NAMES = [
  "pg_search filter-field pushdown",
  "pg_search tokenizer-drift guard",
];

/**
 * The patch block under test plus its prerequisites, pulled out of the
 * Dockerfile's `RUN python3 - <<'PYEOF' ... PYEOF` heredocs by their unique
 * patch names and returned in Dockerfile (application) order.
 */
function patchBlocks(): string[] {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  const picked: string[] = [];
  for (const name of [...PREREQ_PATCH_NAMES, PATCH_NAME]) {
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
  return blocks.filter((b) => picked.includes(b));
}

/**
 * The Python probe. Exits 0 only when all seven properties above hold, and
 * prints the offending assertions otherwise. It asserts OUTCOMES: it runs the
 * real `ensure_text_search_extension` and reads back the DDL it emitted and
 * the exceptions it raised.
 */
const PROBE = String.raw`
import json
import re
import sys

import hindsight_api.migrations as M

failures = []


def fail(msg):
    failures.append(msg)


IDX_BM25_PG_SEARCH = (
    "CREATE INDEX idx_memory_units_text_search ON public.memory_units USING bm25 "
    "(id, text, context, text_signals) WITH (key_field='id')"
)
IDX_GIN = "CREATE INDEX idx_memory_units_text_search ON public.memory_units USING gin (search_vector)"


class _Res:
    def __init__(self, value=None, row=None):
        self._v = value
        self._r = row

    def scalar(self):
        return self._v

    def fetchone(self):
        return self._r


class FakeConn:
    """Answers ONLY the introspection reads; records every DDL statement."""

    def __init__(self, tables):
        # tables: name -> dict(udt_name=..., am=..., indexdef=..., rows=int)
        self.tables = tables
        self.sql = []
        self.committed = False

    def execute(self, statement, params=None):
        s = " ".join(str(statement).split())
        p = params or {}
        if "FROM information_schema.tables" in s:
            return _Res(value=p.get("table_name") in self.tables)
        if "FROM information_schema.columns" in s:
            t = self.tables.get(p.get("table_name"), {})
            udt = t.get("udt_name")
            if udt is None:
                return _Res(row=None)
            data_type = {"tsvector": "tsvector", "text": "text"}.get(udt, "USER-DEFINED")
            return _Res(row=(data_type, udt))
        if "FROM pg_indexes pi" in s:
            t = self.tables.get(p.get("table_name"), {})
            if not t.get("am"):
                return _Res(row=None)
            return _Res(row=(t["am"], t.get("indexdef")))
        if s.startswith("SELECT indexdef FROM pg_indexes"):
            name = (p or {}).get("index_name", "")
            for tn, t in self.tables.items():
                if name == "idx_%s_text_search" % tn:
                    return _Res(value=t.get("indexdef"))
            return _Res(value=None)
        if s.startswith("SELECT COUNT(*)"):
            for tn, t in self.tables.items():
                if s.endswith("public.%s" % tn):
                    return _Res(value=t.get("rows", 0))
            return _Res(value=0)
        if "FROM pg_extension" in s:
            return _Res(row=None)
        self.sql.append(s)
        return _Res()

    def commit(self):
        self.committed = True

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeEngine:
    def __init__(self, conn):
        self._conn = conn

    def connect(self):
        return self._conn


def run(tables, backend):
    """Drive the REAL ensure_text_search_extension; return (error, conn)."""
    conn = FakeConn(tables)
    orig_ce, orig_url = M.create_engine, M.to_libpq_url
    M.create_engine = lambda *a, **k: FakeEngine(conn)
    M.to_libpq_url = lambda u: u
    try:
        M.ensure_text_search_extension("postgresql://x/y", text_search_extension=backend)
        return None, conn
    except Exception as exc:  # noqa: BLE001 - the outcome under test
        return exc, conn
    finally:
        M.create_engine, M.to_libpq_url = orig_ce, orig_url


def ddl(conn):
    return " || ".join(conn.sql)


BIG = 801792

# --- S1. THE TRAPDOOR: index dropped, column survives, backend UNCHANGED ------
# pg_search -> pg_search on a populated table. Nothing about the backend is
# changing; only the index is missing. This must be repaired, not fatal.
err, conn = run(
    {"memory_units": {"udt_name": "text", "am": None, "indexdef": None, "rows": BIG}},
    "pg_search",
)
print("S1_ERR", repr(err))
print("S1_DDL", ddl(conn))
if err is not None:
    fail("TRAPDOOR: a dropped index over a surviving TEXT column is FATAL under an UNCHANGED pg_search backend -> %r" % (err,))
else:
    if "USING bm25" not in ddl(conn):
        fail("S1: the missing BM25 index was not rebuilt: %s" % ddl(conn))
    if "DROP COLUMN" in ddl(conn):
        fail("S1: an index-only rebuild dropped the search_vector column: %s" % ddl(conn))
    # The rebuild must come back with the #4478 filter-pushdown fast fields.
    # "USING bm25" alone would still pass with the pushdown columns silently
    # dropped, which is exactly the regression pg_search_rebuild_bm25_columns
    # exists to prevent: it re-emits pg_search_filter_fields(table) on EVERY
    # branch because they encode the recall arm's WHERE shape, not a tokenizer
    # choice. Structural match, not an exact string: postgres RENDERS the stored
    # indexdef as ((bank_id)::pdb.literal) while the emitted DDL is
    # (bank_id::pdb.literal), and the whitespace here is the f-string's.
    _s1 = ddl(conn)
    for _col in ("bank_id", "fact_type"):
        if not re.search(r"\(+%s\)?::pdb\.literal" % _col, _s1):
            fail(
                "PUSHDOWN LOST: the rebuilt memory_units BM25 index omits the #4478 "
                "%s::pdb.literal filter fast field, so the recall arm's = predicate "
                "falls back to a post-scoring heap_filter -> %s" % (_col, _s1)
            )
    if not re.search(r"key_field='?id'?", _s1):
        fail("S1: the rebuilt BM25 index has no key_field=id reloption -> %s" % _s1)
    # …and the whole column list, in order. FakeConn already collapsed the
    # f-string's newlines, so this is order-sensitive without being
    # whitespace-brittle.
    if not re.search(
        r"CREATE INDEX idx_memory_units_text_search ON public\.memory_units USING bm25 "
        r"\( *id, *text, *context, *text_signals, *\(+bank_id\)?::pdb\.literal\), *"
        r"\(+fact_type\)?::pdb\.literal\) *\)",
        _s1,
    ):
        fail(
            "S1: the rebuilt memory_units index is not the known-good BM25 shape "
            "(id, text, context, text_signals, bank_id::pdb.literal, fact_type::pdb.literal) -> %s" % _s1
        )

# --- S2. NOBODY CREATES THE EXTENSION -----------------------------------------
# Empty table so upstream reaches the pg_search branch: it emits CREATE INDEX
# USING bm25 without ever installing the extension, so the pdb schema the
# ParadeDB casts live in does not exist and the index build dies.
err, conn = run(
    {"memory_units": {"udt_name": "tsvector", "am": "gin", "indexdef": IDX_GIN, "rows": 0}},
    "pg_search",
)
print("S2_ERR", repr(err))
print("S2_DDL", ddl(conn))
if err is not None:
    fail("S2: migrating an EMPTY table to pg_search raised: %r" % (err,))
else:
    d = ddl(conn)
    if "CREATE EXTENSION IF NOT EXISTS pg_search" not in d:
        fail("NO CREATE EXTENSION: the pg_search branch builds a BM25 index without installing pg_search -> %s" % d)
    elif d.index("CREATE EXTENSION IF NOT EXISTS pg_search") > d.index("USING bm25"):
        fail("S2: CREATE EXTENSION pg_search runs AFTER the BM25 CREATE INDEX")

# --- S3. THE SECOND TABLE IS NEVER RECONCILED ---------------------------------
# 'reflections' was renamed to 'mental_models'; the old name matches nothing.
err, conn = run(
    {
        "memory_units": {"udt_name": "text", "am": "bm25", "indexdef": IDX_BM25_PG_SEARCH, "rows": BIG},
        "mental_models": {"udt_name": "tsvector", "am": "gin", "indexdef": IDX_GIN, "rows": 43},
    },
    "pg_search",
)
print("S3_ERR", repr(err))
print("S3_DDL", ddl(conn))
if err is not None:
    fail("S3: reconciling mental_models raised: %r" % (err,))
elif "mental_models" not in ddl(conn):
    fail(
        "ORPHANED TABLE: mental_models keeps a native tsvector GIN under a pg_search backend and is "
        "never reconciled -> %s" % (ddl(conn) or "<no DDL at all>")
    )

# --- S4. THE ERROR TEXT ---------------------------------------------------------
# TEXT column, no index -> nothing can disambiguate pg_textsearch/pgroonga/
# pg_search, and the remedy must name tables that exist.
err, _c = run(
    {
        "memory_units": {"udt_name": "text", "am": None, "indexdef": None, "rows": BIG},
        "mental_models": {"udt_name": "text", "am": None, "indexdef": None, "rows": 43},
    },
    "native",
)
print("S4_ERR", str(err))
if err is None:
    fail("S4: pg_search -> native on populated tables did NOT raise — the real data guard is gone")
else:
    msg = str(err)
    if "from pg_textsearch" in msg:
        fail("MISDETECTED BACKEND: reports 'pg_textsearch' from a TEXT column with no index to read -> %s" % msg)
    if "reflections" in msg:
        fail("DEAD TABLE IN ERROR TEXT: advises operating on 'reflections', renamed away by t5o6p7q8r9s0 -> %s" % msg)
    if "mental_models" not in msg:
        fail("S4: the remedy does not name mental_models -> %s" % msg)

# --- S5. THE GUARD STILL PROTECTS A REAL LOSSY SWITCH ---------------------------
# pg_search -> native with data: the tsvector column comes back EMPTY and is
# only ever written on INSERT, so this must STILL be refused.
err, _c = run(
    {"memory_units": {"udt_name": "text", "am": "bm25", "indexdef": IDX_BM25_PG_SEARCH, "rows": BIG}},
    "native",
)
print("S5_ERR", str(err))
if err is None:
    fail("REGRESSION: pg_search -> native on 801792 rows was ALLOWED; every existing row would become unsearchable")
elif "from pg_search to native" not in str(err):
    fail("S5: the refusal does not name the real direction -> %s" % err)

# --- S6. AN INDEX-ONLY REBUILD MUST NOT DISCARD A POPULATED tsvector -------------
err, conn = run(
    {"memory_units": {"udt_name": "tsvector", "am": None, "indexdef": None, "rows": BIG}},
    "native",
)
print("S6_ERR", repr(err))
print("S6_DDL", ddl(conn))
if err is not None:
    fail("S6: a native backend with a dropped GIN index is FATAL instead of rebuilding the index -> %r" % (err,))
else:
    d = ddl(conn)
    if "DROP COLUMN" in d:
        fail("DATA LOSS: the populated tsvector column is dropped and recreated empty on an index-only rebuild -> %s" % d)
    if "USING gin" not in d:
        fail("S6: the GIN index was not rebuilt -> %s" % d)

# --- S7. THE PRODUCTION SHAPE: native -> pg_search on a POPULATED table ---------
# This is the migration the operator procedure actually performs, and until now
# no scenario covered it. S2 is this shape at rows=0 (so the guard is trivially
# satisfied) and S3 is it on mental_models at 43 rows; neither exercises the
# real one — memory_units carrying a populated tsvector under a live GIN index,
# at the fleet's actual row count. The guard must NOT fire (pg_search keeps
# search_vector as a dummy, so recreating it loses nothing), and the full repair
# sequence must be emitted in the only order that works.
err, conn = run(
    {"memory_units": {"udt_name": "tsvector", "am": "gin", "indexdef": IDX_GIN, "rows": BIG}},
    "pg_search",
)
print("S7_ERR", repr(err))
print("S7_DDL", ddl(conn))
if err is not None:
    fail(
        "S7: the real native -> pg_search migration on %d rows RAISED instead of migrating -> %r"
        % (BIG, err)
    )
else:
    d = ddl(conn)
    # Order is load-bearing end to end: the stale GIN index must go before its
    # column; the tsvector column must go before the TEXT one replaces it; and
    # CREATE EXTENSION must precede the BM25 build or the pdb schema the
    # ParadeDB casts live in does not exist yet.
    _seq = [
        ("DROP INDEX IF EXISTS public.idx_memory_units_text_search", "drop the stale GIN index"),
        ("ALTER TABLE public.memory_units DROP COLUMN IF EXISTS search_vector", "drop the tsvector column"),
        ("CREATE EXTENSION IF NOT EXISTS pg_search CASCADE", "install pg_search"),
        ("ALTER TABLE public.memory_units ADD COLUMN IF NOT EXISTS search_vector TEXT", "add the dummy TEXT column"),
        ("USING bm25", "build the BM25 index"),
    ]
    _at = -1
    for _needle, _what in _seq:
        _i = d.find(_needle)
        if _i < 0:
            fail("S7: the migration never emitted the step to %s -> %s" % (_what, d))
            break
        if _i < _at:
            fail("S7: the step to %s is emitted out of order -> %s" % (_what, d))
            break
        _at = _i
    else:
        if not re.search(r"\(+bank_id\)?::pdb\.literal", d):
            fail("S7: the production migration builds a BM25 index without the #4478 pushdown fields -> %s" % d)

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
 * CI marker. When set, this suite MUST really execute — an absent docker or an
 * absent upstream image becomes a hard failure instead of a green skip.
 */
const REQUIRED = process.env.SWITCHROOM_REQUIRE_HINDSIGHT_PROBE === "1";

const dockerOk = hasDocker();
const imageOk = dockerOk && hasImage(UPSTREAM_IMAGE);

type ProbeResult = { status: number; stdout: string };

/** Run the probe in a throwaway container, optionally patching it first. */
async function runProbe(patched: boolean): Promise<ProbeResult> {
  const name = `sr-hs-tsmig-${patched ? "patched" : "upstream"}-${RUN_ID.slice(0, 8)}`;
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
        "600",
      ]);

    if (patched) {
      for (const block of patchBlocks()) {
        // Each block is self-verifying: it asserts its upstream anchors exist
        // exactly the expected number of times and re-asserts the result, so a
        // non-zero exit here means upstream drifted and the patch must be
        // re-authored in docker/Dockerfile.hindsight.
        await execFileAsync("docker", ["exec", "-i", name, "python3", "-"], { input: block });
      }
    }

    const res = await execFileAsync("docker", ["exec", "-i", "-w", "/app/api", name, "/app/api/.venv/bin/python", "-"], { input: PROBE });
    return { status: 0, stdout: res.stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return { status: err.status ?? -1, stdout: (err.stdout ?? "").toString() };
  } finally {
    try {
      await execFileAsync("docker", ["rm", "-f", name]);
    } catch {
      /* already gone */
    }
  }
}

describe("Dockerfile.hindsight text-search migration probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("extracts the patch block it claims to prove, plus its prerequisites, in order", () => {
    const picked = patchBlocks();
    expect(picked).toHaveLength(3);
    expect(picked[0]).toContain(PREREQ_PATCH_NAMES[0]);
    expect(picked[1]).toContain(PREREQ_PATCH_NAMES[1]);
    expect(picked[2]).toContain(PATCH_NAME);
  });

  it("hard-fails rather than skipping when CI demands a real run", () => {
    if (!REQUIRED) {
      // Local/dev path: skipping is legitimate, but it must be visible rather
      // than silent.
      expect(
        REQUIRED,
        "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE is unset — the behavioural probe " +
          "is advisory here.",
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
        "locally — the workflow must pull the pinned digest before this suite runs",
    ).toBe(true);
  });
});

describe.skipIf(!dockerOk || !imageOk)(
  "Dockerfile.hindsight text-search migration patch changes real behaviour",
  () => {
    afterAll(() => {
      // Label-scoped teardown belt — never an unlabelled bulk removal.
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

    it("unpatched upstream is RED — the trapdoor, the missing extension, the dead table", async () => {
      const { status, stdout } = await runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // 1. the trapdoor, reproduced verbatim: the backend is UNCHANGED and the
      //    only thing wrong is a missing index, yet it is fatal.
      expect(stdout).toContain("TRAPDOOR:");
      expect(stdout).toMatch(
        /S1_ERR .*Cannot change text search extension from pg_textsearch to pg_search/,
      );
      expect(stdout).toMatch(/^S1_DDL\s*$/m); // and it emitted no repair DDL at all
      // 2. the BM25 index is built without the extension owning the pdb schema.
      expect(stdout).toContain("NO CREATE EXTENSION:");
      // 3. mental_models is never reconciled.
      expect(stdout).toContain("ORPHANED TABLE:");
      // 4. the message guesses a backend, and names a table that does not exist.
      expect(stdout).toContain("MISDETECTED BACKEND:");
      expect(stdout).toContain("DEAD TABLE IN ERROR TEXT:");
      // 6. a native fleet that merely lost its GIN index is equally stuck —
      //    "from native to native".
      expect(stdout).toMatch(
        /S6_ERR .*Cannot change text search extension from native to native/,
      );
      // 7. and the migration the operator procedure actually performs — a
      //    populated native memory_units to pg_search — is fatal too, which is
      //    the whole reason the documented runbook could not work.
      expect(stdout).toMatch(
        /S7_ERR .*Cannot change text search extension from native to pg_search/,
      );
      expect(stdout).toMatch(/^S7_DDL\s*$/m); // no repair DDL at all
    }, 300_000);

    it("upstream + the baked patch block is GREEN on all seven properties", async () => {
      const { status, stdout } = await runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      // 1. the trapdoor is repaired in place: the index is rebuilt and the
      //    surviving column is NOT dropped.
      expect(stdout).toMatch(/S1_ERR None/);
      expect(stdout).toMatch(/S1_DDL .*USING bm25/);
      expect(stdout).not.toMatch(/S1_DDL .*DROP COLUMN/);
      // 2. the extension is installed before the index that needs it.
      expect(stdout).toMatch(
        /S2_DDL .*CREATE EXTENSION IF NOT EXISTS pg_search CASCADE .*USING bm25/,
      );
      // 3. mental_models is reconciled under the name it actually has.
      expect(stdout).toMatch(/S3_DDL .*idx_mental_models_text_search/);
      // 4. the message reads the schema instead of guessing, and names real
      //    tables in its remedy.
      expect(stdout).toContain(
        "indeterminate (TEXT search_vector, no text-search index)",
      );
      expect(stdout).toContain("DELETE FROM public.mental_models;");
      // 5. the genuinely lossy switch is STILL refused.
      expect(stdout).toMatch(
        /S5_ERR Cannot change text search extension from pg_search to native/,
      );
      // 6. an index-only rebuild keeps the populated tsvector column.
      expect(stdout).toMatch(/S6_DDL .*USING gin/);
      expect(stdout).not.toMatch(/S6_DDL .*DROP COLUMN/);
      // 7. the production migration — populated native memory_units to
      //    pg_search — completes, in the only order that works.
      expect(stdout).toMatch(/S7_ERR None/);
      expect(stdout).toMatch(
        /S7_DDL .*DROP INDEX IF EXISTS public\.idx_memory_units_text_search.*DROP COLUMN IF EXISTS search_vector.*CREATE EXTENSION IF NOT EXISTS pg_search CASCADE.*ADD COLUMN IF NOT EXISTS search_vector TEXT.*USING bm25/,
      );
      // …and the rebuilt index keeps the #4478 filter-pushdown fast fields, on
      // BOTH the in-place rebuild (S1) and the full production migration (S7).
      expect(stdout).toMatch(/S1_DDL .*bank_id\)?::pdb\.literal/);
      expect(stdout).toMatch(/S1_DDL .*fact_type\)?::pdb\.literal/);
      expect(stdout).toMatch(/S1_DDL .*key_field='id'/);
      expect(stdout).toMatch(/S7_DDL .*bank_id\)?::pdb\.literal/);
    }, 300_000);
  },
);
