/**
 * Behavioural proof for the graph-maintenance retry-storm patch that
 * `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight image.
 *
 * `dockerfile-hindsight-bakes.test.ts` pins the *shape* of that patch block
 * (grep-on-file, runs everywhere). This file proves the *outcome*: it runs the
 * same probe against unpatched upstream (must be RED) and against upstream +
 * the patch block applied (must be GREEN). Nothing here greps the patched
 * source — every assertion drives real shipping code and observes what it does.
 *
 * THE DEFECTS, in the real shipping source at the pinned digest.
 *
 * A production `graph_maintenance` Pass 3 (`prune_stale_cooccurrences`) was
 * measured at ~114,836 ms / 174M shared-buffer hits against a 60s asyncpg
 * `command_timeout`. Three separate bugs turned that one slow statement into a
 * recurring production incident:
 *
 *  A1 `engine/db_utils.py:57` — `_is_retryable` returns True for
 *     `asyncio.TimeoutError`, so a statement that DETERMINISTICALLY blows its
 *     timeout is retried. With `_SWEEP_MAX_RETRIES = 8` that is 9 attempts, on
 *     2 banks, every 30 minutes: ~18 minutes of wasted production DB CPU per
 *     cycle contending with live retain/recall traffic.
 *
 *  A2 `worker/poller.py` — the generic failure path passed `str(e)` to
 *     `_mark_failed`, and `str(asyncio.TimeoutError())` is the EMPTY STRING.
 *     Operations landed as status='failed' with a blank `error_message`.
 *     Measured on a live bank: 23 of 28 failed `graph_maintenance` operations
 *     carried an empty `error_message`.
 *
 *  A3 `engine/graph_maintenance.py` — Pass 2 (orphan-entity prune) and Pass 3
 *     shared ONE transaction, so a Pass 3 timeout rolled back Pass 2's
 *     completed work as well. The naive split (both passes still under ONE
 *     retry scope) has its own defect, which this probe also drives: a Pass 3
 *     retry re-runs Pass 2, finds 0 orphans because the first pass already
 *     committed them, and OVERWRITES the true count with 0.
 *
 * WHY THE SHAPE TEST IS NOT ENOUGH. A1 in particular has a silent-inert
 * failure mode that no grep can see: on Python 3.10+ the builtin
 * `TimeoutError` is an `OSError` SUBCLASS and on 3.11+ `asyncio.TimeoutError`
 * IS that builtin, so a "fix" that adds the `retry_timeouts` parameter but
 * leaves the timeout arm AFTER `isinstance(exc, OSError)` still contains every
 * literal a bakes test greps for while retrying timeouts exactly as before.
 * Only running the patched module catches that, which is what this file does.
 *
 * The probe drives the REAL `retry_with_backoff`, the REAL
 * `WorkerPoller._execute_task_inner` failure path and the REAL
 * `run_graph_maintenance_job` from the image, stubbing only the database and
 * the executor — rather than re-implementing any of them here.
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
const TEST_PHASE = "hindsight-graph-maintenance-retry-storm";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/** The patch this file proves, named by its unique in-block marker. */
const PATCH_NAME = "graph-maintenance retry-storm patch";

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
 * Python probe. Exits 0 only when every property holds; prints the offending
 * assertions otherwise. Every printed sentinel is asserted by BOTH the RED and
 * the GREEN case below, so the two runs are compared on the same observations.
 */
