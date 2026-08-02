/**
 * Behavioural proof for the reranker-foreground-priority patch #3142 that
 * `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight image.
 *
 * `dockerfile-hindsight-bakes.test.ts` pins the SHAPE of the patch block
 * (grep-on-file, runs everywhere). This file proves the OUTCOME: it runs the
 * same probe against unpatched upstream (must be RED — no priority pool, no
 * `background` kwarg) and against upstream + the patch block applied (must be
 * GREEN — foreground work is dispatched ahead of queued background work, and
 * the `background` flag is threaded through the reranker surface).
 *
 * Upstream PR: vectorize-io/hindsight #3142 (OPEN — a source fork patch, not an
 * adopted-upstream retire). The defect it fixes: reranking is CPU-bound in a
 * fixed thread pool, upstream drains ONE FIFO queue, so an interactive
 * (foreground) rerank submitted while consolidation/reflect have already queued
 * a wall of background reranks waits behind every one of them — spiking
 * interactive recall latency. The fix swaps `ThreadPoolExecutor` for a
 * `_PriorityRerankExecutor` (a fixed pool over a `PriorityQueue` ordered
 * `(priority, seq)`; foreground=0 jumps ahead of queued background=1 but never
 * preempts a background job already running) and threads a keyword-only
 * `background` flag from the recall call site through `rerank()` to every
 * provider's `predict()`.
 *
 * The probe asserts OUTCOMES the patch text alone cannot prove, using only the
 * pure-stdlib executor (no model load, so it is deterministic and fast):
 *
 *  - Foreground jumps queued background, FIFO within a priority class. With a
 *    single worker occupied, a background job then two foreground jobs are
 *    queued; on release the two foreground jobs run before the background one,
 *    in submission order — a direct read of the (priority, seq) ordering.
 *  - A background submit still resolves its Future to the real return value,
 *    and an exception propagates to the awaiting caller.
 *  - A Future cancelled while still queued never runs (set_running_or_notify_
 *    cancel path).
 *  - shutdown(wait=True) joins every worker; max_workers < 1 is rejected.
 *  - The `background` param reaches CrossEncoderModel.predict (abstract),
 *    LocalSTCrossEncoder.predict, and CrossEncoderReranker.rerank — keyword-
 *    only, default False — so the recall call site can steer priority.
 *
 * The block is extracted from the Dockerfile itself (never duplicated here), so
 * this test cannot drift from what ships. It applies the block by `docker exec`
 * (not `docker build`) so it runs on daemons without buildx, and it never
 * touches the production `switchroom-hindsight` container.
 *
 * SKIP DISCIPLINE mirrors hindsight-search-patches.test.ts: locally, no docker
 * or no cached image skips (never pull a 6.4GB third-party image onto a dev
 * box); in CI, `.github/workflows/docker-e2e.yml`'s `hindsight-probe` job pulls
 * the pinned digest and sets `SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1`, under which
 * an unavailable docker/image is a HARD FAILURE, never a green skip. Both runs
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
const TEST_PHASE = "hindsight-reranker-priority-patch";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/**
 * The #3142 patch block, pulled out of the Dockerfile's
 * `RUN python3 - <<'PYEOF' … PYEOF` heredocs by its unique patch name.
 */
function patchBlock(): string {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  const b = blocks.find((x) =>
    x.includes("reranker-foreground-priority patch")
  );
  if (!b) {
    throw new Error(
      "Dockerfile.hindsight no longer contains the #3142 " +
        "reranker-foreground-priority RUN block — if it was deliberately " +
        "removed (e.g. adopted upstream), delete this test with it."
    );
  }
  return b;
}

/**
 * Python probe. Exits 0 only when the priority pool exists AND every ordering /
 * threading property holds; prints the offending assertions otherwise. Written
 * so unpatched upstream — which has none of these symbols — reports a clean RED
 * failure rather than dying before the PROBE_EXECUTED sentinel.
 */
