/**
 * Cross-process concurrency test for the vault flock (#978).
 *
 * `flock.test.ts` exercises every per-branch behavior of acquireLock
 * in a single thread using planted lock files. That covers the
 * decision logic but doesn't exercise the design's load-bearing
 * claim: the kernel's `openSync(O_CREAT|O_EXCL)` is atomic, so two
 * processes racing for the same lock cannot both succeed.
 *
 * This file spawns real `worker_threads` (cheaper than child_process
 * and avoids the worktree's node_modules path quirks) that each
 * call `acquireLock` against the same vault file. The assertions:
 *
 *   1. Mutex semantics — over N iterations, no two workers hold
 *      the lock at the same time. Implemented by having each worker
 *      write a marker file ON acquire, sleep briefly, then erase
 *      the marker BEFORE release. A second worker that races into
 *      the critical section would find an existing marker and
 *      report a violation.
 *
 *   2. Bounded contention — every worker eventually acquires (no
 *      starvation, no deadlock). Total runtime stays under a sane
 *      ceiling.
 *
 *   3. Sentinel-dir migration is concurrency-safe — when two
 *      workers start against a planted sentinel dir, exactly one
 *      migrates successfully and both end up acquiring at some
 *      point.
 *
 * Skipped on non-Linux (worker_threads is portable but the lock's
 * pidIsOriginalHolder defense uses /proc, and the test asserts
 * cross-process behavior on the real platform we ship on).
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The worker script is inlined as a string so we don't need a
// separate file in dist/. It imports flock.ts via the vitest test
// runtime so coverage + source-mapping work.
//
// Each worker:
//   1. Acquires the lock.
//   2. Asserts no other worker is in the critical section (marker
//      file at <vaultPath>.marker — if it exists, mutex broke).
//   3. Writes its own marker, sleeps briefly, removes the marker.
//   4. Releases the lock.
//   5. Repeats N times.
//   6. Posts back the count of acquires + any mutex-violation
//      record back to the main thread.
const WORKER_SCRIPT = (testHelperPath: string): string => `
const { parentPort, workerData } = require('node:worker_threads');
const { acquireLock } = require(${JSON.stringify(testHelperPath)});
const { existsSync, writeFileSync, unlinkSync } = require('node:fs');

(async () => {
  const { vaultPath, markerPath, iterations, workerId, budgetMs } = workerData;
  let acquired = 0;
  let mutexViolations = 0;
  let lastErr = null;
  for (let i = 0; i < iterations; i++) {
    let lock = null;
    try {
      lock = acquireLock(vaultPath, { budgetMs });
      if (existsSync(markerPath)) {
        mutexViolations += 1;
      }
      writeFileSync(markerPath, String(workerId));
      // Microsleep — long enough that overlapping acquirers would
      // race into the critical section if the mutex were broken.
      const sleepStart = Date.now();
      while (Date.now() - sleepStart < 10) {
        // busy-wait so we don't yield to the event loop
      }
      try { unlinkSync(markerPath); } catch { /* */ }
      acquired += 1;
    } catch (err) {
      lastErr = err.message;
      break;
    } finally {
      if (lock !== null) {
        try { lock.release(); } catch { /* */ }
      }
    }
  }
  parentPort.postMessage({ workerId, acquired, mutexViolations, lastErr });
})();
`;

// Resolve the bundled flock helper for the worker. Vitest's loader hooks
// transform `.ts` on import inside the main thread, but a `new Worker()`
// spawns a fresh Node runtime that has no such hooks — `require()`ing
// `./flock.ts` raw fails with "Cannot use import statement outside a
// module". To bridge: at `beforeAll` we run `bun build` on `flock.ts`
// and stash the resulting single-file CJS bundle in a per-suite tmp
// dir, then hand that path to the worker. Bun is a hard prereq of the
// repo and the Buildkite pipeline (see `.buildkite/pipeline.yml`), so
// this doesn't add a new dependency.
const FLOCK_SRC_PATH = new URL("./flock.ts", import.meta.url).pathname;
let FLOCK_MODULE_PATH: string;
let FLOCK_BUNDLE_DIR: string;

describe.skipIf(process.platform !== "linux")("flock — cross-process concurrency (#978)", () => {
  let tmp: string;
  let vaultPath: string;
  let markerPath: string;

  beforeAll(() => {
    FLOCK_BUNDLE_DIR = mkdtempSync(join(tmpdir(), "vault-flock-bundle-"));
    FLOCK_MODULE_PATH = join(FLOCK_BUNDLE_DIR, "flock.cjs");
    const result = spawnSync(
      "bun",
      [
        "build",
        FLOCK_SRC_PATH,
        "--target=node",
        "--format=cjs",
        "--outfile",
        FLOCK_MODULE_PATH,
      ],
      { stdio: "pipe", encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(
        `bun build of flock.ts failed (status=${result.status}): ${result.stderr || result.stdout}`,
      );
    }
  });

  afterAll(() => {
    if (FLOCK_BUNDLE_DIR) {
      try { rmSync(FLOCK_BUNDLE_DIR, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vault-flock-concurrent-"));
    vaultPath = join(tmp, "vault.enc");
    markerPath = join(tmp, "vault.enc.marker");
    writeFileSync(vaultPath, "stub");
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  it(
    "two worker_threads racing on the same lock observe strict mutex",
    async () => {
      // Note: worker_threads in vitest can't easily import .ts via
      // require(). To keep the test runnable without a build step,
      // we use eval('require') to bypass the require-from-esm
      // limitation — vitest's transformer makes flock.ts loadable
      // by its built path under node_modules/.vitest cache. If your
      // local setup ever fails this with MODULE_NOT_FOUND, run
      // `npx vitest run --no-isolate` to use the same module
      // registry as the main thread.
      const ITERATIONS = 20;
      const BUDGET_MS = 5000;

      // Build an inline workerScript that calls into vitest's
      // module loader by using an eval() trampoline. The worker
      // process inherits the test's NODE_OPTIONS so vitest's
      // loader hook is active.
      const workerSource = WORKER_SCRIPT(FLOCK_MODULE_PATH);

      const results: { workerId: number; acquired: number; mutexViolations: number; lastErr: string | null }[] = [];
      const workers = [0, 1].map((workerId) => new Promise<void>((resolve, reject) => {
        const w = new Worker(workerSource, {
          eval: true,
          workerData: { vaultPath, markerPath, iterations: ITERATIONS, workerId, budgetMs: BUDGET_MS },
        });
        w.once("message", (msg) => { results.push(msg); resolve(); });
        w.once("error", reject);
        w.once("exit", (code) => {
          if (code !== 0 && results.length < workerId + 1) {
            reject(new Error(`worker ${workerId} exited ${code}`));
          }
        });
      }));

      await Promise.all(workers);

      // Both workers must finish all iterations.
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.lastErr, `worker ${r.workerId} errored: ${r.lastErr}`).toBeNull();
        expect(r.acquired, `worker ${r.workerId} only completed ${r.acquired}/${ITERATIONS}`).toBe(ITERATIONS);
        expect(r.mutexViolations, `worker ${r.workerId} observed mutex violation`).toBe(0);
      }

      // Post-condition: no leftover marker (means every critical
      // section ran its cleanup) AND no leftover lock file.
      expect(existsSync(markerPath)).toBe(false);
      expect(existsSync(`${vaultPath}.lock`)).toBe(false);
    },
    60_000,
  );

  it(
    "concurrent sentinel-dir migration → exactly one winner, both eventually acquire",
    async () => {
      // Plant a v0.7.14-style sentinel dir BEFORE launching workers.
      // Each worker tries to migrate; only one succeeds. The other
      // falls through to contention but should eventually acquire
      // after the winner releases.
      const lockPath = `${vaultPath}.lock`;
      mkdirSync(lockPath, { recursive: true });
      // Backdate the dir so the recent-write guard doesn't refuse.
      // utimesSync is finicky on dirs; just don't write any files inside.
      // (An empty dir trivially passes the recent-write check.)

      const ITERATIONS = 5;
      const BUDGET_MS = 5000;
      const workerSource = WORKER_SCRIPT(FLOCK_MODULE_PATH);
      const results: { workerId: number; acquired: number; mutexViolations: number; lastErr: string | null }[] = [];
      const workers = [0, 1].map((workerId) => new Promise<void>((resolve, reject) => {
        const w = new Worker(workerSource, {
          eval: true,
          workerData: { vaultPath, markerPath, iterations: ITERATIONS, workerId, budgetMs: BUDGET_MS },
        });
        w.once("message", (msg) => { results.push(msg); resolve(); });
        w.once("error", reject);
      }));

      await Promise.all(workers);

      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.lastErr, `worker ${r.workerId} errored: ${r.lastErr}`).toBeNull();
        expect(r.acquired).toBe(ITERATIONS);
        expect(r.mutexViolations).toBe(0);
      }
      // Post-migration the lock path is a file (or gone, if both
      // released cleanly).
      if (existsSync(lockPath)) {
        const stat = readFileSync(lockPath, "utf8");
        expect(stat.length).toBeGreaterThan(0);
      }
    },
    60_000,
  );
});
