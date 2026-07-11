import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkTcp } from "../src/cli/doctor.js";

/**
 * Regression tests for the config→RCE fix in doctor.ts `checkTcp`.
 *
 * The old implementation ran
 *   execSync(`timeout 2 bash -c '</dev/tcp/${host}/${port}'`)
 * so a `host` sourced from `memory.config.url` in switchroom.yaml was parsed
 * by /bin/sh — a shell-injection / RCE path at every `switchroom doctor`.
 * The fix opens a raw net.Socket, so `host` is only ever a literal hostname.
 */
describe("checkTcp — no-shell TCP reachability", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
          }),
      ),
    );
  });

  function listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      servers.push(server);
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("no port"));
      });
    });
  }

  it("returns true for a listening port", async () => {
    const port = await listen();
    await expect(checkTcp("127.0.0.1", port)).resolves.toBe(true);
  });

  it("returns false for a closed port (clean failure, no throw)", async () => {
    // Bind then immediately release the port so nothing is listening on it.
    const port = await listen();
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    await expect(checkTcp("127.0.0.1", port, 1000)).resolves.toBe(false);
  });

  it("returns false for a connection-refused port without spawning a shell", async () => {
    // Port 1 is privileged and unbound in test envs → ECONNREFUSED.
    await expect(checkTcp("127.0.0.1", 1, 1000)).resolves.toBe(false);
  });

  it("does NOT execute shell metacharacters embedded in host (RCE guard)", async () => {
    // This test FAILS against the old `bash -c '</dev/tcp/${host}/...'`
    // implementation: the backtick command substitution would run `touch`
    // and create the sentinel. With net.Socket the whole string is a literal
    // hostname that fails DNS resolution → false, and no file is created.
    const sentinel = join(
      tmpdir(),
      `switchroom-checktcp-pwned-${process.pid}-${Date.now()}`,
    );
    rmSync(sentinel, { force: true });
    try {
      const hostWithBacktick = "127.0.0.1`touch " + sentinel + "`";
      const hostWithDollar = "127.0.0.1$(touch " + sentinel + ")";

      const r1 = await checkTcp(hostWithBacktick, 80, 1000);
      const r2 = await checkTcp(hostWithDollar, 80, 1000);

      expect(r1).toBe(false);
      expect(r2).toBe(false);
      // The load-bearing assertion: the injected command never ran.
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(sentinel, { force: true });
    }
  });
});
