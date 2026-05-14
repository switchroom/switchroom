/**
 * Rule-based corpus generator for the skill-coverage harness.
 *
 * Emits a JSONL of `ProbeRecord` per in-scope skill at
 * `tests/skill-coverage/corpus/<skill>.jsonl`. Per-skill counts:
 *   - 6 paraphrases  (template rewrites of trigger_phrases)
 *   - 3 typos        (transposition / drop / autocorrect-style)
 *   - 3 slang        ("how do I", "yo", "any way to" casual register)
 *   - 3 indirect     (symptom phrasing — "X is acting weird")
 *   - 4 negatives    (drawn from ADJACENT skills' trigger space)
 *
 * Deterministic: given the same skills.json + seed, output is byte-stable.
 * No LLM at corpus-gen time — that's the v2 paraphrase pass. v1 also
 * picks up curated `corpus/seeds/<skill>.yaml` entries when present.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ProbeKind,
  ProbeRecord,
  SkillFixture,
  SkillsFixtureFile,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = resolve(__dirname, "..", "fixtures", "skills.json");
const CORPUS_DIR = resolve(__dirname);
const SEEDS_DIR = resolve(__dirname, "seeds");

const PARAPHRASE_TEMPLATES: Array<(phrase: string) => string> = [
  (p) => `Can you ${p}?`,
  (p) => `I need to ${p}.`,
  (p) => `Help me ${p}.`,
  (p) => `Could you ${p} for me?`,
  (p) => `Please ${p}.`,
  (p) => `I'd like to ${p}.`,
  (p) => `Let's ${p}.`,
  (p) => `${p.charAt(0).toUpperCase()}${p.slice(1)}, please.`,
];

const SLANG_TEMPLATES: Array<(phrase: string) => string> = [
  (p) => `yo, how do i ${p}`,
  (p) => `any way to ${p}?`,
  (p) => `quick q — can i ${p}`,
  (p) => `hey, ${p}?`,
  (p) => `pls ${p}`,
  (p) => `gonna need to ${p}`,
];

const INDIRECT_TEMPLATES: Record<string, string[]> = {
  // Symptom phrasings keyed by skill id. Falls back to a generic
  // "something is going on with X" when no entry exists.
  "switchroom-health": [
    "my agents are acting weird",
    "things feel off",
    "the fleet is sluggish",
  ],
  "switchroom-cli": [
    "the agent just disappeared on me",
    "I don't know what version is live",
    "I want to know what happened last night",
  ],
  "switchroom-status": [
    "is anything running right now",
    "how's the fleet doing",
    "what's alive right now",
  ],
  "file-bug": [
    "this needs to be tracked somewhere",
    "I want a paper trail for this",
    "remember this for later",
  ],
  pdf: [
    "I have this pdf I can't deal with",
    "can you help me with this scan",
    "the form won't let me type into it",
  ],
  docx: [
    "the formatting in this Word file is broken",
    "I need to send a polished doc",
    "this letter needs to look professional",
  ],
  xlsx: [
    "this csv is a mess",
    "the columns are all wrong in this sheet",
    "I need to crunch some numbers in a sheet",
  ],
  pptx: [
    "I need slides for tomorrow",
    "this deck looks terrible",
    "the presentation needs polishing",
  ],
  humanizer: [
    "this paragraph screams ChatGPT",
    "the prose sounds robotic",
    "this reads like AI slop",
  ],
  "buildkite-pipelines": [
    "my pipeline.yml is a mess",
    "the build is slow",
    "tests run in serial when they shouldn't",
  ],
  "buildkite-cli": [
    "I want to do this from the terminal",
    "scripting it locally would be easier",
    "I'd rather not click around the UI",
  ],
};

const TYPO_RULES: Array<(phrase: string) => string> = [
  // Transpose two adjacent letters near the middle.
  (p) => {
    if (p.length < 6) return p;
    const i = Math.floor(p.length / 2);
    return p.slice(0, i) + p.charAt(i + 1) + p.charAt(i) + p.slice(i + 2);
  },
  // Drop a letter ~1/3 in.
  (p) => {
    if (p.length < 6) return p;
    const i = Math.floor(p.length / 3);
    return p.slice(0, i) + p.slice(i + 1);
  },
  // Autocorrect-style — replace a short common word.
  (p) => p.replace(/\bthe\b/i, "teh").replace(/\band\b/i, "adn"),
  // Double a letter.
  (p) => {
    if (p.length < 4) return p;
    const i = Math.floor(p.length / 2);
    return p.slice(0, i) + p.charAt(i) + p.slice(i);
  },
];

export interface GenerateOptions {
  seed: number;
  /** Override; defaults to fixture file alongside this script. */
  fixturesPath?: string;
  /** Skill ids to include — null/empty = all in_default_pool. */
  onlySkills?: string[] | null;
}

