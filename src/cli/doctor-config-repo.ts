/**
 * `switchroom doctor` — config-repo change-control health.
 *
 * Rows (only emitted when a `config_repo:` block is configured):
 *   - **present**  — the configured path is a git repo (else FAIL: the sync
 *     verb and every backup guarantee are dead).
 *   - **private**  — the GitHub remote is private (FAIL if public — the
 *     require_private gate will refuse every push; WARN if unverifiable).
 *   - **personal skills tracked** — how many mirrored personal-skill files on
 *     disk are still untracked. Fires today on GAP A (84 files across the
 *     fleet) and self-clears after the first `config-repo sync`.
 *   - **unpushed** — commits ahead of the upstream, red once the oldest is
 *     older than 24h (the loud backstop for a broken push / offline host).
 *
 * The classifier is pure so both branches of each row are unit-testable without
 * arranging a real repo state.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolvePath } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";
import { PERSONAL_SKILLS_SUBPATH, type CmdRunner } from "../config-repo/sync.js";
import {
  CRON_LOG_PATH,
  CRON_PATH,
  DEFAULT_INTERVAL_MINUTES,
} from "../config-repo/install-cron.js";

export interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
  fix?: string;
}

/** How old the oldest unpushed commit may be before the row goes red. */
export const UNPUSHED_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * How many missed ticks before the "scheduled sync" row goes red. Three
 * intervals is past any plausible transient (a slow sync holding the `flock`, a
 * reboot, one gh probe hanging) and well short of letting a dead schedule look
 * alive for a working day. Computed from `config_repo.interval_minutes` at read
 * time; the constant here is the multiplier.
 */
export const CONFIG_SYNC_STALE_INTERVALS = 3;

/**
 * Facts the scheduled-sync classifier turns into a row. Kept separate from
 * {@link ConfigRepoFacts} so the two rows are independently unit-testable.
 */
export interface ConfigSyncCronFacts {
  /** Is a `config_repo:` block present at all. */
  configured: boolean;
  enabled: boolean;
  /** Does /etc/cron.d/switchroom-config-sync exist. */
  cronInstalled: boolean;
  /** mtime (ms) of the sync log — evidence a tick actually ran; null if absent. */
  logMtimeMs: number | null;
  /** Cadence in minutes, used to size the staleness window. */
  intervalMinutes: number;
}

/**
 * Classify the scheduled-sync (cron) state. Pure, so every branch is asserted
 * in a unit test rather than by arranging a real cron file.
 *
 * States (the plan's Slice 2 doctor contract, plus a firing/staleness signal):
 *   - enabled + NOT installed  → FAIL: backups are simply not running.
 *   - NOT enabled + installed   → WARN: the tick still runs+pushes, but the
 *     feature is off — enable it or `config-repo uninstall-cron`.
 *   - enabled + installed, never ticked → WARN: cron may not be running.
 *   - enabled + installed, stale → FAIL: cron/the tick is failing.
 *   - enabled + installed, fresh → OK.
 *   - NOT enabled + NOT installed → null (feature fully off; no row).
 */
export function classifyConfigSyncCron(
  f: ConfigSyncCronFacts,
  now: number,
): CheckResult | null {
  if (!f.configured) return null;
  const name = "config repo scheduled sync";
  const staleMs = f.intervalMinutes * CONFIG_SYNC_STALE_INTERVALS * 60_000;

  if (f.enabled && !f.cronInstalled) {
    return {
      name,
      status: "fail",
      detail:
        `config_repo.enabled but no cron at ${CRON_PATH} — scheduled backups are NOT running; ` +
        "the repo only captures changes when someone runs `config-repo sync` by hand",
      fix: "Arm it: `switchroom config-repo install-cron --cron-user <operator>` (needs root to write /etc/cron.d).",
    };
  }

  if (!f.enabled && f.cronInstalled) {
    return {
      name,
      status: "warn",
      detail:
        `${CRON_PATH} is installed but config_repo.enabled is false — the tick still commits and pushes`,
      fix: "Either set `config_repo.enabled: true`, or disarm with `switchroom config-repo uninstall-cron`.",
    };
  }

  if (!f.enabled && !f.cronInstalled) return null;

  // enabled && installed — judge firing via the log mtime.
  if (f.logMtimeMs === null) {
    return {
      name,
      status: "warn",
      detail:
        `cron armed but no tick has completed yet (no log at ${CRON_LOG_PATH}) — ` +
        "cron may not be running, or every tick is failing before it writes",
      fix: "Check cron is running and dry-run: `switchroom config-repo sync --no-push`.",
    };
  }

  const ageMs = now - f.logMtimeMs;
  const mins = Math.round(ageMs / 60_000);
  if (ageMs < -staleMs) {
    return {
      name,
      status: "warn",
      detail: `sync log is dated ${Math.abs(mins)}m in the FUTURE — clock skew or a restored backup`,
      fix: "Check the host clock.",
    };
  }
  if (ageMs > staleMs) {
    return {
      name,
      status: "fail",
      detail:
        `last scheduled sync was ${mins}m ago (stale past ${Math.round(staleMs / 60_000)}m) — ` +
        "cron itself or the tick is failing",
      fix: `Inspect ${CRON_LOG_PATH}; dry-run with \`switchroom config-repo sync --no-push\`.`,
    };
  }
  return {
    name,
    status: "ok",
    detail: `armed (*/${f.intervalMinutes} * * * *); last sync ${mins}m ago`,
  };
}

