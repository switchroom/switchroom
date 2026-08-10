/**
 * Host CLI self-update (#3919).
 *
 * THE GAP THIS CLOSES
 *
 * `switchroom update` updated every switchroom component except the one
 * running the update. On the operator host in July 2026 that left the
 * CLI on 0.19.23 while the fleet ran v0.19.28 — three releases of drift,
 * with no command that would ever close it.
 *
 * That is not cosmetic. `switchroom apply` renders every per-agent
 * scaffold from Handlebars templates that ship INSIDE the installed CLI
 * (`profiles/_base/start.sh.hbs` et al.). A merged feature that adds a
 * template variable is invisible on a host whose CLI is stale, no matter
 * how current the container images are. The CLI is the compiler; the
 * images are the output.
 *
 * ORDERING IS THE WHOLE POINT
 *
 * The self-update step runs FIRST, before `apply-config`. Updating the
 * CLI after applying config would render this run's scaffolds from the
 * OLD templates and then leave a new CLI sitting unused until the next
 * update — precisely the drift, one release later.
 *
 * SELF-REPLACEMENT MECHANICS — why swap-then-re-exec, not swap-in-place
 *
 * A process cannot start executing new code by having its own file
 * overwritten. On Linux the swap itself is safe (the running process
 * holds the old inode open through an atomic `rename(2)`; the old bytes
 * stay readable until exit), but the running process keeps running the
 * OLD code. So after the swap we RE-EXEC the new binary with the rest of
 * the update plan and hand it our exit status. Three consequences worth
 * stating:
 *
 *   1. `rename(2)` within the same directory is atomic, so there is no
 *      window where `switchroom` on $PATH is a truncated file. A crash
 *      mid-download touches nothing: the download lands in a temp file
 *      in the version store and is only renamed into place after its
 *      checksum verifies AND it proves it can execute.
 *   2. We do NOT need the detached-helper trick hostd uses for its own
 *      container recreate (`deploy-v01546.sh`, `self-bump.ts`). That
 *      hazard is specific to a process that is about to `docker compose
 *      up` the container it lives in and get SIGKILLed. The host CLI is
 *      an ordinary host process; nothing in the update kills it. A
 *      detached helper here would only cost us the operator's terminal
 *      (no streamed output, no exit code) for no safety gain.
 *   3. The re-exec is guarded by `SWITCHROOM_SELF_UPDATED=1` in the
 *      child's env plus an explicit `--skip-self-update`, so a binary
 *      that mis-reports its own version cannot re-exec forever.
 *
 * FAILURE MODES, STATED
 *
 *   - Download fails / is truncated / registry 404s → the temp file is
 *     removed and the step FAILS the update before anything else runs.
 *     The installed CLI is byte-identical to before.
 *   - Checksum mismatch → same: refuse, delete, fail. We never install
 *     an unverified binary (this is the supply-chain boundary, and
 *     install.sh already enforces it — we match it).
 *   - The new binary is broken (wrong arch, corrupt, missing runtime) →
 *     caught BEFORE the swap by running `<candidate> version` and
 *     requiring exit 0 with a parseable version. A binary that cannot
 *     print its own version never reaches $PATH.
 *   - Interrupted between the swap and `apply-config` → the host is left
 *     with a NEW CLI and un-applied config. That is a benign state: the
 *     next `switchroom update` (or bare `switchroom apply`) converges,
 *     and it is strictly better than the reverse order, which would
 *     leave scaffolds rendered from templates the operator has already
 *     replaced.
 *   - The new CLI is broken in a way `version` does not catch → the
 *     previous binary is still on disk in the version store. Rollback is
 *     one `cp`, and the step prints the exact command.
 *
 * ROLLBACK
 *
 * Every binary this module installs is kept at
 * `<installDir>/.switchroom-versions/switchroom-<version>`, including
 * the OUTGOING one (copied there before the swap). The store lives
 * inside the install dir so it is guaranteed to be on the same
 * filesystem as the target — that is what makes the final `rename(2)`
 * atomic rather than a copy with a torn-file window. Reverting is:
 *
 *     sudo cp <installDir>/.switchroom-versions/switchroom-<old> <installDir>/switchroom
 *
 * We keep the store rather than a symlink farm because `install.sh`
 * installs a plain regular file at `<installDir>/switchroom`; making the
 * target a symlink would diverge from the installer and be silently
 * clobbered back to a regular file the next time anyone ran it.
 *
 * Everything analysable here is a pure function so it unit-tests without
 * network, docker, or a writable /usr/local/bin.
 */

