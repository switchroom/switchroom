/**
 * The POINT of bounding the rollout's subprocesses: hostd's fleet-mutation
 * latch must actually get released when a roll dies on a timeout.
 *
 * `fleetMutationInFlight` is cleared in the `.finally()` of the promise chain
 * in `spawnRollout` (server.ts:3980-3985). That `.finally()` only runs when
 * the child EXITS. Pre-fix, `executeRollout` used `spawnSync` with no
 * `timeout`, so a wedged container blocked the child forever, the promise
 * never settled, the latch was never cleared, and every subsequent fleet
 * mutation was refused with no self-clearing path short of restarting hostd.
 *
 * The claim "a timeout releases the latch" was previously only argued
 * structurally. This asserts it end-to-end against a REAL child process: a
 * `node -e` stub standing in for the rollout child, emitting the
 * timeout-flavoured result sentinel and exiting non-zero exactly as
 * `executeRollout` does after `ROLLOUT_RUN_TIMEOUT_MS` fires.
 *
 * (`process.execPath` is used as the injected `switchroomBin` rather than a
 * shell script in a temp dir: `/tmp` is mounted `noexec` in the container
 * this runs in, so an exec-bit stub is not portable.)
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostdServer, type ServerOptions } from "./server.js";
import { encodeRolloutResultLine, type RolloutResult } from "../cli/rollout.js";

type Entry = {
  request_id: string;
  op: string;
  result?: string;
  exit_code?: number | null;
  timed_out?: boolean;
  failed_agent?: string;
  failed_step?: string;
  rolled?: string[];
};

type Internals = {
  fleetMutationInFlight: { request_id: string } | null;
  spawnRollout(args: string[], entry: Entry): void;
  writeTerminalAudit(entry: Entry): Promise<void>;
  pushRolloutTerminal(entry: Entry): void;
};

/** `node -e` argv that prints `stdout` verbatim then exits `code`. */
function childArgs(stdout: string, code: number): string[] {
  return [
    "-e",
    `process.stdout.write(${JSON.stringify(stdout)});process.exit(${code});`,
  ];
}

function makeServer(): Internals {
  const server = new HostdServer({
    homeDir: mkdtempSync(join(tmpdir(), "hostd-latch-")),
    switchroomBin: process.execPath,
  } as unknown as ServerOptions);
  const internals = server as unknown as Internals;
  // Neutralise the durable-audit and chat side-effects — this test is about
  // the latch, and those paths need a real state dir / relay.
  internals.writeTerminalAudit = async () => undefined;
  internals.pushRolloutTerminal = () => undefined;
  return internals;
}

/** Wait until `predicate()` holds, or the budget expires (no fixed sleeps). */
async function until(predicate: () => boolean, budgetMs = 5000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Drive one roll to termination and hand back the mutated status entry. */
async function runRoll(stdout: string, code: number): Promise<{ entry: Entry; latch: unknown }> {
  const internals = makeServer();
  const entry: Entry = { request_id: `req-${code}-${Math.random()}`, op: "rollout" };
  // Mirror launchRollout (server.ts:2137-2144): take the latch, then spawn.
  internals.fleetMutationInFlight = { request_id: entry.request_id };
  internals.spawnRollout(childArgs(stdout, code), entry);
  expect(internals.fleetMutationInFlight).not.toBeNull();
  await until(() => internals.fleetMutationInFlight === null);
  return { entry, latch: internals.fleetMutationInFlight };
}

describe("fleetMutationInFlight is released when a roll ends on a timeout", () => {
  it("clears the latch and records the timeout as a structured outcome", async () => {
    const sentinel = encodeRolloutResultLine({
      ok: false,
      rolled: ["test-harness"],
      failedStep: "restart-agent",
      failedAgent: "clerk",
      got: null,
      timedOut: true,
      warnings: ["agent restart clerk exceeded its timeout and was killed"],
    } as RolloutResult);

    const { entry, latch } = await runRoll(sentinel + "\n", 1);

    // THE outcome: the next fleet mutation is admissible again with no hostd
    // restart. Pre-fix this never happened — the child never exited at all.
    expect(latch).toBeNull();
    // And the timeout is legible to a get_status reader, not just a tail.
    expect(entry.result).toBe("error");
    expect(entry.timed_out).toBe(true);
    expect(entry.failed_agent).toBe("clerk");
    expect(entry.failed_step).toBe("restart-agent");
  });

  it("does not mark a non-timeout failure as timed_out", async () => {
    const sentinel = encodeRolloutResultLine({
      ok: false,
      rolled: [],
      failedStep: "apply",
      warnings: [],
    } as RolloutResult);

    const { entry, latch } = await runRoll(sentinel + "\n", 1);

    expect(latch).toBeNull();
    expect(entry.result).toBe("error");
    expect(entry.timed_out).toBeUndefined();
  });

  it("clears the latch on a successful roll too (no regression)", async () => {
    const sentinel = encodeRolloutResultLine({
      ok: true,
      rolled: ["test-harness", "clerk"],
      warnings: [],
    } as RolloutResult);

    const { entry, latch } = await runRoll(sentinel + "\n", 0);

    expect(latch).toBeNull();
    expect(entry.result).toBe("completed");
    expect(entry.timed_out).toBeUndefined();
  });

  it("clears the latch even when the child dies with NO sentinel", async () => {
    // The pathological shape: the rollout child is itself SIGKILLed, so no
    // structured result is ever emitted. The `.finally()` must still run.
    const { entry, latch } = await runRoll("", 137);

    expect(latch).toBeNull();
    expect(entry.result).toBe("error");
    expect(entry.timed_out).toBeUndefined();
  });
});
