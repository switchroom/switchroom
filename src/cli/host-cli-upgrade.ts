/**
 * `switchroom host-cli-upgrade` — replace a host operator CLI binary that is
 * NOT the running process (#4585).
 *
 * ## Why this verb exists
 *
 * `switchroom update`'s `self-update-cli` step upgrades the binary it is
 * ITSELF running from, and returns early for anything that is not a
 * `static-binary` — including, deliberately, every in-container run
 * (`detectInstallKind` → `"container"`). That is correct for `update`: a
 * container's CLI comes from its image.
 *
 * The host-CLI-first rollout gate (#4571) created a case that shape cannot
 * serve. An agent-initiated roll runs inside hostd, observes (via
 * `~/.switchroom/host-cli.json`) that the HOST binary is behind the target,
 * and refuses — naming a remedy only a human at a host terminal could
 * perform. hostd mounts no host bindir, so the refusal was the only honest
 * action available to it.
 *
 * This verb is the missing half: given an EXPLICIT path to a host binary
 * (bind-mounted into a short-lived helper container by
 * `./host-cli-heal.ts`), it runs the same checksum-verified,
 * prove-then-swap sequence `switchroom update` runs, against that path
 * instead of `process.execPath`. The judgement call ("should we go to this
 * pin") already happened when the operator tapped the approval card; what is
 * left is mechanical and verifiable.
 *
 * ## What it deliberately does NOT do
 *
 * - It does not touch `~/.switchroom/host-cli.json`. The helper container is
 *   given the binary tree and nothing else — the stamp is rewritten by the
 *   rollout process inside hostd, which already mounts `~/.switchroom` and is
 *   the sanctioned writer there. Keeping the vault out of the helper's mount
 *   set is worth the extra hop.
 * - It does not guess the path. No stamp read, no `$PATH` search: the caller
 *   passes `--binary`, and anything that is not an existing regular file
 *   named `switchroom` is refused.
 * - It does not fall back to "unverified install". Every failure after the
 *   download leaves the original binary untouched (that invariant belongs to
 *   `performSelfUpdate`, which throws rather than half-installing).
 */

import { chownSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Command } from "commander";
import {
  payloadVersionDir,
  performSelfUpdate,
  releaseAssetName,
  type SelfUpdateIO,
} from "./self-update.js";
import { defaultSelfUpdateIO } from "./self-update-io.js";
import { payloadInstallRoot } from "../util/shipped-assets.js";

/**
 * Sentinel prefix for the machine-readable result line. The caller
 * (`host-cli-heal.ts`, reading `docker logs`) parses this rather than
 * scraping prose, and takes the PROVEN version from it rather than assuming
 * the pin landed.
 */
export const HOST_CLI_UPGRADE_SENTINEL = "SWITCHROOM_HOST_CLI_UPGRADE:";

export interface HostCliUpgradeResult {
  ok: boolean;
  /** Version now on disk, proven by running the swapped binary. */
  version?: string;
  binaryPath?: string;
  error?: string;
}

export function encodeHostCliUpgradeResult(r: HostCliUpgradeResult): string {
  return `${HOST_CLI_UPGRADE_SENTINEL}${JSON.stringify(r)}`;
}

/** Parse the sentinel out of a log blob. Returns null when absent/malformed. */
export function parseHostCliUpgradeResult(
  logs: string,
): HostCliUpgradeResult | null {
  const lines = logs.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (!line.startsWith(HOST_CLI_UPGRADE_SENTINEL)) continue;
    try {
      const o = JSON.parse(line.slice(HOST_CLI_UPGRADE_SENTINEL.length)) as
        | Record<string, unknown>
        | null;
      if (typeof o !== "object" || o === null) return null;
      if (typeof o.ok !== "boolean") return null;
      return {
        ok: o.ok,
        ...(typeof o.version === "string" ? { version: o.version } : {}),
        ...(typeof o.binaryPath === "string" ? { binaryPath: o.binaryPath } : {}),
        ...(typeof o.error === "string" ? { error: o.error } : {}),
      };
    } catch {
      return null;
    }
  }
  return null;
}

const SEMVER_TAG_RE = /^v\d+\.\d+\.\d+$/;

export interface HostCliUpgradeIo {
  /** True when `path` is an existing regular file. */
  isFile: (path: string) => boolean;
  /** True when `path` exists at all (file, dir or symlink). */
  exists: (path: string) => boolean;
  /** uid/gid of `path`, or undefined when unreadable. */
  owner: (path: string) => { uid: number; gid: number } | undefined;
  chown: (path: string, uid: number, gid: number) => void;
  /** Entry names in `dir`; `[]` when unreadable. */
  list: (dir: string) => string[];
  selfUpdate: SelfUpdateIO;
  /** `process.platform` / `process.arch`, injectable for tests. */
  platform: NodeJS.Platform;
  arch: string;
  /** Effective uid; the ownership handoff only runs as root. */
  getuid: () => number | undefined;
}

function defaultIo(): HostCliUpgradeIo {
  return {
    isFile: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    exists: (p) => existsSync(p),
    owner: (p) => {
      try {
        const st = statSync(p);
        return { uid: st.uid, gid: st.gid };
      } catch {
        return undefined;
      }
    },
    chown: (p, uid, gid) => chownSync(p, uid, gid),
    list: (d) => {
      try {
        return readdirSync(d);
      } catch {
        return [];
      }
    },
    selfUpdate: defaultSelfUpdateIO(),
    platform: process.platform,
    arch: process.arch,
    getuid: () => process.getuid?.(),
  };
}

