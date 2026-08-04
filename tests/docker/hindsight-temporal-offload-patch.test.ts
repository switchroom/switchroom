/**
 * Behavioural proof for the temporal-OFFLOAD patch
 * `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight image.
 * `dockerfile-hindsight-bakes.test.ts` pins the *shape* of the patch block
 * (grep-on-file, runs everywhere). This file proves the *outcome*: that temporal
 * extraction no longer blocks the shared asyncio loop, and that its input is
 * bounded.
 *
 * The defect, measured live on `switchroom-hindsight` before the fix:
 *
 *   `retrieve_all_fact_types_parallel()` (engine/search/retrieval.py, an
 *   `async def`) called `extract_temporal_constraint()` SYNCHRONOUSLY before any
 *   await → `temporal_extraction.py` → `query_analyzer.py analyze()` →
 *   `dateparser.search_dates(...)`. `search_dates` is synchronous pure-Python
 *   CPU work whose cost is linear in input length × date density. The
 *   consolidation caller (`consolidator.py`, `query=m["text"]`) passes full
 *   multi-KB memory text, so one extraction blocked recall + consolidation +
 *   reranker together for seconds: 186 `EVENT LOOP BLOCKED` events in 4.5h, p50
 *   1.36s, max 14.95s (16KB date-dense text ≈ 988ms measured).
 *
 * The #4313 language pin (a SEPARATE, already-shipped patch) cut dateparser's
 * per-locale cost but cannot bound the per-CALL cost on unbounded input. This
 * patch does two things: (a) offloads `search_dates` to a dedicated
 * single-worker `ThreadPoolExecutor` via `loop.run_in_executor`, and (b) caps
 * the query fed to it with `HINDSIGHT_API_TEMPORAL_MAX_QUERY_CHARS` (default
 * 2000, 0 = unlimited).
 *
 * HONEST CAVEAT encoded below: dateparser is pure-Python + `re`, so the worker
 * thread holds the GIL during matching. Offloading does NOT fully free the loop
 * — it collapses a multi-second uninterruptible stall into ~5ms scheduler slices
 * (`sys.setswitchinterval` granularity). So this file does NOT assert "zero
 * loop lag"; it asserts an asyncio loop-lag probe (a ticker coroutine recording
 * the max inter-tick gap) stays SMALL — orders of magnitude below the parse
 * duration — while a real ≥200ms extraction completes. A test that merely
 * grepped for `run_in_executor` would not fail on the defect; this one bites.
 *
 * RED  = upstream + only the #4313 language block (offload patch ABSENT):
 *        `extract_temporal_constraint` called inline on the loop blocks the
 *        ticker for ≈ the full parse duration, and the async wrapper / config
 *        knob do not exist.
 * GREEN = upstream + #4313 + this offload block: awaiting
 *        `extract_temporal_constraint_async` keeps the max inter-tick gap tiny
 *        while the same parse runs, the char cap collapses a 34KB parse from
 *        ~800ms to <200ms, and the cap drops a date past char 2000 while cap=0
 *        preserves the full scan.
 *
 * The patch blocks are extracted from the Dockerfile itself rather than
 * duplicated here, so this test cannot drift from what actually ships. It
 * applies them by `docker exec` (not `docker build`) so it runs on daemons
 * without buildx, and it never touches the production `switchroom-hindsight`
 * container.
 *
 * SKIP DISCIPLINE: identical to `hindsight-temporal-language-patch.test.ts`.
 * Locally, with no docker or no cached image, this skips (never pull a 6.4GB
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
const TEST_PHASE = "hindsight-temporal-offload-patch";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/** Pull a named `RUN python3 - <<'PYEOF' … PYEOF` heredoc out of the Dockerfile. */
function patchBlockNamed(name: string): string {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  const b = blocks.find((x) => x.includes(name));
  if (!b) {
    throw new Error(
      `Dockerfile.hindsight no longer contains the "${name}" RUN block — if it ` +
        `was deliberately removed, delete this test with it.`
    );
  }
  return b;
}