/** Host facts the classifier turns into rows. */
export interface ConfigRepoFacts {
  /** Is a `config_repo:` block present at all. */
  configured: boolean;
  enabled: boolean;
  repoPath: string;
  isGitRepo: boolean;
  /** GitHub remote visibility: true=private, false=public, null=unverifiable. */
  isPrivate: boolean | null;
  /** Mirrored personal-skill files on disk that git is not tracking. */
  untrackedPersonalSkills: number;
  /** Commits ahead of upstream; null when the upstream ref is unknown. */
  unpushedCount: number | null;
  /** Age (ms) of the OLDEST unpushed commit; null when none/unknown. */
  oldestUnpushedAgeMs: number | null;
}

const FIX_SYNC = "Run `switchroom config-repo sync` (add `--no-push` to commit only).";

export function classifyConfigRepo(f: ConfigRepoFacts): CheckResult[] {
  if (!f.configured) return [];
  const rows: CheckResult[] = [];

  // present
  if (!f.isGitRepo) {
    rows.push({
      name: "config repo present",
      status: "fail",
      detail: `${f.repoPath} is not a git repo (no .git) — config-repo sync cannot run`,
      fix: `Clone the operator's private config repo to ${f.repoPath}, or fix config_repo.path.`,
    });
    // Nothing else is meaningful without a repo.
    return rows;
  }
  rows.push({
    name: "config repo present",
    status: "ok",
    detail: `${f.repoPath}${f.enabled ? "" : " (config_repo.enabled: false)"}`,
  });

  // private
  if (f.isPrivate === false) {
    rows.push({
      name: "config repo private",
      status: "fail",
      detail: "GitHub remote is PUBLIC — require_private will refuse every push, and workspace/memory state must not live in a public repo",
      fix: "Make the remote private (GitHub → Settings → Danger Zone), or move the remote.",
    });
  } else if (f.isPrivate === null) {
    rows.push({
      name: "config repo private",
      status: "warn",
      detail: "could not confirm remote is private (gh unavailable / API unreachable) — pushes will be skipped until verifiable",
      fix: "Check `gh auth status`; the require_private gate fails safe (no push) while unverifiable.",
    });
  } else {
    rows.push({ name: "config repo private", status: "ok", detail: "remote is private" });
  }

  // personal skills tracked (GAP A)
  if (f.untrackedPersonalSkills > 0) {
    rows.push({
      name: "config repo personal skills tracked",
      status: "warn",
      detail: `${f.untrackedPersonalSkills} mirrored personal-skill file(s) on disk are untracked (GAP A) — a repo clone would lose them`,
      fix: FIX_SYNC,
    });
  } else {
    rows.push({
      name: "config repo personal skills tracked",
      status: "ok",
      detail: "all mirrored personal skills are tracked",
    });
  }

  // unpushed
  if (f.unpushedCount === null) {
    rows.push({
      name: "config repo unpushed",
      status: "warn",
      detail: "no upstream tracking ref — cannot tell whether commits are pushed",
      fix: "Set an upstream: `git -C <repo> push -u origin HEAD`.",
    });
  } else if (f.unpushedCount === 0) {
    rows.push({ name: "config repo unpushed", status: "ok", detail: "up to date with upstream" });
  } else {
    const ageMs = f.oldestUnpushedAgeMs ?? 0;
    const hrs = Math.round(ageMs / 3_600_000);
    if (ageMs > UNPUSHED_STALE_MS) {
      rows.push({
        name: "config repo unpushed",
        status: "fail",
        detail: `${f.unpushedCount} unpushed commit(s); oldest is ${hrs}h old (stale past 24h) — push is broken or the host is offline`,
        fix: "Investigate push/auth: `git -C <repo> push`; check `gh auth status` and remote reachability.",
      });
    } else {
      rows.push({
        name: "config repo unpushed",
        status: "ok",
        detail: `${f.unpushedCount} unpushed commit(s), newest activity ${hrs}h ago (within 24h)`,
      });
    }
  }

  return rows;
}

function gitRunner(repoPath: string): CmdRunner {
  return (args) => {
    const r = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf-8" });
    return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
  };
}

function ghRunner(): CmdRunner {
  return (args) => {
    const r = spawnSync("gh", args, { encoding: "utf-8" });
    return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
  };
}

