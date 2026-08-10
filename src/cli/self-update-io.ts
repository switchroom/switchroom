/**
 * Production wiring for the CLI self-update (#3919).
 *
 * Split out from `self-update.ts` so that module stays pure and its
 * download → verify → prove → swap sequence is unit-testable against an
 * in-memory filesystem with no network. Nothing here has logic worth
 * testing in isolation; every decision lives in the pure module.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";

import type { SelfUpdateIO } from "./self-update.js";

/** Bounded so a hung GitHub/CDN connection can't wedge an update. */
const HTTP_TIMEOUT_MS = 60_000;

/** First non-empty line of a stream, bounded — probe details go into prose. */
function firstLine(s: string | undefined | null): string {
  const line = `${s ?? ""}`.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

export function defaultSelfUpdateIO(): SelfUpdateIO {
  return {
    async httpGetText(url) {
      const res = await fetch(url, {
        headers: { "user-agent": "switchroom-cli-self-update" },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    },
    async httpDownload(url, dest) {
      const res = await fetch(url, {
        headers: { "user-agent": "switchroom-cli-self-update" },
        redirect: "follow",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      if (!res.body) throw new Error(`empty response body for ${url}`);
      // Stream to disk — the binary is ~100MB and buffering it whole
      // would spike RSS on a small host.
      await pipeline(
        Readable.fromWeb(
          res.body as unknown as Parameters<typeof Readable.fromWeb>[0],
        ),
        createWriteStream(dest),
      );
    },
    sha256File(path) {
      // Chunked for the same reason httpDownload streams: the artifact is
      // ~100MB and readFileSync would materialise all of it.
      const hash = createHash("sha256");
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.allocUnsafe(1 << 20);
        for (;;) {
          const n = readSync(fd, buf, 0, buf.length, null);
          if (n <= 0) break;
          hash.update(buf.subarray(0, n));
        }
      } finally {
        closeSync(fd);
      }
      return hash.digest("hex");
    },
    probeBinary(path) {
      // `--version`, NOT the `version` SUBCOMMAND.
      //
      // This is the #4586 dead end, root-caused. `switchroom version` renders
      // the fleet health summary: it calls `getConfig()` and exits 1 with
      // "Config error: No switchroom.yaml found" in any context that has no
      // `~/.switchroom/switchroom.yaml`, then enumerates agent containers over
      // the docker socket. The host-CLI heal helper deliberately mounts the
      // install prefix AND NOTHING ELSE — no `~/.switchroom`, no docker socket
      // (`host-cli-heal.ts`, `healHelperArgs`) — so the probe of a perfectly
      // good release binary exited 1 there, every time, and the roll refused
      // with "the downloaded binary did not run cleanly on this host".
      //
      // `--version` is commander's own flag. It still execs the artifact and
      // loads its entire bundled runtime — which is the ONLY thing this check
      // is trying to prove — while touching no config, no docker socket and no
      // network. It is therefore both the cheapest and the strictly more
      // correct proof: a non-zero exit from it indicts the binary, whereas a
      // non-zero exit from `version` mostly indicts the environment.
      const r = spawnSync(path, ["--version"], {
        encoding: "utf-8",
        timeout: 30_000,
        // A candidate binary must not inherit the self-update sentinel or
        // it could mask a loop guard in a future refactor.
        env: { ...process.env, SWITCHROOM_SELF_UPDATED: "" },
      });
      // spawn itself failed: EACCES from a `noexec` staging mount or a missing
      // +x bit, ENOEXEC from a foreign architecture, ENOENT. None of these say
      // anything about the artifact's integrity.
      if (r.error) {
        const code = (r.error as NodeJS.ErrnoException).code;
        return {
          ok: false,
          kind: "not-executable",
          detail: code ? `${code}: ${r.error.message}` : r.error.message,
        };
      }
      if (r.signal) {
        return { ok: false, kind: "not-executable", detail: `killed by signal ${r.signal}` };
      }
      if (r.status !== 0) {
        return {
          ok: false,
          kind: "ran-but-failed",
          detail: `exit ${r.status}${firstLine(r.stderr) ? `: ${firstLine(r.stderr)}` : ""}`,
        };
      }
      const out = `${r.stdout ?? ""}`.trim();
      const m = out.match(/\d+\.\d+\.\d+/);
      if (!m) {
        return {
          ok: false,
          kind: "no-version",
          detail: out ? `printed ${JSON.stringify(firstLine(out))}` : "printed nothing",
        };
      }
      return { ok: true, version: m[0] };
    },
    mkdirp(dir) {
      mkdirSync(dir, { recursive: true });
    },
    copyFile(src, dest) {
      copyFileSync(src, dest);
    },
    chmodExec(path) {
      chmodSync(path, 0o755);
    },
    rename(src, dest) {
      renameSync(src, dest);
    },
    remove(path) {
      rmSync(path, { force: true });
    },
    exists(path) {
      return existsSync(path);
    },
    dirname(path) {
      return dirname(path);
    },
    readText(path) {
      try {
        return readFileSync(path, "utf-8");
      } catch {
        return null;
      }
    },
    extractTarGz(archive, destDir) {
      mkdirSync(destDir, { recursive: true });
      // `tar` rather than a JS tar library: it is present in the base system
      // on every platform the static binary ships for (GNU tar on Linux,
      // bsdtar on macOS), and pulling a runtime dependency into the compiled
      // binary for one call site is the worse trade.
      const r = spawnSync("tar", ["-xzf", archive, "-C", destDir], {
        encoding: "utf-8",
        timeout: 300_000,
      });
      if (r.error) throw r.error;
      if (r.status !== 0) {
        throw new Error(
          `tar -xzf exited ${r.status}: ${(r.stderr ?? "").trim() || "no stderr"}`,
        );
      }
    },
    symlink(target, linkPath) {
      symlinkSync(target, linkPath);
    },
    isSymlink(path) {
      try {
        return lstatSync(path).isSymbolicLink();
      } catch {
        return false;
      }
    },
    removeTree(path) {
      rmSync(path, { recursive: true, force: true });
    },
    listDir(dir) {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
  };
}
