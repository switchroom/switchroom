/**
 * Behavioural proof for the temporal-language patch
 * `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight image.
 * `dockerfile-hindsight-bakes.test.ts` pins the *shape* of the patch block
 * (grep-on-file, runs everywhere). This file proves the *outcome*: it runs the
 * same probe against unpatched upstream (must be RED on the defect) and against
 * upstream + the patch block applied (must be GREEN).
 *
 * The defect, measured live on `switchroom-hindsight` before the fix:
 *
 *   `DateparserQueryAnalyzer.analyze()` (engine/query_analyzer.py) called
 *   `dateparser.search_dates(query, settings=...)` with NO `languages=`
 *   argument, so dateparser auto-detected across 200+ locales on EVERY recall
 *   that reached it. That auto-detection runs INLINE on the single shared
 *   asyncio loop (recall + consolidation + reranker all live in one process).
 *   Under consolidation recall fan-out it blocked the loop for 1-2.6s at a
 *   time: the loop watchdog logged 128 `EVENT LOOP BLOCKED >=1s` events in 20
 *   minutes, with dateparser's per-locale language-split frames
 *   (`dateparser/languages/locale.py:_split`,
 *   `dictionary.py:_split_by_known_words` / `_should_capture`) appearing 1383x
 *   in the blocked stacks. Measured in the image venv on a representative
 *   query: auto-detect 99.8 ms/call vs `languages=["en"]` 0.6 ms/call (~165x).
 *
 * The patch pins `languages=` to a configurable list, `HINDSIGHT_API_TEMPORAL_
 * LANGUAGES` (a real config.py knob, comma-separated, default "en"), on BOTH
 * the `load()` warm-up call and the `analyze()` call. This file asserts the
 * OUTCOMES that make that fix real, none of which is visible from the patch
 * text alone:
 *
 *  - the default resolves to `["en"]` through the real `HindsightConfig.
 *    from_env()`, and the CSV knob parses (`"en, es ,,fr"` -> `["en","es",
 *    "fr"]`, whitespace/empties dropped) with an `["en"]` floor when it
 *    resolves empty — so the loop-starving no-languages call is unreachable by
 *    construction;
 *  - the real `search_dates` a recall issues RECEIVES `languages=["en"]` —
 *    the assertion that reds the instant the pin is reverted — driven through
 *    a query that reaches dateparser (the relative-period fast-path in
 *    `extract_period` short-circuits "last week"/"yesterday" BEFORE dateparser,
 *    so the probe uses an explicit-date query that provably reaches it);
 *  - English temporal extraction still works end to end through the real
 *    `extract_temporal_constraint` ("last week", "yesterday", "3 days ago" all
 *    resolve to a constraint), so pinning the language did not break the
 *    behaviour it exists to keep fast.
 *
 * The patch block is extracted from the Dockerfile itself rather than
 * duplicated here, so this test cannot drift from what actually ships. It
 * applies it by `docker exec` (not `docker build`) so it runs on daemons
 * without buildx, and it never touches the production `switchroom-hindsight`
 * container.
 *
 * SKIP DISCIPLINE: identical to `hindsight-search-patches.test.ts`. Locally,
 * with no docker or no cached image, this skips (never pull a 6.4GB
 * third-party image onto a dev box). In CI the `hindsight-probe` job pulls the
 * pinned digest and sets `SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1`, under which an
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
  "utf8"
);

const RUN_ID = randomUUID();
const TEST_PHASE = "hindsight-temporal-language-patch";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/**
 * The patch block under test, pulled out of the Dockerfile's
 * `RUN python3 - <<'PYEOF' … PYEOF` heredocs by its unique patch name.
 */
function patchBlock(): string {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  const b = blocks.find((x) => x.includes("temporal-language patch"));
  if (!b) {
    throw new Error(
      `Dockerfile.hindsight no longer contains the "temporal-language patch" ` +
        `RUN block — if it was deliberately removed, delete this test with it.`
    );
  }
  return b;
}

/**
 * Python probe. Exits 0 only when the language pin is in effect AND every
 * property above holds; prints the offending assertions otherwise. Asserts
 * OUTCOMES rather than grepping source.
 */