import { compareReleaseTags } from "../config/release-resolve.js";
import {
  ASSET_MANIFEST_FILENAME,
  parseAssetPayloadManifest,
  payloadInstallRoot,
} from "../util/shipped-assets.js";

export const SELF_UPDATE_ENV_SENTINEL = "SWITCHROOM_SELF_UPDATED";
export const VERSION_STORE_DIRNAME = ".switchroom-versions";
export const GITHUB_LATEST_RELEASE_URL =
  "https://api.github.com/repos/switchroom/switchroom/releases/latest";

/**
 * How this copy of switchroom was installed. Only `static-binary` is
 * self-updatable — it is the artifact `install.sh` publishes and the
 * only one where "replace one file" is the complete update.
 */
export type InstallKind =
  | "static-binary"
  | "npm-global"
  | "source-checkout"
  | "container"
  | "unknown";

export interface InstallProbe {
  /** `import.meta.dirname` of the running bundle. `/$bunfs/root` inside
   *  a `bun build --compile` binary. */
  bundleDir: string;
  /** `process.execPath` — the real on-disk binary for a compiled build. */
  execPath: string;
  /** `process.argv[1]`. */
  scriptPath: string;
  /** True when running inside a switchroom container (agent / hostd). */
  inContainer: boolean;
}

export interface InstallDetection {
  kind: InstallKind;
  /** Path of the file to replace. Only set for `static-binary`. */
  binaryPath?: string;
  /** Operator-facing explanation — printed verbatim when we skip. */
  reason: string;
}

/**
 * Classify the running install.
 *
 * Deliberately conservative: anything we cannot positively identify as a
 * published static binary is left ALONE with a message naming the right
 * upgrade command. Clobbering a maintainer's dev checkout — or writing a
 * host binary into a container layer that gets discarded on the next
 * image pull — is far worse than skipping.
 */
export function detectInstallKind(p: InstallProbe): InstallDetection {
  if (p.inContainer) {
    return {
      kind: "container",
      reason:
        "running inside a switchroom container — the CLI here comes from the " +
        "container image and is updated by pulling a new image, not by " +
        "replacing a file. Nothing to self-update.",
    };
  }
  // A `bun build --compile` binary sees its own bundle at the bunfs
  // virtual root; the real file is process.execPath.
  if (p.bundleDir.startsWith("/$bunfs")) {
    if (!p.execPath) {
      return {
        kind: "unknown",
        reason:
          "compiled binary but process.execPath is empty — cannot locate the " +
          "file to replace. Re-run install.sh to upgrade.",
      };
    }
    return {
      kind: "static-binary",
      binaryPath: p.execPath,
      reason: `published static binary at ${p.execPath}`,
    };
  }
  // node_modules FIRST: an npm install also runs `.../dist/cli/switchroom.js`,
  // so the checkout heuristic below would claim it and hand the operator the
  // wrong remediation command.
  if (/[/\\]node_modules[/\\]switchroom[/\\]/.test(p.scriptPath)) {
    return {
      kind: "npm-global",
      reason:
        "installed via npm — self-update does not manage npm installs. " +
        "Upgrade with `npm i -g switchroom@latest`.",
    };
  }
  if (isSwitchroomSourceCheckoutPath(p.scriptPath)) {
    return {
      kind: "source-checkout",
      reason:
        "running from a switchroom source checkout — self-update would clobber " +
        "your working tree. Upgrade with `git pull && bun install && npm run build`.",
    };
  }
  return {
    kind: "unknown",
    reason:
      `could not identify how switchroom was installed (running from ` +
      `"${p.scriptPath}"). Not touching it. Upgrade with the method you used ` +
      `to install, or re-run install.sh.`,
  };
}

/**
 * Path-only source-checkout test.
 *
 * The reliable signal is a `package.json` naming switchroom beside a
 * `.git`, but this module stays pure (no fs) so it unit-tests without a
 * fixture tree. A path heuristic is sufficient here because it is only
 * ever used to DECLINE: a false positive skips a self-update that could
 * have run (the operator gets a message and a command), while a false
 * negative cannot clobber a checkout — the `/$bunfs` branch above has
 * already claimed every compiled binary, and a checkout never runs one.
 */