export interface GenerateResult {
  /** All probes, grouped by target skill (null bucket holds free negatives). */
  bySkill: Record<string, ProbeRecord[]>;
  /** Skills considered out of scope (user_invocable=false or not in pool). */
  skipped: string[];
}

/**
 * Deterministic hash for probe ids. We mix seed in so that different
 * seeds produce different ids for the same phrase — the runner uses
 * ids as primary keys when persisting results.
 */
function probeId(skill: string | null, kind: ProbeKind, phrase: string, seed: number): string {
  const h = createHash("sha256");
  h.update(`${skill ?? "<null>"}|${kind}|${phrase}|${seed}`);
  return h.digest("hex").slice(0, 16);
}

/**
 * Tiny seedable RNG. Used to pick template indices deterministically.
 * mulberry32 — small state, good enough for non-crypto sampling.
 */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Per-skill seed: rng is reseeded from (globalSeed, skillId) so the
 * order in which we walk skills doesn't perturb individual outputs.
 */
function skillRng(seed: number, skillId: string): () => number {
  const h = createHash("sha256");
  h.update(`${seed}|${skillId}`);
  // Take the first 4 bytes as a u32 seed.
  const buf = h.digest();
  const localSeed = buf.readUInt32BE(0);
  return mulberry32(localSeed);
}

/** Round-robin take of `n` items from `items`, using rng to rotate. */
function pickN<T>(items: T[], n: number, rng: () => number): T[] {
  if (items.length === 0) return [];
  const offset = Math.floor(rng() * items.length);
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    out.push(items[(offset + i) % items.length]);
  }
  return out;
}

interface SeedYaml {
  paraphrases?: string[];
  typos?: string[];
  slang?: string[];
  indirect?: string[];
  negatives?: Array<{ phrase: string; expectedOtherSkill?: string }>;
}

/**
 * Minimal YAML parser for the seeds files — enough to handle the
 * shapes we document. We only need: top-level keys, list of scalars,
 * and a `negatives:` list-of-objects with `phrase:` + optional
 * `expectedOtherSkill:`. Bringing the `yaml` dep in would be fine,
 * but keeping this dep-free makes the harness portable.
 */
function parseSeedYaml(src: string): SeedYaml {
  const out: SeedYaml = {};
  const lines = src.split(/\r?\n/);
  let currentKey: keyof SeedYaml | null = null;
  let pendingNeg: { phrase?: string; expectedOtherSkill?: string } | null = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const topKey = line.match(/^([a-zA-Z_]+):\s*$/);
    if (topKey) {
      if (pendingNeg && pendingNeg.phrase != null) {
        (out.negatives ??= []).push(pendingNeg as { phrase: string; expectedOtherSkill?: string });
        pendingNeg = null;
      }
      const k = topKey[1] as keyof SeedYaml;
      currentKey = k;
      if (k === "negatives") out.negatives ??= [];
      continue;
    }
    if (currentKey == null) continue;
    if (currentKey === "negatives") {
      const bullet = line.match(/^\s*-\s*phrase:\s*"(.+)"\s*$/);
      if (bullet) {
        if (pendingNeg && pendingNeg.phrase != null) {
          out.negatives!.push(pendingNeg as { phrase: string; expectedOtherSkill?: string });
        }
        pendingNeg = { phrase: bullet[1] };
        continue;
      }
      const ext = line.match(/^\s+expectedOtherSkill:\s*"?([^"\s]+)"?\s*$/);
      if (ext && pendingNeg) {
        pendingNeg.expectedOtherSkill = ext[1];
        continue;
      }
      const bareBullet = line.match(/^\s*-\s*"(.+)"\s*$/);
      if (bareBullet) {
        if (pendingNeg && pendingNeg.phrase != null) {
          out.negatives!.push(pendingNeg as { phrase: string; expectedOtherSkill?: string });
        }
        pendingNeg = { phrase: bareBullet[1] };
        continue;
      }
    } else {
      const m = line.match(/^\s*-\s*"?(.+?)"?\s*$/);
      if (m) {
        const arr = (out[currentKey] as string[] | undefined) ?? [];
        arr.push(m[1]);
        out[currentKey] = arr as never;
      }
    }
  }
  if (pendingNeg && pendingNeg.phrase != null) {
    (out.negatives ??= []).push(pendingNeg as { phrase: string; expectedOtherSkill?: string });
  }
  return out;
}