const PROBE = String.raw`
import os
import sys
from datetime import datetime

sys.path.insert(0, "/app/api")

failures = []

from hindsight_api.config import HindsightConfig


def resolved_langs(**env):
    # getattr sentinel, not attribute access: on UNPATCHED upstream the field
    # does not exist, and the probe MUST still run to completion (print
    # PROBE_EXECUTED) so an early crash can never read as a green skip.
    for k, v in env.items():
        os.environ[k] = v
    try:
        return getattr(HindsightConfig.from_env(), "temporal_languages", "__ABSENT__")
    finally:
        for k in env:
            os.environ.pop(k, None)


# ---- default resolves to ["en"] through the REAL loader ----
default_langs = resolved_langs()
print("DEFAULT_LANGS", default_langs)
if default_langs != ["en"]:
    failures.append("default temporal_languages != ['en']: %r" % (default_langs,))

# ---- the CSV knob parses, dropping whitespace/empties ----
csv_langs = resolved_langs(HINDSIGHT_API_TEMPORAL_LANGUAGES="en, es ,,fr")
print("CSV_LANGS", csv_langs)
if csv_langs != ["en", "es", "fr"]:
    failures.append("CSV parse wrong: %r" % (csv_langs,))

# ---- an all-empty CSV floors back to ["en"] (no-languages call unreachable) ----
empty_langs = resolved_langs(HINDSIGHT_API_TEMPORAL_LANGUAGES="   ,  ")
print("EMPTY_LANGS", empty_langs)
if empty_langs != ["en"]:
    failures.append("empty CSV did not floor to ['en']: %r" % (empty_langs,))

# ---- the analyzer resolves its pin from config ----
from hindsight_api.engine import query_analyzer as QA

an = QA.DateparserQueryAnalyzer()
analyzer_langs = getattr(an, "_languages", "__ABSENT__")
print("ANALYZER_LANGS", analyzer_langs)
if analyzer_langs != ["en"]:
    failures.append("analyzer._languages != ['en']: %r" % (analyzer_langs,))

# ---- the REAL search_dates a recall issues receives languages=["en"] ----
# "last week"/"yesterday" are resolved by extract_period BEFORE dateparser, so
# use an explicit-date query that provably reaches search_dates.
an.load()
_orig = an._search_dates
captured = {}


def _spy(q, **kw):
    captured["languages"] = kw.get("languages", "__ABSENT__")
    return _orig(q, **kw)


an._search_dates = _spy
an.analyze("what happened on june 10 2025")
cap = captured.get("languages", "__NOT_CALLED__")
print("CAPTURED_LANGUAGES", cap)
if cap != ["en"]:
    failures.append("search_dates did NOT receive languages=['en']: %r" % (cap,))

# ---- English temporal extraction still works end to end ----
from hindsight_api.engine.search.temporal_extraction import extract_temporal_constraint

ref = datetime(2026, 8, 3, 12, 0, 0)
for phrase in ["last week", "yesterday", "3 days ago"]:
    tc = extract_temporal_constraint(phrase, reference_date=ref)
    print("EXTRACT", repr(phrase), tc)
    if tc is None:
        failures.append("English temporal extraction failed for %r" % (phrase,))

print("FAILURES", failures)
# Sentinel: proves the probe ran to completion. The harness asserts this, so a
# probe that dies early or short-circuits can never be mistaken for a pass.
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
  const name = `sr-hs-temporal-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
    0,
    8
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
      { stdio: ["ignore", "ignore", "pipe"] }
    );

    if (patched) {
      // The block is self-verifying: it asserts its upstream anchors exist
      // exactly once and re-asserts the result, so a non-zero exit here means
      // upstream drifted and the patch must be re-authored.
      execFileSync("docker", ["exec", "-i", name, "python3", "-"], {
        input: patchBlock(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    const res = execFileSync(
      "docker",
      ["exec", "-i", "-w", "/app/api", name, "/app/api/.venv/bin/python", "-"],
      { input: PROBE, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" }
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

describe("Dockerfile.hindsight temporal-language probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
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
  "Dockerfile.hindsight temporal-language patch changes real behaviour",
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

    it("unpatched upstream is RED — search_dates gets no languages= and the config knob is absent (proves the probe bites)", () => {
      const { status, stdout } = runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // The concrete defect: the real recall search_dates call carries no
      // languages= at all, so dateparser auto-detects across 200+ locales.
      expect(stdout).toContain("CAPTURED_LANGUAGES __ABSENT__");
      expect(stdout).toContain(
        "search_dates did NOT receive languages=['en']: '__ABSENT__'"
      );
      // …and there is no config knob to have pinned it with.
      expect(stdout).toContain("default temporal_languages != ['en']");
    }, 240_000);

    it("upstream + the baked patch block is GREEN, including the CSV knob and that English extraction still works", () => {
      const { status, stdout } = runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      // The knob: default English, CSV parses, empty floors back to English.
      expect(stdout).toContain("DEFAULT_LANGS ['en']");
      expect(stdout).toContain("CSV_LANGS ['en', 'es', 'fr']");
      expect(stdout).toContain("EMPTY_LANGS ['en']");
      // The load-bearing outcome: the real recall search_dates is pinned.
      expect(stdout).toContain("ANALYZER_LANGS ['en']");
      expect(stdout).toContain("CAPTURED_LANGUAGES ['en']");
      // English temporal extraction survived the pin, all three phrases.
      expect(stdout).toMatch(/EXTRACT 'last week' \(datetime/);
      expect(stdout).toMatch(/EXTRACT 'yesterday' \(datetime/);
      expect(stdout).toMatch(/EXTRACT '3 days ago' \(datetime/);
    }, 240_000);
  }
);