function isSwitchroomSourceCheckoutPath(scriptPath: string): boolean {
  return /[/\\](src|dist)[/\\]cli[/\\]switchroom(\.js|\.ts)?$/.test(scriptPath);
}

/**
 * Release asset name for this platform — must match `install.sh`
 * exactly, because it is the same GitHub release assets we fetch.
 */
export function releaseAssetName(
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  const os =
    platform === "linux" ? "linux" : platform === "darwin" ? "macos" : null;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!os || !cpu) return null;
  return `switchroom-${os}-${cpu}`;
}

/**
 * The shipped-asset payload asset name (#4163). Platform-independent — it is
 * a tar.gz of `profiles/`, `skills/`, `vendor/hindsight-memory/` and `ui/`,
 * all of which are text/templates, so one artifact serves all four binaries.
 *
 * UNVERSIONED on purpose, exactly like the four binaries and the checksums
 * file: release assets are already namespaced by the tag in their download
 * URL, and a `${version}` in the filename would give install.sh and
 * self-update a second thing to derive and get wrong. `install.sh` names this
 * literal string and `scripts/release-assets.mjs` derives the contract from
 * it, so a rename fails `npm run lint` before it can fail a release.
 */
export const ASSET_PAYLOAD_ASSET_NAME = "switchroom-assets.tar.gz";

/**
 * Extract `tag_name` from the GitHub `/releases/latest` payload.
 *
 * `/releases/latest` excludes drafts and pre-releases by construction
 * (documented in skills/switchroom-release/SKILL.md), which is exactly
 * the semantics we want: a self-update must never pull a draft.
 */
export function parseLatestReleaseTag(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { tag_name?: unknown; draft?: unknown };
    if (parsed?.draft === true) return null;
    const tag = parsed?.tag_name;
    if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag)) return null;
    return tag;
  } catch {
    return null;
  }
}

/**
 * Look up an asset's expected SHA256 in the release's
 * `switchroom-checksums.txt` (canonical `<hash>  <file>` format).
 * Fixed-string match on the two-space-prefixed asset name, mirroring the
 * hardening install.sh already carries.
 */
