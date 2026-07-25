/**
 * auth-net-guard — a vitest setup file that makes auth-broker unit tests
 * hermetic by construction (#3612).
 *
 * ── The defect class this closes (#3609, #3612, #3613) ──────────────────
 *
 * `AuthBroker` performs a LIVE quota probe inside several request paths:
 *
 *   markExhaustedAndRoll (src/auth/broker/server.ts)
 *     → nextHealthyAccountLive → probeAndCacheOne → fetchQuota
 *
 * `fetchQuota`'s default abort is 10s (src/auth/quota.ts). The broker test
 * harnesses enforce a 3s RPC deadline. So any broker constructed in a unit
 * test without the `_testFetchQuota` seam (or an equivalent `fetchImpl`) is
 * latency-bound on api.anthropic.com: it passes when the runner's egress
 * fails fast and fails with `Error: rpc timeout` when it does not. That is
 * a pure-latency coin flip, and it went red on main twice — PR #3609 fixed
 * one file per-broker, PR #3613 fixed src/auth/broker/server.test.ts with
 * an in-file guard.
 *
 * Per-file fixes do not close the class: the NEXT broker construction is
 * free to re-introduce it, and there are ~99 constructions in one file
 * alone. So the guard is installed by the RUNNER, for every test file that
 * can reach `fetchQuota`, with no per-file opt-in to forget.
 *
 * ── Mechanism ───────────────────────────────────────────────────────────
 *
 * Wired as `test.setupFiles` in vitest.config.ts. Before each test, if the
 * running test file can reach `fetchQuota` (`shouldGuardSource`), it
 * replaces `globalThis.fetch` with a stub that REJECTS IMMEDIATELY, and
 * restores the real one afterwards.
 *
 * Semantics are unchanged for these suites: the credentials they seed are
 * fakes, so a real probe could only ever have produced a FAILURE. The stub
 * produces the same failure — `fetchQuota` catches it and returns
 * `{ ok: false, reason: "quota probe network error: …" }` — but in
 * microseconds instead of up to 10 seconds, and without leaving the box.
 * Tests that inject `_testFetchQuota` / `fetchImpl` never reach `fetch` and
 * are unaffected.
 *
 * The predicate and the trip counter live in `auth-net-guard-core.mjs`,
 * which registers NO hooks — so importing the counter (as the runtime
 * proof in src/auth/broker/net-hermeticity.test.ts does) cannot
 * accidentally install the guard and mask a broken wiring.
 */

import { relative, resolve } from "node:path";
import { afterEach, beforeEach, expect } from "vitest";

import {
  AUTH_NET_GUARD_MARKER,
  recordAuthNetGuardTrip,
  resetAuthNetGuardTrips,
  shouldGuardTestFile,
} from "./auth-net-guard-core.mjs";

function currentTestFile(ctx) {
  const fromTask = ctx?.task?.file?.filepath;
  if (typeof fromTask === "string" && fromTask.length > 0) return fromTask;
  const fromExpect = expect.getState?.().testPath;
  return typeof fromExpect === "string" && fromExpect.length > 0 ? fromExpect : undefined;
}

function describeTarget(input) {
  try {
    if (typeof input === "string") return input;
    if (input && typeof input === "object" && "url" in input) return String(input.url);
    return String(input);
  } catch {
    return "<unprintable request>";
  }
}

/**
 * The pristine `fetch`, captured once at setup-file load — before any test
 * body has run. Restoring THIS (rather than whatever `globalThis.fetch`
 * happened to be when the hook fired) keeps the restore correct if two
 * guarded tests ever interleave (`it.concurrent`), where a
 * last-writer-wins capture could otherwise re-install a dead stub.
 */
const PRISTINE_FETCH = globalThis.fetch;

/**
 * Whether the guard is currently installed. `currentTestFile` can in
 * principle return undefined if vitest changes how it exposes the running
 * file; the guard then no-ops rather than throwing across every suite in
 * the repo. That failure mode is deliberately backstopped by the runtime
 * alarm in src/auth/broker/net-hermeticity.test.ts, which goes red the
 * moment the guard stops installing.
 */
let installed = false;

beforeEach((ctx) => {
  resetAuthNetGuardTrips();
  installed = false;
  const file = currentTestFile(ctx);
  if (!file || !shouldGuardTestFile(resolve(file))) return;
  installed = true;
  globalThis.fetch = async (input) => {
    recordAuthNetGuardTrip();
    throw new Error(
      `${AUTH_NET_GUARD_MARKER}: blocked outbound fetch to ${describeTarget(input)} from ` +
        `${relative(process.cwd(), file)}. Auth-broker unit tests must not touch the ` +
        `network — inject \`_testFetchQuota\` (broker) or \`fetchImpl\` (fetchQuota) ` +
        `if this test needs a real quota result.`,
    );
  };
});

afterEach(() => {
  if (!installed) return;
  globalThis.fetch = PRISTINE_FETCH;
  installed = false;
});
