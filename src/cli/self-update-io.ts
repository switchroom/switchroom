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
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";

import type { SelfUpdateIO } from "./self-update.js";

/** Bounded so a hung GitHub/CDN connection can't wedge an update. */
const HTTP_TIMEOUT_MS = 60_000;

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
    probeBinaryVersion(path) {
      const r = spawnSync(path, ["version"], {
        encoding: "utf-8",
        timeout: 30_000,
        // A candidate binary must not inherit the self-update sentinel or
        // it could mask a loop guard in a future refactor.
        env: { ...process.env, SWITCHROOM_SELF_UPDATED: "" },
      });
      if (r.status !== 0) return null;
      const out = `${r.stdout ?? ""}`.trim();
      const m = out.match(/\d+\.\d+\.\d+/);
      return m ? m[0] : null;
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
  };
}
