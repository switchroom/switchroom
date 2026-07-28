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

export interface SelfUpdateIO {
  /** GET a URL as text. Throws on non-2xx. */
  httpGetText(url: string): Promise<string>;
  /** GET a URL and write the body to `dest`. Throws on non-2xx. */
  httpDownload(url: string, dest: string): Promise<void>;
  /** Lowercase hex SHA256 of a file. */
  sha256File(path: string): string;
  /** Run `<path> version` and return the printed version, or null when
   *  the binary does not exit 0 / prints nothing parseable. */
  probeBinaryVersion(path: string): string | null;
  mkdirp(dir: string): void;
  copyFile(src: string, dest: string): void;
  chmodExec(path: string): void;
  /** Atomic same-filesystem rename. */
  rename(src: string, dest: string): void;
  remove(path: string): void;
  exists(path: string): boolean;
  dirname(path: string): string;
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
  const proved = io.probeBinaryVersion(tmp);
  if (!proved) {
    io.remove(tmp);
    throw new Error(
      `self-update: the downloaded ${plan.to} binary did not run cleanly on this host ` +
        `(\`switchroom version\` failed) — refusing to install it. The installed CLI is unchanged.`,
    );
  }

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
    message:
      `host CLI ${plan.from} → ${plan.to} (verified sha256, ran clean). ` +
      rollbackHint(installDir, plan.from),
  };
}
