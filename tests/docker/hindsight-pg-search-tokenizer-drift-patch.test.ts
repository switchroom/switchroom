/**
 * Behavioural proof for the pg_search tokenizer-drift guard (epic #4474, C1)
 * that `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight
 * image.
 *
 * `dockerfile-hindsight-bakes.test.ts` pins the *shape* of that patch block
 * (grep-on-file, runs everywhere). This file proves the *outcome*: it runs the
 * same probe against unpatched upstream (must be RED — the rebuild silently
 * drops stemming) and against upstream + the patch block applied (must be
 * GREEN on every property).
 *
 * THE DEFECT, in the real shipping source at tag v0.8.6.
 *
 * The stemmed/stopworded ParadeDB variant the fleet needs for recall quality
 * (`stemmer=english` + `stopwords_language=english`) cannot be expressed
 * through `HINDSIGHT_API_TEXT_SEARCH_EXTENSION_PG_SEARCH_TOKENIZER`:
 * `_pg_search.py:32-85` takes a bare tokenizer NAME from a fixed set and emits
 * an unstemmed `(field::pdb.<tok>)` cast. So it can only ever exist as
 * hand-built DDL. Nothing then defends it — every "does the index match the
 * config" decision keys on the `key_field` reloption alone
 * (`migrations.py:887`) and never looks at the tokenizer cast.
 *
 * The probe drives the single most dangerous consequence: the REBUILD in
 * `alembic/versions/a2b3c4d5e6f7_add_text_signals_column.py:75-83`, which does
 * an unconditional `DROP INDEX` + `CREATE INDEX` against a POPULATED
 * `memory_units` and takes its column list straight from the config knob. Given
 * a live stemmed index, unpatched upstream emits `(id, text, context,
 * text_signals)` — unstemmed. No error, no log line, recall quality quietly
 * degraded fleet-wide.
 *
 * The properties this probe drives, none of which the patch TEXT can show:
 *
 *  1. THE REBUILD PRESERVES STEMMING — the real `_pg_upgrade()` from the
 *     shipping migration, given a live stemmed index, emits a `CREATE INDEX`
 *     that still carries `stemmer=english` / `stopwords_language=english`.
 *     This is the property that is RED on upstream.
 *  2. THE MIGRATION STILL DOES ITS JOB — the rebuilt index gains
 *     `text_signals` and keeps `key_field='id'`. Preserving semantics must not
 *     silently neuter the migration.
 *  3. THE BOOT PATH SURFACES THE DRIFT — a drift record is produced, naming the
 *     observed cast, the configured one, and that config cannot express it.
 *  4. NO FALSE ALARM — an index whose tokenizer already matches config yields
 *     no drift, so the ERROR line means something when it appears.
 *  5. CONFIG STILL WINS WHEN IT CAN — a drift the knob CAN express (e.g. a live
 *     `pdb.icu` against an unset knob) is a deliberate config change and the
 *     rebuild applies config. The guard preserves what config cannot express,
 *     it does not freeze the index.
 *  6. IT NEVER RAISES — the guard runs inside `ensure_text_search_extension`,
 *     which executes on EVERY boot and already raises `RuntimeError` on a
 *     schema mismatch with data present (`migrations.py:768 -> :922 -> :940`).
 *     A guard that raised would take the SEMANTIC arm down with the keyword
 *     one — a full memory outage, strictly worse than the silent degradation
 *     it fixes. The probe feeds it malformed, truncated and hostile index
 *     definitions and asserts it returns instead of raising.
 *
 * The probe drives the REAL shipping migration with fakes ONLY at the alembic
 * boundary (`op` / `context`), capturing the DDL it actually emits, rather than
 * re-implementing the rebuild here. Nothing in it greps the patched source.
 *
 * The patch block is extracted from the Dockerfile itself rather than
 * duplicated here, so this test cannot drift from what actually ships. It
 * applies it by `docker exec` (not `docker build`) so it runs on daemons
 * without buildx, and it never touches the production `switchroom-hindsight`
 * container. No database is required: the rebuild is observed as emitted SQL.
 *
 * SKIP DISCIPLINE: identical to `hindsight-mm-refresh-debounce-patch.test.ts`.
 * Locally, with no docker or no cached image, this skips (never pull a 6.4GB
 * third-party image onto a dev box). In CI the `hindsight-probe` job pulls the
 * pinned digest and sets SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1, under which an
 * unavailable docker/image is a HARD FAILURE, never a green skip. Both runs
 * assert a `PROBE_EXECUTED` sentinel so a probe that dies early can never be
 * mistaken for a pass.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
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
const TEST_PHASE = "hindsight-pg-search-tokenizer-drift-patch";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/** The patch this file proves, named by its unique in-block marker. */
const PATCH_NAME = "pg_search tokenizer-drift guard";

