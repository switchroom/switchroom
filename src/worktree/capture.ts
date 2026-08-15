/**
 * worktree capture — turn a checkout into a VERIFIED git bundle before anyone
 * deletes it.
 *
 * WHY THIS EXISTS
 * ---------------
 * 2026-08-15: a fleet host hit 85% root-disk full and 41 stale checkouts were
 * deleted to reclaim it. That deletion was only safe because of a bash script
 * written by hand that morning and thrown away afterwards. `worktree gc
 * --reclaim-dirty` quarantines by MOVING a directory, which is an undo only
 * until someone runs `--purge-trash`; after that the work is gone and the
 * disk is the only copy that ever existed.
 *
 * The naive rescue — `git bundle create <file> --all` — is a trap. `--all`
 * does not carry:
 *
 *   1. Uncommitted working-tree changes  — not in any ref.
 *   2. Untracked files                   — likewise.
 *   3. Stash entries below `stash@{0}`   — `refs/stash` itself IS included by
 *      `--all` on modern git (verified on 2.47.3: `git bundle list-heads` of
 *      an `--all` bundle lists `refs/stash`), but the older entries hang off
 *      the stash REFLOG, and bundles carry no reflogs. Everything below the
 *      top of the stash is dropped silently.
 *   4. Unreachable / dangling commits    — from local amends and rebases that
 *      never left the box. Invisible to `git status` (which calls the tree
 *      CLEAN) and invisible to "is HEAD pushed?" (which says YES). Measured on
 *      the reference fleet: 5,703 / 5,395 / 5,449 / 760 unreachable commits in
 *      four such trees — ~12k commits an `--all` bundle would have dropped
 *      without a word.
 *
 * Add to that: commits held ONLY by a reflog. `git fsck --unreachable` treats
 * reflogs as roots, so it does NOT report them — but a bundle has no reflogs,
 * so they die with the directory. This module passes `--no-reflogs` so they
 * are rescued too.
 *
 * HOW IT WORKS — the source repo is never written to
 * --------------------------------------------------
 * Rescuing an unreachable commit means putting a REF on it (a bundle tip must
 * be nameable, and `git clone`/`fetch` can only retrieve named refs), and
 * capturing the working tree means writing blobs and a commit. Doing that in
 * the source repo would mean a "capture" verb that mutates 12,000 refs into a
 * repo the operator may well decide to keep — acceptable in a throwaway bash
 * script that runs seconds before `rm -rf`, NOT acceptable in a general
 * purpose verb whose primary mode captures WITHOUT deleting.
 *
 * So every write goes to a disposable bare STAGING repo that borrows the
 * source's object database through `objects/info/alternates`:
 *
 *   - source repo  → only read commands (`rev-parse`, `for-each-ref`, `fsck`,
 *     `rev-list -g`). Its refs, its index, and its HEAD are untouched.
 *   - staging repo → gets every source ref recreated verbatim, plus the
 *     rescued refs, plus the new working-tree snapshot commit. `git add -A`
 *     runs with `--git-dir` pointing at staging, so both the new blobs and
 *     the index land there and the source index is never mutated. (The
 *     briefing's `GIT_INDEX_FILE` idea solves half of this — the index — but
 *     still writes refs into the source repo. Relocating the whole git dir
 *     solves all of it.)
 *   - the bundle is created from staging; staging is then deleted. The rescued
 *     refs and the snapshot commit exist only inside the bundle.
 *
 * VERIFICATION — `git bundle verify` is necessary and NOT sufficient
 * -----------------------------------------------------------------
 * `git bundle verify` only parses the header and checks that the bundle's
 * PREREQUISITES exist locally. It never reads the pack. Measured on 2.47.3:
 * a bundle truncated to its first 200 bytes, and a bundle with one flipped
 * byte inside the pack, BOTH verify "is okay" with exit 0 — while a readback
 * fails with `index-pack died` / `pack has bad object at offset 1864`. Gating
 * a deletion on `bundle verify` alone would therefore have deleted a checkout
 * against an unreadable bundle.
 *
 * The gate here is both halves, and deletion is impossible unless BOTH pass:
 *   1. `git bundle verify` — header sanity + no unmet prerequisites.
 *   2. READBACK: `git fetch <bundle> 'refs/*:refs/*'` into a fresh empty bare
 *      repo, then assert the recovered ref set equals the intended ref set.
 *      This forces git to index the whole pack (checksum included) and proves
 *      the refs actually arrive — an outcome, not a code path.
 *
 * A directory that is not a git repository at all is NOT half-handled: it is
 * refused with an explicit message, because a "bundle" verb that silently
 * produces a tarball with weaker verification semantics would be a lie.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gitArgs, describeExecFailure } from "./gc.js";
import { detectCheckoutKind } from "./remove-checkout.js";
import {
  resolveScratchConfig,
  scratchVolumeAvailable,
} from "../agents/scratch.js";
import { loadConfig } from "../config/loader.js";

// ── constants ───────────────────────────────────────────────────────────────

/** Ref namespace every rescued (otherwise unnameable) tip is filed under. */
export const RESCUE_NS = "refs/rescued";

