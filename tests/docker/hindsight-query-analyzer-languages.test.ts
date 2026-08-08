/**
 * Behavioural proof that switchroom's `HINDSIGHT_API_QUERY_ANALYZER_LANGUAGES`
 * emission is load-bearing against the pinned upstream Hindsight image.
 *
 * ## Why this file changed shape at v0.9.0
 *
 * It used to prove switchroom's OWN temporal-language image patch (#4313), which
 * added a `HINDSIGHT_API_TEMPORAL_LANGUAGES` knob and pinned `languages=` on both
 * `search_dates` call sites. Upstream #3154 (in v0.9.0) implements the same idea
 * natively — `DateparserQueryAnalyzer(languages=...)`, a shared `_search_kwargs()`
 * used by `load()` and `analyze()`, and the config knob
 * `HINDSIGHT_API_QUERY_ANALYZER_LANGUAGES` — so the patch block was deleted.
 *
 * The DEFECT did not go away with the patch: upstream's default is `None`, which
 * is documented in its own docstring as "full auto-detection across all 200+
 * locales — unchanged behavior". Measured live on `switchroom-hindsight` before
 * #4313, and unchanged by #3154:
 *
 *   auto-detect 99.8 ms/call vs `languages=["en"]` 0.6 ms/call (~165x), running
 *   INLINE on the single shared asyncio loop (recall + consolidation + reranker
 *   all live in one process). The loop watchdog logged 128 `EVENT LOOP BLOCKED
 *   >=1s` events in 20 minutes, with dateparser's per-locale language-split
 *   frames appearing 1383x in the blocked stacks.
 *
 * What buys the speedup now is switchroom EMITTING the knob on every host
 * (`HINDSIGHT_PERF_DEFAULTS_UNGATED` in `src/setup/hindsight-perf-defaults.ts`),
 * not anything in the image. That makes the emission the fragile part — dropping
 * it, or demoting it to an override-only key, is a 165x recall regression with no
 * error anywhere. So this file now proves the pair:
 *
 *  - **RED**: with the variable UNSET (upstream's stock state), the real
 *    `search_dates` a recall issues receives NO `languages=` at all.
 *  - **GREEN**: with the variable set to the value switchroom actually emits
 *    (imported from the source of truth, not hardcoded here), the same call
 *    receives `languages=["en"]`, still returns a non-empty parse, and English
 *    temporal extraction still works end to end.
 *
 * The GREEN value is imported from `HINDSIGHT_PERF_DEFAULTS_UNGATED` on purpose:
 * if someone removes the entry, this suite fails to find it and reds, rather than
 * happily proving a value nothing emits.
 *
 * SKIP DISCIPLINE: identical to `hindsight-search-patches.test.ts`. Locally, with
 * no docker or no cached image, this skips (never pull a 6.4GB third-party image
 * onto a dev box). In CI the `hindsight-probe` job pulls the pinned digest and
 * sets `SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1`, under which an unavailable
 * docker/image is a HARD FAILURE, never a green skip. Both runs assert a
 * `PROBE_EXECUTED` sentinel so a probe that dies early can never be mistaken for
 * a pass.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { HINDSIGHT_PERF_DEFAULTS_UNGATED } from "../../src/setup/hindsight-perf-defaults.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(
  resolve(root, "docker/Dockerfile.hindsight"),
  "utf8"
);

const RUN_ID = randomUUID();
const TEST_PHASE = "hindsight-query-analyzer-languages";

const ENV_KEY = "HINDSIGHT_API_QUERY_ANALYZER_LANGUAGES";

/**
 * The value switchroom actually ships, read from the defaults table rather than
 * restated here — a probe that proves a value nothing emits proves nothing.
 */
