/**
 * Guard: every skill a PROFILE TEMPLATE names must actually be runnable by the
 * agent that renders it (switchroom #3929).
 *
 * `profiles/**\/*.hbs` renders into each agent's `CLAUDE.md` / `start.sh`, so a
 * skill named there is an instruction the agent will act on autonomously. For
 * that instruction to be executable, two things must hold:
 *
 *   1. The skill SHIPS — `skills/<name>/SKILL.md` exists in the package
 *      (`package.json` "files" includes `skills`, and `switchroom update`
 *      syncs that payload into `~/.switchroom/skills/_bundled/`).
 *   2. The skill is INSTALLED for every agent — it is a declared builtin
 *      default (`getBuiltinDefaultSkillEntries()`), which is what symlinks it
 *      into `<agent>/.claude/skills/`. A profile template renders for every
 *      agent using that profile, so naming a skill that is only available
 *      on-demand or foreman-only leaves most agents with a dead instruction.
 *
 * A reference that satisfies neither is a "ghost skill": referenced everywhere,
 * runnable nowhere. The agent then either fails to find it or improvises, and
 * both are worse than the guidance naming a path that exists.
 *
 * The sibling packaging guard in `src/agents/reconcile-default-skills.test.ts`
 * pins the other direction (declared defaults ⊆ shipped `skills/`). Neither one
 * subsumes the other: that one cannot see a template naming a skill that was
 * never declared, and this one cannot see a declared default that stopped
 * shipping.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getBuiltinDefaultSkillEntries } from "../src/memory/scaffold-integration.js";

// tests/<thisfile> → repo root is one level up.
const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const profilesDir = join(repoRoot, "profiles");
const skillsDir = join(repoRoot, "skills");

/** Skill directory names are kebab-case with at least two segments. Requiring
 *  a hyphen is what keeps prose words (`retain`, `reflect`) out of the match. */
const SKILL_NAME = "[a-z][a-z0-9]*(?:-[a-z0-9]+)+";
const BACKTICKED = /`([^`\n]+)`/g;
const SKILLS_PATH = new RegExp(String.raw`(?<![\w/-])skills\/(${SKILL_NAME})(?![\w-])`, "g");
const IS_SKILL_NAME = new RegExp(`^${SKILL_NAME}$`);

/**
 * Names the extractor MUST still find. This is the anti-vacuity ratchet: an
 * extractor that silently stops matching (a reworded sentence that drops the
 * word "skill", a regex tightened too far) would otherwise pass on an empty
 * set and this whole guard would go quiet without anyone noticing.
 *
 * Removing an entry is a deliberate, reviewable edit — do it in the same PR
 * that removes the reference from the template.
 */
const EXPECTED_TEMPLATE_SKILL_REFERENCES = [
  "mental-model-curator",
  "switchroom-runtime",
] as const;

interface SkillReference {
  name: string;
  where: string;
}

function handlebarsTemplates(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...handlebarsTemplates(p));
    else if (entry.name.endsWith(".hbs")) out.push(p);
  }
  return out.sort();
}

/**
 * Collect skill references from one template. Two deterministic shapes, both
 * of which the current templates use:
 *
 *   - a backticked kebab-case token on a line that also says "skill"
 *     (`(or run the \`mental-model-curator\` skill)`), and
 *   - a `skills/<name>` path (`skills/switchroom-runtime/SKILL.md`), which is
 *     unambiguous on its own and needs no nearby keyword.
 */
function extractSkillReferences(file: string, body: string): SkillReference[] {
  const refs: SkillReference[] = [];
  body.split("\n").forEach((line, idx) => {
    const where = `${file}:${idx + 1}`;
    if (/skill/i.test(line)) {
      for (const m of line.matchAll(BACKTICKED)) {
        const token = m[1].trim();
        if (IS_SKILL_NAME.test(token)) refs.push({ name: token, where });
      }
    }
    for (const m of line.matchAll(SKILLS_PATH)) {
      refs.push({ name: m[1], where });
    }
  });
  return refs;
}

function collectAllReferences(): SkillReference[] {
  const templates = handlebarsTemplates(profilesDir);
  // Sanity: if profiles/ ever stops yielding templates, every assertion below
  // becomes vacuous.
  expect(templates.length).toBeGreaterThan(0);
  return templates.flatMap((file) =>
    extractSkillReferences(file.slice(repoRoot.length + 1), readFileSync(file, "utf8")),
  );
}

describe("profile templates only name skills agents can actually run", () => {
  it("finds the known skill references (extractor has not gone silent)", () => {
    const found = new Set(collectAllReferences().map((r) => r.name));
    for (const name of EXPECTED_TEMPLATE_SKILL_REFERENCES) {
      expect(
        found.has(name),
        `profiles/ no longer yields a detectable reference to the "${name}" skill. ` +
          `Either the reference was removed (drop it from ` +
          `EXPECTED_TEMPLATE_SKILL_REFERENCES in the same PR) or it was reworded ` +
          `into a shape the extractor cannot see (restore a \`${name}\` backtick on ` +
          `a line mentioning "skill", or a skills/${name} path) — otherwise this ` +
          `guard silently stops covering it.`,
      ).toBe(true);
    }
  });

  it("every skill named in profiles/**/*.hbs ships in the package skills/ dir", () => {
    // Sanity: skills/ must exist, or the check is vacuous.
    expect(existsSync(skillsDir)).toBe(true);

    const unshipped = collectAllReferences().filter(
      (r) => !existsSync(join(skillsDir, r.name, "SKILL.md")),
    );
    expect(
      unshipped.map((r) => `${r.name} (${r.where})`),
      "profile template(s) name a skill with no skills/<name>/SKILL.md. Ship the " +
        "skill or stop naming it — an agent told to run a skill that does not " +
        "exist either fails to find it or improvises.",
    ).toEqual([]);
  });

  it("every skill named in profiles/**/*.hbs is a builtin default (so it is installed)", () => {
    const defaults = new Set(getBuiltinDefaultSkillEntries().map((e) => e.key));
    // Sanity: the defaults list must be non-empty, or the check is vacuous.
    expect(defaults.size).toBeGreaterThan(0);

    const notInstalled = collectAllReferences().filter((r) => !defaults.has(r.name));
    expect(
      notInstalled.map((r) => `${r.name} (${r.where})`),
      "profile template(s) name a skill that is not in " +
        "getBuiltinDefaultSkillEntries(), so it is never symlinked into an " +
        "agent's .claude/skills/. Add it to the builtin defaults or stop naming " +
        "it in a template that renders for every agent.",
    ).toEqual([]);
  });
});