/**
 * Branch the working-tree snapshot is filed under.
 *
 * A BRANCH (`refs/heads/…`), not `refs/rescued/wip`, and deliberately so:
 * `git clone <bundle>` only fetches `refs/heads/*` and `refs/tags/*`, so a
 * snapshot parked outside `refs/heads` would be invisible to the restore
 * command an operator reaches for first. Staging's HEAD is pointed at it, so
 * a plain clone checks the rescued tree straight out.
 */
export const WIP_BRANCH = "refs/heads/rescued-wip";

/** Where bundles land under the bulk volume / the switchroom home. */
export const RESCUE_SUBDIR = "switchroom/rescue";

/**
 * Identity for the working-tree snapshot commit.
 *
 * `git commit-tree` refuses to run without one, and it is NOT safe to assume
 * the host has a `user.email`: a CI runner, a bare rescue shell, and a fresh
 * container all have none. The snapshot is a machine artefact, not anyone's
 * authorship, so it gets a fixed synthetic identity on an `.invalid` domain
 * (RFC 2606) rather than inventing a human's.
 */
const SNAPSHOT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "switchroom worktree capture",
  GIT_AUTHOR_EMAIL: "capture@switchroom.invalid",
  GIT_COMMITTER_NAME: "switchroom worktree capture",
  GIT_COMMITTER_EMAIL: "capture@switchroom.invalid",
};

/** Generous ceiling: `fsck` over a tree with ~12k unreachable commits. */
const MAX_BUFFER = 256 * 1024 * 1024;

// ── result types ────────────────────────────────────────────────────────────

export type CaptureFailure =
  | "missing"
  | "not-a-directory"
  | "not-a-git-repo"
  | "nothing-to-capture"
  | "bundle-failed"
  | "verify-failed"
  | "readback-failed"
  | "worktree-snapshot-failed"
  | "delete-failed";

export interface CaptureRefCounts {
  /** Refs copied verbatim out of the source repo (heads, tags, remotes, stash). */
  source: number;
  /** `refs/rescued/unreachable/<sha>` — dangling commits fsck found. */
  unreachable: number;
  /** `refs/rescued/stash/<n>` — one per stash reflog entry, newest first. */
  stash: number;
  /** Whether a working-tree snapshot commit was made. */
  wip: boolean;
  /** Total refs written into the bundle. */
  total: number;
}

export interface CaptureResult {
  /** Absolute path of the checkout that was captured. */
  source: string;
  /** Absolute path of the bundle, or null if none was produced. */
  bundle: string | null;
  bytes: number;
  /** True only when BOTH `bundle verify` and the readback assertion passed. */
  verified: boolean;
  refs: CaptureRefCounts;
  /** Source HEAD: branch name, `detached@<sha>`, or null for an unborn HEAD. */
  head: string | null;
  /** True when the source directory was deleted (requires `verified`). */
  deleted: boolean;
  /** Overall success of the CAPTURE (deletion is reported separately). */
  ok: boolean;
  failure?: CaptureFailure;
  error?: string;
  /** Non-fatal problems (skipped refs, prune failures, …). */
  warnings: string[];
  capturedAt: string;
}

