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
  mkdirSync,
  accessSync,
  constants as fsConstants,
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
    // Count must come from THIS UPDATE's rowcount (psql `UPDATE N` tag), not a
    // follow-up SELECT of recently-touched pending rows (that counted fresh
    // enqueues and inflated the reaper log after #3421).
    expect(raw).toMatch(/\^UPDATE\[\[:space:\]\]\+/);
    expect(raw).not.toMatch(
      /SELECT count\(\*\) FROM async_operations WHERE status='pending' AND worker_id IS NULL/,
    );
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
      //
      // The pg0 pre-start's own "skipped: pg0 binary not found" line is
      // expected on a host with no pg0 (fsync defaults ON, so the pre-start
      // always runs now) and is stripped before the crash-signature check —
      // otherwise a deliberate log would satisfy the `not found` guard.
      const reaperNoise = stderr.replace(
        /^switchroom-hindsight-entrypoint: pg0 pre-start .*$/gm,
        "",
      );
      expect(stderr).not.toMatch(/stale-claim reaper reset/);
      expect(reaperNoise).not.toMatch(/Traceback|psql:|not found/);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }, 10_000);

  // ── Corrupt-index self-heal (incident 2026-07-22) ──────────────────────
  //
  // The 3-day consolidation freeze: a corrupt pk_async_operations btree made
  // the reaper's reset UPDATE throw `duplicate key ... pk_async_operations`,
  // and the OLD reaper piped that into `2>/dev/null) || return 0` — silently
  // no-oping with no alarm and no heal, so stuck 'processing' ops were never
  // reset and every affected bank deadlocked. These tests drive the reaper
  // with a FAKE psql that reproduces the corrupt-index scenario and assert
  // the OUTCOME: a loud alarm + REINDEX self-heal + successful retry. They
  // FAIL against the old swallow-and-return behavior (no alarm/heal ever
  // emitted), so they actually pin the bug, not just the code path.

  /**
   * Return an EXEC-capable temp dir. Some sandboxes mount os.tmpdir() noexec,
   * which would make `[ -x fake_psql ]` false and no-op the reaper; fall back
   * to a repo-local cache dir. CI's tmpdir is exec, so it uses that.
   */
  function execTmpDir(prefix: string): string {
    const bases = [
      tmpdir(),
      resolve(__dirname, "..", "..", "node_modules", ".cache"),
    ];
    for (const base of bases) {
      try {
        mkdirSync(base, { recursive: true });
        const d = mkdtempSync(join(base, prefix));
        const probe = join(d, "probe.sh");
        writeFileSync(probe, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        accessSync(probe, fsConstants.X_OK);
        return d;
      } catch {
        /* try next base */
      }
    }
    throw new Error("no exec-capable tmp base for fake-psql");
  }

  /** Write a fake `psql` into an exec-capable dir; return that bin dir. */
  function installFakePsql(stateDir: string): string {
    const binDir = execTmpDir("swr-fakebin-");
    mkdirSync(stateDir, { recursive: true });
    const psql = join(binDir, "psql");
    writeFileSync(
      psql,
      `#!/bin/sh
# Fake psql for hindsight reaper/maintenance outcome tests.
sql=""; prev=""
for a in "$@"; do
  case "$prev" in -c|-tAc) sql="$a" ;; esac
  prev="$a"
done
[ -n "\${FAKE_PSQL_LOG:-}" ] && printf '%s\\n' "$sql" >> "$FAKE_PSQL_LOG"
mode="\${FAKE_PSQL_MODE:-healthy}"
state="\${FAKE_PSQL_STATE:-/tmp}"
case "$sql" in
  "SELECT 1") echo 1; exit 0 ;;
  "CREATE EXTENSION"*) exit 0 ;;
  "REINDEX INDEX"*) echo REINDEX; touch "$state/reindexed" 2>/dev/null; exit 0 ;;
  *bt_index_check*)
    if [ "$mode" = corrupt ]; then
      echo 'ERROR:  heap tuple (172,11) lacks matching index tuple within index "pk_async_operations"' >&2
      exit 1
    fi
    exit 0 ;;
  *"count(*)"*"status='processing'"*)
    if [ "$mode" = corrupt ] || [ "$mode" = stuck ]; then echo 4; else echo 0; fi
    exit 0 ;;
  "UPDATE async_operations SET status='pending'"*)
    if [ "$mode" = corrupt ] && [ ! -f "$state/reindexed" ]; then
      echo 'ERROR:  duplicate key value violates unique constraint "pk_async_operations"' >&2
      echo 'DETAIL:  Key (operation_id)=(6cade4c3) already exists.' >&2
      exit 1
    fi
    echo 'UPDATE 3'; exit 0 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    return binDir;
  }

  function writePgInstance(path: string): void {
    writeFileSync(
      path,
      JSON.stringify({
        username: "hindsight",
        database: "hindsight",
        port: 5432,
        password: "testpw",
      }),
    );
  }

  it("reaper self-heals a corrupt pk_async_operations index: alarms LOUDLY, REINDEXes, and retries the reset (incident 2026-07-22)", async () => {
    stopBroker = await startFakeBroker(socketPath);
    const stateDir = join(dir, "fakestate");
    const sqlLog = join(dir, "psql-sql.log");
    const pgInstance = join(dir, "instance.json");
    const binDir = installFakePsql(stateDir);
    writePgInstance(pgInstance);

    const child = spawn("sh", [ENTRYPOINT, "sleep", "6"], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        SWITCHROOM_AUTH_BROKER_SOCKET: socketPath,
        SWITCHROOM_HINDSIGHT_CRED_DIR: credDir,
        SWITCHROOM_HINDSIGHT_WAIT_S: "5",
        SWITCHROOM_HINDSIGHT_REFRESH_S: "1",
        SWITCHROOM_HINDSIGHT_FETCHER: FETCHER,
        SWITCHROOM_HINDSIGHT_PG0_INSTANCE: pgInstance,
        SWITCHROOM_HINDSIGHT_REAP_STALE_S: "1800",
        FAKE_PSQL_MODE: "corrupt",
        FAKE_PSQL_STATE: stateDir,
        FAKE_PSQL_LOG: sqlLog,
      },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    try {
      await new Promise((r) => setTimeout(r, 3000));
      // 1. It ALARMED (never silently swallowed) on the failed reset.
      expect(stderr).toMatch(/ERROR: hindsight-reaper reset_failed/);
      // 2. It recognized the corrupt-index signature and self-healed.
      expect(stderr).toMatch(/reindex_selfheal=attempting/);
      expect(stderr).toMatch(/reindex_selfheal=ok/);
      // 3. The retry after REINDEX actually reset the stuck ops.
      expect(stderr).toMatch(/stale-claim reaper reset 3 stuck 'processing' op/);
      expect(stderr).toMatch(/reindex_selfheal=recovered/);
      // 4. The SQL trace proves the sequence: reset -> REINDEX -> reset.
      const log = readFileSync(sqlLog, "utf-8").trim().split("\n");
      const firstReset = log.findIndex((l) => /^UPDATE async_operations SET status='pending'/.test(l));
      const reindex = log.findIndex((l) => /^REINDEX INDEX .*pk_async_operations/.test(l));
      const retry = log.findIndex(
        (l, i) => i > reindex && /^UPDATE async_operations SET status='pending'/.test(l),
      );
      expect(firstReset).toBeGreaterThanOrEqual(0);
      expect(reindex).toBeGreaterThan(firstReset);
      expect(retry).toBeGreaterThan(reindex);
      // The reset is bounded + concurrency-safe (never steal a live claim).
      expect(log.some((l) => /FOR UPDATE SKIP LOCKED LIMIT/.test(l))).toBe(true);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 12_000);

  it("reaper does NOT alarm or REINDEX when the reset succeeds (no false positives)", async () => {
    stopBroker = await startFakeBroker(socketPath);
    const stateDir = join(dir, "fakestate");
    const sqlLog = join(dir, "psql-sql.log");
    const pgInstance = join(dir, "instance.json");
    const binDir = installFakePsql(stateDir);
    writePgInstance(pgInstance);

    const child = spawn("sh", [ENTRYPOINT, "sleep", "5"], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        SWITCHROOM_AUTH_BROKER_SOCKET: socketPath,
        SWITCHROOM_HINDSIGHT_CRED_DIR: credDir,
        SWITCHROOM_HINDSIGHT_WAIT_S: "5",
        SWITCHROOM_HINDSIGHT_REFRESH_S: "1",
        SWITCHROOM_HINDSIGHT_FETCHER: FETCHER,
        SWITCHROOM_HINDSIGHT_PG0_INSTANCE: pgInstance,
        FAKE_PSQL_MODE: "healthy",
        FAKE_PSQL_STATE: stateDir,
        FAKE_PSQL_LOG: sqlLog,
      },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    try {
      await new Promise((r) => setTimeout(r, 2500));
      expect(stderr).toMatch(/stale-claim reaper reset 3 stuck/);
      expect(stderr).not.toMatch(/reset_failed/);
      expect(stderr).not.toMatch(/reindex_selfheal/);
      const log = readFileSync(sqlLog, "utf-8");
      expect(log).not.toMatch(/REINDEX INDEX/);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 10_000);

  it("reaper reset is bounded + concurrency-safe and never swallows the failure (static guard)", () => {
    const raw = readFileSync(ENTRYPOINT, "utf-8");
    // Bounded batch + skip rows a live worker holds (never steal a claim).
    expect(raw).toMatch(/FOR UPDATE SKIP LOCKED LIMIT \$\{REAP_BATCH_LIMIT\}/);
    // The old silent-swallow shape MUST be gone: no reset psql piped into
    // `2>/dev/null) ... || return 0`. The reset now captures stderr (2>&1)
    // and branches on failure with a loud ERROR.
    expect(raw).not.toMatch(/UPDATE async_operations SET status='pending'[\s\S]{0,400}2>\/dev\/null\)"\s*\|\|\s*return 0/);
    expect(raw).toMatch(/ERROR: hindsight-reaper reset_failed/);
    // Self-heal is gated (alarm-only when disabled) and keyed on the exact
    // corrupt-index signature, not any failure.
    expect(raw).toMatch(/REINDEX_SELFHEAL/);
    expect(raw).toMatch(/grep -q 'pk_async_operations'/);
    expect(raw).toMatch(/REINDEX INDEX CONCURRENTLY pk_async_operations/);
  });

  // ── pg0 sizing pre-start (#3706) ───────────────────────────────────────
  //
  // pg0 bakes `-c shared_buffers=… -c effective_cache_size=…` into the
  // `postgres` child's ARGV, and postgres ranks the `command line` source
  // above `postgresql.auto.conf` — so `ALTER SYSTEM SET` cannot change them
  // (verified live: ALTER SYSTEM + pg_reload_conf() left pg_settings reporting
  // the old value with source='command line'). The only route is to start pg0
  // ourselves with tuned flags BEFORE the exec, because hindsight_api's
  // EmbeddedPostgres.ensure_running() short-circuits on an already-running
  // instance.
  //
  // These tests drive the entrypoint with a FAKE pg0 that records its argv and
  // assert the OUTCOME: the tuned flags land, an operator opt-out removes only
  // the knob it names, and every failure path still reaches `exec` so a sizing
  // change can never be why the container fails to boot.

  /** Write a fake `pg0` that logs argv (one arg per line) and exits `code`. */
  function installFakePg0(logPath: string, code = 0): string {
    const binDir = execTmpDir("swr-fakepg0-");
    const pg0 = join(binDir, "pg0");
    writeFileSync(
      pg0,
      `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> "${logPath}"; done
[ ${code} -eq 0 ] || echo "fake pg0: could not create shared memory segment" >&2
exit ${code}
`,
      { mode: 0o755 },
    );
    return pg0;
  }

  /**
   * Boot the entrypoint to completion with extra env, returning stderr + the
   * exit status. The CMD defaults to one that exits immediately.
   */
  function runWithEnv(
    extraEnv: Record<string, string>,
    cmd: string[] = ["true"],
  ): Promise<{ status: number | null; stderr: string }> {
    return new Promise((res) => {
      const child = spawn("sh", [ENTRYPOINT, ...cmd], {
        env: {
          ...process.env,
          SWITCHROOM_AUTH_BROKER_SOCKET: socketPath,
          SWITCHROOM_HINDSIGHT_CRED_DIR: credDir,
          SWITCHROOM_HINDSIGHT_WAIT_S: "5",
          SWITCHROOM_HINDSIGHT_REFRESH_S: "0",
          SWITCHROOM_HINDSIGHT_FETCHER: FETCHER,
          SWITCHROOM_HINDSIGHT_PG0_INSTANCE: join(dir, "does-not-exist.json"),
          ...extraEnv,
        },
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
      const killer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, 20000);
      child.on("close", (status) => {
        clearTimeout(killer);
        res({ status, stderr });
      });
    });
  }

  /** Read a fake-pg0 argv log back as an array. */
  function argvOf(logPath: string): string[] {
    return existsSync(logPath)
      ? readFileSync(logPath, "utf-8").split("\n").filter((l) => l !== "")
      : [];
  }

  it("pre-starts pg0 with BOTH tuned -c flags before exec'ing the CMD", async () => {
    stopBroker = await startFakeBroker(socketPath);
    const log = join(dir, "pg0-argv.log");
    const marker = join(dir, "cmd-ran");
    const r = await runWithEnv(
      {
        SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(log),
        SWITCHROOM_HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE: "4096MB",
        SWITCHROOM_HINDSIGHT_PG_SHARED_BUFFERS: "1536MB",
      },
      ["sh", "-c", `touch ${marker}`],
    );
    expect(r.status).toBe(0);
    const argv = argvOf(log);
    expect(argv[0]).toBe("start");
    // The flags themselves — the whole point of the change.
    expect(argv).toContain("effective_cache_size=4096MB");
    expect(argv).toContain("shared_buffers=1536MB");
    // ...plus the durability flag, which defaults ON inside the entrypoint.
    expect(argv).toContain("fsync=on");
    // ...each introduced by its own `-c`, which is pg0's flag syntax.
    expect(argv.filter((a) => a === "-c").length).toBe(3);
    // The instance identity hindsight_api will look for, or it won't adopt ours.
    expect(argv[argv.indexOf("--name") + 1]).toBe("hindsight");
    // Ordering matters: pre-start must happen BEFORE the exec, otherwise
    // hindsight_api wins the race and starts pg0 untuned.
    expect(r.stderr).toMatch(/pg0 pre-start ok/);
    expect(existsSync(marker)).toBe(true);
  }, 20_000);

  it("still pre-starts for fsync alone when BOTH sizing knobs are cleared", async () => {
    // An older switchroom that emits neither sizing var must STILL get a
    // crash-safe database — durability cannot be contingent on a CLI version.
    // Pre-#3706 this case skipped the pre-start entirely; it no longer can.
    stopBroker = await startFakeBroker(socketPath);
    const log = join(dir, "pg0-argv-none.log");
    const r = await runWithEnv({
      SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(log),
      SWITCHROOM_HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE: "",
      SWITCHROOM_HINDSIGHT_PG_SHARED_BUFFERS: "",
    });
    expect(r.status).toBe(0);
    const argv = argvOf(log);
    expect(argv).toContain("fsync=on");
    // ...and nothing else: clearing a sizing knob must still clear it.
    expect(argv.filter((a) => a === "-c")).toEqual(["-c"]);
    expect(argv.some((a) => a.startsWith("shared_buffers="))).toBe(false);
    expect(argv.some((a) => a.startsWith("effective_cache_size="))).toBe(false);
    expect(r.stderr).toMatch(/pg0 pre-start ok/);
  }, 20_000);

  it("does NOT touch pg0 at all when every knob is opted out", async () => {
    // The full pre-#3706 escape hatch: an operator who explicitly turns all
    // three off gets exactly hindsight_api starting pg0 itself.
    stopBroker = await startFakeBroker(socketPath);
    const log = join(dir, "pg0-argv-alloff.log");
    const r = await runWithEnv({
      SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(log),
      SWITCHROOM_HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE: "",
      SWITCHROOM_HINDSIGHT_PG_SHARED_BUFFERS: "",
      SWITCHROOM_HINDSIGHT_PG_FSYNC: "off",
    });
    expect(r.status).toBe(0);
    expect(argvOf(log)).toEqual([]);
    expect(r.stderr).not.toMatch(/pg0 pre-start ok/);
  }, 20_000);

  it("never hands postgres a non-boolean fsync value", async () => {
    // `fsync` is applied only for the exact token `on`. A typo must degrade to
    // pg0's own `-F` rather than becoming `-c fsync=oon`, which would make the
    // server refuse to start and turn a durability change into a boot failure.
    stopBroker = await startFakeBroker(socketPath);
    const log = join(dir, "pg0-argv-fsync-typo.log");
    const r = await runWithEnv({
      SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(log),
      SWITCHROOM_HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE: "4096MB",
      SWITCHROOM_HINDSIGHT_PG_FSYNC: "oon",
    });
    expect(r.status).toBe(0);
    const argv = argvOf(log);
    expect(argv).toContain("effective_cache_size=4096MB");
    expect(argv.some((a) => a.startsWith("fsync="))).toBe(false);
  }, 20_000);

  it("accepts an upper-case ON, like the other knobs' sentinels", async () => {
    stopBroker = await startFakeBroker(socketPath);
    const log = join(dir, "pg0-argv-fsync-upper.log");
    const r = await runWithEnv({
      SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(log),
      SWITCHROOM_HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE: "",
      SWITCHROOM_HINDSIGHT_PG_SHARED_BUFFERS: "",
      SWITCHROOM_HINDSIGHT_PG_FSYNC: "ON",
    });
    expect(r.status).toBe(0);
    expect(argvOf(log)).toContain("fsync=on");
  }, 20_000);

  it("`off` opts out ONE knob and leaves the other applied", async () => {
    stopBroker = await startFakeBroker(socketPath);
    const log = join(dir, "pg0-argv-off.log");
    const r = await runWithEnv({
      SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(log),
      SWITCHROOM_HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE: "4096MB",
      SWITCHROOM_HINDSIGHT_PG_SHARED_BUFFERS: "OFF",
    });
    expect(r.status).toBe(0);
    const argv = argvOf(log);
    expect(argv).toContain("effective_cache_size=4096MB");
    // The sentinel must not leak through as a literal postgres value either —
    // `shared_buffers=off` would make the server refuse to start.
    expect(argv.some((a) => a.startsWith("shared_buffers="))).toBe(false);
  }, 20_000);

  it("a FAILING pg0 pre-start warns loudly but still boots (fallback intact)", async () => {
    // The safety property the whole design rests on: hindsight_api then starts
    // pg0 with pg0's own defaults, exactly as before this change.
    stopBroker = await startFakeBroker(socketPath);
    const log = join(dir, "pg0-argv-fail.log");
    const marker = join(dir, "cmd-ran-after-failure");
    const r = await runWithEnv(
      {
        SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(log, 1),
        SWITCHROOM_HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE: "4096MB",
        SWITCHROOM_HINDSIGHT_PG_SHARED_BUFFERS: "1536MB",
      },
      ["sh", "-c", `touch ${marker}`],
    );
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(r.stderr).toMatch(/WARNING: pg0 pre-start failed/);
    expect(r.stderr).not.toMatch(/pg0 pre-start ok/);
  }, 20_000);

  it("skips the pre-start when the DB is not the default embedded instance", async () => {
    // Starting a server underneath an operator who pointed hindsight at an
    // external postgres (or a differently-named pg0) would be actively wrong.
    stopBroker = await startFakeBroker(socketPath);
    const log = join(dir, "pg0-argv-extdb.log");
    const r = await runWithEnv({
      SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(log),
      SWITCHROOM_HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE: "4096MB",
      SWITCHROOM_HINDSIGHT_PG_SHARED_BUFFERS: "1536MB",
      HINDSIGHT_API_DB_URL: "postgresql://user:pw@db.example.com:5432/hindsight",
    });
    expect(r.status).toBe(0);
    expect(argvOf(log)).toEqual([]);
    expect(r.stderr).toMatch(/pg0 pre-start skipped/);
  }, 20_000);

  it("reuses the existing instance's credentials + port instead of rewriting them", async () => {
    // `pg0 start` REWRITES instance.json. If we passed different credentials
    // than the live cluster's, hindsight_api's ensure_running() would hand the
    // engine a URI that cannot authenticate.
    stopBroker = await startFakeBroker(socketPath);
    const log = join(dir, "pg0-argv-ident.log");
    const instance = join(dir, "instance.json");
    writeFileSync(
      instance,
      JSON.stringify({
        pid: 153,
        port: 5433,
        username: "hsuser",
        password: "hspass",
        database: "hsdb",
      }),
    );
    const r = await runWithEnv({
      SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(log),
      SWITCHROOM_HINDSIGHT_PG0_INSTANCE: instance,
      // A READABLE descriptor also arms the boot-deferred reaper, whose
      // background subshell holds the stdio pipes open so `close` never
      // fires. Disable it — this test is about the pre-start argv only.
      SWITCHROOM_HINDSIGHT_REAP_STALE_S: "0",
      SWITCHROOM_HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE: "4096MB",
      SWITCHROOM_HINDSIGHT_PG_SHARED_BUFFERS: "1536MB",
    });
    expect(r.status).toBe(0);
    const argv = argvOf(log);
    expect(argv[argv.indexOf("--username") + 1]).toBe("hsuser");
    expect(argv[argv.indexOf("--password") + 1]).toBe("hspass");
    expect(argv[argv.indexOf("--database") + 1]).toBe("hsdb");
    expect(argv[argv.indexOf("--port") + 1]).toBe("5433");
  }, 20_000);

  it("falls back to hindsight_api's own defaults when no descriptor exists (first boot)", async () => {
    // EmbeddedPostgres' DEFAULT_USERNAME/PASSWORD/DATABASE are all
    // "hindsight", and it passes no port so pg0 auto-allocates. A first boot
    // must be byte-identical to what hindsight_api itself would have done.
    stopBroker = await startFakeBroker(socketPath);
    const log = join(dir, "pg0-argv-firstboot.log");
    const r = await runWithEnv({
      SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(log),
      SWITCHROOM_HINDSIGHT_PG0_INSTANCE: join(dir, "absent.json"),
      SWITCHROOM_HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE: "4096MB",
    });
    expect(r.status).toBe(0);
    const argv = argvOf(log);
    expect(argv[argv.indexOf("--username") + 1]).toBe("hindsight");
    expect(argv[argv.indexOf("--password") + 1]).toBe("hindsight");
    expect(argv[argv.indexOf("--database") + 1]).toBe("hindsight");
    expect(argv).not.toContain("--port");
  }, 20_000);

  it("boots normally when the pg0 binary is missing entirely", async () => {
    stopBroker = await startFakeBroker(socketPath);
    const marker = join(dir, "cmd-ran-no-pg0");
    const r = await runWithEnv(
      {
        SWITCHROOM_HINDSIGHT_PG0_BIN: join(dir, "no-such-pg0"),
        SWITCHROOM_HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE: "4096MB",
        SWITCHROOM_HINDSIGHT_PG_SHARED_BUFFERS: "1536MB",
      },
      ["sh", "-c", `touch ${marker}`],
    );
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(r.stderr).toMatch(/pg0 pre-start skipped: pg0 binary not found/);
  }, 20_000);

  // ── Text-search provisioning (durable stopword config) ─────────────────
  //
  // switchroom runs hindsight recall through a CUSTOM Postgres text-search
  // regconfig (HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE =
  // hindsight_english), whose snowball dictionary carries a stopword file that
  // drops boilerplate lexemes. It was first applied by hand on the live volume
  // and nothing re-creates it. Two ways that bites a fresh boot:
  //   L1  fresh/empty volume + the env set → the backfill migration runs
  //       to_tsvector('hindsight_english'::regconfig, …); `::regconfig` resolves
  //       at PLAN time, so a missing config is SQLSTATE 42704 and the whole API
  //       crash-loops. The config must exist BEFORE migrations.
  //   L2  an embedded-pg version bump extracts a NEW install dir WITHOUT the
  //       stopword file → to_tsvector fails "could not open stop-word file".
  // provision_text_search() runs BEFORE the exec: it materializes the stopword
  // file into the current install's tsearch_data (L2) and runs IDEMPOTENT DDL
  // creating the dict + config (L1). These tests drive it with a fake pg0 + a
  // fake psql that captures the DDL on stdin, and assert the OUTCOME.

  /** Write a fake `psql` that appends whatever it reads on stdin to a log. */
  function installFakeStdinPsql(stdinLog: string): string {
    const binDir = execTmpDir("swr-fakepsql-stdin-");
    const psql = join(binDir, "psql");
    writeFileSync(
      psql,
      `#!/bin/sh
# Fake psql for text-search provisioning tests: capture the DDL fed on stdin.
cat >> "${stdinLog}"
exit 0
`,
      { mode: 0o755 },
    );
    return binDir;
  }

  it("provisions the stopword file + idempotent, catalog-guarded DDL before exec", async () => {
    stopBroker = await startFakeBroker(socketPath);
    const pg0log = join(dir, "prov-pg0.log");
    const ddlLog = join(dir, "prov-ddl.sql");
    const stopSrc = join(dir, "hindsight_extra.stop");
    const STOP_BYTES = "claude\ncode\nagent\n";
    writeFileSync(stopSrc, STOP_BYTES);
    // A tsearch_data dir that matches the glob (the current install).
    const tsDir = join(dir, "inst", "18.1.0", "share", "tsearch_data");
    mkdirSync(tsDir, { recursive: true });
    const pgInstance = join(dir, "instance.json");
    writePgInstance(pgInstance);
    const psqlBin = installFakeStdinPsql(ddlLog);

    const r = await runWithEnv({
      PATH: `${psqlBin}:${process.env.PATH}`,
      SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(pg0log),
      SWITCHROOM_HINDSIGHT_PG0_INSTANCE: pgInstance,
      SWITCHROOM_HINDSIGHT_REAP_STALE_S: "0",
      SWITCHROOM_HINDSIGHT_TS_STOP_SRC: stopSrc,
      SWITCHROOM_HINDSIGHT_TS_STOP_DEST_GLOB: join(dir, "inst", "*", "share", "tsearch_data"),
    });
    expect(r.status).toBe(0);

    // L2: the stopword file was materialized into the current install, byte-exact.
    const placed = join(tsDir, "hindsight_extra.stop");
    expect(existsSync(placed)).toBe(true);
    expect(readFileSync(placed, "utf-8")).toBe(STOP_BYTES);

    // L1: the idempotent DDL was fed to psql.
    expect(existsSync(ddlLog)).toBe(true);
    const ddl = readFileSync(ddlLog, "utf-8");
    // Guarded against the CATALOG (Postgres has no CREATE ... IF NOT EXISTS for
    // TS objects) via pg_ts_dict / pg_ts_config, so it is a no-op after boot 1.
    expect(ddl).toMatch(/IF NOT EXISTS/);
    expect(ddl).toMatch(/FROM pg_ts_dict\b/);
    expect(ddl).toMatch(/FROM pg_ts_config\b/);
    // Creates the dict (with the stopword file) + the config (COPY of english).
    expect(ddl).toMatch(/CREATE TEXT SEARCH DICTIONARY public\.hindsight_stem/);
    expect(ddl).toMatch(/StopWords = hindsight_extra/);
    expect(ddl).toMatch(
      /CREATE TEXT SEARCH CONFIGURATION public\.hindsight_english \(COPY = pg_catalog\.english\)/,
    );
    // Word tokens routed through the stopword-bearing stemmer …
    expect(ddl).toMatch(
      /ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH public\.hindsight_stem/,
    );
    // … but NUMBER/int tokens are LEFT on the default `simple` dict so numbers,
    // semvers, ports and error codes stay searchable — they must NOT be remapped.
    expect(ddl).not.toMatch(/\b(int|uint|numword|numhword|float)\b/);
    // NEVER destructive: no DROP ... CASCADE that could nuke dependent indexes.
    expect(ddl).not.toMatch(/DROP\b/i);
    // It reported success and reached exec.
    expect(r.stderr).toMatch(/text-search provisioning ok/);
  }, 20_000);

  it("re-materializes the stopword file into EVERY install dir (survives a pg version bump)", async () => {
    // L2 durability: pg0 extracts a fresh, version-scoped install dir on an
    // embedded-pg bump. The glob matches every install; the file is placed into
    // each, so a bump can never leave the NEW install without the stopword file.
    stopBroker = await startFakeBroker(socketPath);
    const ddlLog = join(dir, "prov-ddl2.sql");
    const stopSrc = join(dir, "hindsight_extra.stop");
    writeFileSync(stopSrc, "claude\ncode\n");
    const oldDir = join(dir, "inst", "17.4.0", "share", "tsearch_data");
    const newDir = join(dir, "inst", "18.1.0", "share", "tsearch_data");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    const pgInstance = join(dir, "instance.json");
    writePgInstance(pgInstance);

    const r = await runWithEnv({
      PATH: `${installFakeStdinPsql(ddlLog)}:${process.env.PATH}`,
      SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(join(dir, "prov-pg0-2.log")),
      SWITCHROOM_HINDSIGHT_PG0_INSTANCE: pgInstance,
      SWITCHROOM_HINDSIGHT_REAP_STALE_S: "0",
      SWITCHROOM_HINDSIGHT_TS_STOP_SRC: stopSrc,
      SWITCHROOM_HINDSIGHT_TS_STOP_DEST_GLOB: join(dir, "inst", "*", "share", "tsearch_data"),
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(oldDir, "hindsight_extra.stop"))).toBe(true);
    expect(existsSync(join(newDir, "hindsight_extra.stop"))).toBe(true);
  }, 20_000);

  it("is a clean no-op (no DDL, still boots) when the stopword source is absent", async () => {
    // An older image without the baked stopword file — or an operator who
    // removed it — must boot exactly as before: provisioning disables itself.
    stopBroker = await startFakeBroker(socketPath);
    const ddlLog = join(dir, "prov-ddl-absent.sql");
    const marker = join(dir, "prov-absent-ran");
    const pgInstance = join(dir, "instance.json");
    writePgInstance(pgInstance);

    const r = await runWithEnv(
      {
        PATH: `${installFakeStdinPsql(ddlLog)}:${process.env.PATH}`,
        SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(join(dir, "prov-pg0-absent.log")),
        SWITCHROOM_HINDSIGHT_PG0_INSTANCE: pgInstance,
        SWITCHROOM_HINDSIGHT_REAP_STALE_S: "0",
        SWITCHROOM_HINDSIGHT_TS_STOP_SRC: join(dir, "no-such-stopfile.stop"),
      },
      ["sh", "-c", `touch ${marker}`],
    );
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(ddlLog)).toBe(false);
    expect(r.stderr).not.toMatch(/text-search provisioning ok/);
  }, 20_000);

  it("skips text-search provisioning for an external (non-embedded) database", async () => {
    // Reaching into an operator's external postgres to run our DDL would be
    // actively wrong — provisioning only ever touches the embedded pg0.
    stopBroker = await startFakeBroker(socketPath);
    const ddlLog = join(dir, "prov-ddl-extdb.sql");
    const stopSrc = join(dir, "hindsight_extra.stop");
    writeFileSync(stopSrc, "claude\ncode\n");

    const r = await runWithEnv({
      PATH: `${installFakeStdinPsql(ddlLog)}:${process.env.PATH}`,
      SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(join(dir, "prov-pg0-extdb.log")),
      SWITCHROOM_HINDSIGHT_REAP_STALE_S: "0",
      SWITCHROOM_HINDSIGHT_TS_STOP_SRC: stopSrc,
      SWITCHROOM_HINDSIGHT_TS_STOP_DEST_GLOB: join(dir, "inst", "*", "share", "tsearch_data"),
      HINDSIGHT_API_DB_URL: "postgresql://user:pw@db.example.com:5432/hindsight",
    });
    expect(r.status).toBe(0);
    expect(existsSync(ddlLog)).toBe(false);
    expect(r.stderr).toMatch(/text-search provisioning skipped/);
  }, 20_000);

  // provision_pg_search() runs BEFORE prestart_pg0(): it stages the pg_search
  // extension (.so + control + SQL) into the embedded-pg install dir and leaves
  // pg0 STOPPED so prestart_pg0's start is the one that sets
  // shared_preload_libraries=pg_search (a PGC_POSTMASTER GUC). These tests drive
  // it with a baked-artifact tree + a fake pg0 and assert the OUTCOME.

  /** Stage a fake baked pg_search artifact tree (.so + control + version SQL). */
  function installFakePgSearchBake(root: string, major = "18"): void {
    const lib = join(root, major, "lib");
    const ext = join(root, major, "extension");
    mkdirSync(lib, { recursive: true });
    mkdirSync(ext, { recursive: true });
    writeFileSync(join(lib, "pg_search.so"), "\x7fELF fake pg_search .so");
    writeFileSync(join(ext, "pg_search.control"), "default_version = '0.25.1'\n");
    writeFileSync(join(ext, "pg_search--0.25.1.sql"), "-- fake base sql\n");
    writeFileSync(join(ext, "pg_search--0.24.0--0.25.1.sql"), "-- fake upgrade sql\n");
  }

  it("stages pg_search into the install dir and preloads it via prestart_pg0", async () => {
    // The core happy path (reboot: the version-scoped install dir already
    // exists). The .so + control + SQL are copied in, pg0 is STOPPED, and the
    // authoritative prestart start carries shared_preload_libraries=pg_search.
    stopBroker = await startFakeBroker(socketPath);
    const pg0log = join(dir, "pgs-pg0.log");
    const bakeRoot = join(dir, "bake");
    installFakePgSearchBake(bakeRoot);
    const installLib = join(dir, "inst", "18.1.0", "lib");
    const installExt = join(dir, "inst", "18.1.0", "share", "extension");
    mkdirSync(installLib, { recursive: true });
    mkdirSync(installExt, { recursive: true });
    const marker = join(dir, "pgs-cmd-ran");

    const r = await runWithEnv(
      {
        SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(pg0log),
        SWITCHROOM_HINDSIGHT_REAP_STALE_S: "0",
        SWITCHROOM_HINDSIGHT_PG_SEARCH_SRC_ROOT: bakeRoot,
        SWITCHROOM_HINDSIGHT_PG_SEARCH_INSTALL_GLOB: join(dir, "inst", "*"),
        HINDSIGHT_API_TEXT_SEARCH_EXTENSION: "pg_search",
      },
      ["sh", "-c", `touch ${marker}`],
    );
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(true);

    // The extension artifacts were materialized into the current install dir.
    expect(existsSync(join(installLib, "pg_search.so"))).toBe(true);
    expect(existsSync(join(installExt, "pg_search.control"))).toBe(true);
    expect(existsSync(join(installExt, "pg_search--0.25.1.sql"))).toBe(true);

    const argv = argvOf(pg0log);
    // provision_pg_search stops pg0 so the preload can be applied at next start.
    expect(argv).toContain("stop");
    // prestart_pg0's authoritative start carries the preload GUC.
    expect(argv).toContain("shared_preload_libraries=pg_search");
    expect(r.stderr).toMatch(/pg_search provisioning ok/);
    expect(r.stderr).toMatch(/pg0 pre-start ok/);
  }, 20_000);

  it("starts pg0 PLAIN first to extract a fresh-volume install dir, then copies", async () => {
    // First boot on an empty volume: the install dir does not exist until pg0
    // extracts it. provision_pg_search must start pg0 WITHOUT a preload it
    // cannot yet satisfy, let the dir appear, then copy — never hand the very
    // first start a missing library.
    stopBroker = await startFakeBroker(socketPath);
    const pg0log = join(dir, "pgs-fresh-pg0.log");
    const bakeRoot = join(dir, "bake");
    installFakePgSearchBake(bakeRoot);
    const installBase = join(dir, "inst", "18.1.0");
    // A fake pg0 that materializes the version-scoped install dir on `start`,
    // exactly as the real pg0 extracts it on first run.
    const binDir = execTmpDir("swr-fakepg0-mkinstall-");
    const pg0 = join(binDir, "pg0");
    writeFileSync(
      pg0,
      `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> "${pg0log}"; done
if [ "$1" = start ]; then mkdir -p "${join(installBase, "lib")}" "${join(installBase, "share", "extension")}"; fi
exit 0
`,
      { mode: 0o755 },
    );

    const r = await runWithEnv({
      SWITCHROOM_HINDSIGHT_PG0_BIN: pg0,
      SWITCHROOM_HINDSIGHT_REAP_STALE_S: "0",
      SWITCHROOM_HINDSIGHT_PG_SEARCH_SRC_ROOT: bakeRoot,
      SWITCHROOM_HINDSIGHT_PG_SEARCH_INSTALL_GLOB: join(dir, "inst", "*"),
      HINDSIGHT_API_TEXT_SEARCH_EXTENSION: "pg_search",
    });
    expect(r.status).toBe(0);
    // The plain extraction start ran (a `start` appears in the log) …
    expect(argvOf(pg0log)).toContain("start");
    // … and the copy landed after the dir appeared.
    expect(existsSync(join(installBase, "lib", "pg_search.so"))).toBe(true);
    expect(existsSync(join(installBase, "share", "extension", "pg_search.control"))).toBe(true);
    expect(r.stderr).toMatch(/pg_search provisioning ok/);
  }, 20_000);

  it("is a clean no-op (no copy, no preload) when the backend is not pg_search", async () => {
    // The byte-identical-to-before guarantee: a native-pinned fleet (or an older
    // switchroom that never emits the selector) must not stage the extension nor
    // preload it. This is the safety valve for a not-yet-migrated populated DB.
    stopBroker = await startFakeBroker(socketPath);
    const pg0log = join(dir, "pgs-native-pg0.log");
    const bakeRoot = join(dir, "bake");
    installFakePgSearchBake(bakeRoot);
    const installLib = join(dir, "inst", "18.1.0", "lib");
    mkdirSync(installLib, { recursive: true });

    const r = await runWithEnv({
      SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(pg0log),
      SWITCHROOM_HINDSIGHT_REAP_STALE_S: "0",
      SWITCHROOM_HINDSIGHT_PG_SEARCH_SRC_ROOT: bakeRoot,
      SWITCHROOM_HINDSIGHT_PG_SEARCH_INSTALL_GLOB: join(dir, "inst", "*"),
      HINDSIGHT_API_TEXT_SEARCH_EXTENSION: "native",
    });
    expect(r.status).toBe(0);
    // Not staged …
    expect(existsSync(join(installLib, "pg_search.so"))).toBe(false);
    // … and never preloaded.
    expect(argvOf(pg0log)).not.toContain("shared_preload_libraries=pg_search");
    expect(r.stderr).not.toMatch(/pg_search provisioning ok/);
  }, 20_000);

  it("refuses to copy an ABI-mismatched .so when the install major moves ahead of the baked deb", async () => {
    // A pg0 embedded-pg bump that lands a NEW major before the baked deb is
    // updated must NOT copy the wrong-major .so (which would crash the postmaster
    // on preload). It is skipped with a loud warning; bump PG_SEARCH_* to fix.
    stopBroker = await startFakeBroker(socketPath);
    const pg0log = join(dir, "pgs-mismatch-pg0.log");
    const bakeRoot = join(dir, "bake");
    installFakePgSearchBake(bakeRoot, "18");
    // The live install is major 19 — ahead of the baked 18.
    const installLib = join(dir, "inst", "19.0.0", "lib");
    mkdirSync(installLib, { recursive: true });

    const r = await runWithEnv({
      SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(pg0log),
      SWITCHROOM_HINDSIGHT_REAP_STALE_S: "0",
      SWITCHROOM_HINDSIGHT_PG_SEARCH_SRC_ROOT: bakeRoot,
      SWITCHROOM_HINDSIGHT_PG_SEARCH_INSTALL_GLOB: join(dir, "inst", "*"),
      HINDSIGHT_API_TEXT_SEARCH_EXTENSION: "pg_search",
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(installLib, "pg_search.so"))).toBe(false);
    expect(r.stderr).toMatch(/major != baked/);
    // The load-bearing half: because the copy was SKIPPED, no .so landed in the
    // version-matched install dir, so prestart_pg0 must NOT hand the postmaster
    // shared_preload_libraries=pg_search — that would tell pg0 to preload a
    // library that isn't there and turn a graceful ABI-skip into a boot
    // crash-loop. The preload gate keys off the LANDED artifact, not the bake.
    expect(argvOf(pg0log)).not.toContain("shared_preload_libraries=pg_search");
  }, 20_000);

  it("does NOT adopt an already-running preload-less postmaster: SHOW-verifies, stops, restarts WITH the preload (MAJOR-2)", async () => {
    // The dangerous adopt path: provision_pg_search()'s best-effort stop left a
    // plain (preload-less) postmaster up, and prestart_pg0's `start` loses the
    // race and gets "already running". A naive adopt would strand the box —
    // shared_preload_libraries is PGC_POSTMASTER, so CREATE EXTENSION pg_search
    // can never succeed against a server that came up without the preload. The
    // entrypoint must SHOW-verify the preload, and finding it absent, STOP and
    // restart WITH shared_preload_libraries=pg_search rather than adopt.
    stopBroker = await startFakeBroker(socketPath);
    const pg0log = join(dir, "pgs-adopt-pg0.log");
    const bakeRoot = join(dir, "bake");
    installFakePgSearchBake(bakeRoot, "18");
    // Reboot path: a version-matched install dir already exists, so the .so
    // lands there and the preload IS intended (landed major 18 == baked 18).
    mkdirSync(join(dir, "inst", "18.1.0", "lib"), { recursive: true });
    mkdirSync(join(dir, "inst", "18.1.0", "share", "extension"), { recursive: true });

    // A stateful fake pg0: the FIRST `start` reports "already running" (the
    // preload-less postmaster provisioning left up); after a `stop`, the next
    // `start` succeeds — modelling a real stop+restart that applies the preload.
    // Each invocation is also logged as ONE space-joined line to invLog so the
    // test can count how many `start`s carried shared_preload_libraries=pg_search
    // (a later native provision_text_search start carries none, so a raw token
    // count would be ambiguous — the preload flag is the load-bearing signal).
    const binDir = execTmpDir("swr-fakepg0-adopt-");
    const pg0 = join(binDir, "pg0");
    const startCtr = join(dir, "adopt-startctr");
    const invLog = join(dir, "adopt-inv.log");
    writeFileSync(
      pg0,
      `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> "${pg0log}"; done
printf '%s\\n' "$*" >> "${invLog}"
if [ "$1" = start ]; then
  n=$(cat "${startCtr}" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${startCtr}"
  if [ "$n" = 1 ]; then echo "fake pg0: FATAL: instance is already running" >&2; exit 1; fi
fi
exit 0
`,
      { mode: 0o755 },
    );

    const stateDir = join(dir, "adopt-fakestate");
    const psqlBin = installFakePsql(stateDir); // SHOW ... -> empty (preload-less)
    const psqlLog = join(dir, "adopt-psql.log");
    const pgInstance = join(dir, "adopt-instance.json");
    writePgInstance(pgInstance);

    const r = await runWithEnv({
      SWITCHROOM_HINDSIGHT_PG0_BIN: pg0,
      PATH: `${psqlBin}:${process.env.PATH}`,
      FAKE_PSQL_LOG: psqlLog,
      SWITCHROOM_HINDSIGHT_PG0_INSTANCE: pgInstance,
      SWITCHROOM_HINDSIGHT_REAP_STALE_S: "0",
      SWITCHROOM_HINDSIGHT_PG_SEARCH_SRC_ROOT: bakeRoot,
      SWITCHROOM_HINDSIGHT_PG_SEARCH_INSTALL_GLOB: join(dir, "inst", "*"),
      HINDSIGHT_API_TEXT_SEARCH_EXTENSION: "pg_search",
    });
    expect(r.status).toBe(0);
    // The preload was SHOW-verified against the running postmaster.
    expect(argvOf(psqlLog)).toContain("SHOW shared_preload_libraries");
    // It did NOT silently adopt: the preload-less server was stopped and a
    // SECOND preload-carrying start ran. A silent adopt would show exactly ONE
    // start carrying shared_preload_libraries=pg_search (the failed first try).
    const preloadStarts = argvOf(invLog).filter(
      (l) => l.startsWith("start") && l.includes("shared_preload_libraries=pg_search"),
    ).length;
    expect(preloadStarts).toBe(2);
    expect(argvOf(pg0log)).toContain("stop");
    expect(r.stderr).toMatch(/already running WITHOUT pg_search preload/);
    expect(r.stderr).toMatch(/restarted to apply pg_search preload/);
    // And it did NOT take the silent-adopt branch.
    expect(r.stderr).not.toMatch(/already running WITH pg_search preload; adopting/);
  }, 20_000);

  it("loud-fails rather than silently adopting when the preload-less postmaster cannot be stopped (MAJOR-2)", async () => {
    // The unstoppable variant: prestart_pg0 SHOW-verifies the missing preload but
    // its stop fails. It must NOT pretend success — it adopts only as a last
    // resort with a LOUD warning that CREATE EXTENSION pg_search will fail, never
    // logging the "restarted with preload" success line.
    stopBroker = await startFakeBroker(socketPath);
    const pg0log = join(dir, "pgs-unstoppable-pg0.log");
    const bakeRoot = join(dir, "bake");
    installFakePgSearchBake(bakeRoot, "18");
    mkdirSync(join(dir, "inst", "18.1.0", "lib"), { recursive: true });
    mkdirSync(join(dir, "inst", "18.1.0", "share", "extension"), { recursive: true });

    // Fake pg0: `start` always reports "already running"; the FIRST `stop`
    // (provision's) succeeds so provisioning stays fast, but the SECOND `stop`
    // (prestart's) fails — the postmaster cannot be brought down.
    const binDir = execTmpDir("swr-fakepg0-unstoppable-");
    const pg0 = join(binDir, "pg0");
    const stopCtr = join(dir, "unstoppable-stopctr");
    const invLog = join(dir, "unstoppable-inv.log");
    writeFileSync(
      pg0,
      `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> "${pg0log}"; done
printf '%s\\n' "$*" >> "${invLog}"
if [ "$1" = stop ]; then
  n=$(cat "${stopCtr}" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${stopCtr}"
  if [ "$n" = 1 ]; then exit 0; fi
  echo "fake pg0: stop failed: could not remove postmaster.pid" >&2; exit 1
fi
if [ "$1" = start ]; then echo "fake pg0: FATAL: instance is already running" >&2; exit 1; fi
exit 0
`,
      { mode: 0o755 },
    );

    const stateDir = join(dir, "unstoppable-fakestate");
    const psqlBin = installFakePsql(stateDir);
    const pgInstance = join(dir, "unstoppable-instance.json");
    writePgInstance(pgInstance);

    const r = await runWithEnv({
      SWITCHROOM_HINDSIGHT_PG0_BIN: pg0,
      PATH: `${psqlBin}:${process.env.PATH}`,
      SWITCHROOM_HINDSIGHT_PG0_INSTANCE: pgInstance,
      SWITCHROOM_HINDSIGHT_REAP_STALE_S: "0",
      SWITCHROOM_HINDSIGHT_PG_SEARCH_SRC_ROOT: bakeRoot,
      SWITCHROOM_HINDSIGHT_PG_SEARCH_INSTALL_GLOB: join(dir, "inst", "*"),
      HINDSIGHT_API_TEXT_SEARCH_EXTENSION: "pg_search",
    });
    // Boot still proceeds (best-effort), but the failure is LOUD, not silent.
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/could not stop the already-running instance/);
    expect(r.stderr).toMatch(/adopting the preload-less postmaster/);
    // No successful restart happened: only the one (failed) preload-carrying start.
    const preloadStarts = argvOf(invLog).filter(
      (l) => l.startsWith("start") && l.includes("shared_preload_libraries=pg_search"),
    ).length;
    expect(preloadStarts).toBe(1);
    expect(r.stderr).not.toMatch(/restarted to apply pg_search preload/);
  }, 20_000);

  it("skips pg_search provisioning for an external (non-embedded) database", async () => {
    // Never reach into an operator's external postgres to stage our extension.
    stopBroker = await startFakeBroker(socketPath);
    const pg0log = join(dir, "pgs-extdb-pg0.log");
    const bakeRoot = join(dir, "bake");
    installFakePgSearchBake(bakeRoot);
    const installLib = join(dir, "inst", "18.1.0", "lib");
    mkdirSync(installLib, { recursive: true });

    const r = await runWithEnv({
      SWITCHROOM_HINDSIGHT_PG0_BIN: installFakePg0(pg0log),
      SWITCHROOM_HINDSIGHT_REAP_STALE_S: "0",
      SWITCHROOM_HINDSIGHT_PG_SEARCH_SRC_ROOT: bakeRoot,
      SWITCHROOM_HINDSIGHT_PG_SEARCH_INSTALL_GLOB: join(dir, "inst", "*"),
      HINDSIGHT_API_TEXT_SEARCH_EXTENSION: "pg_search",
      HINDSIGHT_API_DB_URL: "postgresql://user:pw@db.example.com:5432/hindsight",
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(installLib, "pg_search.so"))).toBe(false);
    expect(r.stderr).toMatch(/pg_search provisioning skipped/);
  }, 20_000);

  it("bakes the pinned pg_search deb + libopenblas0 into the Dockerfile", () => {
    // The entrypoint re-materializes what the image bakes; assert the bake is
    // present, pinned (no floating latest), and provides the runtime prereq.
    const dockerfilePath = resolve(__dirname, "..", "..", "docker", "Dockerfile.hindsight");
    const raw = readFileSync(dockerfilePath, "utf-8");
    // libopenblas0 is a hard DT_NEEDED of pg_search.so.
    expect(raw).toMatch(/apt-get install -y --no-install-recommends libopenblas0/);
    // Version + checksums are pinned, not floating.
    expect(raw).toMatch(/ARG PG_SEARCH_VERSION=0\.25\.1/);
    expect(raw).toMatch(/ARG PG_SEARCH_SHA256_AMD64=[0-9a-f]{64}/);
    expect(raw).toMatch(/ARG PG_SEARCH_SHA256_ARM64=[0-9a-f]{64}/);
    expect(raw).toMatch(/sha256sum -c -/);
    // Staged at the STABLE path the entrypoint's PG_SEARCH_SRC_ROOT defaults to.
    expect(raw).toMatch(/\/usr\/local\/lib\/switchroom\/pg_search/);
    // amd64 + arm64 ARE the shipped arches: each maps to a checksum, not the
    // fail branch.
    expect(raw).toMatch(/amd64\) _arch=amd64; _sha="\$\{PG_SEARCH_SHA256_AMD64\}";;/);
    expect(raw).toMatch(/arm64\) _arch=arm64; _sha="\$\{PG_SEARCH_SHA256_ARM64\}";;/);
    // The default text-search backend is pg_search, so a build with NO baked deb
    // would crash-loop on CREATE EXTENSION at first boot. The unsupported-arch
    // branch must FAIL the build (exit 1), never silently `exit 0` — and must not
    // carry the old false "installs fall back to native text search" comment,
    // which no longer holds now that pg_search is the emitted default.
    const archCase = raw
      .split("\n")
      .find((l) => l.includes("no prebuilt deb") || l.includes("artifact not available for TARGETARCH"));
    expect(archCase, "unsupported-arch case arm not found in Dockerfile").toBeDefined();
    expect(archCase).toMatch(/exit 1;;/);
    expect(archCase).not.toMatch(/exit 0/);
    expect(raw).not.toMatch(/fall back to native text search/);
  });

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