const PROBE = String.raw`
import asyncio
import json
import sys

failures = []


def fail(msg):
    failures.append(msg)


from hindsight_api.engine import db_utils
from hindsight_api.engine import graph_maintenance as gm


# ── zero out the backoff sleeps, nothing else ─────────────────────────────
# db_utils reaches asyncio for exactly two things: asyncio.TimeoutError in the
# retryability predicate, and asyncio.sleep for the backoff. Swapping in a shim
# that keeps the former and no-ops the latter makes the probe fast WITHOUT
# reducing the retry budget, so the attempt COUNTS below are the real ones
# (9 = _SWEEP_MAX_RETRIES 8 + 1), not a shrunken stand-in.
class _NoSleepAsyncio:
    TimeoutError = asyncio.TimeoutError

    @staticmethod
    async def sleep(_delay):
        return None


db_utils.asyncio = _NoSleepAsyncio


class DeadlockDetectedError(Exception):
    """Stands in for asyncpg's error class, which db_utils matches BY NAME."""


# ══ A1: retry_with_backoff must be able to treat a timeout as a verdict ═══
async def _count_attempts(exc_factory, **kwargs):
    calls = []

    async def _f():
        calls.append(1)
        raise exc_factory()

    try:
        await db_utils.retry_with_backoff(_f, max_retries=8, **kwargs)
    except TypeError:
        # NOT swallowed: unpatched upstream has no retry_timeouts parameter, and
        # that must surface as the distinct "no such knob" signal below rather
        # than being mistaken for "the function ran and made 0 attempts".
        raise
    except BaseException:
        pass
    return len(calls)


timeout_default = asyncio.run(_count_attempts(asyncio.TimeoutError))
print("A1_TIMEOUT_ATTEMPTS_DEFAULT", timeout_default)
if timeout_default != 9:
    fail("default retry_with_backoff no longer retries timeouts (%d attempts, expected 9)" % timeout_default)

def _optout(exc_factory):
    """Attempts under retry_timeouts=False; -1 when the knob does not exist."""
    try:
        return asyncio.run(_count_attempts(exc_factory, retry_timeouts=False))
    except TypeError as e:
        print("A1_NO_RETRY_TIMEOUTS_PARAM", repr(str(e)))
        return -1


timeout_optout = _optout(asyncio.TimeoutError)
print("A1_TIMEOUT_ATTEMPTS_OPTOUT", timeout_optout)
if timeout_optout != 1:
    fail("retry_timeouts=False did not stop the retry storm (%d attempts, expected 1)" % timeout_optout)

# The opt-out must be SURGICAL: a builtin TimeoutError is an OSError subclass on
# py3.10+, so an implementation that tests the OSError arm first is inert. Drive
# both classes, and prove the non-timeout retryables are untouched.
builtin_optout = _optout(TimeoutError)
print("A1_BUILTIN_TIMEOUT_ATTEMPTS_OPTOUT", builtin_optout)
if builtin_optout != 1:
    fail("builtin TimeoutError still retried under retry_timeouts=False (%d attempts) — the OSError arm swallowed it" % builtin_optout)

for label, factory in (("deadlock", DeadlockDetectedError), ("connection", ConnectionError), ("oserror", OSError)):
    n = _optout(factory)
    print("A1_STILL_RETRIED_" + label.upper(), n)
    if n != 9:
        fail("retry_timeouts=False wrongly disabled retries for %s (%d attempts, expected 9)" % (label, n))

n = _optout(ValueError)
print("A1_NONRETRYABLE_ATTEMPTS", n)
if n != 1:
    fail("a non-retryable error was retried (%d attempts, expected 1)" % n)


# ══ A2: a failed task must never record a blank error_message ════════════
from hindsight_api.worker import poller as poller_mod


class _NullMetrics:
    def record_operation_result(self, *a, **k):
        return None


poller_mod.get_metrics_collector = lambda: _NullMetrics()


def _drive_failure(exc):
    """Run the REAL _execute_task_inner failure path; capture what it records."""
    p = object.__new__(poller_mod.WorkerPoller)
    recorded = {}

    async def _run_executor(task, task_type):
        raise exc

    async def _mark_failed(operation_id, error_message, schema):
        recorded["error_message"] = error_message

    async def _mark_completed(operation_id, schema):
        raise AssertionError("task should not have completed")

    p._run_executor = _run_executor
    p._mark_failed = _mark_failed
    p._mark_completed = _mark_completed
    task = poller_mod.ClaimedTask(
        operation_id="op-probe",
        task_dict={"type": "graph_maintenance", "bank_id": "probe"},
        schema=None,
    )
    asyncio.run(p._execute_task_inner(task))
    return recorded.get("error_message")


msg_timeout = _drive_failure(asyncio.TimeoutError())
print("A2_TIMEOUT_ERROR_MESSAGE", json.dumps(msg_timeout))
if not (msg_timeout or "").strip():
    fail("a timed-out task recorded a BLANK error_message: %r" % (msg_timeout,))
else:
    if "TimeoutError" not in msg_timeout:
        fail("the recorded error_message does not name the exception class: %r" % (msg_timeout,))
    if "graph_maintenance" not in msg_timeout:
        fail("the recorded error_message carries no task context: %r" % (msg_timeout,))

# Conservative by design: an exception that DOES have a message is passed
# through byte-for-byte, so existing operator surfaces that match on error text
# (and _summarise_child_error_messages, which groups siblings by exact message)
# are unaffected.
msg_normal = _drive_failure(RuntimeError("boom: something specific"))
print("A2_NORMAL_ERROR_MESSAGE", json.dumps(msg_normal))
if msg_normal != "boom: something specific":
    fail("a normal error message was rewritten: %r" % (msg_normal,))


# ══ A3: Pass 2 and Pass 3 must not share a transaction or a retry scope ═══
class _Txn:
    """Records whether the block it wrapped committed or rolled back."""

    def __init__(self, log):
        self._log = log

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self._log.append("rollback" if exc_type is not None else "commit")
        return False


class _Conn:
    def __init__(self, log):
        self._log = log

    def transaction(self):
        return _Txn(self._log)


class _Acquire:
    def __init__(self, log):
        self._log = log

    async def __aenter__(self):
        return _Conn(self._log)

    async def __aexit__(self, *a):
        return False


class _Store:
    """Fake memories store: counts each pass and scripts Pass 3's outcome."""

    def __init__(self, pass3):
        self.orphan_calls = 0
        self.cooccurrence_calls = 0
        self._pass3 = pass3

    async def relink_pass(self, **kwargs):
        return {}

    async def prune_orphan_entities(self, **kwargs):
        self.orphan_calls += 1
        # The real prune is idempotent: the FIRST call finds the orphans, every
        # later call in the same job finds none because they are already gone.
        return 7 if self.orphan_calls == 1 else 0

    async def prune_stale_cooccurrences(self, **kwargs):
        self.cooccurrence_calls += 1
        outcome = self._pass3(self.cooccurrence_calls)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


class _Engine:
    async def _get_backend(self):
        return object()


def _run_job(pass3):
    """Drive the REAL run_graph_maintenance_job against fakes."""
    import hindsight_api.config as config_mod
    import hindsight_api.engine.memories as memories_mod
    import hindsight_api.engine.memory_engine as memory_engine_mod

    txn_log = []
    store = _Store(pass3)
    config_mod.get_config = lambda: object()
    memories_mod.get_memories = lambda: store
    memory_engine_mod.acquire_with_retry = lambda backend, **k: _Acquire(txn_log)

    error = None
    result = None
    try:
        result = asyncio.run(
            gm.run_graph_maintenance_job(_Engine(), "probe-bank", None, operation_id="op-probe")
        )
    except BaseException as e:
        error = e
    return store, txn_log, result, error


# --- A3a: Pass 3 times out. Pass 2's work must survive, and must not storm. ---
store, txn_log, result, error = _run_job(lambda n: asyncio.TimeoutError())
print("A3A_ORPHAN_PASSES", store.orphan_calls)
print("A3A_COOCCURRENCE_PASSES", store.cooccurrence_calls)
print("A3A_TXN_LOG", json.dumps(txn_log))
print("A3A_ERROR", type(error).__name__ if error is not None else None)
if store.cooccurrence_calls != 1:
    fail("Pass 3 timeout was retried %d times — the storm is still there" % store.cooccurrence_calls)
if store.orphan_calls != 1:
    fail("Pass 2 ran %d times for one job — a Pass 3 retry is re-running it" % store.orphan_calls)
if "commit" not in txn_log:
    fail("nothing committed: Pass 2's orphan prune was rolled back by Pass 3's failure (%r)" % (txn_log,))
if txn_log[:1] != ["commit"]:
    fail("Pass 2 did not commit before Pass 3 ran: %r" % (txn_log,))
if error is None:
    fail("a failing Pass 3 silently reported success — the failure must still propagate")

# --- A3b: Pass 3 fails retryably once, then succeeds. The count must hold. ---
def _deadlock_once(n):
    return DeadlockDetectedError("simulated") if n == 1 else 4


store, txn_log, result, error = _run_job(_deadlock_once)
print("A3B_ORPHAN_PASSES", store.orphan_calls)
print("A3B_COOCCURRENCE_PASSES", store.cooccurrence_calls)
print("A3B_RESULT", json.dumps(result, sort_keys=True))
print("A3B_ERROR", type(error).__name__ if error is not None else None)
if error is not None:
    fail("a retryable Pass 3 failure was not retried: %r" % (error,))
if store.cooccurrence_calls != 2:
    fail("expected exactly one Pass 3 retry, saw %d attempts" % store.cooccurrence_calls)
if store.orphan_calls != 1:
    fail("Pass 2 re-ran on the Pass 3 retry (%d calls) — its real count gets overwritten" % store.orphan_calls)
if (result or {}).get("orphan_entities_pruned") != 7:
    fail(
        "the reported orphan count was clobbered by the Pass 3 retry: %r (expected 7)"
        % ((result or {}).get("orphan_entities_pruned"),)
    )
if (result or {}).get("stale_cooccurrences_pruned") != 4:
    fail("the reported stale-cooccurrence count is wrong: %r" % ((result or {}).get("stale_cooccurrences_pruned"),))

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
  const name = `sr-hs-gmstorm-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
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
        // The block is self-verifying: it asserts each upstream anchor exists
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