function loadSeedYaml(skillId: string): SeedYaml | null {
  const p = join(SEEDS_DIR, `${skillId}.yaml`);
  if (!existsSync(p)) return null;
  try {
    return parseSeedYaml(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function loadFixtures(path: string = FIXTURES_PATH): SkillsFixtureFile {
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as SkillsFixtureFile;
}

/**
 * Synthesise the per-skill probe set. Pure function — no I/O.
 * Exposed for unit tests.
 */
export function generateForSkill(
  skill: SkillFixture,
  allSkills: SkillFixture[],
  seed: number,
): ProbeRecord[] {
  const rng = skillRng(seed, skill.id);
  const probes: ProbeRecord[] = [];
  const seenPhrases = new Set<string>();

  const push = (
    rec: Omit<ProbeRecord, "id"> & { phrase: string },
  ): void => {
    const phrase = rec.phrase.trim();
    if (!phrase) return;
    if (seenPhrases.has(phrase.toLowerCase())) return;
    seenPhrases.add(phrase.toLowerCase());
    probes.push({
      id: probeId(rec.targetSkill, rec.kind, phrase, seed),
      ...rec,
      phrase,
    });
  };

  const triggers = skill.trigger_phrases.length > 0 ? skill.trigger_phrases : [skill.description];

  /**
   * Prepend the skill's `context_prefix` (if any) to a rule-generated
   * phrase. Round-3 analysis (`scorecards/round-3.scorecard.md`)
   * showed median F1=0.33: bare paraphrases like "Help me retry a
   * build" lacked domain context, so the model answered
   * conversationally instead of firing the Skill tool. The prefix
   * resupplies that context cheaply. Negative controls are NEVER
   * prefixed — they're drawn from adjacent-skill triggers to test
   * cross-skill confusion, and a prefix would defeat the test.
   * Author-curated seed-yaml probes are also left alone (callers
   * who write seeds opt out of this behaviour by construction).
   */
  const withPrefix = (phrase: string): string => {
    if (!skill.context_prefix) return phrase;
    return `${skill.context_prefix}${phrase}`;
  };

  // Curated seeds get prepended for each category; they take priority
  // and are deduped against the rule-based variants below.
  const yaml = loadSeedYaml(skill.id);
  if (yaml?.paraphrases) {
    for (const p of yaml.paraphrases) {
      push({ targetSkill: skill.id, kind: "paraphrase", phrase: p, source: "seed-yaml" });
    }
  }
  if (yaml?.typos) {
    for (const p of yaml.typos) {
      push({ targetSkill: skill.id, kind: "typo", phrase: p, source: "seed-yaml" });
    }
  }
  if (yaml?.slang) {
    for (const p of yaml.slang) {
      push({ targetSkill: skill.id, kind: "slang", phrase: p, source: "seed-yaml" });
    }
  }
  if (yaml?.indirect) {
    for (const p of yaml.indirect) {
      push({ targetSkill: skill.id, kind: "indirect", phrase: p, source: "seed-yaml" });
    }
  }
  if (yaml?.negatives) {
    for (const n of yaml.negatives) {
      push({
        targetSkill: null,
        kind: "negative",
        phrase: n.phrase,
        source: "seed-yaml",
        expectedOtherSkill: n.expectedOtherSkill,
      });
    }
  }

  // ── paraphrases: 6
  for (let i = probes.filter((p) => p.kind === "paraphrase").length; i < 6; i++) {
    const trigger = triggers[Math.floor(rng() * triggers.length)];
    const tmpl = PARAPHRASE_TEMPLATES[Math.floor(rng() * PARAPHRASE_TEMPLATES.length)];
    push({
      targetSkill: skill.id,
      kind: "paraphrase",
      phrase: withPrefix(tmpl(trigger)),
      source: "paraphrase-template",
    });
  }

  // ── typos: 3
  for (let i = probes.filter((p) => p.kind === "typo").length; i < 3; i++) {
    const trigger = triggers[Math.floor(rng() * triggers.length)];
    const rule = TYPO_RULES[Math.floor(rng() * TYPO_RULES.length)];
    push({
      targetSkill: skill.id,
      kind: "typo",
      phrase: withPrefix(rule(trigger)),
      source: "typo-rule",
    });
  }

  // ── slang: 3
  for (let i = probes.filter((p) => p.kind === "slang").length; i < 3; i++) {
    const trigger = triggers[Math.floor(rng() * triggers.length)];
    const tmpl = SLANG_TEMPLATES[Math.floor(rng() * SLANG_TEMPLATES.length)];
    push({
      targetSkill: skill.id,
      kind: "slang",
      phrase: withPrefix(tmpl(trigger)),
      source: "slang-template",
    });
  }

  // ── indirect: 3 (curated table preferred, fallback to generic). Honour
  // the existing yaml-seeded count so cap-aware generation matches paraphrase/
  // typo/slang above — 3 yaml + 3 template = 6 would violate the documented
  // per-category cap that tests/skill-coverage/tests/corpus.test.ts pins.
  const indirectRemaining = Math.max(
    0,
    3 - probes.filter((p) => p.kind === "indirect").length,
  );
  const indirectPool =
    INDIRECT_TEMPLATES[skill.id] ?? [
      `something is going on with ${skill.id}`,
      `the ${skill.id} thing is weird`,
      `can you take a look at the ${skill.id} situation`,
    ];
  const indirects = pickN(indirectPool, indirectRemaining, rng);
  for (const phrase of indirects) {
    push({
      targetSkill: skill.id,
      kind: "indirect",
      phrase: withPrefix(phrase),
      source: "indirect-template",
    });
  }

  // ── negative controls: 4 drawn from adjacent skills
  const adjacent = skill.adjacent_skills
    .map((id) => allSkills.find((s) => s.id === id))
    .filter((s): s is SkillFixture => !!s);
  if (adjacent.length > 0) {
    // Walk adjacents round-robin until we have 4.
    let need = 4 - probes.filter((p) => p.kind === "negative").length;
    let idx = 0;
    let guard = 0;
    while (need > 0 && guard < 32) {
      const adj = adjacent[idx % adjacent.length];
      const trigger = adj.trigger_phrases[Math.floor(rng() * Math.max(adj.trigger_phrases.length, 1))];
      if (trigger) {
        push({
          targetSkill: null,
          kind: "negative",
          phrase: trigger,
          source: "negative-from-adjacent",
          expectedOtherSkill: adj.id,
        });
      }
      idx++;
      guard++;
      need = 4 - probes.filter((p) => p.kind === "negative").length;
    }
  }

  return probes;
}

export function generateCorpus(opts: GenerateOptions): GenerateResult {
  const { seed, fixturesPath, onlySkills } = opts;
  const fixtures = loadFixtures(fixturesPath);
  const inScope = fixtures.skills.filter(
    (s) =>
      s.user_invocable &&
      s.in_default_pool &&
      (!onlySkills || onlySkills.length === 0 || onlySkills.includes(s.id)),
  );
  const skipped = fixtures.skills
    .filter((s) => !s.user_invocable || !s.in_default_pool)
    .map((s) => s.id);

  const bySkill: Record<string, ProbeRecord[]> = {};
  for (const skill of inScope) {
    bySkill[skill.id] = generateForSkill(skill, fixtures.skills, seed);
  }
  return { bySkill, skipped };
}

/** Stable JSONL serialise: one record per line, keys in declared order. */
export function probesToJsonl(probes: ProbeRecord[]): string {
  return (
    probes
      .map((p) =>
        JSON.stringify({
          id: p.id,
          targetSkill: p.targetSkill,
          kind: p.kind,
          phrase: p.phrase,
          source: p.source,
          ...(p.expectedOtherSkill ? { expectedOtherSkill: p.expectedOtherSkill } : {}),
        }),
      )
      .join("\n") + "\n"
  );
}

/** CLI entry — writes JSONL files under tests/skill-coverage/corpus/. */
export function writeCorpusFiles(result: GenerateResult, outDir: string = CORPUS_DIR): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const [skill, probes] of Object.entries(result.bySkill)) {
    const p = join(outDir, `${skill}.jsonl`);
    writeFileSync(p, probesToJsonl(probes));
    written.push(p);
  }
  return written;
}

// ── CLI entrypoint ────────────────────────────────────────────────────────
// Run as: `bun tests/skill-coverage/corpus/generate-corpus.ts [--seed=N] [--skills=a,b]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  let seed = 1;
  let onlySkills: string[] | null = null;
  for (const a of argv) {
    const sm = a.match(/^--seed=(\d+)$/);
    if (sm) seed = Number(sm[1]);
    const km = a.match(/^--skills=(.+)$/);
    if (km) onlySkills = km[1].split(",").map((s) => s.trim()).filter(Boolean);
  }
  const result = generateCorpus({ seed, onlySkills });
  const written = writeCorpusFiles(result);
  // eslint-disable-next-line no-console
  console.log(`wrote ${written.length} jsonl files (seed=${seed})`);
  if (result.skipped.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`skipped (out of scope): ${result.skipped.join(", ")}`);
  }
}
