/**
 * Real-world dependency wiring for the release watcher (#1743).
 *
 * The watcher itself (`release-watcher.ts`) is dependency-injected and
 * has no docker / CLI knowledge. This module supplies the concrete
 * implementations used by the daemon in production.
 *
 * Detection strategy:
 *   1. `docker manifest inspect <image_ref>` → remote digest of the
 *      release tag (network round-trip to GHCR).
 *   2. `docker image inspect <image_ref>` → local image's RepoDigest.
 *   3. If remote != local → release available.
 *
 * Both probes are bounded by spawn timeouts; any error (network, auth,
 * registry rate-limit) surfaces as a `check_failed` event and the
 * tick is dropped (no retry-storm — the next interval will retry).
 */

import { spawn } from "node:child_process";

export interface ProbeResult {
  /** "sha256:..." digest, or null if the probe failed. */
  digest: string | null;
  /** stderr tail for diagnostics. */
  error?: string;
}

/** Run a process to completion, return stdout / stderr / exit. */
async function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const to = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch { /* nothing to do */ }
    }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    p.on("close", (code: number | null) => {
      clearTimeout(to);
      res({ stdout, stderr, code });
    });
    p.on("error", () => {
      clearTimeout(to);
      res({ stdout, stderr, code: -1 });
    });
  });
}

/** Resolve remote digest via `docker manifest inspect`. */
export async function probeRemoteDigest(
  imageRef: string,
  dockerBin = "docker",
): Promise<ProbeResult> {
  const r = await run(
    dockerBin,
    ["manifest", "inspect", "--verbose", imageRef],
    30_000,
  );
  if (r.code !== 0) {
    return {
      digest: null,
      error: r.stderr.trim().split("\n").slice(-3).join(" | "),
    };
  }
  try {
    const parsed = JSON.parse(r.stdout);
    if (Array.isArray(parsed)) {
      // Manifest list — `docker pull` of the tag resolves to the
      // platform-matched entry; use the first entry's Descriptor as
      // the comparator. (Docker doesn't expose the list-digest via
      // this command, but the per-platform digest is stable and
      // matches what `RepoDigests` records locally after a pull.)
      const first = parsed[0];
      if (first?.Descriptor?.digest) return { digest: first.Descriptor.digest };
      return { digest: null, error: "manifest list missing Descriptor.digest" };
    }
    if (parsed?.Descriptor?.digest) return { digest: parsed.Descriptor.digest };
    return { digest: null, error: "manifest response missing Descriptor.digest" };
  } catch (e) {
    return { digest: null, error: (e as Error).message };
  }
}

/** Resolve local digest via `docker image inspect`. */
export async function probeLocalDigest(
  imageRef: string,
  dockerBin = "docker",
): Promise<ProbeResult> {
  const r = await run(
    dockerBin,
    ["image", "inspect", "--format", "{{json .RepoDigests}}|{{.Id}}", imageRef],
    10_000,
  );
  if (r.code !== 0) {
    return {
      digest: null,
      error: r.stderr.trim().split("\n").slice(-3).join(" | "),
    };
  }
  const out = r.stdout.trim();
  const sep = out.indexOf("|");
  const repoDigestsJson = sep >= 0 ? out.slice(0, sep) : "";
  const id = sep >= 0 ? out.slice(sep + 1) : out;
  try {
    const repoDigests = repoDigestsJson
      ? (JSON.parse(repoDigestsJson) as string[] | null)
      : null;
    if (repoDigests && repoDigests.length > 0) {
      // `repo@sha256:<hex>` — keep the digest half so we can compare
      // against the remote manifest digest directly.
      const at = repoDigests[0].lastIndexOf("@");
      if (at >= 0) return { digest: repoDigests[0].slice(at + 1) };
    }
    if (id) return { digest: id };
    return { digest: null, error: "no RepoDigests or Id" };
  } catch (e) {
    return { digest: null, error: (e as Error).message };
  }
}

/** Build a release `checkFn` that compares remote vs local digest. */
export function makeReleaseCheck(opts: {
  imageRef: string;
  dockerBin?: string;
  log?: (m: string) => void;
}) {
  return async () => {
    const [remote, local] = await Promise.all([
      probeRemoteDigest(opts.imageRef, opts.dockerBin),
      probeLocalDigest(opts.imageRef, opts.dockerBin),
    ]);
    if (!remote.digest) {
      throw new Error(`remote digest probe failed: ${remote.error ?? "unknown"}`);
    }
    if (!local.digest) {
      // Local image absent: treat as "available" so the watcher pulls
      // for the first time. Operators who don't want this behaviour
      // can set apply_on_detect=false to gate on operator review.
      if (opts.log)
        opts.log(
          `local image absent for ${opts.imageRef} — treating as release available`,
        );
      return { available: true, version: remote.digest };
    }
    return {
      available: remote.digest !== local.digest,
      version: remote.digest,
    };
  };
}

/** Build an `applyFn` that runs `switchroom update`. */
export function makeApply(switchroomBin: string) {
  return async () => {
    const r = await run(switchroomBin, ["update"], 30 * 60_000); // 30m ceiling
    if (r.code !== 0) {
      throw new Error(
        `switchroom update failed (exit ${r.code}): ${r.stderr.trim().slice(-500)}`,
      );
    }
  };
}

/** Build a `restartFn` that runs `switchroom restart all` (graceful). */
export function makeRestart(switchroomBin: string) {
  return async () => {
    const r = await run(switchroomBin, ["restart", "all"], 5 * 60_000); // 5m ceiling
    if (r.code !== 0) {
      throw new Error(
        `switchroom restart all failed (exit ${r.code}): ${r.stderr.trim().slice(-500)}`,
      );
    }
  };
}