describe("Dockerfile.hindsight graph-maintenance retry-storm probe is real, not a silent skip", () => {
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
  "Dockerfile.hindsight graph-maintenance retry-storm patch changes real behaviour",
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

    it("unpatched upstream is RED — the storm, the blank error, and the clobbered count are all live", async () => {
      const { status, stdout } = await runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // A1: upstream retries a deterministic timeout to exhaustion, and has no
      // way to say otherwise.
      expect(stdout).toContain("A1_TIMEOUT_ATTEMPTS_DEFAULT 9");
      expect(stdout).toContain("A1_NO_RETRY_TIMEOUTS_PARAM");
      expect(stdout).toContain("A1_TIMEOUT_ATTEMPTS_OPTOUT -1");

      // A2: a timed-out task records an EMPTY error_message.
      expect(stdout).toContain('A2_TIMEOUT_ERROR_MESSAGE ""');

      // A3a: Pass 3's timeout storms 9 times, drags Pass 2 through 9 reruns,
      // and every one of those transactions rolls back — Pass 2's work is lost.
      expect(stdout).toContain("A3A_COOCCURRENCE_PASSES 9");
      expect(stdout).toContain("A3A_ORPHAN_PASSES 9");
      expect(stdout).toContain(
        `A3A_TXN_LOG [${Array(9).fill('"rollback"').join(", ")}]`,
      );

      // A3b: a single retryable Pass 3 failure re-runs Pass 2 and overwrites
      // the real orphan count with 0.
      expect(stdout).toContain("A3B_ORPHAN_PASSES 2");
      expect(stdout).toContain('"orphan_entities_pruned": 0');
    }, 240_000);

    it("patched is GREEN — timeouts are a verdict, failures are legible, Pass 2 survives", async () => {
      const { status, stdout } = await runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(stdout).toContain("FAILURES []");
      expect(status, `probe failed:\n${stdout}`).toBe(0);

      // A1: the opt-out bites, and bites ONLY timeouts. The default is
      // unchanged, so every other retry_with_backoff caller in the image keeps
      // upstream behaviour.
      expect(stdout).toContain("A1_TIMEOUT_ATTEMPTS_DEFAULT 9");
      expect(stdout).toContain("A1_TIMEOUT_ATTEMPTS_OPTOUT 1");
      expect(stdout).toContain("A1_BUILTIN_TIMEOUT_ATTEMPTS_OPTOUT 1");
      expect(stdout).toContain("A1_STILL_RETRIED_DEADLOCK 9");
      expect(stdout).toContain("A1_STILL_RETRIED_CONNECTION 9");
      expect(stdout).toContain("A1_STILL_RETRIED_OSERROR 9");

      // A2: diagnostic, and non-empty messages are untouched.
      expect(stdout).toMatch(
        /A2_TIMEOUT_ERROR_MESSAGE "[^"]*TimeoutError[^"]*graph_maintenance[^"]*"/,
      );
      expect(stdout).toContain(
        'A2_NORMAL_ERROR_MESSAGE "boom: something specific"',
      );

      // A3a: one Pass 3 attempt, one Pass 2 run, and Pass 2 COMMITTED before
      // Pass 3 was even tried. The failure still propagates.
      expect(stdout).toContain("A3A_COOCCURRENCE_PASSES 1");
      expect(stdout).toContain("A3A_ORPHAN_PASSES 1");
      expect(stdout).toContain('A3A_TXN_LOG ["commit", "rollback"]');
      expect(stdout).toContain("A3A_ERROR TimeoutError");

      // A3b: the retry scope covers Pass 3 only, so the real orphan count
      // survives the retry.
      expect(stdout).toContain("A3B_ORPHAN_PASSES 1");
      expect(stdout).toContain("A3B_COOCCURRENCE_PASSES 2");
      expect(stdout).toContain('"orphan_entities_pruned": 7');
      expect(stdout).toContain('"stale_cooccurrences_pruned": 4');
    }, 240_000);
  },
);
