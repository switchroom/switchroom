/**
 * Profile / skill picker — workstream 4 of epic #543, closes #190.
 *
 * Replaces the `--profile <name>` required-flag stub in
 * `switchroom agent add` with a guided picker:
 *
 *   1. If a profile was supplied up-front (--profile / SWITCHROOM_PROFILE),
 *      validate it against the filesystem (listAvailableProfiles) and
 *      return. Same fast path the BotFather walkthrough uses.
 *   2. Otherwise, print a numbered list of available profiles with a
 *      one-line gloss for each, and let the operator pick by number or
 *      by name. Re-prompt on bad input rather than hard-failing.
 *   3. After a profile is chosen, optionally narrow the bundled skill
 *      set: list the profile's skills/* subdirs and let the operator
 *      keep all (default), drop them all, or pass an explicit
 *      comma-separated subset via --skills.
 *
 * Stays flag-driven for non-interactive flows: passing --profile and
 * --skills (or SWITCHROOM_PROFILE / SWITCHROOM_SKILLS env vars) skips
 * the picker entirely. The interactive path is only entered when the
 * profile flag is absent AND a `readLine` reader is available.
 *
 * All I/O is injected:
 *   - log: where the picker copy goes (defaults to console.log)
 *   - readLine: how we slurp the operator's choice (no default)
 *   - listProfiles: how we discover candidates (defaults to
 *     listAvailableProfiles — tests inject a fake to avoid touching
 *     the real profiles/ dir)
 *   - listProfileSkills: how we discover bundled skills under a
 *     profile (defaults to a real readdir on profiles/<name>/skills)
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { listAvailableProfiles, PROFILES_ROOT } from "../agents/profiles.js";

/**
 * Short description per profile — kept as a static map so the picker UI
 * has something to show even if the profile dir doesn't ship a README.
 * Unknown profiles render with an empty gloss; that's fine.
 */
const PROFILE_GLOSSES: Record<string, string> = {
  default: "minimal baseline — generic chat helper, no opinion.",
  coding: "developer copilot — architecture + code-review skills.",
  "executive-assistant": "schedule + comms — daily briefing, meeting prep.",
  "health-coach": "wellness coach — daily check-ins, weekly reviews.",
};

export interface ProfilePickerOpts {
  /** Optional: profile already chosen (--profile flag or env). Skips the picker. */
  existingProfile?: string;
  /**
   * Optional: explicit skills selector (--skills flag or env). One of:
   *   - "all"  → keep every bundled skill (the default behaviour)
   *   - "none" → drop them all
   *   - "a,b"  → comma-separated subset; unknown names error loudly
   * When omitted we either run the interactive picker (if readLine is
   * present) or default to "all".
   */
  existingSkills?: string;
  /**
   * Reader used for the interactive prompt. When omitted and no
   * existingProfile is supplied, the picker throws — non-interactive
   * runs must supply --profile up-front.
   */
  readLine?: (prompt: string) => Promise<string>;
  /** Logger for picker copy. Defaults to console.log. */
  log?: (line: string) => void;
  /** Test seam — defaults to listAvailableProfiles. */
  listProfiles?: () => string[];
  /**
   * Test seam — given a profile name, return the names of subdirs under
   * profiles/<name>/skills/ (each is a bundled skill). Defaults to a
   * real readdir against the project's profiles/ root.
   */
  listProfileSkills?: (profileName: string) => string[];
  /**
   * Maximum number of re-prompts on bad input before giving up. Default 3.
   */
  maxAttempts?: number;
}

export interface ProfilePickerResult {
  /** The validated profile name to extend from. */
  profile: string;
  /**
   * The set of bundled skill names to keep (matches subdir names under
   * profiles/<profile>/skills/). Empty array means "drop all bundled
   * skills". When the chosen profile ships no skills/, this is also [].
   */
  skills: string[];
  /**
   * The full set of bundled skill names available under the chosen
   * profile, before any picker narrowing. Empty if the profile ships
   * no skills/. Useful for downstream pruning ("which subdirs should
   * I touch?") so we don't accidentally remove unrelated files.
   */
  allSkills: string[];
  /** True iff the picker ran interactively (i.e. no --profile flag). */
  pickerShown: boolean;
}