/**
 * Hand the swapped tree back to whoever owned the binary before the swap.
 *
 * The helper container runs as root; the operator's install tree usually does
 * not (`~/.local/bin`, or a `/usr/local/bin` chowned to the operator so the
 * self-heal timer can rename over it — `docs/operators/host-cli-self-heal.md`
 * § Requirements). Leaving root-owned files behind would break exactly that
 * non-root self-heal path on the NEXT tick, converting a one-off heal into a
 * permanent regression. Same rule as every other root-writes-into-an-operator-
 * tree site in this repo (CLAUDE.md § Root-context editing).
 *
 * Best-effort by construction: a chown failure is reported, never fatal — the
 * binary is already correctly installed at that point.
 */
export function handBackOwnership(
  paths: string[],
  owner: { uid: number; gid: number },
  io: HostCliUpgradeIo,
  depth = 0,
): string[] {
  const failures: string[] = [];
  for (const p of paths) {
    if (!io.exists(p)) continue;
    try {
      io.chown(p, owner.uid, owner.gid);
    } catch (err) {
      failures.push(`${p}: ${(err as Error).message}`);
    }
    // One level of recursion per call, bounded — the trees involved are
    // `<install>/.switchroom-versions/` (flat) and `<prefix>/share/` (a
    // symlink plus versioned dirs), not arbitrary user data.
    if (depth < 3) {
      const children = io.list(p).map((c) => join(p, c));
      if (children.length > 0) {
        failures.push(...handBackOwnership(children, owner, io, depth + 1));
      }
    }
  }
  return failures;
}

export interface HostCliUpgradeOptions {
  /** In-container path of the HOST binary to replace. */
  binary: string;
  /** Target release tag, `vX.Y.Z`. */
  pin: string;
  /** Version currently installed, for the rollback archive's name. */
  from: string;
}

/**
 * Replace `opts.binary` with the `opts.pin` release, verified end to end.
 *
 * Returns a result rather than throwing so the caller always gets a sentinel
 * line on stdout — a helper container that dies with a bare stack trace tells
 * the roll nothing actionable.
 */
export async function runHostCliUpgrade(
  opts: HostCliUpgradeOptions,
  io: HostCliUpgradeIo = defaultIo(),
  log: (s: string) => void = () => {},
): Promise<HostCliUpgradeResult> {
  const { binary, pin, from } = opts;
  if (!SEMVER_TAG_RE.test(pin)) {
    return { ok: false, error: `--pin must be a vX.Y.Z release tag, got "${pin}"` };
  }
  if (!binary.startsWith("/")) {
    return { ok: false, error: `--binary must be an absolute path, got "${binary}"` };
  }
  if (basename(binary) !== "switchroom") {
    return {
      ok: false,
      error:
        `--binary must name a file called \`switchroom\`, got ` +
        `"${basename(binary)}" — refusing to overwrite an unrelated file.`,
    };
  }
  if (!io.isFile(binary)) {
    return {
      ok: false,
      error:
        `${binary} is not an existing regular file — the host bindir is either ` +
        `not mounted or the recorded host CLI path is stale.`,
    };
  }
  const asset = releaseAssetName(io.platform, io.arch);
  if (!asset) {
    return {
      ok: false,
      error: `no published binary for ${io.platform}/${io.arch}`,
    };
  }
  // Capture BEFORE the swap: the new file is created by this (root) process,
  // so its own ownership carries no information about who should own it.
  const priorOwner = io.owner(binary);

  let result;
  try {
    result = await performSelfUpdate({
      plan: {
        action: "update",
        from: `v${from.replace(/^v/, "")}`,
        to: pin,
        binaryPath: binary,
      },
      assetName: asset,
      io: io.selfUpdate,
      log,
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  // Prove the file that is NOW on the host's $PATH answers with the target —
  // `performSelfUpdate` proves the staged candidate, this proves the swap.
  const proven = io.selfUpdate.probeBinaryVersion(binary);
  if (!proven || `v${proven.replace(/^v/, "")}` !== pin) {
    return {
      ok: false,
      error:
        `swapped ${binary} but it reports ${proven ?? "<nothing>"}, not ${pin} — ` +
        `the install did not land. ${result.message}`,
    };
  }

  if (priorOwner && priorOwner.uid !== io.getuid()) {
    const installDir = dirname(binary);
    const failures = handBackOwnership(
      [
        binary,
        join(installDir, ".switchroom-versions"),
        payloadInstallRoot(binary),
        payloadVersionDir(payloadInstallRoot(binary), pin),
      ],
      priorOwner,
      io,
    );
    if (failures.length > 0) {
      log(
        `warning: could not hand ownership back to uid ${priorOwner.uid}: ` +
          `${failures.join("; ")}\n`,
      );
    }
  }

  return { ok: true, version: pin, binaryPath: binary };
}

export function registerHostCliUpgradeCommand(program: Command): void {
  program
    .command("host-cli-upgrade")
    .description(
      "INTERNAL (#4585): replace a bind-mounted HOST switchroom binary with a " +
        "published release, checksum-verified. Spawned by rollout inside a " +
        "short-lived helper container; not for interactive use.",
    )
    .requiredOption("--binary <path>", "Path of the host binary to replace")
    .requiredOption("--pin <version>", "Target release tag, vX.Y.Z")
    .requiredOption("--from <version>", "Version currently installed")
    .action(async (opts: { binary: string; pin: string; from: string }) => {
      const result = await runHostCliUpgrade(opts, defaultIo(), (s) =>
        process.stderr.write(s.endsWith("\n") ? s : `${s}\n`),
      );
      process.stdout.write(`${encodeHostCliUpgradeResult(result)}\n`);
      if (!result.ok) {
        process.stderr.write(`host-cli-upgrade failed: ${result.error}\n`);
        process.exitCode = 1;
      }
    });
}
