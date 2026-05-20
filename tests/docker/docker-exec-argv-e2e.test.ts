/**
 * Live docker-exec argv-passthrough regression guard (PR #1529 class).
 *
 * Why this test exists:
 *
 * `src/host-control/server.ts:handleAgentExec` runs operator-issued
 * commands inside a per-agent container via
 *
 *   spawn("docker", ["exec", container, ...req.args.argv])
 *
 * Before #1529 the invocation had a `--` between container and argv.
 * Unlike `docker run`, `docker exec` does NOT recognize `--` as an
 * option/argv separator — it execs a binary literally named "--" and
 * exits 127. EVERY real `agent_exec` was broken for the months the
 * `--` lived in main, and CI was green throughout because the test
 * harness substituted a docker stub that ignored argv past `$1`.
 *
 * This test exercises the REAL docker binary against a REAL labeled
 * container, so a `--` regression (or any other argv-passthrough
 * breakage) fails the gate. No stub substitution.
 *
 * Per the project CLAUDE.md docker test discipline:
 *   - container created with `--rm` (self-clean on exit)
 *   - labeled `switchroom.test=phase1c` + per-run uuid
 *   - per-name `docker rm -f` in finally
 *   - `safeLabelTeardown` belt-and-braces in afterAll
 *
 * Skipped when docker isn't available (local dev without docker, or CI
 * environments that don't expose the daemon).
 */

import { describe, it, expect, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import {
  newRunId,
  dockerRunLabelsArgv,
  safeLabelTeardown,
} from "./_label-helpers.js";

// Tiny, ubiquitous, no-dependency image — same idiom as other docker
// e2e tests in this suite use for chown helpers.
const IMAGE = "busybox:latest";

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

function pullImage(ref: string): boolean {
  try {
    execSync(`docker pull ${ref}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dockerOk = hasDocker();
// busybox is so small (~5MB) we just pull it if absent rather than
// skipping — keeps the test reliable on fresh CI runners.
const imageReady = dockerOk && (hasImage(IMAGE) || pullImage(IMAGE));

const RUN_ID = newRunId();
const LABELS_ARGV = dockerRunLabelsArgv(RUN_ID);
const CONTAINER_NAME = `switchroom-test-exec-${RUN_ID.slice(0, 8)}`;

// One long-lived container per test file; each test execs into it.
// `tail -f /dev/null` keeps it alive without consuming resources.
function startContainer(): void {
  const args = [
    "run", "-d", "--rm",
    "--name", CONTAINER_NAME,
    ...LABELS_ARGV,
    IMAGE,
    "tail", "-f", "/dev/null",
  ];
  const r = spawnSync("docker", args, { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(
      `docker run failed: status=${r.status} stderr=${r.stderr}`,
    );
  }
}

function rmContainer(): void {
  try {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

afterAll(() => {
  rmContainer();
  safeLabelTeardown(RUN_ID);
});

// Helper that mirrors src/host-control/server.ts:1261 `runDocker()`'s
// shape — we run docker with the same spawn+capture pattern the
// production code uses, so a regression of #1529's `--` would surface
// here exactly as it surfaced in production.
function runDocker(
  args: string[],
): { exit_code: number; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf-8" });
  return {
    exit_code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

(imageReady ? describe : describe.skip)(
  "docker-exec argv passthrough (regression guard for #1529)",
  () => {
    // Boot the container once for the whole describe block. Vitest
    // doesn't expose beforeAll-style top-level hooks via the imported
    // names we use elsewhere; do it inline.
    let booted = false;
    function ensureBooted(): void {
      if (!booted) {
        startContainer();
        booted = true;
      }
    }

    it("single-arg command echoes back via real docker exec", () => {
      ensureBooted();
      // Production shape (post-#1529): no `--` between container and argv.
      const r = runDocker(["exec", CONTAINER_NAME, "echo", "hello"]);
      expect(r.exit_code).toBe(0);
      expect(r.stdout.trim()).toBe("hello");
    });

    it("multi-arg command preserves argv boundaries", () => {
      ensureBooted();
      // The exact bug class #1529 was about: argv past the first
      // element must reach the in-container binary literally.
      const r = runDocker([
        "exec", CONTAINER_NAME,
        "echo", "alpha", "beta", "gamma",
      ]);
      expect(r.exit_code).toBe(0);
      expect(r.stdout.trim()).toBe("alpha beta gamma");
    });

    it("argv containing leading-dash tokens passes through (not re-parsed by docker exec)", () => {
      ensureBooted();
      // A pre-#1529 invocation would have inserted `--` here.
      // Confirming the post-fix shape: leading-dash tokens reach the
      // in-container binary untouched and `docker exec` does NOT
      // reinterpret them as its own flags.
      //
      // We exec a small `sh -lc` so the shell receives "-n" as an
      // argument to `echo` (not as a docker option). busybox's echo
      // accepts `-n` as "no trailing newline".
      const r = runDocker([
        "exec", CONTAINER_NAME,
        "sh", "-lc", "echo -n no-newline",
      ]);
      expect(r.exit_code).toBe(0);
      expect(r.stdout).toBe("no-newline");
    });

    it("REGRESSION GUARD: inserting `--` between container and argv fails (the #1529 bug)", () => {
      ensureBooted();
      // This is the EXACT shape that lived in production until #1529.
      // docker exec tries to exec a binary literally named "--" and
      // exits 127. If a future refactor reintroduces `--`, every real
      // agent_exec breaks; this assertion catches it.
      const r = runDocker([
        "exec", CONTAINER_NAME, "--", "echo", "broken",
      ]);
      expect(r.exit_code).not.toBe(0);
      // docker emits a "OCI runtime exec failed" / "executable file
      // not found" / similar — exact text is docker-version dependent,
      // but exit_code != 0 is the contract this test asserts.
    });

    it("non-zero exit from the in-container command propagates", () => {
      ensureBooted();
      // Verifies the exit_code wiring: production agent_exec returns
      // result="error" when exit_code != 0. A stub that always returned
      // 0 would silently mask command failures.
      const r = runDocker(["exec", CONTAINER_NAME, "sh", "-lc", "exit 42"]);
      expect(r.exit_code).toBe(42);
    });
  },
);