/**
 * PREREQUISITE, applied first (switchroom #4478). The pushdown block installs
 * `pg_search_filter_fields` / `pg_search_filter_columns` into `_pg_search.py`,
 * which this patch's rebuild calls so that a rebuild cannot silently un-do the
 * BM25 filter-field fix. It is a real ordering dependency in the Dockerfile,
 * so the probe reproduces it rather than pretending the block is standalone;
 * `hindsight-pg-search-filter-pushdown-patch.test.ts` owns its assertions.
 */
const PREREQ_PATCH_NAME = "pg_search filter-field pushdown";

/**
 * The patch block under test plus its prerequisite, pulled out of the
 * Dockerfile's `RUN python3 - <<'PYEOF' ... PYEOF` heredocs by their unique
 * patch names and returned in Dockerfile (application) order.
 */
function patchBlocks(): string[] {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  const picked: string[] = [];
  for (const name of [PREREQ_PATCH_NAME, PATCH_NAME]) {
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
 * Python probe. Exits 0 only when all six properties above hold; prints the
 * offending assertions otherwise.
 *
 * Deliberately asserts OUTCOMES: it runs the real `_pg_upgrade()` from the
 * shipping text_signals migration against a fake alembic boundary and reads
 * back the DDL it emits.
 */
const PROBE = String.raw`
import importlib.util
import json
import os
import sys

failures = []


def fail(msg):
    failures.append(msg)


STEM = "simple('stemmer=english', 'stopwords_language=english')"

# What a hand-built "Variant B" index looks like in pg_indexes.indexdef. Only
# (id, text, context) — this is the pre-text_signals shape the migration below
# is about to rebuild.
LIVE_STEMMED = (
    "CREATE INDEX idx_memory_units_text_search ON public.memory_units USING bm25 "
    "(id, (text::pdb.%s), (context::pdb.%s)) WITH (key_field='id')" % (STEM, STEM)
)
LIVE_PLAIN = (
    "CREATE INDEX idx_memory_units_text_search ON public.memory_units USING bm25 "
    "(id, text, context) WITH (key_field='id')"
)
LIVE_ICU = (
    "CREATE INDEX idx_memory_units_text_search ON public.memory_units USING bm25 "
    "(id, (text::pdb.icu), (context::pdb.icu)) WITH (key_field='id')"
)

os.environ["HINDSIGHT_API_TEXT_SEARCH_EXTENSION"] = "pg_search"
os.environ.pop("HINDSIGHT_API_TEXT_SEARCH_EXTENSION_PG_SEARCH_TOKENIZER", None)

MIG_PATH = "/app/api/hindsight_api/alembic/versions/a2b3c4d5e6f7_add_text_signals_column.py"


# --- fakes at the alembic boundary ONLY ---------------------------------------
class _Result:
    def __init__(self, value):
        self._value = value

    def scalar(self):
        return self._value


class _Bind:
    def __init__(self, indexdef):
        self.indexdef = indexdef

    def execute(self, statement, params=None):
        return _Result(self.indexdef)

    def exec_driver_sql(self, statement, params=None):
        return _Result(self.indexdef)


class FakeOp:
    def __init__(self, indexdef):
        self.sql = []
        self._bind = _Bind(indexdef)

    def execute(self, statement):
        self.sql.append(" ".join(str(statement).split()))

    def get_bind(self):
        return self._bind


class _FakeConfig:
    def get_main_option(self, name, default=None):
        return None


class FakeContext:
    config = _FakeConfig()


def load_migration():
    spec = importlib.util.spec_from_file_location("sr_probe_text_signals", MIG_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def rebuild_ddl(live_indexdef):
    """Run the REAL migration upgrade and return the CREATE INDEX it emits."""
    mod = load_migration()
    fake = FakeOp(live_indexdef)
    mod.op = fake
    mod.context = FakeContext()
    mod._pg_upgrade()
    created = [s for s in fake.sql if s.upper().startswith("CREATE INDEX")]
    if len(created) != 1:
        fail("migration emitted %d CREATE INDEX statements (expected 1): %s" % (len(created), fake.sql))
        return ""
    return created[0]


# --- 1 + 2. the rebuild preserves stemming and still adds text_signals ---------
ddl = rebuild_ddl(LIVE_STEMMED)
print("REBUILD_DDL", ddl)
if "stemmer=english" not in ddl:
    fail("REBUILD DROPPED THE STEMMER: the rebuilt index is unstemmed -> " + ddl)
if "stopwords_language=english" not in ddl:
    fail("REBUILD DROPPED THE STOPWORD FILTER: " + ddl)
if "text_signals" not in ddl:
    fail("rebuild lost text_signals — the migration's own purpose: " + ddl)
if "key_field='id'" not in ddl:
    fail("rebuild lost key_field='id': " + ddl)

# --- 3. the boot path surfaces the drift ---------------------------------------
try:
    import hindsight_api._pg_search as pgs
except Exception as exc:  # pragma: no cover - import cannot fail in the image
    pgs = None
    fail("could not import hindsight_api._pg_search: %r" % (exc,))

check = getattr(pgs, "check_pg_search_tokenizer_drift", None) if pgs else None
if check is None:
    fail(
        "NO TOKENIZER DRIFT DETECTOR: a hand-built stemmed index is adopted as valid "
        "and nothing reports that the live index no longer tokenizes the way config says"
    )
else:
    record = check(LIVE_STEMMED, ("text", "context", "text_signals"), "", table="memory_units", index_name="idx")
    if not record:
        fail("drift detector returned nothing for a stemmed index against an unset tokenizer knob")
    else:
        print("DRIFT_RECORD", json.dumps({k: record[k] for k in sorted(record) if k != "observed_casts"}, default=str))
        if record.get("config_expressible") is not False:
            fail("drift detector claims the config knob can express %r" % (record.get("observed_tokenizer"),))
        if "stemmer=english" not in str(record.get("observed_tokenizer")):
            fail("drift record does not name the observed stemmed tokenizer: %r" % (record,))

    # --- 4. no false alarm -----------------------------------------------------
    if check(LIVE_PLAIN, ("text", "context"), "", table="t", index_name="i") is not None:
        fail("drift reported for an index that already matches the configured tokenizer")
    if check(LIVE_ICU, ("text", "context"), "icu", table="t", index_name="i") is not None:
        fail("drift reported for an icu index against an icu-configured knob")

rebuild_cols = getattr(pgs, "pg_search_rebuild_bm25_columns", None) if pgs else None
if rebuild_cols is None:
    fail("no rebuild-aware column builder: every rebuild takes its columns from config alone")
else:
    # --- 5. config still wins when it CAN express the difference ---------------
    cols = rebuild_cols(LIVE_ICU, "id", ("text", "context"), "", table="t", index_name="i")
    print("EXPRESSIBLE_DRIFT_COLS", cols)
    if cols != "id, text, context":
        fail("an expressible tokenizer drift was not resolved in favour of config: %r" % (cols,))

    # A fresh build (no pre-existing index) must be byte-identical to upstream.
    fresh = rebuild_cols(None, "id", ("text", "context"), "icu", table="t", index_name="i")
    upstream_fresh = pgs.pg_search_bm25_columns("id", ("text", "context"), "icu")
    if fresh != upstream_fresh:
        fail("fresh build diverged from upstream: %r != %r" % (fresh, upstream_fresh))

# --- 6. it never raises --------------------------------------------------------
HOSTILE = [
    None,
    "",
    "not an index definition at all",
    "CREATE INDEX i ON t USING gin (search_vector)",
    "CREATE INDEX i ON t USING bm25 (id, (text::pdb.simple('unterminated",
    "CREATE INDEX i ON t USING bm25 (",
    "CREATE INDEX i ON t USING bm25 (id, (text::pdb.simple('a'); DROP TABLE x --')) WITH (key_field='id')",
]
if check is not None and rebuild_cols is not None:
    for hostile in HOSTILE:
        try:
            check(hostile, ("text", "context"), "", table="t", index_name="i")
        except Exception as exc:
            fail("drift detector RAISED on %r: %r — this runs on the every-boot path" % (hostile, exc))
        try:
            out = rebuild_cols(hostile, "id", ("text", "context"), "", table="t", index_name="i")
        except Exception as exc:
            fail("rebuild builder RAISED on %r: %r — this runs on the every-boot path" % (hostile, exc))
        else:
            if ";" in out or "--" in out:
                fail("rebuild builder re-emitted an unsafe cast from %r: %r" % (hostile, out))

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
function runProbe(patched: boolean): ProbeResult {
  const name = `sr-hs-pgstok-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
    0,
    8,
  )}`;
  try {
    execFileSync(
      "docker",
      [
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
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    if (patched) {
      for (const block of patchBlocks()) {
        // The block is self-verifying: it asserts its upstream anchors exist
        // exactly once each and re-asserts the result, so a non-zero exit here
        // means upstream drifted and the patch must be re-authored.
        execFileSync("docker", ["exec", "-i", name, "python3", "-"], {
          input: block,
          stdio: ["pipe", "pipe", "pipe"],
        });
      }
    }

    const res = execFileSync(
      "docker",
      ["exec", "-i", "-w", "/app/api", name, "/app/api/.venv/bin/python", "-"],
      { input: PROBE, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" },
    );
    return { status: 0, stdout: res };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return {
      status: err.status ?? -1,
      stdout: (err.stdout ?? "").toString(),
    };
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
}

describe("Dockerfile.hindsight pg_search tokenizer-drift probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("extracts the patch block it claims to prove plus its prerequisite, in order", () => {
    const picked = patchBlocks();
    expect(picked).toHaveLength(2);
    expect(picked[0]).toContain(PREREQ_PATCH_NAME);
    expect(picked[1]).toContain(PATCH_NAME);
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
  "Dockerfile.hindsight pg_search tokenizer-drift patch changes real behaviour",
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

    it("unpatched upstream is RED — the rebuild silently drops stemming", () => {
      const { status, stdout } = runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // The defect, driven: the shipping migration rebuilds a live STEMMED
      // index as a plain unstemmed one, on a populated table, with no error.
      expect(stdout).toMatch(
        /REBUILD_DDL .*USING bm25 \(id, text, context, text_signals\)/,
      );
      expect(stdout).toContain("REBUILD DROPPED THE STEMMER");
      expect(stdout).toContain("NO TOKENIZER DRIFT DETECTOR");
    }, 240_000);

    it("upstream + the baked patch block is GREEN on all six properties", () => {
      const { status, stdout } = runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      // 1 + 2. the rebuild carries the hand-built semantics forward AND still
      // does what the migration exists to do.
      expect(stdout).toContain("stemmer=english");
      expect(stdout).toContain("stopwords_language=english");
      expect(stdout).toMatch(/REBUILD_DDL .*text_signals::pdb\.simple/);
      // 3. the drift is named, not merely repaired.
      expect(stdout).toContain('"config_expressible": false');
      // 5. an expressible drift still resolves in favour of config.
      expect(stdout).toContain("EXPRESSIBLE_DRIFT_COLS id, text, context");
    }, 240_000);
  },
);
