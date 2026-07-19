/**
 * Smoke-test for `docker/hindsight-entrypoint.sh`. The shim is sh + a
 * Node one-liner, so we can drive it from vitest by:
 *
 *   1. Standing up a fake auth-broker UDS in a tmpdir.
 *   2. Running the shim with env vars overriding the socket path,
 *      cred dir, and wait timeout to point at the fake.
 *   3. Asserting it (a) writes the dotfile credentials.json, (b)
 *      execs into the given CMD with CLAUDE_CONFIG_DIR exported.
 *
 * We don't need docker for this — the shim is portable sh + node.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const ENTRYPOINT = resolve(
  __dirname,
  "..",
  "..",
  "docker",
  "hindsight-entrypoint.sh",
);
/** The Dockerfile copies the fetcher to /usr/local/lib/switchroom/ at
 *  build time; the entrypoint resolves the path via env. For host
 *  tests we point at the source file directly. */
const FETCHER = resolve(
  __dirname,
  "..",
  "..",
  "docker",
  "hindsight-fetch-creds.cjs",
);

interface FakeBrokerOpts {
  /** What to send back on `get-credentials`. */
  response?: (id: string) => string;
}

async function startFakeBroker(
  socketPath: string,
  opts: FakeBrokerOpts = {},
): Promise<() => Promise<void>> {
  const conns = new Set<import("node:net").Socket>();
  const server = createServer((sock) => {
    conns.add(sock);
    sock.on("close", () => conns.delete(sock));
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      let req: { id: string; op: string };
      try {
        req = JSON.parse(line);
      } catch {
        sock.end();
        return;
      }
      if (req.op !== "get-credentials") {
        sock.write(
          JSON.stringify({
            v: 1,
            id: req.id,
            ok: false,
            error: { code: "UNKNOWN_VERB", message: "test fake only handles get-credentials" },
          }) + "\n",
        );
        sock.end();
        return;
      }
      const respLine = opts.response
        ? opts.response(req.id)
        : JSON.stringify({
            v: 1,
            id: req.id,
            ok: true,
            data: {
              account: "test@example.com",
              credentials: {
                claudeAiOauth: {
                  accessToken: "test-access-token-abc",
                  refreshToken: "test-refresh-token-xyz",
                  expiresAt: 1799999999000,
                },
              },
            },
          }) + "\n";
      sock.write(respLine);
      sock.end();
    });
    sock.on("error", () => {
      conns.delete(sock);
      try { sock.destroy(); } catch { /* ignore */ }
    });
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(socketPath, () => res());
  });

  return () =>
    new Promise<void>((res) => {
      for (const c of conns) {
        try { c.destroy(); } catch { /* ignore */ }
      }
      conns.clear();
      server.close(() => res());
    });
}