const EMITTED_LANGUAGES = (() => {
  const entry = HINDSIGHT_PERF_DEFAULTS_UNGATED.find(([k]) => k === ENV_KEY);
  if (!entry) {
    throw new Error(
      `${ENV_KEY} is no longer an emitted UNGATED default. If that was ` +
        `deliberate, the ~165x dateparser auto-detection cost is back on every ` +
        `recall — see this file's header before deleting it.`
    );
  }
  return entry[1];
})();

/** `"en"` -> `['en']` as Python renders the parsed list. */
const EXPECTED_PY_LIST = `[${EMITTED_LANGUAGES.split(",")
  .map((c) => `'${c.trim().toLowerCase()}'`)
  .join(", ")}]`;

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/**
 * Python probe. Exits 0 only when the recall path's `search_dates` call is
 * actually language-pinned AND the pin still parses; prints the offending
 * assertions otherwise. Asserts OUTCOMES rather than grepping source.
 *
 * It deliberately builds the analyzer the way `memory_engine.py` does —
 * `DateparserQueryAnalyzer(languages=config.query_analyzer_languages)` — so a
 * regression anywhere between the env var and the dateparser call is caught,
 * not just the config parse.
 */
const PROBE = String.raw`
import sys
from datetime import datetime

sys.path.insert(0, "/app/api")

failures = []

from hindsight_api.config import HindsightConfig

cfg = HindsightConfig.from_env()
langs = getattr(cfg, "query_analyzer_languages", "__ABSENT__")
print("CONFIG_LANGS", langs)

from hindsight_api.engine import query_analyzer as QA

# Exactly how memory_engine.py constructs it.
an = QA.DateparserQueryAnalyzer(languages=langs if langs != "__ABSENT__" else None)
an.load()

_orig = an._search_dates
captured = {}


def _spy(q, **kw):
    captured["languages"] = kw.get("languages", "__ABSENT__")
    result = _orig(q, **kw)
    captured["result"] = result
    return result


an._search_dates = _spy
# "last week"/"yesterday" are resolved by extract_period BEFORE dateparser, so
# use an explicit-date query that provably reaches search_dates.
an.analyze("what happened on june 10 2025")
cap = captured.get("languages", "__NOT_CALLED__")
print("CAPTURED_LANGUAGES", cap)
if cap != EXPECT_LANGS:
    failures.append("search_dates did NOT receive languages=%r: %r" % (EXPECT_LANGS, cap))

# The pin only earns its keep if the query still parses under it: a "fast" pin
# that returned nothing would be a silent recall-quality regression. Assert the
# REAL search_dates return value (captured from _orig, not a stub) is non-empty.
parsed = captured.get("result", "__NOT_CALLED__")
print("CAPTURED_RESULT_NONEMPTY", bool(parsed) and parsed != "__NOT_CALLED__")
if not (bool(parsed) and parsed != "__NOT_CALLED__"):
    failures.append(
        "explicit-date query parsed to EMPTY temporal result under %r: %r"
        % (EXPECT_LANGS, parsed)
    )

# English temporal extraction still works end to end under the pin.
from hindsight_api.engine.search.temporal_extraction import extract_temporal_constraint

ref = datetime(2026, 8, 3, 12, 0, 0)
for phrase in ["last week", "yesterday", "3 days ago"]:
    tc = extract_temporal_constraint(phrase, reference_date=ref, analyzer=an)
    print("EXTRACT", repr(phrase), tc)
    if tc is None:
        failures.append("English temporal extraction failed for %r" % (phrase,))

print("FAILURES", failures)
# Sentinel: proves the probe ran to completion. The harness asserts this, so a
# probe that dies early or short-circuits can never be mistaken for a pass.
print("PROBE_EXECUTED")
sys.exit(1 if failures else 0)
`;

/** The probe with its expectation bound — the same bytes run RED and GREEN. */
function probeSource(): string {
  return `EXPECT_LANGS = ${EXPECTED_PY_LIST}\n${PROBE}`;
}

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

/**
 * Run the probe in a throwaway container, with or without switchroom's env
 * emission. `emitted: false` is upstream's stock state — the RED case.
 */