// The offload patch's anchors are the POST-#4313 file state, so #4313 must be
// applied first — the same order the Dockerfile applies them.
const LANG_BLOCK = patchBlockNamed("temporal-language patch");
const OFFLOAD_BLOCK = patchBlockNamed("temporal-offload patch");

/**
 * GREEN probe. Runs against upstream + #4313 + the offload block. Exits 0 only
 * when the loop stays responsive off-loop AND the char cap behaves. Asserts
 * OUTCOMES, never source text.
 */
const GREEN_PROBE = String.raw`
import asyncio
import os
import sys
import time

sys.path.insert(0, "/app/api")

failures = []

from hindsight_api.config import HindsightConfig
from hindsight_api.engine import query_analyzer as QA
from hindsight_api.engine.search.temporal_extraction import (
    extract_temporal_constraint,
    extract_temporal_constraint_async,
)

# ---- the config knob resolves to 2000 through the REAL loader ----
cap_default = getattr(HindsightConfig.from_env(), "temporal_max_query_chars", "__ABSENT__")
print("DEFAULT_CAP", cap_default)
if cap_default != 2000:
    failures.append("default temporal_max_query_chars != 2000: %r" % (cap_default,))

# A big, date-dense text: long enough that the parse is unambiguously real work.
chunk = "on june 10 2025 and march 3 2024 and 5 days ago something happened; "
text = chunk * 500
print("TEXT_LEN", len(text))


async def ticker(stop, gaps):
    last = time.perf_counter()
    while not stop.is_set():
        await asyncio.sleep(0.005)
        now = time.perf_counter()
        gaps.append((now - last) * 1000.0)
        last = now


async def measure_offloop():
    # Uncapped analyzer so the off-loop parse is genuinely long.
    an = QA.DateparserQueryAnalyzer()
    an._max_query_chars = 0
    stop = asyncio.Event()
    gaps = []
    tk = asyncio.create_task(ticker(stop, gaps))
    await asyncio.sleep(0.05)  # let the ticker settle
    t0 = time.perf_counter()
    await extract_temporal_constraint_async(text, analyzer=an)
    dur = (time.perf_counter() - t0) * 1000.0
    stop.set()
    await tk
    return dur, max(gaps)


extract_ms, max_gap = asyncio.run(measure_offloop())
print("OFFLOOP_EXTRACT_MS", round(extract_ms, 1))
print("MAX_INTERTICK_GAP_MS", round(max_gap, 1))

# The load-bearing outcome. The extraction must be real work (>=150ms) so this
# is not a vacuous pass, and the loop must have kept ticking: max gap tiny in
# absolute terms AND a small fraction of the parse. On the unpatched sync path
# the gap is ~= the full parse duration (see the RED probe).
if extract_ms < 150:
    failures.append("off-loop extraction too fast to be a real probe: %.1fms" % (extract_ms,))
if max_gap >= 150:
    failures.append("loop stalled off-loop: max inter-tick gap %.1fms >= 150ms" % (max_gap,))
if max_gap >= extract_ms * 0.5:
    failures.append(
        "loop gap not decoupled from parse: gap %.1fms vs extract %.1fms" % (max_gap, extract_ms)
    )

# ---- the char cap collapses per-call cost on a huge query ----
big = chunk * 500  # ~34KB
an_cap = QA.DateparserQueryAnalyzer()
an_cap._max_query_chars = 2000
t0 = time.perf_counter()
extract_temporal_constraint(big, analyzer=an_cap)
capped_ms = (time.perf_counter() - t0) * 1000.0
print("CAPPED_MS", round(capped_ms, 1))
if capped_ms >= 200:
    failures.append("cap=2000 did not bound cost: %.1fms >= 200ms" % (capped_ms,))

# ---- correctness: a date past char 2000 is dropped under the cap, kept at 0 ----
# Head has no temporal content; the only date lives well past 2000 chars.
head = ("plain words with no temporal content here " * 60)[:2100]
mixed = head + " on june 10 2025 clearly a date"
an_c = QA.DateparserQueryAnalyzer()
an_c._max_query_chars = 2000
capped_res = extract_temporal_constraint(mixed, analyzer=an_c)
an_u = QA.DateparserQueryAnalyzer()
an_u._max_query_chars = 0
full_res = extract_temporal_constraint(mixed, analyzer=an_u)
print("MIXED_HEADLEN", len(head))
print("CAPPED_DROPS_LATE_DATE", capped_res is None)
print("FULLSCAN_KEEPS_LATE_DATE", full_res is not None)
if capped_res is not None:
    failures.append("cap=2000 did NOT drop a date past char 2000: %r" % (capped_res,))
if full_res is None:
    failures.append("cap=0 (full scan) missed the late date it should keep")

# ---- and the cap does not harm a short live-recall-shaped query ----
short = extract_temporal_constraint("what happened on june 10 2025", analyzer=QA.DateparserQueryAnalyzer())
print("SHORT_QUERY_NONNULL", short is not None)
if short is None:
    failures.append("cap regressed a short explicit-date query (would break live recall)")

print("FAILURES", failures)
print("PROBE_EXECUTED")
sys.exit(1 if failures else 0)
`;

