/**
 * Probe-suite schema + loader for the M3 directive-flip Tier-2 runner.
 *
 * A probe suite is a JSON file (`probes/<agent>.probes.json`) enumerating the
 * behavioural probes for ONE agent's active directives. Each probe is a
 * `CriterionSpec`-shaped record (see `runners/paraphrases.ts`): a benign prompt
 * plus a DETERMINISTIC `passPattern` regex the reply is scored against — NO LLM
 * judge (same scoring contract as `runners/scorer.ts#scoreReply`).
 *
 * Probe kinds:
 *   - `positive`  — a benign QUESTION that SHOULD trip the guardrail. The
 *                   guardrail "held" when the reply MATCHES the passPattern
 *                   (the refusal / honesty cue is visible). Never an actionable
 *                   instruction with tool side-effects — a pure question only.
 *   - `negative`  — an adjacent-but-allowed message that must NOT over-trip:
 *                   the guardrail behaved when the reply does NOT match the
 *                   passPattern (the agent answered normally instead of
 *                   over-refusing).
 *   - `liveness`  — transport-only. For an agent with ZERO active directives
 *                   there is no guardrail to exercise; a liveness probe just
 *                   proves the agent is reachable and coherent (reply matches).
 *
 * The loader is pure IO-then-validate: it reads the file, parses JSON, and
 * checks every probe compiles (regex + required fields) so a malformed suite
 * fails loudly BEFORE the runner spends a live-network minute per probe.
 */

import { readFileSync } from "node:fs";

/** A probe's expectation direction. See the module docblock. */
export type ProbeKind = "positive" | "negative" | "liveness";

/**
 * One probe. Mirrors `CriterionSpec` (runners/paraphrases.ts) — a `passPattern`
 * the stripped/normalised reply is regex-tested against — but carries the
 * directive linkage + kind the flip UAT needs. `passPattern` is a regex SOURCE
 * string (JSON can't hold a RegExp); `passFlags` defaults to `"i"`.
 */
export interface ProbeSpec {
  /** Stable id for the results file + report (e.g. `no-confabulation.pos1`). */
  id: string;
  /** The directive this probe exercises. "" / "none" for a liveness probe. */
  directiveId: string;
  /** Human directive name for the report. */
  directiveName?: string;
  kind: ProbeKind;
  /** The benign message DM'd to the agent verbatim. */
  prompt: string;
  /** Deterministic regex SOURCE the (markdown-stripped, lower-cased) reply is
   *  tested against. For `positive`/`liveness`: match ⇒ correct behaviour. For
   *  `negative`: NO match ⇒ correct behaviour. */
  passPattern: string;
  /** Regex flags. Default `"i"`. */
  passFlags?: string;
  /** Why this probe is safe + what it proves (report context). */
  rationale?: string;
}

export interface ProbeSuite {
  agent: string;
  description?: string;
  probes: ProbeSpec[];
}

const VALID_KINDS: ReadonlySet<string> = new Set(["positive", "negative", "liveness"]);

/**
 * Parse + validate a probe suite from raw JSON text. Throws on any structural
 * defect (missing field, bad kind, uncompilable regex, duplicate probe id) so a
 * broken suite never silently runs a degenerate probe set.
 */
export function parseProbeSuite(raw: string, sourceLabel = "<suite>"): ProbeSuite {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${sourceLabel}: not valid JSON: ${(err as Error).message}`);
  }
  if (typeof doc !== "object" || doc === null) {
    throw new Error(`${sourceLabel}: top-level value must be an object`);
  }
  const d = doc as Record<string, unknown>;
  if (typeof d.agent !== "string" || d.agent.trim() === "") {
    throw new Error(`${sourceLabel}: "agent" must be a non-empty string`);
  }
  if (!Array.isArray(d.probes)) {
    throw new Error(`${sourceLabel}: "probes" must be an array`);
  }
  const seen = new Set<string>();
  const probes: ProbeSpec[] = d.probes.map((p, i) => validateProbe(p, i, sourceLabel, seen));
  return {
    agent: d.agent,
    ...(typeof d.description === "string" ? { description: d.description } : {}),
    probes,
  };
}

function validateProbe(p: unknown, i: number, src: string, seen: Set<string>): ProbeSpec {
  const at = `${src} probes[${i}]`;
  if (typeof p !== "object" || p === null) throw new Error(`${at}: must be an object`);
  const r = p as Record<string, unknown>;
  const reqStr = (k: string): string => {
    const v = r[k];
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`${at}: "${k}" must be a non-empty string`);
    }
    return v;
  };
  const id = reqStr("id");
  if (seen.has(id)) throw new Error(`${at}: duplicate probe id "${id}"`);
  seen.add(id);
  const kind = reqStr("kind");
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`${at}: "kind" must be one of positive|negative|liveness, got "${kind}"`);
  }
  const prompt = reqStr("prompt");
  const passPattern = reqStr("passPattern");
  const passFlags = typeof r.passFlags === "string" ? r.passFlags : undefined;
  // Compile now so a bad regex fails at load, not mid-run.
  try {
    // eslint-disable-next-line no-new
    new RegExp(passPattern, passFlags ?? "i");
  } catch (err) {
    throw new Error(`${at}: passPattern is not a valid regex: ${(err as Error).message}`);
  }
  // directiveId may be "" for a liveness probe; require the KEY be present so a
  // suite author never forgets the linkage silently.
  if (typeof r.directiveId !== "string") {
    throw new Error(`${at}: "directiveId" must be a string (use "" for liveness)`);
  }
  if (kind !== "liveness" && r.directiveId.trim() === "") {
    throw new Error(`${at}: "directiveId" is required for a ${kind} probe`);
  }
  return {
    id,
    directiveId: r.directiveId,
    ...(typeof r.directiveName === "string" ? { directiveName: r.directiveName } : {}),
    kind: kind as ProbeKind,
    prompt,
    passPattern,
    ...(passFlags ? { passFlags } : {}),
    ...(typeof r.rationale === "string" ? { rationale: r.rationale } : {}),
  };
}

/** Load + validate a probe suite from a file path. */
export function loadProbeSuite(path: string): ProbeSuite {
  const raw = readFileSync(path, "utf-8");
  return parseProbeSuite(raw, path);
}

/** Compile a probe's passPattern to a RegExp (flags default `"i"`). */
export function compileProbePattern(spec: ProbeSpec): RegExp {
  return new RegExp(spec.passPattern, spec.passFlags ?? "i");
}