function runEntrypoint(opts: {
  socketPath: string;
  credDir: string;
  cmd: string[];
  waitS?: number;
  refreshS?: number;
}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Use async spawn (NOT spawnSync) because the fake auth-broker runs
    // in this same Node process — spawnSync would block the event loop
    // and the broker would never accept the entrypoint's UDS connection.
    const child = spawn("sh", [ENTRYPOINT, ...opts.cmd], {
      env: {
        ...process.env,
        SWITCHROOM_AUTH_BROKER_SOCKET: opts.socketPath,
        SWITCHROOM_HINDSIGHT_CRED_DIR: opts.credDir,
        SWITCHROOM_HINDSIGHT_WAIT_S: String(opts.waitS ?? 5),
        // Tests default to disabling the refresh loop (REFRESH_S=0)
        // because most tests run `cmd: ["true"]` / `["env"]` and exit
        // immediately — leaving a background loop dangling would
        // confuse vitest's afterEach teardown. The refresh-specific
        // test explicitly sets refreshS=1 to exercise it.
        SWITCHROOM_HINDSIGHT_REFRESH_S: String(opts.refreshS ?? 0),
        // Tell the entrypoint where to find the extracted fetcher
        // (the Dockerfile installs it to /usr/local/lib/switchroom/
        // at build time; for host tests we point at the source file).
        SWITCHROOM_HINDSIGHT_FETCHER: FETCHER,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    const killer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, 30000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
  });
}

describe("hindsight-entrypoint.sh (#1245)", () => {
  let dir: string;
  let socketPath: string;
  let credDir: string;
  let stopBroker: (() => Promise<void>) | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swr-hsi-entry-"));
    socketPath = join(dir, "broker.sock");
    credDir = join(dir, "creds");
    chmodSync(ENTRYPOINT, 0o755);
  });

  afterEach(async () => {
    if (stopBroker) {
      await stopBroker();
      stopBroker = null;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("fetches credentials and writes them to /run/claude-creds/.credentials.json (dotfile)", async () => {
    stopBroker = await startFakeBroker(socketPath);
    // Use `env` as the CMD — it prints the env vars and exits 0,
    // letting us see CLAUDE_CONFIG_DIR was exported into the child.
    const result = await runEntrypoint({
      socketPath,
      credDir,
      cmd: ["env"],
    });
    expect(result.status).toBe(0);

    const dotfile = join(credDir, ".credentials.json");
    expect(existsSync(dotfile)).toBe(true);

    // The non-dot path MUST NOT exist — claude reads the dotfile name.
    const nondot = join(credDir, "credentials.json");
    expect(existsSync(nondot)).toBe(false);

    const parsed = JSON.parse(readFileSync(dotfile, "utf-8"));
    expect(parsed.claudeAiOauth.accessToken).toBe("test-access-token-abc");
    expect(parsed.claudeAiOauth.refreshToken).toBe("test-refresh-token-xyz");
  });

  it("exports CLAUDE_CONFIG_DIR=<credDir> into the exec'd command", async () => {
    stopBroker = await startFakeBroker(socketPath);
    const result = await runEntrypoint({
      socketPath,
      credDir,
      cmd: ["env"],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`CLAUDE_CONFIG_DIR=${credDir}`);
  });

  it("execs into the given CMD (PID-1 semantics preserved)", async () => {
    stopBroker = await startFakeBroker(socketPath);
    const marker = join(dir, "child-ran");
    // sh -c 'touch $marker'
    const result = await runEntrypoint({
      socketPath,
      credDir,
      cmd: ["sh", "-c", `touch ${marker} && echo CHILD_OK`],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CHILD_OK");
    expect(existsSync(marker)).toBe(true);
  });

  it("exits non-zero with a clear log line when the broker returns an error", async () => {
    stopBroker = await startFakeBroker(socketPath, {
      response: (id) =>
        JSON.stringify({
          v: 1,
          id,
          ok: false,
          error: { code: "FORBIDDEN", message: "synthetic test error" },
        }) + "\n",
    });
    const result = await runEntrypoint({
      socketPath,
      credDir,
      cmd: ["echo", "should-not-run"],
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/FORBIDDEN/);
    expect(result.stderr).toMatch(/synthetic test error/);
    expect(result.stdout).not.toContain("should-not-run");
  });

  it("times out cleanly when the broker socket never appears", async () => {
    // No broker started — socket path stays missing.
    const result = await runEntrypoint({
      socketPath,
      credDir,
      cmd: ["echo", "should-not-run"],
      waitS: 2,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/did not appear within 2s/);
    expect(result.stdout).not.toContain("should-not-run");
  });

  it("writes the credentials file with mode 0600 (per-consumer-only readable)", async () => {
    stopBroker = await startFakeBroker(socketPath);
    const result = await runEntrypoint({
      socketPath,
      credDir,
      cmd: ["true"],
    });
    expect(result.status).toBe(0);
    const dotfile = join(credDir, ".credentials.json");
    const { statSync } = await import("node:fs");
    const mode = statSync(dotfile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("rejects malformed broker responses without booting", async () => {
    stopBroker = await startFakeBroker(socketPath, {
      response: () => "this is not json\n",
    });
    const result = await runEntrypoint({
      socketPath,
      credDir,
      cmd: ["echo", "should-not-run"],
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("should-not-run");
    // And the (sentinel-relevant) file MUST NOT exist on failure.
    const dotfile = join(credDir, ".credentials.json");
    expect(existsSync(dotfile)).toBe(false);
  });

  it("entrypoint script itself contains no embedded API key / secret-shaped literal", () => {
    const raw = readFileSync(ENTRYPOINT, "utf-8");
    expect(raw).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(raw).not.toMatch(/OPENAI_API_KEY/);
    expect(raw).not.toMatch(/HINDSIGHT_API_LLM_API_KEY/);
    // Sanity: it DOES reference the right protocol verb and dotfile.
    expect(raw).toContain("get-credentials");
    expect(raw).toContain(".credentials.json");
  });

  it("avoids the `credentials.json` non-dot path (claude reads the dotfile)", () => {
    const raw = readFileSync(ENTRYPOINT, "utf-8");
    // The on-disk file path MUST always be the dotfile form — the
    // claude SDK reads `.credentials.json`. Match `/credentials.json`
    // (with a slash before it) only when preceded by a dot.
    const nonDotMatches = raw.match(/\/credentials\.json/g) ?? [];
    expect(nonDotMatches).toEqual([]);
    // And the dotfile form MUST appear at least once (defense against
    // someone gutting the file).
    expect(raw).toMatch(/\.credentials\.json/);
  });

  it("refresh loop re-fetches credentials so the tmpfs copy never goes stale", async () => {
    // Stale-credentials regression: the entrypoint used to fetch once
    // at boot and exec; after the broker's first 60-min refresh, the
    // hindsight tmpfs copy would diverge from the broker's canonical
    // creds and the access token would expire with no recovery path.
    // RFC H §4.8 step 6 prescribes a refresh loop — this test pins it.
    //
    // The fake broker returns a different accessToken on each call
    // (suffix = the per-connection counter). We run the entrypoint
    // with REFRESH_S=1 and a long-running CMD, wait ~2.5s for the
    // sidecar to tick at least once, then read the dotfile and verify
    // its accessToken changed from the boot value.
    let counter = 0;
    stopBroker = await startFakeBroker(socketPath, {
      response: (id) => {
        counter += 1;
        return JSON.stringify({
          v: 1,
          id,
          ok: true,
          data: {
            account: "test@example.com",
            credentials: {
              claudeAiOauth: {
                accessToken: `test-access-token-tick-${counter}`,
                refreshToken: `test-refresh-token-tick-${counter}`,
                expiresAt: 1799999999000,
              },
            },
          },
        }) + "\n";
      },
    });
    const dotfile = join(credDir, ".credentials.json");
    // CMD = `sleep 5` so the entrypoint stays resident long enough
    // for the refresh sidecar to tick. We kill the child after 2.5s.
    const child = spawn("sh", [ENTRYPOINT, "sleep", "5"], {
      env: {
        ...process.env,
        SWITCHROOM_AUTH_BROKER_SOCKET: socketPath,
        SWITCHROOM_HINDSIGHT_CRED_DIR: credDir,
        SWITCHROOM_HINDSIGHT_WAIT_S: "5",
        SWITCHROOM_HINDSIGHT_REFRESH_S: "1",
        SWITCHROOM_HINDSIGHT_FETCHER: FETCHER,
      },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    try {
      // Wait for boot fetch to land.
      await new Promise<void>((res, rej) => {
        const start = Date.now();
        const iv = setInterval(() => {
          if (existsSync(dotfile)) {
            clearInterval(iv);
            res();
          } else if (Date.now() - start > 5000) {
            clearInterval(iv);
            rej(new Error("boot fetch never wrote the dotfile"));
          }
        }, 50);
      });
      const bootCreds = JSON.parse(readFileSync(dotfile, "utf-8"));
      expect(bootCreds.claudeAiOauth.accessToken).toBe("test-access-token-tick-1");

      // Wait for at least one refresh tick (interval=1s; give 2.5s).
      await new Promise((r) => setTimeout(r, 2500));

      const refreshedCreds = JSON.parse(readFileSync(dotfile, "utf-8"));
      // Counter must have advanced — i.e. the refresh sidecar fetched
      // again at least once. We don't pin the exact value (the sleep is
      // imprecise) but it must be > 1.
      const match = refreshedCreds.claudeAiOauth.accessToken.match(/tick-(\d+)$/);
      expect(match).not.toBeNull();
      expect(parseInt(match![1], 10)).toBeGreaterThan(1);
      expect(stderr).toMatch(/credential refresh loop started/);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }, 10_000);

  it("pins a stable HINDSIGHT_API_WORKER_ID so restart-recovery reclaims stranded ops", async () => {
    // Durability fix (incident 2026-06-18): the upstream worker_id
    // defaults to the container hostname (ephemeral docker id), so a
    // worker that died mid-consolidation stranded its 'processing' ops
    // forever — recover_own_tasks() only reclaims WHERE worker_id=<own>.
    // Pinning a stable id makes every restart reclaim its predecessor's
    // work. `env` as CMD prints the exported environment.
    stopBroker = await startFakeBroker(socketPath);
    const result = await runEntrypoint({ socketPath, credDir, cmd: ["env"] });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^HINDSIGHT_API_WORKER_ID=switchroom-hindsight$/m);
  });

  it("lets an operator-provided HINDSIGHT_API_WORKER_ID win (`:=` only fills when unset)", async () => {
    stopBroker = await startFakeBroker(socketPath);
    const result = await new Promise<{ status: number | null; stdout: string }>(
      (res) => {
        const child = spawn("sh", [ENTRYPOINT, "env"], {
          env: {
            ...process.env,
            SWITCHROOM_AUTH_BROKER_SOCKET: socketPath,
            SWITCHROOM_HINDSIGHT_CRED_DIR: credDir,
            SWITCHROOM_HINDSIGHT_WAIT_S: "5",
            SWITCHROOM_HINDSIGHT_REFRESH_S: "0",
            SWITCHROOM_HINDSIGHT_FETCHER: FETCHER,
            HINDSIGHT_API_WORKER_ID: "operator-pinned-id",
          },
        });
        let stdout = "";
        child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
        child.on("close", (status) => res({ status, stdout }));
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^HINDSIGHT_API_WORKER_ID=operator-pinned-id$/m);
  });

  it("ships a lease-timeout reaper that resets stuck 'processing' ops, correctly guarded", () => {
    // The reaper is the no-restart-wedge backstop. We can't stand up the
    // embedded pg in a host unit test, so pin its SQL shape + guards
    // statically (the dangerous-to-drift parts).
    const raw = readFileSync(ENTRYPOINT, "utf-8");
    // Only touches stuck 'processing' rows, never anything else.
    expect(raw).toMatch(/status='processing'/);
    // Keyed on claim AGE (lease timeout), not the ephemeral worker_id.
    expect(raw).toMatch(/claimed_at < now\(\) - make_interval\(secs => \$\{REAP_STALE_S\}\)/);
    // Batch-ops guard — coalesce(...)='' form. RETURNING was removed after
    // the 2026-07-19 dual-writer recovery: the RETURNING variant aborted
    // under concurrent activity with a spurious pk_async_operations
    // violation and the reaper silently stopped working.
    expect(raw).toMatch(/coalesce\(result_metadata->>'batch_id',''\) = ''/);
    // Concrete anti-pattern: RETURNING piped into grep -c (the form that
    // aborted under concurrent activity). A mention of RETURNING in a
    // comment is fine — ban the pipeline shape only.
    expect(raw).not.toMatch(/RETURNING[\s\S]{0,80}grep -c/);
    // Gated + best-effort: 0 disables, and it rides the existing loop.
    expect(raw).toMatch(/REAP_STALE_S.*-gt 0.*\|\| return 0/);
    expect(raw).toMatch(/reap_stale_processing \|\| true/);
    // Boot-deferred single shot so recreate doesn't wait REAP_STALE_S (30m).
    expect(raw).toMatch(/reap_stale_processing_when_ready/);
  });

  it("the reaper no-ops cleanly when the embedded pg descriptor is absent (host/test)", async () => {
    // With REAP_STALE_S>0 (default) but PG0_INSTANCE pointing nowhere, the
    // reaper must early-return without erroring under `set -e`. Boot with a
    // live refresh loop (REFRESH_S=1 → reaper fires each tick) and a
    // resident CMD; after a couple ticks the marker must exist (entrypoint
    // reached exec) and stderr must carry the loop-started line with no
    // psql/python crash leaking through. We don't await 'close' — the
    // background loop holds the stdio pipes open — we kill after the wait,
    // mirroring the refresh-loop test above.
    stopBroker = await startFakeBroker(socketPath);
    const marker = join(dir, "reaper-safe-child-ran");
    const child = spawn(
      "sh",
      [ENTRYPOINT, "sh", "-c", `touch ${marker}; sleep 5`],
      {
        env: {
          ...process.env,
          SWITCHROOM_AUTH_BROKER_SOCKET: socketPath,
          SWITCHROOM_HINDSIGHT_CRED_DIR: credDir,
          SWITCHROOM_HINDSIGHT_WAIT_S: "5",
          SWITCHROOM_HINDSIGHT_REFRESH_S: "1",
          SWITCHROOM_HINDSIGHT_FETCHER: FETCHER,
          SWITCHROOM_HINDSIGHT_PG0_INSTANCE: join(dir, "does-not-exist.json"),
        },
      },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    try {
      await new Promise((r) => setTimeout(r, 2500));
      expect(existsSync(marker)).toBe(true);
      expect(stderr).toMatch(/credential refresh loop started/);
      // The reaper fired (REFRESH_S=1) but found no pg → silent no-op:
      // no reset log, and crucially no leaked psql/python crash.
      expect(stderr).not.toMatch(/stale-claim reaper reset/);
      expect(stderr).not.toMatch(/Traceback|psql:|not found/);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }, 10_000);

  it("Dockerfile pins UID 11000 to match HINDSIGHT_DEFAULT_UID", () => {
    // The broker chowns the per-consumer socket to consumer.uid (mode 0600).
    // If the runtime UID inside hindsight didn't match what the operator
    // wrote in auth.consumers[hindsight].uid (default 11000), the entrypoint
    // would EACCES on connect.
    const dockerfilePath = resolve(__dirname, "..", "..", "docker", "Dockerfile.hindsight");
    const raw = readFileSync(dockerfilePath, "utf-8");
    // Numerically pinned, not just relying on the upstream user.
    expect(raw).toMatch(/NEW_UID=11000/);
    expect(raw).toMatch(/usermod -u\s+["']?\$NEW_UID["']?\s+hindsight/);
  });
});
