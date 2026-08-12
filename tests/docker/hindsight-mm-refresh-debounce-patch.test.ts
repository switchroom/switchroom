/**
 * Behavioural proof for the MM-refresh-debounce patch
 * `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight image.
 *
 * `dockerfile-hindsight-bakes.test.ts` pins the *shape* of that patch block
 * (grep-on-file, runs everywhere). This file proves the *outcome*: it runs the
 * same probe against unpatched upstream (must be RED — upstream refreshes the
 * recently-refreshed model too) and against upstream + the patch block applied
 * (must be GREEN on every property).
 *
 * THE DEFECT, in the real shipping source. `_trigger_mental_model_refreshes`
 * (`engine/consolidation/consolidator.py`) runs at the end of EVERY completed
 * consolidation operation and submits a refresh for every
 * `refresh_after_consolidation: true` mental model that is "stale" — where
 * stale means "any in-scope memory ingested since last_refreshed_at"
 * (`memory_engine.py compute_mental_model_is_stale`). Under sustained
 * ingestion that is true on every round, so every round regenerates every
 * model. Measured on this fleet during the 2026-08-01 backlog drain
 * (hindsight's own llm_requests table): the `finn` bank's FOUR mental models
 * were refreshed 1,902 times in one day — roughly one full LLM regeneration
 * per model per minute for ~9 hours, 20.77M tokens; fleet-wide the
 * refresh_mental_model operation burned 3,003 calls / 36.6M tokens that day.
 * Upstream has no debounce (verified against vectorize-io/hindsight main
 * 2026-08-02, merged and open PRs).
 *
 * The properties this probe drives, none of which the patch TEXT can show:
 *
 *  1. FLOOR BINDS — with the default floor (env unset ⇒ 3600s baked into the
 *     image), a model refreshed 100s ago is NOT submitted, and the debounce
 *     decision happens BEFORE the per-candidate staleness query (a debounced
 *     model costs zero DB round-trips).
 *  2. FLOOR RELEASES — a model refreshed 7200s ago IS submitted: the floor
 *     defers, it does not starve.
 *  3. NULL IS NEVER DEBOUNCED — a never-refreshed model is always submitted;
 *     debouncing it would leave a new mental model permanently empty.
 *  4. ZERO IS EXACT UPSTREAM — HINDSIGHT_MM_REFRESH_MIN_INTERVAL_S=0 submits
 *     all three models, i.e. the documented rollback hatch really restores
 *     refresh-every-round.
 *  5. BAD VALUES DEGRADE, NEVER RAISE — an unparseable or negative env value
 *     behaves like the default floor rather than taking consolidation down.
 *
 * The probe drives the REAL `_trigger_mental_model_refreshes` from the image
 * with fakes only at the engine boundary (`compute_mental_model_is_stale`
 * always answers True and `submit_async_refresh_mental_model` records — the
 * point is to observe WHICH candidates the shipping trigger loop actually
 * submits), rather than re-implementing the loop here. The env knob is read
 * once at module import, so the probe re-imports the module per scenario —
 * exactly what a container restart does in production.
 *
 * The patch block is extracted from the Dockerfile itself rather than
 * duplicated here, so this test cannot drift from what actually ships. It
 * applies it by `docker exec` (not `docker build`) so it runs on daemons
 * without buildx, and it never touches the production `switchroom-hindsight`
 * container.
 *
 * SKIP DISCIPLINE: identical to `hindsight-retry-perturbation-patches.test.ts`.
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
const TEST_PHASE = "hindsight-mm-refresh-debounce-patch";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/** The patch this file proves, named by its unique in-block marker. */
const PATCH_NAME = "MM-refresh-debounce patch";

/**
 * The patch block under test, pulled out of the Dockerfile's
 * `RUN python3 - <<'PYEOF' ... PYEOF` heredocs by its unique patch name.
 */
function patchBlocks(): string[] {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  const hits = blocks.filter((b) => b.includes(PATCH_NAME));
  if (hits.length !== 1) {
    throw new Error(
      `Dockerfile.hindsight contains ${hits.length} "${PATCH_NAME}" RUN blocks ` +
        `(expected exactly 1) — if the patch was deliberately removed, delete ` +
        `this test with it.`,
    );
  }
  return hits;
}

/**
 * Python probe. Exits 0 only when all five properties above hold; prints the
 * offending assertions otherwise.
 *
 * Deliberately asserts OUTCOMES: it runs the real trigger loop from the image
 * and records which mental models it actually submits for refresh. Nothing
 * here greps the patched source.
 */