const DEFAULT_MAX_ATTEMPTS = 3;
// Reuse the layout-aware profiles root from ../agents/profiles.js so the
// dev/npm vs. Docker-image resolution (#3346) lives in exactly one place.

/**
 * Default real-fs implementation of listProfileSkills. Returns the
 * subdirectory names under profiles/<name>/skills/, or [] if that path
 * doesn't exist.
 */
export function defaultListProfileSkills(profileName: string): string[] {
  const skillsDir = resolve(PROFILES_ROOT, profileName, "skills");
  if (!existsSync(skillsDir)) {
    return [];
  }
  try {
    return readdirSync(skillsDir)
      .filter((entry) => {
        try {
          return statSync(resolve(skillsDir, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * Run the picker. Returns the validated profile + skill subset, or
 * throws with an actionable message.
 */
export async function runProfilePicker(
  opts: ProfilePickerOpts,
): Promise<ProfilePickerResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const listProfiles = opts.listProfiles ?? listAvailableProfiles;
  const listSkills = opts.listProfileSkills ?? defaultListProfileSkills;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const available = listProfiles();
  if (available.length === 0) {
    throw new Error(
      "No profiles are available on disk. Expected at least 'default' under profiles/.",
    );
  }

  // ── Fast path: profile already in hand ────────────────────────────────────
  if (opts.existingProfile) {
    if (!available.includes(opts.existingProfile)) {
      throw new Error(
        `Unknown profile: "${opts.existingProfile}". ` +
          `Available: ${available.join(", ")}.`,
      );
    }
    const skills = resolveSkillsSelection(
      opts.existingProfile,
      opts.existingSkills,
      listSkills,
    );
    return {
      profile: opts.existingProfile,
      skills,
      allSkills: listSkills(opts.existingProfile),
      pickerShown: false,
    };
  }

  // ── Interactive path requires a reader ────────────────────────────────────
  if (!opts.readLine) {
    throw new Error(
      "No --profile supplied and no interactive reader available. " +
        `Re-run with --profile <name> (one of: ${available.join(", ")}) or set SWITCHROOM_PROFILE.`,
    );
  }

  const profile = await pickProfileInteractive({
    available,
    readLine: opts.readLine,
    log,
    maxAttempts,
  });

  const allSkills = listSkills(profile);
  let skills: string[];
  if (opts.existingSkills !== undefined) {
    // --skills was passed alongside the interactive profile pick: honour it.
    skills = resolveSkillsSelection(profile, opts.existingSkills, listSkills);
  } else if (allSkills.length === 0) {
    skills = [];
  } else {
    skills = await pickSkillsInteractive({
      profile,
      allSkills,
      readLine: opts.readLine,
      log,
      maxAttempts,
    });
  }

  return { profile, skills, allSkills, pickerShown: true };
}

interface PickProfileArgs {
  available: string[];
  readLine: (prompt: string) => Promise<string>;
  log: (line: string) => void;
  maxAttempts: number;
}

async function pickProfileInteractive(args: PickProfileArgs): Promise<string> {
  const { available, readLine, log, maxAttempts } = args;
  log("");
  log("  Pick a profile for this agent:");
  log("");
  available.forEach((name, idx) => {
    const gloss = PROFILE_GLOSSES[name] ?? "";
    const padded = String(idx + 1).padStart(2, " ");
    if (gloss) {
      log(`    ${padded}. ${name}  —  ${gloss}`);
    } else {
      log(`    ${padded}. ${name}`);
    }
  });
  log("");

  let lastErr: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt =
      attempt === 1
        ? "  Choose a profile (number or name): "
        : `  Choose a profile (attempt ${attempt}/${maxAttempts}): `;
    const raw = (await readLine(prompt)).trim();
    if (!raw) {
      lastErr = "empty input";
      log("  ! Empty selection — try again.");
      continue;
    }
    // Number?
    const num = Number.parseInt(raw, 10);
    if (Number.isFinite(num) && String(num) === raw) {
      if (num >= 1 && num <= available.length) {
        return available[num - 1]!;
      }
      lastErr = `out-of-range (${num})`;
      log(`  ! ${num} is out of range (1..${available.length}).`);
      continue;
    }
    // Name match?
    if (available.includes(raw)) {
      return raw;
    }
    lastErr = `unknown profile "${raw}"`;
    log(`  ! Unknown profile "${raw}". Valid: ${available.join(", ")}.`);
  }
  throw new Error(
    `Profile picker failed after ${maxAttempts} attempts (last: ${lastErr ?? "unknown"}). ` +
      `Re-run with --profile <name>.`,
  );
}

interface PickSkillsArgs {
  profile: string;
  allSkills: string[];
  readLine: (prompt: string) => Promise<string>;
  log: (line: string) => void;
  maxAttempts: number;
}

async function pickSkillsInteractive(args: PickSkillsArgs): Promise<string[]> {
  const { profile, allSkills, readLine, log, maxAttempts } = args;
  log("");
  log(`  Profile "${profile}" bundles ${allSkills.length} skill${allSkills.length === 1 ? "" : "s"}:`);
  allSkills.forEach((name, idx) => {
    const padded = String(idx + 1).padStart(2, " ");
    log(`    ${padded}. ${name}`);
  });
  log("");
  log('  Press Enter to keep all, type "none" to drop all, or pass a comma-');
  log("  separated subset (numbers or names, e.g. 1,3 or check-in,weekly-review).");
  log("");

  let lastErr: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = (await readLine("  Skills: ")).trim();
    if (!raw) {
      return [...allSkills];
    }
    if (raw.toLowerCase() === "all") {
      return [...allSkills];
    }
    if (raw.toLowerCase() === "none") {
      return [];
    }
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const picked: string[] = [];
    let badPart: string | undefined;
    for (const part of parts) {
      const num = Number.parseInt(part, 10);
      if (Number.isFinite(num) && String(num) === part) {
        if (num >= 1 && num <= allSkills.length) {
          picked.push(allSkills[num - 1]!);
        } else {
          badPart = `out-of-range (${num})`;
          break;
        }
      } else if (allSkills.includes(part)) {
        picked.push(part);
      } else {
        badPart = `unknown skill "${part}"`;
        break;
      }
    }
    if (badPart) {
      lastErr = badPart;
      log(`  ! ${badPart}. Try again.`);
      continue;
    }
    // De-dupe while preserving order.
    return [...new Set(picked)];
  }
  throw new Error(
    `Skill picker failed after ${maxAttempts} attempts (last: ${lastErr ?? "unknown"}). ` +
      `Re-run with --skills all|none|<comma-list>.`,
  );
}

/**
 * Parse the --skills selector against the bundled skill list. Exported
 * so the CLI can validate up-front (before kicking off the wizard) when
 * --skills is supplied with --profile.
 */
export function resolveSkillsSelection(
  profile: string,
  selector: string | undefined,
  listSkills: (profileName: string) => string[],
): string[] {
  const all = listSkills(profile);
  if (selector === undefined || selector === "" || selector.toLowerCase() === "all") {
    return all;
  }
  if (selector.toLowerCase() === "none") {
    return [];
  }
  const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
  const picked: string[] = [];
  for (const part of parts) {
    if (!all.includes(part)) {
      throw new Error(
        `Unknown skill "${part}" for profile "${profile}". ` +
          `Available: ${all.length ? all.join(", ") : "(none)"}.`,
      );
    }
    picked.push(part);
  }
  return [...new Set(picked)];
}