/**
 * RED probe. Runs against upstream + only the #4313 language block (offload
 * patch ABSENT). Proves the defect bites: the async wrapper and config knob do
 * not exist, and calling the sync extractor inline on the loop blocks the
 * ticker for ≈ the full parse duration.
 */
const RED_PROBE = String.raw`
import asyncio
import sys
import time

sys.path.insert(0, "/app/api")

from hindsight_api.config import HindsightConfig
from hindsight_api.engine import query_analyzer as QA
import hindsight_api.engine.search.temporal_extraction as TE

# The async wrapper must not exist yet, and neither must the config knob.
has_async = hasattr(TE, "extract_temporal_constraint_async")
print("HAS_ASYNC_WRAPPER", has_async)
cap_default = getattr(HindsightConfig.from_env(), "temporal_max_query_chars", "__ABSENT__")
print("DEFAULT_CAP", cap_default)

chunk = "on june 10 2025 and march 3 2024 and 5 days ago something happened; "
text = chunk * 500
print("TEXT_LEN", len(text))


async def ticker(stop, gaps):
    last = time.perf_counter()
    while not stop.is_set():
        await asyncio.sleep(0.005)
        now = time.perf_counter()
        gaps.append((now - last) * 1000.0)
        last = now


async def measure_inline():
    an = QA.DateparserQueryAnalyzer()
    stop = asyncio.Event()
    gaps = []
    tk = asyncio.create_task(ticker(stop, gaps))
    await asyncio.sleep(0.05)
    t0 = time.perf_counter()
    # The pre-patch retrieval.py behaviour: sync extraction inline on the loop.
    TE.extract_temporal_constraint(text, analyzer=an)
    dur = (time.perf_counter() - t0) * 1000.0
    stop.set()
    await tk
    return dur, max(gaps)


extract_ms, max_gap = asyncio.run(measure_inline())
print("INLINE_EXTRACT_MS", round(extract_ms, 1))
print("MAX_INTERTICK_GAP_MS", round(max_gap, 1))
print("PROBE_EXECUTED")
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
 */
const REQUIRED = process.env.SWITCHROOM_REQUIRE_HINDSIGHT_PROBE === "1";

const dockerOk = hasDocker();
const imageOk = dockerOk && hasImage(UPSTREAM_IMAGE);

type ProbeResult = { status: number; stdout: string };

/**
 * Run a probe in a throwaway container. Always applies the #4313 language block
 * first (it is already-shipped); applies the offload block too iff `offload`.
 */
function runProbe(offload: boolean, probe: string): ProbeResult {
  const name = `sr-hs-toff-${offload ? "green" : "red"}-${RUN_ID.slice(0, 8)}`;
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
        "400",
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );

    // #4313 first (its anchors are upstream); it is the baseline both RED and
    // GREEN share, since it ships independently of this fix.
    execFileSync("docker", ["exec", "-i", name, "python3", "-"], {
      input: LANG_BLOCK,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (offload) {
      // Self-verifying: asserts its post-#4313 anchors exist exactly once, so a
      // non-zero exit here means upstream (or #4313) drifted and the patch must
      // be re-authored.
      execFileSync("docker", ["exec", "-i", name, "python3", "-"], {
        input: OFFLOAD_BLOCK,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    const res = execFileSync(
      "docker",
      ["exec", "-i", "-w", "/app/api", name, "/app/api/.venv/bin/python", "-"],
      { input: probe, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" }
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

describe("Dockerfile.hindsight temporal-offload probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("hard-fails rather than skipping when CI demands a real run", () => {
    if (!REQUIRED) {
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
  "Dockerfile.hindsight temporal-offload patch changes real behaviour",
  () => {
    afterAll(() => {
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

    it("unpatched (offload absent) is RED — sync extraction blocks the loop for ≈ the full parse, and the wrapper/knob don't exist", () => {
      const { stdout } = runProbe(false, RED_PROBE);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      // The async off-loop wrapper does not exist yet…
      expect(stdout).toContain("HAS_ASYNC_WRAPPER False");
      // …nor the config knob (getattr sentinel on the real loader).
      expect(stdout).toContain("DEFAULT_CAP __ABSENT__");

      // The concrete defect: the loop was blocked for ≈ the whole parse. Parse
      // the two numbers out and assert the gap is a large fraction of it.
      const extract = Number(
        stdout.match(/INLINE_EXTRACT_MS ([\d.]+)/)?.[1] ?? "0"
      );
      const gap = Number(
        stdout.match(/MAX_INTERTICK_GAP_MS ([\d.]+)/)?.[1] ?? "0"
      );
      expect(extract, `probe did not do real work:\n${stdout}`).toBeGreaterThan(
        150
      );
      expect(
        gap,
        `expected the loop to be blocked for ~the full parse but gap=${gap}ms extract=${extract}ms:\n${stdout}`
      ).toBeGreaterThan(extract * 0.5);
    }, 240_000);

    it("upstream + #4313 + the offload block is GREEN — the loop stays responsive off-loop and the char cap bounds cost", () => {
      const { status, stdout } = runProbe(true, GREEN_PROBE);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      // The knob resolves to 2000 through the real loader.
      expect(stdout).toContain("DEFAULT_CAP 2000");
      // The load-bearing outcome: real work off-loop, loop stayed responsive.
      expect(stdout).toContain("CAPPED_DROPS_LATE_DATE True");
      expect(stdout).toContain("FULLSCAN_KEEPS_LATE_DATE True");
      expect(stdout).toContain("SHORT_QUERY_NONNULL True");

      // Cross-check the numbers directly too: gap must be tiny vs the parse.
      const extract = Number(
        stdout.match(/OFFLOOP_EXTRACT_MS ([\d.]+)/)?.[1] ?? "0"
      );
      const gap = Number(
        stdout.match(/MAX_INTERTICK_GAP_MS ([\d.]+)/)?.[1] ?? "0"
      );
      expect(extract, `off-loop parse too short:\n${stdout}`).toBeGreaterThan(
        150
      );
      expect(
        gap,
        `loop stalled off-loop: gap=${gap}ms extract=${extract}ms:\n${stdout}`
      ).toBeLessThan(150);
      expect(gap).toBeLessThan(extract * 0.5);
    }, 240_000);
  }
);