export function expectedChecksum(
  checksumsText: string,
  asset: string,
): string | null {
  for (const line of checksumsText.split("\n")) {
    const idx = line.indexOf(`  ${asset}`);
    if (idx <= 0) continue;
    // The asset name must terminate the line — otherwise
    // `switchroom-linux-amd64` would match `switchroom-linux-amd64.sig`.
    if (line.slice(idx + 2).trim() !== asset) continue;
    const hash = line.slice(0, idx).trim();
    if (/^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  return null;
}

/** What the self-update step decided to do. */
export type SelfUpdateAction =
  | { action: "skip"; reason: string }
  | { action: "current"; version: string }
  | { action: "update"; from: string; to: string; binaryPath: string };

/**
 * Decide whether to replace the binary. Pure.
 *
 * A NEWER local CLI than the published release is left alone (an
 * operator running an RC / a locally-built binary must not be silently
 * downgraded by a routine update).
 */
export function planSelfUpdate(opts: {
  detection: InstallDetection;
  currentVersion: string;
  latestTag: string | null;
}): SelfUpdateAction {
  const { detection, currentVersion, latestTag } = opts;
  if (detection.kind !== "static-binary" || !detection.binaryPath) {
    return { action: "skip", reason: detection.reason };
  }
  if (!latestTag) {
    return {
      action: "skip",
      reason:
        "could not resolve the latest published release from GitHub " +
        "(offline, rate-limited, or the API changed shape) — leaving the CLI as-is.",
    };
  }
  const current = `v${currentVersion.trim().replace(/^v/, "")}`;
  const cmp = compareReleaseTags(current, latestTag);
  if (cmp === null) {
    return {
      action: "skip",
      reason:
        `local CLI version "${currentVersion}" is not a comparable semver — ` +
        `refusing to guess whether ${latestTag} is an upgrade.`,
    };
  }
  if (cmp >= 0) return { action: "current", version: current };
  return {
    action: "update",
    from: current,
    to: latestTag,
    binaryPath: detection.binaryPath,
  };
}

/**
 * Where a given version's binary is archived. Inside the install dir so
 * the final install is a same-filesystem atomic rename.
 */
export function versionStorePath(
  installDir: string,
  version: string,
  sep = "/",
): string {
  return `${installDir}${sep}${VERSION_STORE_DIRNAME}${sep}switchroom-${version.replace(/^v/, "")}`;
}

/** Operator-facing rollback instruction for a completed swap. */
export function rollbackHint(installDir: string, previousVersion: string): string {
  return (
    `Rollback: cp ${versionStorePath(installDir, previousVersion)} ` +
    `${installDir}/switchroom`
  );
}

/**
 * True when this process is itself the child of a self-update re-exec —
 * the loop guard. Also honoured when the operator passes
 * `--skip-self-update` explicitly.
 */
export function alreadySelfUpdated(env: NodeJS.ProcessEnv): boolean {
  return env[SELF_UPDATE_ENV_SENTINEL] === "1";
}

// ─── execution ───────────────────────────────────────────────────────────
//
// Every side effect is behind this interface so the whole download →
// verify → prove → swap sequence is exercisable in a unit test with an
// in-memory filesystem and no network.

/**
 * The outcome of executing a candidate binary to ask it its version.
 *
 * The `kind` split is the whole point. Before #4586's follow-up the probe
 * returned `string | null`, so THREE different situations arrived at the
 * caller as the same `null`:
 *
 *  - the artifact is genuinely broken (wrong arch, unloadable runtime),
 *  - the artifact is fine but this process could not EXEC it where it was
 *    staged (a `noexec` staging mount, a lost +x bit, ENOEXEC under an
 *    emulated arch),
 *  - the artifact ran fine but the command we chose to run needed something
 *    the environment does not have.
 *
 * Only the first is "do not install this binary". The other two are
 * environment faults, and reporting them as a bad download sends the
 * operator to re-download an artifact that was never the problem — which is
 * exactly the wrong-remedy dead end this type exists to prevent.
 */
export type BinaryProbe =
  | { ok: true; version: string }
  | {
      ok: false;
      /**
       * `not-executable` — the exec never happened or the process was killed
       * by a signal (EACCES from a `noexec` mount or a missing +x bit,
       * ENOEXEC, ENOENT). Says nothing about the artifact's integrity.
       *
       * `ran-but-failed` — the binary executed and exited non-zero. THIS is
       * the one that indicts the artifact, provided the probe command is one
       * that cannot fail for environmental reasons (see
       * `defaultSelfUpdateIO().probeBinary`).
       *
       * `no-version` — exited 0 but printed nothing that parses as a semver.
       */
      kind: "not-executable" | "ran-but-failed" | "no-version";
      /** One bounded line naming the errno / exit code / output. */
      detail: string;
    };

/**
 * Operator-facing prose for a failed probe, phrased per {@link BinaryProbe}
 * `kind` so the remedy the reader acts on is the right one.
 *
 * Shared by `performSelfUpdate` (probing the freshly downloaded candidate)
 * and `host-cli-upgrade` (probing the binary after the swap) so the two can
 * never disagree about what a probe failure means.
 */
export function describeBinaryProbeFailure(opts: {
  probe: Extract<BinaryProbe, { ok: false }>;
  /** Path that was probed. */
  path: string;
  /** What the probed file is, for the sentence subject. */
  subject: string;
}): string {
  const { probe, path, subject } = opts;
  switch (probe.kind) {
    case "not-executable":
      return (
        `could not EXECUTE ${subject} at ${path} (${probe.detail}). This is a ` +
        `property of WHERE it was staged, not of the artifact — the usual causes ` +
        `are a staging directory mounted \`noexec\`, a lost execute bit, or an ` +
        `architecture this kernel cannot run. The download's sha256 already ` +
        `matched the release's checksums file, so re-downloading will not help.`
      );
    case "ran-but-failed":
      return (
        `${subject} at ${path} ran but exited non-zero for \`--version\` ` +
        `(${probe.detail}) — the artifact itself is faulty.`
      );
    case "no-version":
      return (
        `${subject} at ${path} ran and exited 0 but printed no parseable version ` +
        `(${probe.detail}) — the artifact itself is faulty.`
      );
  }
}

export interface SelfUpdateIO {
  /** GET a URL as text. Throws on non-2xx. */
  httpGetText(url: string): Promise<string>;
  /** GET a URL and write the body to `dest`. Throws on non-2xx. */
  httpDownload(url: string, dest: string): Promise<void>;
  /** Lowercase hex SHA256 of a file. */
  sha256File(path: string): string;
  /**
   * Execute `<path>` and read back the version it reports.
   *
   * Returns a THREE-state answer, not a boolean-ish `string | null`, because
   * "the binary is bad" and "we could not execute it here" demand opposite
   * remedies and conflating them is what dead-ended a real roll (#4586 →
   * this fix). See {@link BinaryProbe}.
   */
  probeBinary(path: string): BinaryProbe;
  mkdirp(dir: string): void;
  copyFile(src: string, dest: string): void;
  chmodExec(path: string): void;
  /** Atomic same-filesystem rename. */
  rename(src: string, dest: string): void;
  remove(path: string): void;
  exists(path: string): boolean;
  dirname(path: string): string;

  // ── shipped-asset payload (#4163) ──────────────────────────────────
  /** Read a UTF-8 file, or null when it cannot be read. */
  readText(path: string): string | null;
  /** Extract a .tar.gz into `destDir` (created if absent). */
  extractTarGz(archive: string, destDir: string): void;
  /** Create a symlink at `linkPath` pointing at `target`. */
  symlink(target: string, linkPath: string): void;
  /** True when `path` is itself a symlink (does NOT follow it). */
  isSymlink(path: string): boolean;
  /** Recursive remove. No-op when absent. */
  removeTree(path: string): void;
  /** Entry names in `dir`, or [] when it cannot be listed. */
  listDir(dir: string): string[];
}

export interface SelfUpdateResult {
  /** True when the on-disk binary was replaced (caller must re-exec). */
  replaced: boolean;
  /** Human line for the update log. */
  message: string;
  /** New version, when replaced. */
  newVersion?: string;
  /** Path of the (now new) binary, when replaced. */
  binaryPath?: string;
  /** Outcome of the shipped-asset payload install that preceded the swap. */
  payload?: AssetPayloadResult;
}

/**
 * Resolve the latest published release tag. Returns null on any failure
 * — a self-update that cannot reach GitHub SKIPS, it does not fail the
 * update (an offline host must still be able to run `switchroom update
 * --skip-images` against local state).
 */
export async function fetchLatestReleaseTag(
  io: Pick<SelfUpdateIO, "httpGetText">,
): Promise<string | null> {
  try {
    return parseLatestReleaseTag(await io.httpGetText(GITHUB_LATEST_RELEASE_URL));
  } catch {
    return null;
  }
}

// ─── shipped-asset payload (#4163) ───────────────────────────────────────
//
// THE ATOMICITY PROBLEM, AND WHAT WE ACTUALLY GUARANTEE
//
// The CLI and the templates it renders are two artifacts. No syscall swaps
// two filesystem objects at once, so "atomic" here is a property built out of
// four smaller guarantees, not a claim about one rename:
//
//   1. SAME RELEASE BY CONSTRUCTION. Binary and payload are fetched from one
//      resolved tag's `releases/download/<tag>/` prefix and verified against
//      that release's single `switchroom-checksums.txt`. There is no code
//      path that can pair version A's binary with version B's payload.
//   2. PAYLOAD FIRST, BINARY SECOND. Each is installed with an atomic
//      `rename(2)`, payload before binary. A crash, a SIGKILL or a power cut
//      between them therefore leaves NEW payload + OLD binary — an old CLI
//      reading templates one version ahead — and never the inverse, which is
//      the failure #4163 calls out as worse than the status quo.
//   3. CONVERGENCE, NOT JUST ORDERING. Ordering alone would strand a host
//      whose payload step failed: the next `switchroom update` would see the
//      binary already current and skip everything. So the payload is checked
//      and repaired on EVERY update run, including the "already current" one.
//   4. DETECTION. The payload carries `switchroom-assets.json` naming the
//      release it was cut from; `assetPayloadSkew()` compares it to the
//      running CLI, and `switchroom doctor` fails on disagreement.
//
// The payload is installed as a VERSIONED DIRECTORY plus a symlink:
//
//   /usr/local/share/switchroom-0.19.44/   (extracted, verified)
//   /usr/local/share/switchroom -> switchroom-0.19.44   (atomic swap)
//
// `rename(2)` cannot replace a non-empty directory, but it CAN replace a
// symlink — which is what makes the publish step atomic. A pre-existing real
// directory (a hand-staged one, or an older install) is moved aside once, to
// `<root>.replaced`, so the first upgrade to this scheme is recoverable.

export interface AssetPayloadResult {
  /** True when the payload on disk was replaced. */
  installed: boolean;
  /** Payload version now on disk. */
  version: string;
  /** The symlink path the CLI resolves through. */
  root: string;
  message: string;
}

/** Where a version's payload is extracted, beside the symlink root. */
export function payloadVersionDir(root: string, version: string): string {
  return `${root}-${version.replace(/^v/, "")}`;
}

/**
 * Download, verify and install the shipped-asset payload for `tag`.
 *
 * THROWS on every failure. A binary without its payload cannot scaffold a
 * single agent, so a payload that cannot be installed is a failed update, not
 * a warning — that is the whole lesson of #4161.
 *
 * Idempotent: when the payload already on disk reports `tag`, nothing is
 * downloaded and `installed` is false.
 */
export async function installAssetPayload(opts: {
  /** Release tag to install, e.g. `v0.19.44`. */
  tag: string;
  /** Path of the installed binary; the payload root is derived from it. */
  binaryPath: string;
  io: SelfUpdateIO;
  /** Pre-fetched checksums text, to avoid a second GET in the update path. */
  checksumsText?: string;
  /** Force a reinstall even when the on-disk version already matches. */
  force?: boolean;
  log?: (s: string) => void;
}): Promise<AssetPayloadResult> {
  const { tag, binaryPath, io } = opts;
  const log = opts.log ?? (() => {});
  const wanted = `v${tag.replace(/^v/, "")}`;
  const root = payloadInstallRoot(binaryPath);
  const parent = io.dirname(root);
  const versionDir = payloadVersionDir(root, wanted);

  if (!opts.force) {
    const current = readPayloadVersion(io, root);
    if (current === wanted) {
      return {
        installed: false,
        version: wanted,
        root,
        message: `shipped-asset payload already ${wanted} at ${root}`,
      };
    }
  }

  const base = `https://github.com/switchroom/switchroom/releases/download/${wanted}`;
  const tmpArchive = `${versionDir}.download.tar.gz`;
  const incoming = `${versionDir}.incoming`;

  io.mkdirp(parent);
  io.remove(tmpArchive);
  io.removeTree(incoming);

  log(`downloading ${ASSET_PAYLOAD_ASSET_NAME} ${wanted}`);
  try {
    await io.httpDownload(`${base}/${ASSET_PAYLOAD_ASSET_NAME}`, tmpArchive);
  } catch (err) {
    io.remove(tmpArchive);
    throw new Error(
      `self-update: download of ${base}/${ASSET_PAYLOAD_ASSET_NAME} failed ` +
        `(${(err as Error).message}). The shipped-asset payload (profiles, skills, ` +
        `vendor) is what \`switchroom apply\` scaffolds from, so the update stops ` +
        `here rather than leave a CLI that cannot scaffold. Nothing was changed.`,
    );
  }

  // Same supply-chain boundary as the binary: never unpack an unverified
  // archive. The payload contains shell templates that end up executing as
  // every agent's container entrypoint.
  let checksums: string;
  if (opts.checksumsText !== undefined) {
    checksums = opts.checksumsText;
  } else {
    try {
      checksums = await io.httpGetText(`${base}/switchroom-checksums.txt`);
    } catch (err) {
      io.remove(tmpArchive);
      throw new Error(
        `self-update: could not fetch switchroom-checksums.txt for ${wanted} ` +
          `(${(err as Error).message}) — refusing to unpack an unverified asset ` +
          `payload. Nothing was changed.`,
      );
    }
  }
  const expected = expectedChecksum(checksums, ASSET_PAYLOAD_ASSET_NAME);
  if (!expected) {
    io.remove(tmpArchive);
    throw new Error(
      `self-update: release ${wanted} has no checksum entry for ` +
        `${ASSET_PAYLOAD_ASSET_NAME}. Either the release predates the asset ` +
        `payload (#4163) or it is incomplete — refusing to unpack it. Nothing ` +
        `was changed.`,
    );
  }
  const actual = io.sha256File(tmpArchive).toLowerCase();
  if (actual !== expected) {
    io.remove(tmpArchive);
    throw new Error(
      `self-update: SHA256 mismatch for ${ASSET_PAYLOAD_ASSET_NAME} (expected ` +
        `${expected}, got ${actual}) — refusing to unpack. Nothing was changed.`,
    );
  }

  try {
    io.extractTarGz(tmpArchive, incoming);
  } catch (err) {
    io.remove(tmpArchive);
    io.removeTree(incoming);
    throw new Error(
      `self-update: could not unpack ${ASSET_PAYLOAD_ASSET_NAME} into ${incoming} ` +
        `(${(err as Error).message}). Nothing was changed.`,
    );
  }
  io.remove(tmpArchive);

  // Prove the archive really is this release's payload before it can become
  // the templates every agent boots from — the payload equivalent of running
  // `<candidate> version` on the binary.
  const unpacked = parseAssetPayloadManifest(
    io.readText(`${incoming}/${ASSET_MANIFEST_FILENAME}`) ?? "",
  );
  if (!unpacked || unpacked.version !== wanted) {
    io.removeTree(incoming);
    throw new Error(
      `self-update: the ${wanted} asset payload unpacked with version ` +
        `${unpacked?.version ?? "<none>"} in ${ASSET_MANIFEST_FILENAME} — refusing ` +
        `to install a payload that does not match the release it came from. ` +
        `Nothing was changed.`,
    );
  }

  io.removeTree(versionDir);
  io.rename(incoming, versionDir);

  // ── the publish step: one atomic rename over the symlink ──────────────
  if (io.exists(root) && !io.isSymlink(root)) {
    // First upgrade from a hand-staged / pre-#4163 real directory. Moved
    // aside rather than deleted so an operator who staged something there
    // can get it back; only ONE such copy is ever kept.
    const aside = `${root}.replaced`;
    io.removeTree(aside);
    io.rename(root, aside);
    log(`moved the pre-existing ${root} aside to ${aside}`);
  }
  const linkTmp = `${root}.new-link`;
  io.remove(linkTmp);
  io.symlink(basenameOf(versionDir), linkTmp);
  io.rename(linkTmp, root);

  prunePayloadVersions(io, root, wanted);

  return {
    installed: true,
    version: wanted,
    root,
    message: `shipped-asset payload ${wanted} installed at ${root} -> ${basenameOf(versionDir)}`,
  };
}

/** Payload version currently published at `root`, or null. */
export function readPayloadVersion(
  io: Pick<SelfUpdateIO, "readText">,
  root: string,
): string | null {
  const body = io.readText(`${root}/${ASSET_MANIFEST_FILENAME}`);
  if (body === null) return null;
  return parseAssetPayloadManifest(body)?.version ?? null;
}

function basenameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/**
 * Keep the live payload and ONE previous version (so a binary rollback still
 * has templates to render from), delete the rest. Unbounded growth would add
 * ~7 MB per release to `/usr/local/share` forever.
 */
function prunePayloadVersions(
  io: SelfUpdateIO,
  root: string,
  keepVersion: string,
): void {
  const parent = io.dirname(root);
  const prefix = `${basenameOf(root)}-`;
  const versions = io
    .listDir(parent)
    .filter((n) => n.startsWith(prefix) && /^\d+\.\d+\.\d+$/.test(n.slice(prefix.length)))
    .map((n) => n.slice(prefix.length))
    .sort((a, b) => compareReleaseTags(`v${a}`, `v${b}`) ?? 0);
  const keep = new Set([keepVersion.replace(/^v/, "")]);
  const previous = versions.filter((v) => !keep.has(v)).pop();
  if (previous) keep.add(previous);
  for (const v of versions) {
    if (!keep.has(v)) io.removeTree(`${parent}/${prefix}${v}`);
  }
}

/**
 * Download, verify, prove, and atomically install the target release's
 * binary. THROWS on every failure after the decision to update — at that
 * point the operator has been told an upgrade is happening, and silently
 * continuing on a stale CLI is the bug this PR exists to kill.
 *
 * Invariant: `binaryPath` is either the untouched original or a fully
 * verified new binary. There is no intermediate state.
 */
export async function performSelfUpdate(opts: {
  plan: Extract<SelfUpdateAction, { action: "update" }>;
  assetName: string;
  io: SelfUpdateIO;
  log?: (s: string) => void;
}): Promise<SelfUpdateResult> {
  const { plan, assetName, io } = opts;
  const log = opts.log ?? (() => {});
  const installDir = io.dirname(plan.binaryPath);
  const store = `${installDir}/${VERSION_STORE_DIRNAME}`;
  const base = `https://github.com/switchroom/switchroom/releases/download/${plan.to}`;
  const staged = versionStorePath(installDir, plan.to);
  const tmp = `${staged}.download`;

  io.mkdirp(store);
  io.remove(tmp);

  log(`downloading ${assetName} ${plan.to}`);
  try {
    await io.httpDownload(`${base}/${assetName}`, tmp);
  } catch (err) {
    io.remove(tmp);
    throw new Error(
      `self-update: download of ${base}/${assetName} failed (${(err as Error).message}). ` +
        `The installed CLI is unchanged.`,
    );
  }

  // Supply-chain boundary: never install an unverified binary. Same
  // check install.sh performs, for the same reason.
  let checksums: string;
  try {
    checksums = await io.httpGetText(`${base}/switchroom-checksums.txt`);
  } catch (err) {
    io.remove(tmp);
    throw new Error(
      `self-update: could not fetch switchroom-checksums.txt for ${plan.to} ` +
        `(${(err as Error).message}) — refusing to install an unverified binary. ` +
        `The installed CLI is unchanged.`,
    );
  }
  const expected = expectedChecksum(checksums, assetName);
  if (!expected) {
    io.remove(tmp);
    throw new Error(
      `self-update: release ${plan.to} has no checksum entry for ${assetName} — ` +
        `refusing to install an unverified binary. The installed CLI is unchanged.`,
    );
  }
  const actual = io.sha256File(tmp).toLowerCase();
  if (actual !== expected) {
    io.remove(tmp);
    throw new Error(
      `self-update: SHA256 mismatch for ${assetName} (expected ${expected}, got ${actual}) — ` +
        `refusing to install. The installed CLI is unchanged.`,
    );
  }
  io.chmodExec(tmp);

  // Prove the candidate RUNS before it can become `switchroom` on
  // $PATH. Catches an arch mismatch, a truncated-but-correctly-hashed
  // artifact (impossible, but cheap to exclude), and a binary whose
  // bundled runtime this host cannot load. A CLI that cannot print its
  // own version must never reach the operator's PATH.
  //
  // The check is never SKIPPED, whatever the probe says — an unproven binary
  // does not get installed. But the message distinguishes "the artifact is
  // bad" from "we could not run it here", because the remedies are opposite.
  const proved = io.probeBinary(tmp);
  if (!proved.ok) {
    io.remove(tmp);
    throw new Error(
      `self-update: ${describeBinaryProbeFailure({
        probe: proved,
        path: tmp,
        subject: `the downloaded ${plan.to} binary`,
      })} Refusing to install it. The installed CLI is unchanged.`,
    );
  }

  // ── payload BEFORE binary (#4163) ──────────────────────────────────
  // Both artifacts come from `plan.to` and are verified against the same
  // `checksums` text fetched above, so they cannot be mismatched versions.
  // Installing the payload first means an interruption between the two
  // atomic renames leaves new-templates/old-CLI, never new-CLI/old-templates.
  const payload = await installAssetPayload({
    tag: plan.to,
    binaryPath: plan.binaryPath,
    io,
    checksumsText: checksums,
    log,
  });
  log(payload.message);

  // Archive the OUTGOING binary before the swap so rollback is a copy.
  const previousArchive = versionStorePath(installDir, plan.from);
  try {
    if (!io.exists(previousArchive)) io.copyFile(plan.binaryPath, previousArchive);
  } catch (err) {
    io.remove(tmp);
    throw new Error(
      `self-update: could not archive the current binary to ${previousArchive} ` +
        `(${(err as Error).message}) — refusing to swap without a rollback copy. ` +
        `The installed CLI is unchanged.`,
    );
  }

  // Keep the verified artifact in the store under its version, then
  // install it. Both renames are same-filesystem (the store is a
  // subdirectory of the install dir), so each is atomic: `switchroom`
  // on $PATH is never a partially-written file.
  io.rename(tmp, staged);
  io.copyFile(staged, `${plan.binaryPath}.new`);
  io.chmodExec(`${plan.binaryPath}.new`);
  io.rename(`${plan.binaryPath}.new`, plan.binaryPath);

  log(rollbackHint(installDir, plan.from));
  return {
    replaced: true,
    newVersion: plan.to,
    binaryPath: plan.binaryPath,
    payload,
    message:
      `host CLI ${plan.from} → ${plan.to} (verified sha256, ran clean; ` +
      `asset payload ${payload.version}). ` +
      rollbackHint(installDir, plan.from),
  };
}