export interface CaptureOptions {
  /** Checkout to capture. */
  dir: string;
  /** Explicit bundle path. Wins over `dest`. */
  out?: string;
  /** Directory to auto-name the bundle inside. Default {@link rescueDestRoot}. */
  dest?: string;
  /** Delete the checkout after a VERIFIED capture. Off by default. */
  deleteAfter?: boolean;
  /** Clock seam for the auto-generated file name. */
  now?: Date;
  /**
   * Fault-injection seam, called with the bundle path the moment git finishes
   * writing it and BEFORE the verification gate runs.
   *
   * It exists so the gate can be tested against a genuinely damaged artefact
   * (truncated / corrupted / short write on a full disk) without waiting for
   * a real disk to fill. Tests assert the production OUTCOME — no deletion,
   * `readback-failed` — not that the hook was called.
   */
  onBundleWritten?: (bundlePath: string) => void;
}

// ── pure helpers (unit-tested directly) ─────────────────────────────────────

/** One `unreachable <type> <sha>` line from `git fsck`. */
export function parseFsckUnreachableCommits(fsckOutput: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of fsckOutput.split("\n")) {
    const parts = raw.trim().split(/\s+/);
    // "unreachable commit <sha>" — field 2 is the object TYPE, and only
    // commits are useful tips. Trees/blobs come along inside them.
    if (parts.length < 3) continue;
    if (parts[0] !== "unreachable" && parts[0] !== "dangling") continue;
    if (parts[1] !== "commit") continue;
    const sha = parts[2]!;
    if (!/^[0-9a-f]{7,64}$/.test(sha)) continue;
    if (seen.has(sha)) continue;
    seen.add(sha);
    out.push(sha);
  }
  return out;
}

/** Parse `git for-each-ref --format='%(objectname) %(refname)'`. */
export function parseForEachRef(output: string): Array<{ sha: string; ref: string }> {
  const out: Array<{ sha: string; ref: string }> = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const sp = line.indexOf(" ");
    if (sp <= 0) continue;
    const sha = line.slice(0, sp);
    const ref = line.slice(sp + 1).trim();
    if (!/^[0-9a-f]{7,64}$/.test(sha) || !ref.startsWith("refs/")) continue;
    out.push({ sha, ref });
  }
  return out;
}

/** `git update-ref --stdin` payload for a batch of ref creations. */
export function updateRefStdin(refs: Array<{ sha: string; ref: string }>): string {
  return refs.map((r) => `create ${r.ref} ${r.sha}`).join("\n") + (refs.length ? "\n" : "");
}

/**
 * Deterministic bundle file name: `<checkout>-<YYYYMMDD-HHMMSS>.bundle`.
 *
 * Local wall-clock, not UTC — an operator reading a rescue directory is
 * matching these against when they ran the sweep.
 */
