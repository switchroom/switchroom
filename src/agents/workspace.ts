/**
 * Workspace file discovery + bootstrap injection pipeline.
 *
 * This module is switchroom's analogue of OpenClaw's
 * `src/agents/workspace.ts` (simplified for switchroom's narrower scope —
 * single host, no plugin-owned extra bootstrap files).
 *
 * Concepts:
 *
 * - **Stable files** (injected via `--append-system-prompt` at claude CLI
 *   launch): AGENTS.md, SOUL.md, IDENTITY.md, USER.md, TOOLS.md. These rarely
 *   change within a session, so we bake them into the system prompt where
 *   they cache nicely.
 * - **Dynamic files** (injected via UserPromptSubmit hook at the start of
 *   each turn): MEMORY.md, memory/YYYY-MM-DD.md for today and yesterday,
 *   HEARTBEAT.md. These change mid-session and need to be re-read on every
 *   turn.
 *
 * Both pipelines run through `bootstrap-budget.ts` for per-file and
 * total-size cap enforcement so we don't blow through Claude Code's
 * `--append-system-prompt` limit (~100KB) or the per-turn prompt budget.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  analyzeBootstrapBudget,
  appendBootstrapPromptWarning,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
  DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO,
  DEFAULT_BOOTSTRAP_PROMPT_WARNING_MAX_FILES,
  type BootstrapBudgetAnalysis,
  type BootstrapPromptWarning,
  type BootstrapPromptWarningMode,
} from "./bootstrap-budget.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  type EmbeddedContextFile,
  type WorkspaceBootstrapFile,
  type WorkspaceBootstrapFileName,
} from "./bootstrap-types.js";

export const DEFAULT_WORKSPACE_DIR_NAME = "workspace";
export const DEFAULT_MEMORY_SUBDIR = "memory";

/**
 * Files that are stable across a session and belong in the system prompt via
 * `--append-system-prompt` for prefix cache stability.
 */
export const STABLE_BOOTSTRAP_FILENAMES: WorkspaceBootstrapFileName[] = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
];

/**
 * Files that change mid-session and belong in the UserPromptSubmit hook
 * (re-read every turn). MEMORY.md and HEARTBEAT.md are read from the
 * workspace root; daily files are read from `workspace/memory/YYYY-MM-DD.md`.
 */
export const DYNAMIC_BOOTSTRAP_FILENAMES: WorkspaceBootstrapFileName[] = [
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
];

export const DEFAULT_BOOTSTRAP_MAX_CHARS = 12_000;
export const DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 64_000;
export const DEFAULT_DYNAMIC_TOTAL_MAX_CHARS = 24_000;

export type BootstrapBudgetConfig = {
  bootstrapMaxChars?: number;
  bootstrapTotalMaxChars?: number;
  nearLimitRatio?: number;
  warningMode?: BootstrapPromptWarningMode;
  warningMaxFiles?: number;
};

export type BootstrapInjectionResult = {
  files: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  concatenated: string;
  analysis: BootstrapBudgetAnalysis;
  warning: BootstrapPromptWarning;
};

/**
 * Resolve the default workspace directory for an agent. An agent's
 * workspace lives at `<agentDir>/workspace/` by convention. Agent scaffolding
 * seeds this directory with profile-provided template files (AGENTS.md,
 * SOUL.md, etc.), which Ken can then edit in place.
 */
export function resolveAgentWorkspaceDir(agentDir: string): string {
  return path.join(agentDir, DEFAULT_WORKSPACE_DIR_NAME);
}

/**
 * Check whether a workspace directory has been set up for an agent. Used by
 * the CLI to decide whether to seed the templates.
 */
export async function isWorkspaceSetupCompleted(workspaceDir: string): Promise<boolean> {
  try {
    const agentsPath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
    const info = await stat(agentsPath);
    return info.isFile();
  } catch {
    return false;
  }
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    return content;
  } catch (err) {
    if (isErrnoException(err) && (err.code === "ENOENT" || err.code === "EISDIR")) {
      return undefined;
    }
    throw err;
  }
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string";
}

async function loadNamedFile(
  workspaceDir: string,
  name: WorkspaceBootstrapFileName,
  relativePath?: string,
): Promise<WorkspaceBootstrapFile> {
  const filePath = path.join(workspaceDir, relativePath ?? name);
  const content = await readOptionalFile(filePath);
  if (content === undefined) {
    return { name, path: filePath, missing: true };
  }
  return { name, path: filePath, content, missing: false };
}

/**
 * Load the stable workspace bootstrap files. Files that don't exist are
 * reported as `missing: true` rather than throwing, so callers can decide
 * whether absence is acceptable.
 */