/** Walk each agent's personal-skills slice and count files not tracked by git. */
export function countUntrackedPersonalSkills(repoPath: string, git: CmdRunner): number {
  const agentsDir = join(repoPath, "agents");
  if (!existsSync(agentsDir)) return 0;

  const tracked = new Set<string>();
  const ls = git(["ls-files"]);
  if (ls.ok) {
    for (const line of ls.stdout.split("\n")) {
      if (line.includes(`/${PERSONAL_SKILLS_SUBPATH}/`)) tracked.add(line);
    }
  }

  let untracked = 0;
  const walk = (dir: string, relPrefix: string): void => {
    let ents: string[];
    try {
      ents = readdirSync(dir);
    } catch {
      return;
    }
    for (const ent of ents) {
      const abs = join(dir, ent);
      const rel = relPrefix ? `${relPrefix}/${ent}` : ent;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile() && !tracked.has(rel)) untracked++;
    }
  };

  for (const agent of safeReaddir(agentsDir)) {
    const ps = join(agentsDir, agent, PERSONAL_SKILLS_SUBPATH);
    if (!existsSync(ps)) continue;
    for (const ent of safeReaddir(ps)) {
      if (ent.startsWith(".")) continue; // staging/prior/trash/journal siblings
      const abs = join(ps, ent);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const rel = `agents/${agent}/${PERSONAL_SKILLS_SUBPATH}/${ent}`;
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile() && !tracked.has(rel)) untracked++;
    }
  }
  return untracked;
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/** Compute unpushed count + oldest-commit age against the upstream ref. */
export function readUnpushed(
  git: CmdRunner,
  now: number,
): { count: number | null; oldestAgeMs: number | null } {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok) return { count: null, oldestAgeMs: null };
  // Resolve the configured upstream; if none, we can't judge.
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (!upstream.ok || upstream.stdout.length === 0) return { count: null, oldestAgeMs: null };

  const log = git(["log", "--format=%ct", `${upstream.stdout}..HEAD`]);
  if (!log.ok) return { count: null, oldestAgeMs: null };
  const times = log.stdout
    .split("\n")
    .map((l) => Number.parseInt(l.trim(), 10))
    .filter((n) => Number.isFinite(n));
  if (times.length === 0) return { count: 0, oldestAgeMs: null };
  const oldest = Math.min(...times);
  return { count: times.length, oldestAgeMs: now - oldest * 1000 };
}

/** Read host facts and classify. */
export function checkConfigRepo(
  config: SwitchroomConfig,
  now: number = Date.now(),
): CheckResult[] {
  const block = config.config_repo;
  if (!block) return [];

  const repoPath = block.path
    ? resolvePath(block.path)
    : join(process.env.SWITCHROOM_HOME ?? process.env.HOME ?? homedir(), ".switchroom-config");

  // Scheduled-sync (cron) row — independent of whether the repo is a git repo,
  // so it is read once and appended to whichever branch returns.
  const cronRow = classifyConfigSyncCron(
    {
      configured: true,
      enabled: block.enabled,
      cronInstalled: existsSync(CRON_PATH),
      logMtimeMs: safeMtimeMs(CRON_LOG_PATH),
      intervalMinutes: block.interval_minutes ?? DEFAULT_INTERVAL_MINUTES,
    },
    now,
  );
  const withCron = (rows: CheckResult[]): CheckResult[] =>
    cronRow ? [...rows, cronRow] : rows;

  const isGitRepo = existsSync(join(repoPath, ".git"));
  if (!isGitRepo) {
    return withCron(
      classifyConfigRepo({
        configured: true,
        enabled: block.enabled,
        repoPath,
        isGitRepo: false,
        isPrivate: null,
        untrackedPersonalSkills: 0,
        unpushedCount: null,
        oldestUnpushedAgeMs: null,
      }),
    );
  }

  const git = gitRunner(repoPath);
  const gh = ghRunner();

  // Visibility probe (best-effort).
  let isPrivate: boolean | null = null;
  const remoteUrl = git(["remote", "get-url", block.remote]);
  if (remoteUrl.ok) {
    const m = remoteUrl.stdout.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/);
    if (m) {
      const r = gh(["api", `repos/${m[1]}/${m[2]}`, "--jq", ".private"]);
      if (r.ok) {
        const v = r.stdout.trim().toLowerCase();
        isPrivate = v === "true" ? true : v === "false" ? false : null;
      }
    }
  }

  const untracked = countUntrackedPersonalSkills(repoPath, git);
  const unpushed = readUnpushed(git, now);

  return withCron(
    classifyConfigRepo({
      configured: true,
      enabled: block.enabled,
      repoPath,
      isGitRepo: true,
      isPrivate,
      untrackedPersonalSkills: untracked,
      unpushedCount: unpushed.count,
      oldestUnpushedAgeMs: unpushed.oldestAgeMs,
    }),
  );
}

/** mtime (ms) of a file, or null when absent/unreadable. */
function safeMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