export function bundleFileName(dir: string, now: Date = new Date()): string {
  const slug = basename(resolve(dir)).replace(/[^A-Za-z0-9._-]+/g, "-") || "checkout";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${slug}-${stamp}.bundle`;
}

/**
 * Default destination for bundles.
 *
 * Order: `SWITCHROOM_RESCUE_DIR` → the bulk volume → `~/.switchroom/rescue`.
 *
 * WHY THE BULK VOLUME, AND WHY NOT `/scratch`. #4723 introduced the bulk
 * volume (`scratch.volume`, default `/mnt/bulkdata`) precisely because the
 * root disk is the thing that fills up. Writing rescue bundles for 41
 * checkouts onto the disk you are trying to reclaim is self-defeating, so the
 * VOLUME is the right default. The per-agent `/scratch` tree on it is NOT:
 * that tree is documented as relocated package CACHES — purgeable by design,
 * and chowned to one agent's container uid, which is exactly the wrong owner
 * and exactly the wrong lifetime for the only surviving copy of someone's
 * work. Rescue bundles get their own sibling directory under the volume.
 *
 * Falls back to the root disk when no volume is mounted (a dev box), and the
 * CLI says so out loud rather than silently doing something surprising.
 */
export function rescueDestRoot(
  /**
   * Config seam. Deliberately tolerant: this verb must work on a host with no
   * switchroom.yaml at all (a dev box, or a bare rescue shell). Config absence
   * means "defaults", never a crash on the code path that saves data.
   */
  loadCfg: () => unknown = () => {
    try {
      return loadConfig();
    } catch {
      return undefined;
    }
  },
): string {
  const override = process.env.SWITCHROOM_RESCUE_DIR;
  if (override && override.trim()) return resolve(override.trim());
  const cfg = resolveScratchConfig((loadCfg() as { scratch?: unknown }) ?? {});
  if (scratchVolumeAvailable(cfg.volume)) {
    return join(cfg.volume, RESCUE_SUBDIR);
  }
  return join(homedir(), ".switchroom", "rescue");
}

/** True when the rescue root is on the root disk (caller warns). */
export function rescueRootIsFallback(destRoot: string): boolean {
  return destRoot === join(homedir(), ".switchroom", "rescue");
}

// ── exec plumbing ───────────────────────────────────────────────────────────

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run git and return stdout even when the command fails.
 *
 * `git fsck` on a damaged repo exits non-zero while still printing the
 * unreachable-commit lines we need — throwing them away would lose exactly
 * the commits this module exists to rescue.
 */
function run(
  args: string[],
  input?: string,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): RunResult {
  try {
    const stdout = execFileSync("git", args, {
      encoding: "utf-8",
      stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      maxBuffer: MAX_BUFFER,
      input,
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
    });
    return { ok: true, stdout: stdout ?? "", stderr: "" };
  } catch (e) {
    const err = e as { stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      stdout: typeof err.stdout === "string" ? err.stdout : String(err.stdout ?? ""),
      stderr: describeExecFailure(e),
    };
  }
}

/**
 * git invocation against the disposable staging repo.
 *
 * The hardening flags mirror `gitArgs` (see gc.ts:428): staging borrows the
 * source's object store and runs commands over the source WORK TREE, and the
 * invoking user is frequently root, so config-driven execution
 * (`core.fsmonitor`, hooks, init templates) must be neutered on every call.
 */
function stageArgs(stageDir: string, ...rest: string[]): string[] {
  return [
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "init.templateDir=",
    "-c", `safe.directory=${stageDir}`,
    "--git-dir", stageDir,
    ...rest,
  ];
}

/**
 * Create refs in the staging repo, batched, degrading to one-at-a-time.
 *
 * `update-ref --stdin` is a single transaction: ONE ref pointing at a missing
 * object aborts the whole batch. On a damaged repo — the exact case this verb
 * is for — that would turn "rescued 11,999 of 12,000 commits" into "rescued
 * nothing", so a failed batch is retried per-ref and the individual losers are
 * reported as warnings instead of taking the capture down with them.
 */
function createRefs(
  stageDir: string,
  refs: Array<{ sha: string; ref: string }>,
  warnings: string[],
): number {
  if (refs.length === 0) return 0;
  const batch = run(stageArgs(stageDir, "update-ref", "--stdin"), updateRefStdin(refs));
  if (batch.ok) return refs.length;

  let created = 0;
  for (const r of refs) {
    const one = run(stageArgs(stageDir, "update-ref", r.ref, r.sha));
    if (one.ok) created++;
    else warnings.push(`could not rescue ref ${r.ref} (${r.sha}): ${one.stderr}`);
  }
  return created;
}

// ── the verb ────────────────────────────────────────────────────────────────

/**
 * Capture a checkout into a verified bundle, optionally deleting it after.
 *
 * CAPTURE AND DELETE ARE SEPARABLE — capture alone is the default and touches
 * nothing. `deleteAfter` is the only path that removes anything, and it is
 * unreachable unless `verified` is true.
 */
export function captureCheckout(opts: CaptureOptions): CaptureResult {
  const source = resolve(opts.dir);
  const now = opts.now ?? new Date();
  const warnings: string[] = [];
  const base: CaptureResult = {
    source,
    bundle: null,
    bytes: 0,
    verified: false,
    refs: { source: 0, unreachable: 0, stash: 0, wip: false, total: 0 },
    head: null,
    deleted: false,
    ok: false,
    warnings,
    capturedAt: now.toISOString(),
  };

  // ── 0. the directory itself ───────────────────────────────────────────────
  let st;
  try {
    st = statSync(source);
  } catch {
    return { ...base, failure: "missing", error: `No such directory: ${source}` };
  }
  if (!st.isDirectory()) {
    return { ...base, failure: "not-a-directory", error: `Not a directory: ${source}` };
  }

  // ── 1. is it a git repository at all? ─────────────────────────────────────
  const commonDirProbe = run(gitArgs(source, "rev-parse", "--git-common-dir"));
  if (!commonDirProbe.ok) {
    return {
      ...base,
      failure: "not-a-git-repo",
      error:
        `${source} is not a usable git repository (${commonDirProbe.stderr}).\n` +
        "A bundle cannot represent it. Capture it as a tarball instead:\n" +
        `  tar -C ${dirname(source)} -czf <dest>/${basename(source)}.tar.gz ${basename(source)}\n` +
        "then verify with `tar -tzf <file> >/dev/null` before deleting anything.",
    };
  }
  const objectsDir = join(resolve(source, commonDirProbe.stdout.trim()), "objects");
  const bare = run(gitArgs(source, "rev-parse", "--is-bare-repository")).stdout.trim() === "true";
  const headSha = run(gitArgs(source, "rev-parse", "--verify", "--quiet", "HEAD")).stdout.trim();
  const headBranch = run(gitArgs(source, "symbolic-ref", "--quiet", "HEAD")).stdout.trim();
  const head = headBranch
    ? headBranch.replace(/^refs\/heads\//, "")
    : headSha
      ? `detached@${headSha.slice(0, 12)}`
      : null;

  // ── 2. destination ────────────────────────────────────────────────────────
  const destRoot = opts.out ? dirname(resolve(opts.out)) : (opts.dest ? resolve(opts.dest) : rescueDestRoot());
  const bundlePath = opts.out ? resolve(opts.out) : join(destRoot, bundleFileName(source, now));
  // Writing the only surviving copy INSIDE the thing you are about to delete is
  // a capture that deletes itself. Refuse it up front rather than discovering
  // it after the `rmSync`.
  if (bundlePath === source || bundlePath.startsWith(source + "/")) {
    return {
      ...base,
      head,
      failure: "bundle-failed",
      error:
        `Refusing to write the bundle inside the checkout being captured ` +
        `(${bundlePath} is under ${source}). Pass --dest or --out somewhere else.`,
    };
  }
  try {
    mkdirSync(destRoot, { recursive: true });
  } catch (e) {
    return {
      ...base,
      failure: "bundle-failed",
      error: `Cannot create destination ${destRoot}: ${(e as Error).message}`,
    };
  }

  // Staging + readback repos live NEXT TO the bundle, so they share its
  // filesystem: a destination too small for the bundle fails here, during
  // staging, rather than half-way through writing the only copy of the work.
  const stageParent = mkdtempSync(join(destRoot, ".capture-"));
  const stageDir = join(stageParent, "stage.git");
  const readbackDir = join(stageParent, "readback.git");

  try {
    // ── 3. staging repo, borrowing the source object store ──────────────────
    const init = run([
      "-c", "init.templateDir=",
      "init", "--bare", "--quiet", stageDir,
    ]);
    if (!init.ok) {
      return { ...base, failure: "bundle-failed", error: `staging init failed: ${init.stderr}` };
    }
    mkdirSync(join(stageDir, "objects", "info"), { recursive: true });
    writeFileSync(join(stageDir, "objects", "info", "alternates"), objectsDir + "\n");

    // ── 4. every ref the source can see, verbatim ───────────────────────────
    const sourceRefs = parseForEachRef(
      run(gitArgs(source, "for-each-ref", "--format=%(objectname) %(refname)")).stdout,
    );
    const sourceRefNames = new Set(sourceRefs.map((r) => r.ref));
    const nSource = createRefs(stageDir, sourceRefs, warnings);

    // ── 5. hazard 4 — unreachable commits ───────────────────────────────────
    // `--no-reflogs` is load-bearing: without it fsck treats reflogs as roots,
    // so a commit held only by the HEAD reflog (every `commit --amend`) is
    // reported as REACHABLE and skipped — and then dropped, because bundles
    // carry no reflogs. Verified on 2.47.3: plain `--unreachable` reports 0
    // for a freshly amended commit, `--no-reflogs` reports it.
    // `--connectivity-only` skips object content hashing; on a multi-GB repo
    // full fsck is minutes, and the pack's own checksum is validated by the
    // readback gate below anyway.
    const fsck = run(
      gitArgs(source, "fsck", "--unreachable", "--no-progress", "--no-reflogs", "--connectivity-only"),
    );
    if (!fsck.ok && !fsck.stdout.trim()) {
      warnings.push(`fsck could not enumerate unreachable commits: ${fsck.stderr}`);
    }
    const unreachable = parseFsckUnreachableCommits(fsck.stdout).map((sha) => ({
      sha,
      ref: `${RESCUE_NS}/unreachable/${sha}`,
    }));
    const nUnreachable = createRefs(stageDir, unreachable, warnings);

    // ── 6. hazard 3 — the whole stash, not just stash@{0} ───────────────────
    // `refs/stash` came along in step 4, but that is only the TOP entry.
    // `rev-list -g refs/stash` walks the stash reflog, which the bundle cannot
    // carry, so each entry gets its own ref. Index order is preserved
    // (`stash/0` == `stash@{0}`).
    const stashRefs: Array<{ sha: string; ref: string }> = [];
    if (sourceRefNames.has("refs/stash")) {
      const entries = run(gitArgs(source, "rev-list", "-g", "refs/stash")).stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => /^[0-9a-f]{7,64}$/.test(s));
      entries.forEach((sha, i) => stashRefs.push({ sha, ref: `${RESCUE_NS}/stash/${i}` }));
    }
    const nStash = createRefs(stageDir, stashRefs, warnings);

    // ── 7. hazards 1+2 — uncommitted changes and untracked files ────────────
    let wip = false;
    let wipCommit: string | null = null;
    if (!bare && existsSync(source)) {
      // `git add -A` against an EMPTY staging index and the source work tree
      // records the tree as it is on disk: tracked-and-modified, staged, and
      // untracked, in one shot, without reading (or touching) the source
      // index. Ignored files are excluded — deliberate: `.gitignore` is where
      // node_modules and build output live, and a rescue bundle that inlines
      // those is one nobody can afford to write.
      // cwd is the work tree itself: `add -A` with no pathspec means "the
      // whole work tree" only when git can resolve one, and a pathspec would
      // be interpreted relative to the CALLER's cwd, not `--work-tree`.
      const add = run(
        stageArgs(stageDir, "--work-tree", source, "add", "-A"),
        undefined,
        source,
      );
      if (!add.ok) {
        return {
          ...base,
          bundle: null,
          head,
          failure: "worktree-snapshot-failed",
          error:
            `Could not snapshot the working tree of ${source}: ${add.stderr}\n` +
            "Refusing to continue — an incomplete snapshot is exactly the silent " +
            "loss this verb exists to prevent.",
        };
      }
      const tree = run(stageArgs(stageDir, "write-tree")).stdout.trim();
      if (/^[0-9a-f]{7,64}$/.test(tree)) {
        const msg =
          `rescued working tree of ${source}\n\n` +
          `Captured ${now.toISOString()} by \`switchroom worktree capture\`.\n` +
          "Contains tracked modifications AND untracked files as they were on " +
          "disk. Ignored files are not included.\n";
        const commit = run(
          stageArgs(
            stageDir,
            "commit-tree",
            tree,
            ...(headSha ? ["-p", headSha] : []),
            "-m",
            msg,
          ),
          undefined,
          undefined,
          // `commit-tree` REQUIRES an identity, and the hosts this verb runs on
          // are exactly the ones least likely to have one: a CI runner, a
          // rescue shell, a container with no `~/.gitconfig`. Without this the
          // snapshot dies with "Committer identity unknown" and hazards 1+2 are
          // silently lost — which is the whole point of the verb. Env vars are
          // used rather than `-c user.*` so an inherited GIT_COMMITTER_* cannot
          // override them and reintroduce the failure.
          SNAPSHOT_IDENTITY,
        );
        if (commit.ok && /^[0-9a-f]{7,64}$/.test(commit.stdout.trim())) {
          wipCommit = commit.stdout.trim();
          // Collision-proof: a source branch literally named `rescued-wip`
          // must not be overwritten by the snapshot.
          let ref = WIP_BRANCH;
          for (let i = 2; sourceRefNames.has(ref); i++) ref = `${WIP_BRANCH}-${i}`;
          if (createRefs(stageDir, [{ sha: wipCommit, ref }], warnings) === 1) {
            wip = true;
            run(stageArgs(stageDir, "symbolic-ref", "HEAD", ref));
          }
        } else {
          warnings.push(`could not record the working-tree snapshot commit: ${commit.stderr}`);
        }
      } else {
        warnings.push("could not write a tree for the working-tree snapshot");
      }
      // A submodule is recorded as a GITLINK — a bare sha, not content. If the
      // submodule's own objects live inside the checkout, the bundle does not
      // carry them and the restored tree will have an empty submodule dir.
      // Say so rather than let the operator find out at restore time.
      if (existsSync(join(source, ".gitmodules"))) {
        warnings.push(
          "this checkout has submodules: they are captured as gitlinks only, " +
            "so submodule CONTENT is not in this bundle — capture each submodule " +
            "separately if it holds unpushed work",
        );
      }
    }

    // A sensible HEAD so `git clone <bundle>` checks something out instead of
    // warning about a nonexistent remote HEAD.
    if (!wip) {
      if (headBranch && sourceRefNames.has(headBranch)) {
        run(stageArgs(stageDir, "symbolic-ref", "HEAD", headBranch));
      } else if (headSha) {
        const ref = "refs/heads/rescued-head";
        if (createRefs(stageDir, [{ sha: headSha, ref }], warnings) === 1) {
          run(stageArgs(stageDir, "symbolic-ref", "HEAD", ref));
        }
      }
    }

    const total = nSource + nUnreachable + nStash + (wip ? 1 : 0);
    const refCounts: CaptureRefCounts = {
      source: nSource,
      unreachable: nUnreachable,
      stash: nStash,
      wip,
      total,
    };
    if (total === 0) {
      return {
        ...base,
        head,
        refs: refCounts,
        failure: "nothing-to-capture",
        error:
          `${source} has no refs, no unreachable commits and no working-tree ` +
          "content — there is nothing a bundle could carry. Nothing was deleted.",
      };
    }

    // ── 8. the bundle ───────────────────────────────────────────────────────
    const created = run(stageArgs(stageDir, "bundle", "create", bundlePath, "--all"));
    if (!created.ok || !existsSync(bundlePath)) {
      return {
        ...base,
        head,
        refs: refCounts,
        failure: "bundle-failed",
        error: `git bundle create failed: ${created.stderr}`,
      };
    }
    opts.onBundleWritten?.(bundlePath);
    const bytes = statSync(bundlePath).size;
    if (bytes === 0) {
      return {
        ...base,
        bundle: bundlePath,
        head,
        refs: refCounts,
        failure: "bundle-failed",
        error: "git bundle create produced an empty file",
      };
    }

    // ── 9. the gate — verify AND read back ──────────────────────────────────
    const verify = run(stageArgs(stageDir, "bundle", "verify", bundlePath));
    if (!verify.ok) {
      return {
        ...base,
        bundle: bundlePath,
        bytes,
        head,
        refs: refCounts,
        failure: "verify-failed",
        error: `git bundle verify failed: ${verify.stderr}. Nothing was deleted.`,
      };
    }

    // `bundle verify` never reads the pack (a truncated bundle passes it), so
    // the real proof is a readback into an object store that shares NOTHING
    // with the source: index-pack must reconstruct every object and every
    // intended ref must arrive.
    const rbInit = run([
      "-c", "init.templateDir=",
      "init", "--bare", "--quiet", readbackDir,
    ]);
    if (!rbInit.ok) {
      return {
        ...base,
        bundle: bundlePath,
        bytes,
        head,
        refs: refCounts,
        failure: "readback-failed",
        error: `could not create the readback repo: ${rbInit.stderr}. Nothing was deleted.`,
      };
    }
    const fetched = run(
      stageArgs(readbackDir, "fetch", "--quiet", bundlePath, "refs/*:refs/*"),
    );
    if (!fetched.ok) {
      return {
        ...base,
        bundle: bundlePath,
        bytes,
        head,
        refs: refCounts,
        failure: "readback-failed",
        error:
          `the bundle did not read back: ${fetched.stderr}. ` +
          "Nothing was deleted; the checkout is still on disk.",
      };
    }
    const recovered = new Set(
      parseForEachRef(
        run(stageArgs(readbackDir, "for-each-ref", "--format=%(objectname) %(refname)")).stdout,
      ).map((r) => r.ref),
    );
    const intended = parseForEachRef(
      run(stageArgs(stageDir, "for-each-ref", "--format=%(objectname) %(refname)")).stdout,
    ).map((r) => r.ref);
    const lost = intended.filter((r) => !recovered.has(r));
    if (lost.length > 0) {
      return {
        ...base,
        bundle: bundlePath,
        bytes,
        head,
        refs: refCounts,
        failure: "readback-failed",
        error:
          `${lost.length} ref(s) did not survive the round-trip (e.g. ${lost[0]}). ` +
          "Nothing was deleted.",
      };
    }

    const result: CaptureResult = {
      ...base,
      bundle: bundlePath,
      bytes,
      verified: true,
      head,
      refs: refCounts,
      ok: true,
    };

    // Self-describing: a rescue directory full of bundles is useless if you
    // cannot tell which checkout each one came from. Written BEFORE the delete
    // so it exists even if the delete throws, and rewritten after so it records
    // what actually happened.
    const writeManifest = (r: CaptureResult): void => {
      try {
        writeFileSync(`${bundlePath}.json`, JSON.stringify(r, null, 2) + "\n");
      } catch (e) {
        warnings.push(`could not write the manifest sidecar: ${(e as Error).message}`);
      }
    };
    writeManifest(result);

    // ── 10. deletion — only ever from here ──────────────────────────────────
    if (opts.deleteAfter) {
      const kind = detectCheckoutKind(source);
      try {
        rmSync(source, { recursive: true, force: true });
        result.deleted = true;
      } catch (e) {
        const failed = { ...result, failure: "delete-failed" as const, error: (e as Error).message };
        writeManifest(failed);
        return failed;
      }
      if (kind === "worktree") {
        // The directory is gone; the source repo's `.git/worktrees/<name>`
        // admin entry would otherwise linger forever.
        // `--git-common-dir` on a linked worktree resolves to the MAIN repo's
        // `.git` directory, so its parent is the repo to prune from.
        const repoRoot = dirname(resolve(source, commonDirProbe.stdout.trim()));
        const pruned = run(gitArgs(repoRoot, "worktree", "prune"));
        if (!pruned.ok) warnings.push(`git worktree prune failed in ${repoRoot}: ${pruned.stderr}`);
      }
      writeManifest(result);
    }

    return result;
  } finally {
    try {
      rmSync(stageParent, { recursive: true, force: true });
    } catch {
      warnings.push(`could not remove the staging dir ${stageParent}`);
    }
  }
}

/** Operator-facing restore instructions for a captured bundle. */
export function restoreCommands(bundlePath: string): string[] {
  const name = basename(bundlePath).replace(/\.bundle$/, "");
  return [
    `git clone ${bundlePath} ${name}`,
    `git clone --mirror ${bundlePath} ${name}.git`,
  ];
}