export async function loadStableBootstrapFiles(
  workspaceDir: string,
): Promise<WorkspaceBootstrapFile[]> {
  const loaded = await Promise.all(
    STABLE_BOOTSTRAP_FILENAMES.map((name) => loadNamedFile(workspaceDir, name)),
  );
  return loaded;
}

/**
 * Load the dynamic workspace bootstrap files — MEMORY.md, HEARTBEAT.md, and
 * today/yesterday's daily note at `memory/YYYY-MM-DD.md`.
 *
 * Dates are computed against `now` (defaults to the current time) in UTC by
 * default; pass a timezone-shifted `now` if you want local-date daily notes.
 */
export async function loadDynamicBootstrapFiles(
  workspaceDir: string,
  options?: { now?: Date; includeYesterday?: boolean },
): Promise<WorkspaceBootstrapFile[]> {
  const now = options?.now ?? new Date();
  const includeYesterday = options?.includeYesterday ?? true;

  const files = await Promise.all(
    DYNAMIC_BOOTSTRAP_FILENAMES.map((name) => loadNamedFile(workspaceDir, name)),
  );

  const todayRelative = dailyMemoryRelativePath(now);
  const todayName: WorkspaceBootstrapFileName = DEFAULT_MEMORY_FILENAME; // reuse tag
  const today = await loadNamedFile(workspaceDir, todayName, todayRelative);
  today.path = path.join(workspaceDir, todayRelative);
  files.push(today);

  if (includeYesterday) {
    const yesterdayRelative = dailyMemoryRelativePath(addDays(now, -1));
    const yesterday = await loadNamedFile(workspaceDir, todayName, yesterdayRelative);
    yesterday.path = path.join(workspaceDir, yesterdayRelative);
    files.push(yesterday);
  }

  return files;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Compute the relative path to the daily memory file for `date` in the
 * host's LOCAL timezone. A UTC-based computation would roll "today"
 * over at UTC midnight, which is early-morning for users in UTC+10
 * and mid-afternoon for users in UTC-8 — both wrong for "today's
 * notes" semantics. Node's getFullYear/getMonth/getDate already read
 * the host's local TZ from the system, which is what we want.
 */
function dailyMemoryRelativePath(date: Date): string {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  return path.join(DEFAULT_MEMORY_SUBDIR, `${y}-${m}-${d}.md`);
}

function addDays(date: Date, days: number): Date {
  const out = new Date(date.getTime());
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * Truncate a file's raw content to at most `maxChars`, preserving the head
 * and tail with an explicit ellipsis marker so the model knows content was
 * cut. Returns the untouched string when already under the limit.
 */
function truncateContent(name: string, content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  if (maxChars < 200) {
    return content.slice(0, Math.max(0, maxChars));
  }
  // Reserve room for the marker text based on actual length, then
  // shrink head+tail to fit. Previous hard-coded 64-char reservation
  // underflowed for long file names + large raw sizes, overshooting the
  // cap by a few chars in pathological cases.
  const headRoomInitial = Math.floor(maxChars * 0.7);
  const sampleMarker = `\n…(truncated ${name}: kept ${headRoomInitial}+${Math.max(0, maxChars - headRoomInitial - 96)} chars of ${content.length})…\n`;
  const markerReserve = Math.max(64, sampleMarker.length + 8); // +8 slack for digit width changes
  const headRoom = Math.min(headRoomInitial, Math.max(0, maxChars - markerReserve - 8));
  const tailRoom = Math.max(0, maxChars - headRoom - markerReserve);
  const head = content.slice(0, Math.max(0, headRoom));
  const tail = tailRoom > 0 ? content.slice(content.length - tailRoom) : "";
  const result = `${head}\n…(truncated ${name}: kept ${headRoom}+${tailRoom} chars of ${content.length})…\n${tail}`;
  // Belt-and-braces: if the computed marker ended up longer than
  // reserved (e.g. multi-byte name with unusual digit widths), trim to
  // the cap rather than return an over-cap string.
  return result.length <= maxChars ? result : result.slice(0, maxChars);
}

/**
 * Core projection step: given a set of loaded workspace files and a budget
 * config, build the concatenated "Project Context" block that gets injected
 * into the system prompt (or prepended to a user turn for dynamic files),
 * along with the analysis metadata callers need to decide whether to emit a
 * truncation warning.
 */
export function projectBootstrapFiles(params: {
  files: WorkspaceBootstrapFile[];
  heading: string;
  budget: Required<Pick<BootstrapBudgetConfig, "bootstrapMaxChars" | "bootstrapTotalMaxChars">> & {
    nearLimitRatio?: number;
  };
  seenSignatures?: string[];
  warningMode?: BootstrapPromptWarningMode;
  warningMaxFiles?: number;
}): BootstrapInjectionResult {
  const {
    files,
    heading,
    budget,
    seenSignatures,
    warningMode = "once",
    warningMaxFiles = DEFAULT_BOOTSTRAP_PROMPT_WARNING_MAX_FILES,
  } = params;
  const perFileCap = budget.bootstrapMaxChars;
  let remainingTotal = budget.bootstrapTotalMaxChars;

  const injectedFiles: EmbeddedContextFile[] = [];
  const parts: string[] = [];

  for (const file of files) {
    if (file.missing || typeof file.content !== "string") {
      continue;
    }
    const raw = file.content.trimEnd();
    if (raw.length === 0) {
      continue;
    }
    const perFileAllowed = Math.min(perFileCap, remainingTotal);
    if (perFileAllowed <= 0) {
      break;
    }
    const injected = truncateContent(file.name, raw, perFileAllowed);
    const relativePath = file.path;
    injectedFiles.push({ path: relativePath, content: injected });
    parts.push(`## ${relativePath}`);
    parts.push(injected);
    remainingTotal -= injected.length;
    if (remainingTotal <= 0) {
      break;
    }
  }

  const concatenated =
    parts.length > 0
      ? [heading.trim().length > 0 ? `# ${heading}` : null, ...parts]
          .filter((p): p is string => p !== null)
          .join("\n\n")
      : "";
  const stats = buildBootstrapInjectionStats({
    bootstrapFiles: files,
    injectedFiles,
  });
  const analysis = analyzeBootstrapBudget({
    files: stats,
    bootstrapMaxChars: budget.bootstrapMaxChars,
    bootstrapTotalMaxChars: budget.bootstrapTotalMaxChars,
    nearLimitRatio: budget.nearLimitRatio ?? DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO,
  });
  const warning = buildBootstrapPromptWarning({
    analysis,
    mode: warningMode,
    seenSignatures,
    maxFiles: warningMaxFiles,
  });

  return { files, injectedFiles, concatenated, analysis, warning };
}

/**
 * Convenience: build the full `--append-system-prompt` block for stable
 * files. Returns empty string when no files exist.
 */
export async function buildStableBootstrapPrompt(params: {
  workspaceDir: string;
  budget?: BootstrapBudgetConfig;
  seenSignatures?: string[];
}): Promise<BootstrapInjectionResult> {
  const files = await loadStableBootstrapFiles(params.workspaceDir);
  const budget = {
    bootstrapMaxChars: params.budget?.bootstrapMaxChars ?? DEFAULT_BOOTSTRAP_MAX_CHARS,
    bootstrapTotalMaxChars:
      params.budget?.bootstrapTotalMaxChars ?? DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS,
    nearLimitRatio: params.budget?.nearLimitRatio,
  };
  return projectBootstrapFiles({
    files,
    heading: "Project Context (stable workspace files)",
    budget,
    seenSignatures: params.seenSignatures,
    warningMode: params.budget?.warningMode,
    warningMaxFiles: params.budget?.warningMaxFiles,
  });
}

/**
 * Convenience: build the UserPromptSubmit hook body for dynamic files.
 * Returns empty string when no files exist.
 */
export async function buildDynamicBootstrapPrompt(params: {
  workspaceDir: string;
  now?: Date;
  includeYesterday?: boolean;
  budget?: BootstrapBudgetConfig;
  seenSignatures?: string[];
}): Promise<BootstrapInjectionResult> {
  const files = await loadDynamicBootstrapFiles(params.workspaceDir, {
    now: params.now,
    includeYesterday: params.includeYesterday,
  });
  const budget = {
    bootstrapMaxChars: params.budget?.bootstrapMaxChars ?? DEFAULT_BOOTSTRAP_MAX_CHARS,
    bootstrapTotalMaxChars:
      params.budget?.bootstrapTotalMaxChars ?? DEFAULT_DYNAMIC_TOTAL_MAX_CHARS,
    nearLimitRatio: params.budget?.nearLimitRatio,
  };
  return projectBootstrapFiles({
    files,
    heading: "Project Context (dynamic workspace files)",
    budget,
    seenSignatures: params.seenSignatures,
    warningMode: params.budget?.warningMode,
    warningMaxFiles: params.budget?.warningMaxFiles,
  });
}

/**
 * Append the truncation warning (if any) to a user-turn prompt. Use this in
 * the UserPromptSubmit hook so the warning lives in the turn, not the stable
 * system prompt (preserving prefix cache stability).
 */
export function decorateTurnWithWarning(
  turnPrompt: string,
  warning: BootstrapPromptWarning,
): string {
  if (!warning.warningShown || warning.lines.length === 0) {
    return turnPrompt;
  }
  return appendBootstrapPromptWarning(turnPrompt, warning.lines);
}