const PROBE = String.raw`
import inspect
import sys
import threading
import time

import hindsight_api.engine.cross_encoder as ce
from hindsight_api.engine.cross_encoder import CrossEncoderModel
from hindsight_api.engine.search.reranking import CrossEncoderReranker

failures = []

Executor = getattr(ce, "_PriorityRerankExecutor", None)
print("EXECUTOR_PRESENT", Executor is not None)
if Executor is None:
    failures.append("no _PriorityRerankExecutor - PR #3142 patch is not applied")


def bg_param(fn):
    p = inspect.signature(fn).parameters.get("background")
    return p


# The background flag must reach every layer the recall call site steers
# through, keyword-only with a False default (so existing positional callers are
# untouched and remote providers can accept-and-ignore it).
for label, fn in (
    ("CrossEncoderModel.predict", CrossEncoderModel.predict),
    ("LocalSTCrossEncoder.predict", ce.LocalSTCrossEncoder.predict),
    ("CrossEncoderReranker.rerank", CrossEncoderReranker.rerank),
):
    p = bg_param(fn)
    print("BG_PARAM", label, p is not None)
    if p is None:
        failures.append("%s lost the background kwarg - #3142 not applied" % label)
        continue
    if p.kind is not inspect.Parameter.KEYWORD_ONLY:
        failures.append("%s background param is not keyword-only" % label)
    if p.default is not False:
        failures.append("%s background default is not False (got %r)" % (label, p.default))

if Executor is not None:
    # ---- deterministic priority ordering with a single worker ----
    # One worker means (priority, seq) fully determines execution order, so this
    # is a direct behavioural read of "foreground jumps queued background,
    # FIFO within a priority class" with no timing race.
    pool = Executor(max_workers=1, thread_name_prefix="probe")
    order = []
    order_lock = threading.Lock()
    occupied = threading.Event()
    release = threading.Event()

    def occupy():
        occupied.set()
        release.wait(5)

    def rec(tag):
        with order_lock:
            order.append(tag)
        return tag

    f_occ = pool.submit(occupy)
    if not occupied.wait(5):
        failures.append("worker never picked up the occupying job")
    # Queue background FIRST, then two foreground, while the worker is busy.
    f_bg = pool.submit(rec, "bg", background=True)
    f_fg1 = pool.submit(rec, "fg1", background=False)
    f_fg2 = pool.submit(rec, "fg2", background=False)
    release.set()
    for f in (f_occ, f_bg, f_fg1, f_fg2):
        f.result(5)
    print("PRIORITY_ORDER", order)
    if order != ["fg1", "fg2", "bg"]:
        failures.append(
            "priority order wrong: %r (foreground must precede queued "
            "background, FIFO within a priority class)" % (order,)
        )

    # ---- a background submit resolves to the real value ----
    r = pool.submit(lambda x: x * 2, 21, background=True).result(5)
    print("BG_RESULT", r)
    if r != 42:
        failures.append("background submit did not resolve to the real return value (got %r)" % (r,))

    # ---- exceptions propagate to the awaiting caller ----
    def boom():
        raise ValueError("kaboom")

    exc_ok = False
    try:
        pool.submit(boom).result(5)
    except ValueError as e:
        exc_ok = str(e) == "kaboom"
    print("EXC_PROPAGATED", exc_ok)
    if not exc_ok:
        failures.append("exception did not propagate from the worker to the caller")

    # ---- a Future cancelled while still queued never runs ----
    started2 = threading.Event()
    release2 = threading.Event()

    def occupy2():
        started2.set()
        release2.wait(5)

    f_occ2 = pool.submit(occupy2)
    started2.wait(5)
    f_skip = pool.submit(rec, "should-not-run")
    cancelled = f_skip.cancel()
    release2.set()
    f_occ2.result(5)
    time.sleep(0.2)  # let the worker drain the (cancelled) queue entry
    ran = "should-not-run" in order
    print("CANCELLED_QUEUED_SKIPPED", cancelled and not ran)
    if not cancelled or ran:
        failures.append("a Future cancelled while queued still executed")

    # ---- shutdown joins every worker; bad size is rejected ----
    pool.shutdown(wait=True)
    alive = [t for t in pool._threads if t.is_alive()]
    print("SHUTDOWN_JOINED", not alive)
    if alive:
        failures.append("shutdown(wait=True) left %d worker(s) alive" % (len(alive),))

    rejected = False
    try:
        Executor(max_workers=0)
    except ValueError:
        rejected = True
    print("REJECTS_ZERO_WORKERS", rejected)
    if not rejected:
        failures.append("max_workers=0 was not rejected")

print("FAILURES", failures)
# Sentinel: proves the probe ran to completion.
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
 * `.github/workflows/docker-e2e.yml` sets it after pulling the pinned digest.
 */
const REQUIRED = process.env.SWITCHROOM_REQUIRE_HINDSIGHT_PROBE === "1";

const dockerOk = hasDocker();
const imageOk = dockerOk && hasImage(UPSTREAM_IMAGE);

type ProbeResult = { status: number; stdout: string };

/** Run the probe in a throwaway container, optionally patching first. */
function runProbe(patched: boolean): ProbeResult {
  const name = `sr-hs-rerank-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
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
      // exactly the expected number of times and re-asserts the result, so a
      // non-zero exit here means upstream drifted and the patch must be
      // re-authored.
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

describe("Dockerfile.hindsight reranker-priority probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("the #3142 RUN block is present to extract", () => {
    expect(patchBlock()).toContain("class _PriorityRerankExecutor:");
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
  "Dockerfile.hindsight reranker-priority patch changes real behaviour",
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

    it("unpatched upstream is RED (no priority pool, no background kwarg)", () => {
      const { status, stdout } = runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);
      expect(stdout).toContain("EXECUTOR_PRESENT False");
      expect(stdout).toContain(
        "no _PriorityRerankExecutor - PR #3142 patch is not applied"
      );
      // The background kwarg is absent from every layer upstream.
      expect(stdout).toContain("BG_PARAM CrossEncoderModel.predict False");
      expect(stdout).toContain("BG_PARAM CrossEncoderReranker.rerank False");
    }, 240_000);

    it("upstream + the baked #3142 block is GREEN, priority ordering and all", () => {
      const { status, stdout } = runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      expect(stdout).toContain("EXECUTOR_PRESENT True");
      // Foreground jumps queued background, FIFO within a priority class.
      expect(stdout).toContain("PRIORITY_ORDER ['fg1', 'fg2', 'bg']");
      // The background flag reaches every steered layer, keyword-only/False.
      expect(stdout).toContain("BG_PARAM CrossEncoderModel.predict True");
      expect(stdout).toContain("BG_PARAM LocalSTCrossEncoder.predict True");
      expect(stdout).toContain("BG_PARAM CrossEncoderReranker.rerank True");
      // Futures resolve, exceptions propagate, cancellation is honoured,
      // shutdown joins, and a bad pool size is rejected.
      expect(stdout).toContain("BG_RESULT 42");
      expect(stdout).toContain("EXC_PROPAGATED True");
      expect(stdout).toContain("CANCELLED_QUEUED_SKIPPED True");
      expect(stdout).toContain("SHUTDOWN_JOINED True");
      expect(stdout).toContain("REJECTS_ZERO_WORKERS True");
    }, 240_000);
  }
);
