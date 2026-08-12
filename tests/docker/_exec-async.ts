/**
 * Non-blocking `execFileSync` for the docker probe suites.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * The hindsight probes drive `docker run` / `docker exec` legs that each
 * take tens of seconds. Written with `execFileSync` they block the vitest
 * WORKER's event loop for that entire time, and a blocked worker cannot
 * read the IPC channel it shares with the vitest main process.
 *
 * vitest's worker→main RPC (`onTaskUpdate`, `onUserConsoleLog`, …) is
 * birpc with a HARD-CODED 60 s timeout — `DEFAULT_TIMEOUT = 6e4` in
 * `vitest/dist/chunks/index.*.js`, and neither `createForksRpcOptions`
 * (`chunks/utils.*.js`) nor `createRuntimeRpc` (`chunks/rpc.*.js`) passes a
 * `timeout` override, so no vitest config knob can raise it. The main
 * process answers `onTaskUpdate` promptly; the WORKER just never gets to
 * process the reply, and when it finally does return to the event loop the
 * timers phase runs before the poll phase, so the 60 s timer fires first:
 *
 *     Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 *       ❯ Object.onTimeoutError vitest/dist/chunks/rpc.*.js:53:10
 *
 * All tests PASS and vitest still exits 1 (unhandled error). Observed on
 * run 31575484897 / job 94046556074 (2026-08-12): the reflect-directives
 * probe, 5/5 green, two tests of 32.3 s + 30.3 s of uninterrupted
 * `execFileSync`, file duration 63.07 s — one merge-queue ejection and a
 * manual re-enqueue. It is a reporter-IPC starvation bug, not a test
 * failure, so retrying it would only hide a real hang later.
 *
 * Awaiting the child instead keeps the worker's loop turning, so the RPC
 * reply is read as it arrives and the timer never reaches 60 s. Semantics
 * mirror `execFileSync` closely enough to be a drop-in at the call sites:
 * stdout/stderr are captured (never inherited), a non-zero exit throws, and
 * the thrown error carries `.status` / `.stdout` / `.stderr`.
 *
 * Unlike `execFileSync` there is no 1 MiB `maxBuffer` ceiling — probe
 * output is bounded by the probe scripts themselves, and an ENOBUFS throw
 * mid-probe would be a worse failure mode than a large string.
 */

import { spawn } from "node:child_process";

export interface ExecOutcome {
  /** Exit status. 0 on the resolved path. */
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Thrown on a non-zero exit or a spawn error. Field names match what
 * `execFileSync` attaches, so `catch (e) { (e as {status?: number}).status }`
 * call sites keep working unchanged.
 */
export class ExecFailure extends Error implements ExecOutcome {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, outcome: ExecOutcome) {
    super(message);
    this.name = "ExecFailure";
    this.status = outcome.status;
    this.stdout = outcome.stdout;
    this.stderr = outcome.stderr;
  }
}

export interface ExecOptions {
  /** Written to the child's stdin, then stdin is closed. */
  input?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Hard ceiling; the child is SIGKILLed and the call rejects. */
  timeoutMs?: number;
}

/**
 * Run `file` with `args`, awaiting the child instead of blocking the event
 * loop. Resolves on exit 0; rejects with {@link ExecFailure} otherwise.
 */
export function execFileAsync(
  file: string,
  args: readonly string[],
  opts: ExecOptions = {}
): Promise<ExecOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env,
      cwd: opts.cwd,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });

    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }

    child.on("error", (err) => {
      // Spawn failure (ENOENT, EACCES). `execFileSync` leaves `.status`
      // undefined here; the probe call sites normalise a missing status to
      // -1, so report that directly.
      settle(() =>
        reject(
          new ExecFailure(`${file}: ${err.message}`, {
            status: -1,
            stdout,
            stderr,
          })
        )
      );
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      // A signal-killed child has a null code; -1 keeps it distinguishable
      // from success without pretending to be an exit status.
      const status = code ?? -1;
      if (status === 0) {
        settle(() => resolve({ status, stdout, stderr }));
        return;
      }
      const how = signal ? `killed by ${signal}` : `exited ${status}`;
      settle(() =>
        reject(
          new ExecFailure(
            `${file} ${args.join(" ")} — ${how}\n${stderr.slice(-4000)}`,
            { status, stdout, stderr }
          )
        )
      );
    };

    // `close` is the preferred signal because it means stdio reached EOF and
    // the buffers are complete. But it only fires once EVERY holder of those
    // pipes is gone: `sh -c "sleep 30"` SIGKILLed at the shell leaves the
    // `sleep` grandchild owning stdout, and `close` then waits out the full
    // sleep — a hang worse than the flake this file exists to fix. So `exit`
    // (the direct child is reaped) starts a bounded grace period for trailing
    // output, after which the call settles with what it has.
    let exited = false;
    child.on("exit", (code, signal) => {
      exited = true;
      const grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }, 250);
      grace.unref?.();
      child.once("close", () => clearTimeout(grace));
    });
    child.on("close", (code, signal) => {
      if (!exited) return; // spawn error path; `error` handles it
      finish(code, signal);
    });

    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}