function runProbe(emitted: boolean): ProbeResult {
  const name = `sr-hs-qalang-${emitted ? "emitted" : "stock"}-${RUN_ID.slice(
    0,
    8
  )}`;
  try {
    const runArgs = [
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
    ];
    if (emitted) runArgs.push("-e", `${ENV_KEY}=${EMITTED_LANGUAGES}`);
    runArgs.push(UPSTREAM_IMAGE, "sleep", "300");
    execFileSync("docker", runArgs, { stdio: ["ignore", "ignore", "pipe"] });

    const res = execFileSync(
      "docker",
      ["exec", "-i", "-w", "/app/api", name, "/app/api/.venv/bin/python", "-"],
      { input: probeSource(), stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" }
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

describe("Dockerfile.hindsight query-analyzer-language probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("proves against the value switchroom actually emits", () => {
    // Not a hardcoded "en": the constant is read from the defaults table, so a
    // removed or renamed emission cannot leave this suite green.
    expect(EMITTED_LANGUAGES).toBeTruthy();
    expect(EXPECTED_PY_LIST).toMatch(/^\['[a-z-]+'(, '[a-z-]+')*\]$/);
  });

  it("hard-fails rather than skipping when CI demands a real run", () => {
    if (!REQUIRED) {
      // Local/dev path: skipping is legitimate (never pull a 6.4GB image onto
      // a dev box), but it must be visible rather than silent.
      expect(
        REQUIRED,
        "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE is unset — the behavioural probe " +
          "is advisory here. CI's hindsight-probe job sets it after pulling " +
          `${UPSTREAM_IMAGE}.`
      ).toBe(false);
      return;
    }
    expect(
      dockerOk,
      "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but the docker daemon is unreachable"
    ).toBe(true);
    expect(
      imageOk,
      `SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but ${UPSTREAM_IMAGE} is not present ` +
        "locally — the workflow must pull the pinned digest before running this suite"
    ).toBe(true);
  });
});

describe.skipIf(!dockerOk || !imageOk)(
  "switchroom's HINDSIGHT_API_QUERY_ANALYZER_LANGUAGES emission changes real behaviour",
  () => {
    afterAll(() => {
      // Label-scoped teardown belt (never an unlabelled bulk removal).
      try {
        const ids = execSync(
          `docker ps -aq --filter label=switchroom.test.run=${RUN_ID}`,
          { encoding: "utf8" }
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

    it("stock upstream (variable UNSET) is RED — search_dates gets no languages= and auto-detects 200+ locales (proves the probe bites)", () => {
      const { status, stdout } = runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // Upstream's documented default: None, i.e. full auto-detection. This is
      // the exact state a dropped emission would leave the fleet in.
      expect(stdout).toContain("CONFIG_LANGS None");
      expect(stdout).toContain("CAPTURED_LANGUAGES __ABSENT__");
    }, 240_000);

    it("with switchroom's emission the recall path is pinned, still parses, and English extraction still works", () => {
      const { status, stdout } = runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      // The env var reaches config…
      expect(stdout).toContain(`CONFIG_LANGS ${EXPECTED_PY_LIST}`);
      // …and, through the analyzer memory_engine builds, the real call.
      expect(stdout).toContain(`CAPTURED_LANGUAGES ${EXPECTED_PY_LIST}`);
      // The pin did not neuter the parse: the explicit-date query still yields
      // a non-empty temporal result (#4318).
      expect(stdout).toContain("CAPTURED_RESULT_NONEMPTY True");
      // English temporal extraction survived the pin, all three phrases.
      expect(stdout).toMatch(/EXTRACT 'last week' \(datetime/);
      expect(stdout).toMatch(/EXTRACT 'yesterday' \(datetime/);
      expect(stdout).toMatch(/EXTRACT '3 days ago' \(datetime/);
    }, 240_000);
  }
);