const PROBE = String.raw`
import asyncio
import importlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone

failures = []


def fail(msg):
    failures.append(msg)


import hindsight_api.engine.consolidation.consolidator as consolidator

ENV = "HINDSIGHT_MM_REFRESH_MIN_INTERVAL_S"


def load(interval):
    """Re-import the module under a given env value.

    The knob is read once at import (a container restart in production), so
    each scenario re-executes the module top level rather than poking a
    global — the probe exercises the shipping read path, not a shortcut.
    """
    if interval is None:
        os.environ.pop(ENV, None)
    else:
        os.environ[ENV] = interval
    return importlib.reload(consolidator)


NOW = datetime.now(timezone.utc)


def rows():
    return [
        {
            "id": "mm-fresh",
            "name": "fresh (refreshed 100s ago)",
            "tags": None,
            "last_refreshed_at": NOW - timedelta(seconds=100),
            "trigger": {"refresh_after_consolidation": True},
        },
        {
            "id": "mm-old",
            "name": "old (refreshed 7200s ago)",
            "tags": None,
            "last_refreshed_at": NOW - timedelta(seconds=7200),
            "trigger": {"refresh_after_consolidation": True},
        },
        {
            "id": "mm-never",
            "name": "never refreshed",
            "tags": None,
            "last_refreshed_at": None,
            "trigger": {"refresh_after_consolidation": True},
        },
    ]


class FakeConn:
    async def fetch(self, sql, *params):
        return rows()


class FakePool:
    """Raw-pool shape for acquire_with_retry's legacy branch."""

    def __init__(self, conn):
        self._conn = conn

    async def acquire(self):
        return self._conn

    async def release(self, conn):
        return None


class FakeEngine:
    """Fakes ONLY the engine boundary; the trigger loop under test is real."""

    def __init__(self):
        self._backend = FakePool(FakeConn())
        self.staleness_checked = []
        self.submitted = []

    async def compute_mental_model_is_stale(self, conn, bank_id, candidate):
        self.staleness_checked.append(candidate["id"])
        # Always stale — the exact condition of a bank under sustained
        # ingestion, which is the scenario the debounce exists for.
        return True

    async def submit_async_refresh_mental_model(self, bank_id, mental_model_id, request_context):
        self.submitted.append(mental_model_id)


async def drive(mod):
    eng = FakeEngine()
    n = await mod._trigger_mental_model_refreshes(
        memory_engine=eng,
        bank_id="probe-bank",
        request_context=object(),
        consolidated_tags=None,
        perf=None,
    )
    return n, eng


# ── 1-3. the default floor (env unset => image-baked 3600s) ───────────────
mod = load(None)
n, eng = asyncio.run(drive(mod))
print("DEFAULT_SUBMITTED", json.dumps(sorted(eng.submitted)))
print("DEFAULT_STALE_CHECKED", json.dumps(sorted(eng.staleness_checked)))
if "mm-fresh" in eng.submitted:
    fail("a model refreshed 100s ago was submitted under the default floor")
if "mm-old" not in eng.submitted:
    fail("a model refreshed 7200s ago was NOT submitted — the floor starves instead of deferring")
if "mm-never" not in eng.submitted:
    fail("a never-refreshed model was NOT submitted — NULL must never be debounced")
if n != len(eng.submitted):
    fail("returned count %r disagrees with %d submissions" % (n, len(eng.submitted)))
if "mm-fresh" in eng.staleness_checked:
    fail("the debounce did not precede the staleness round-trip — a debounced model still costs a query")

# ── 4. zero is the exact-upstream rollback hatch ──────────────────────────
mod = load("0")
n0, eng0 = asyncio.run(drive(mod))
print("OFF_SUBMITTED", json.dumps(sorted(eng0.submitted)))
if sorted(eng0.submitted) != ["mm-fresh", "mm-never", "mm-old"]:
    fail("interval 0 did not restore upstream refresh-every-round: " + json.dumps(sorted(eng0.submitted)))

# ── 5. bad values degrade to the default floor, never raise ───────────────
for bad in ("not-a-number", "-5", "nan"):
    mod = load(bad)
    try:
        nb, engb = asyncio.run(drive(mod))
    except Exception as e:
        fail("env %r raised out of the consolidation path: %s: %s" % (bad, type(e).__name__, e))
        continue
    if "mm-fresh" in engb.submitted:
        fail("env %r did not degrade to the default floor (fresh model submitted)" % (bad,))
    if "mm-old" not in engb.submitted or "mm-never" not in engb.submitted:
        fail("env %r over-blocked: submitted=%s" % (bad, json.dumps(sorted(engb.submitted))))

print("FAILURES", failures)
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
  const name = `sr-hs-mmdeb-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
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
        // The block is self-verifying: it asserts its upstream anchor exists
        // exactly once and re-asserts the result, so a non-zero exit here means
        // upstream drifted and the patch must be re-authored.
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

describe("Dockerfile.hindsight MM-refresh-debounce probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("extracts exactly the one patch block it claims to prove", () => {
    expect(patchBlocks()).toHaveLength(1);
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
  "Dockerfile.hindsight MM-refresh-debounce patch changes real behaviour",
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

    it("unpatched upstream is RED — the just-refreshed model is refreshed again", async () => {
      const { status, stdout } = await runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // The defect, driven: upstream submits ALL three models — including the
      // one refreshed 100 seconds ago — which is one consolidation round of
      // the measured 1,902-refreshes-a-day loop.
      expect(stdout).toContain(
        'DEFAULT_SUBMITTED ["mm-fresh", "mm-never", "mm-old"]',
      );
    }, 240_000);

    it("upstream + the baked patch block is GREEN on all five properties", async () => {
      const { status, stdout } = await runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      // 1-3. the floor binds on the fresh model, releases the elapsed one,
      // and never debounces a never-refreshed model…
      expect(stdout).toContain('DEFAULT_SUBMITTED ["mm-never", "mm-old"]');
      // …and the debounced model never reaches the staleness query.
      expect(stdout).toContain(
        'DEFAULT_STALE_CHECKED ["mm-never", "mm-old"]',
      );
      // 4. the documented rollback hatch is exact upstream behaviour.
      expect(stdout).toContain(
        'OFF_SUBMITTED ["mm-fresh", "mm-never", "mm-old"]',
      );
    }, 240_000);
  },
);
