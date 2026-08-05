/**
 * Agent self-improvement — the EVAL-CASE SINK (RFC amendment §"corrections
 * as eval cases").
 *
 * When an operator corrects the agent, the lesson should not just steer a
 * reflect pass — it should become a *regression test* on the relevant skill,
 * so the eval gate (eval-gate.ts) can prove the skill still handles it. This
 * module is the deterministic library that turns a correction into an entry
 * in a skill's `evals/evals.json` (the schema skill-creator already uses).
 *
 * What lives here (pure, no model, no network):
 *   - parse + fingerprint an eval case (dedup, stable id);
 *   - append a case to a skill's evals.json, ADD-ONLY (prior cases are
 *     preserved verbatim — an append never edits or drops an existing case);
 *   - a held-out sink in the state dir (cases kept OUT of evals.json, so an
 *     edit can't be tuned to pass its own newly-added test);
 *   - a tamper-EVIDENT integrity manifest (sha256 per skill's evals.json)
 *     plus baseline snapshots, so the Stop-hook sweep can detect and
 *     self-heal an out-of-band edit to evals.json.
 *
 * HONESTY (RFC amendment MJ1): the sha256 manifest is tamper-EVIDENT and
 * self-healing, NOT a cryptographic boundary. The manifest and the baseline
 * snapshots both live in the agent-writable state dir, so a model that also
 * rewrites them defeats the check. It is NOT "Bash-proof at decision time."
 * The HARD backstop against a tampered eval causing a bad silent apply is
 * elsewhere: T1 silent-apply (`SWITCHROOM_SELF_IMPROVE_T1_LIVE`) defaults
 * OFF, so no eval — tampered or not — can trigger a silent auto-apply. This
 * manifest is defense-in-depth: it makes drift visible and reverts it.
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

import { evalsJsonPath } from "./eval-gate.js";
import { scanForPII } from "./pii-scan.js";

// ── Schema ───────────────────────────────────────────────────────────

/** One eval case (skill-creator's `evals.json` case shape, loosened). */
export interface EvalCase {
  /** Stable id (assigned on append if absent). */
  id?: string;
  /** The test prompt — the correction, framed as an input. REQUIRED. */
  prompt: string;
  /** Optional reference/expected output. */
  expected_output?: string;
  /** Optional fixture file map (skill-creator supports this; the one-tap
   *  CLI path does not populate it — see the L1 follow-up). */
  files?: string[];
  /** Assertions the grader checks (free-form strings). */
  expectations?: string[];
  /** Provenance — which correction this came from (audit only). */
  source?: string;
}

/** A skill's evals.json document. */
export interface EvalsDoc {
  skill_name?: string;
  evals: EvalCase[];
}

export interface ParsedCase {
  ok: true;
  case: EvalCase;
}
export interface ParseError {
  ok: false;
  error: string;
}

/**
 * Validate + normalize an untrusted eval-case object. The only hard
 * requirement is a non-empty `prompt`; everything else is optional and
 * passed through (unknown fields dropped).
 */
export function parseEvalCase(raw: unknown): ParsedCase | ParseError {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "eval case must be a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.prompt !== "string" || o.prompt.trim().length === 0) {
    return { ok: false, error: "eval case requires a non-empty 'prompt'" };
  }
  const ec: EvalCase = { prompt: o.prompt };
  if (typeof o.id === "string" && o.id.length > 0) ec.id = o.id;
  if (typeof o.expected_output === "string") ec.expected_output = o.expected_output;
  if (typeof o.source === "string") ec.source = o.source;
  if (Array.isArray(o.files) && o.files.every((f) => typeof f === "string")) {
    ec.files = o.files as string[];
  }
  if (
    Array.isArray(o.expectations) &&
    o.expectations.every((e) => typeof e === "string")
  ) {
    ec.expectations = o.expectations as string[];
  }
  return { ok: true, case: ec };
}

/** Normalize a prompt for fingerprinting: trim, collapse ws, lowercase. */
function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Stable djb2 fingerprint of a case's prompt (dedup + id source). */
export function caseFingerprint(prompt: string): string {
  const norm = normalizePrompt(prompt);
  let h = 5381;
  for (let i = 0; i < norm.length; i++) {
    h = ((h << 5) + h + norm.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ── evals.json read / append (ADD-ONLY) ──────────────────────────────

/** Read + validate a skill's evals.json. Returns null when absent/unreadable. */
export function readEvalsDoc(skillDir: string): EvalsDoc | null {
  const p = evalsJsonPath(skillDir);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as EvalsDoc;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.evals)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o644 });
  renameSync(tmp, path);
}

export interface AppendResult {
  ok: true;
  case: EvalCase;
  /** Index of the appended case in the evals array. */
  index: number;
  /** Total case count after the append. */
  total: number;
}
export interface AppendRejected {
  ok: false;
  reason: string;
  /** True when the reason is a duplicate (caller may report "already covered"). */
  duplicate?: boolean;
}

/**
 * Append a case to a skill's evals.json, ADD-ONLY. Existing cases are
 * preserved exactly (we parse, keep the array, and only push). A case whose
 * prompt fingerprint already exists is rejected as a duplicate — the sink is
 * idempotent, so the same correction never bloats the file. An id is
 * assigned from the fingerprint when the case doesn't carry one.
 */
export function appendEvalCase(
  skillDir: string,
  slug: string,
  input: EvalCase,
): AppendResult | AppendRejected {
  const parsed = parseEvalCase(input);
  if (!parsed.ok) return { ok: false, reason: parsed.error };
  const ec = parsed.case;

  const doc: EvalsDoc = readEvalsDoc(skillDir) ?? { skill_name: slug, evals: [] };
  if (!doc.skill_name) doc.skill_name = slug;

  const fp = caseFingerprint(ec.prompt);
  for (const existing of doc.evals) {
    if (typeof existing?.prompt === "string" && caseFingerprint(existing.prompt) === fp) {
      return { ok: false, reason: "duplicate: this correction is already an eval case", duplicate: true };
    }
  }

  if (!ec.id) ec.id = `case-${fp}`;
  // Guard against an id collision with a differently-worded existing case.
  if (doc.evals.some((e) => e?.id === ec.id)) {
    ec.id = `case-${fp}-${doc.evals.length}`;
  }

  const before = doc.evals.length;
  doc.evals.push(ec);
  writeAtomic(evalsJsonPath(skillDir), JSON.stringify(doc, null, 2) + "\n");
  return { ok: true, case: ec, index: before, total: doc.evals.length };
}

// ── Held-out sink (kept OUT of evals.json) ───────────────────────────

export const HELD_OUT_FILE = "self-improve-held-out-evals.jsonl";

/** Path to the per-agent held-out eval sink. */
export function heldOutPath(stateDir: string): string {
  return join(stateDir, HELD_OUT_FILE);
}

/**
 * Append a case to the held-out sink (never into a skill's evals.json), so a
 * skill edit can't be tuned to pass a test it also just authored. Append-only
 * jsonl; each line records the slug, the case, and a timestamp.
 */
export function appendHeldOutCase(
  stateDir: string,
  slug: string,
  ec: EvalCase,
  opts: { now?: () => number } = {},
): void {
  const now = opts.now ?? Date.now;
  mkdirSync(stateDir, { recursive: true });
  const fd = openSync(heldOutPath(stateDir), "a");
  try {
    writeSync(
      fd,
      JSON.stringify({ at: new Date(now()).toISOString(), slug, case: ec }) + "\n",
    );
  } finally {
    closeSync(fd);
  }
}

// ── Tamper-EVIDENT integrity manifest + baseline snapshots ───────────
//
// NOT a cryptographic boundary (MJ1) — see the module header. Self-healing
// defense-in-depth; the real backstop is T1_LIVE defaulting OFF.

export const EVAL_MANIFEST_FILE = "self-improve-eval-manifest.json";
export const EVAL_BASELINE_SUBDIR = "self-improve-eval-baselines";

interface ManifestEntry {
  sha256: string;
  updated_at: string;
  skill_dir: string;
}
type Manifest = Record<string, ManifestEntry>;

function manifestPath(stateDir: string): string {
  return join(stateDir, EVAL_MANIFEST_FILE);
}
function baselineEvalsPath(stateDir: string, slug: string): string {
  return join(stateDir, EVAL_BASELINE_SUBDIR, slug, "evals.json");
}

/** sha256 of a skill's evals.json bytes, or null when it doesn't exist. */
export function evalsSha256(skillDir: string): string | null {
  const p = evalsJsonPath(skillDir);
  if (!existsSync(p)) return null;
  try {
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

function readManifest(stateDir: string): Manifest {
  const p = manifestPath(stateDir);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as Manifest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeManifest(stateDir: string, m: Manifest): void {
  writeAtomic(manifestPath(stateDir), JSON.stringify(m, null, 2) + "\n");
}

/**
 * Record the current evals.json as the sanctioned baseline: update the
 * manifest hash AND snapshot the file. Called by the deterministic applier
 * after every sanctioned append, so the last sanctioned state is always
 * recoverable.
 */
export function recordEvalBaseline(
  stateDir: string,
  slug: string,
  skillDir: string,
  opts: { now?: () => number } = {},
): void {
  const sha = evalsSha256(skillDir);
  if (sha === null) return; // nothing to record
  const now = opts.now ?? Date.now;
  const m = readManifest(stateDir);
  m[slug] = { sha256: sha, updated_at: new Date(now()).toISOString(), skill_dir: skillDir };
  writeManifest(stateDir, m);
  const snap = baselineEvalsPath(stateDir, slug);
  mkdirSync(dirname(snap), { recursive: true });
  copyFileSync(evalsJsonPath(skillDir), snap);
}

/**
 * Is a skill's CURRENT evals.json safe to adopt as a NEW trusted baseline
 * without having gone through the sanctioned applier? (MAJOR 2.)
 *
 * The sanctioned `apply-eval-case` path fail-closed PII/secret-scans every case
 * it appends (invariant I4) and then records the baseline DIRECTLY, so by the
 * time the Stop-hook sweep sees a sanctioned write the status is already "ok" —
 * never "missing". A "missing" (first-sight) or snapshot-less "drift" evals.json
 * therefore appeared OUT OF BAND: a skill-creator hand-author, or — the hole
 * this closes — a Bash redirect that never reached the write-block hook. We must
 * NOT silently trust such bytes: they carry the exact PII/secret leak the scan
 * exists to stop. Before they can become a baseline they run the SAME
 * fail-closed scan the sanctioned path runs. FAIL-CLOSED: an unreadable file OR
 * any finding OR a scan error ⇒ NOT clean (do not trust).
 *
 * This is the deterministic invariant that pairs with the Bash write-block
 * (skill-validate-pretool): even if the command-string heuristic misses an
 * exotic writer, the poisoned bytes never become a trusted baseline here, so
 * drift-detection and the apply-guard's has-evals gate can't be defeated by
 * pre-seeding a first-sight evals.json.
 */
export function evalsBaselineTrusted(skillDir: string): boolean {
  const p = evalsJsonPath(skillDir);
  let text: string;
  try {
    text = readFileSync(p, "utf-8");
  } catch {
    return false; // unreadable ⇒ fail-closed
  }
  return scanForPII(text).ok;
}

export type IntegrityStatus = "ok" | "drift" | "missing" | "no-evals";

/** Compare a skill's current evals.json against the recorded manifest. */
export function verifyEvalIntegrity(
  stateDir: string,
  slug: string,
  skillDir: string,
): IntegrityStatus {
  const sha = evalsSha256(skillDir);
  if (sha === null) return "no-evals"; // no evals.json on disk (present or removed)
  const m = readManifest(stateDir);
  const entry = m[slug];
  if (!entry) return "missing"; // evals present but no baseline recorded (first sight)
  return sha === entry.sha256 ? "ok" : "drift";
}

/** List `{slug, skillDir}` for every skill under `skillsRoot` that carries
 *  an evals.json. Best-effort; returns [] on any fs error. */
export function listSkillsWithEvals(
  skillsRoot: string,
): Array<{ slug: string; skillDir: string }> {
  const out: Array<{ slug: string; skillDir: string }> = [];
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch {
    return out;
  }
  for (const slug of entries) {
    const skillDir = join(skillsRoot, slug);
    if (existsSync(evalsJsonPath(skillDir))) out.push({ slug, skillDir });
  }
  return out;
}

export interface SweepReport {
  recorded: string[]; // slugs seen for the first time (baseline established)
  healed: string[]; // slugs whose out-of-band drift was reverted
  ok: string[]; // slugs that verified clean
  quarantined: string[]; // slugs whose un-sanctioned evals.json failed the
  // PII/secret scan → NOT adopted as a baseline (MAJOR 2)
}

/**
 * Stop-hook integrity sweep. For every skill with evals under `skillsRoot`:
 *   - first sight (no manifest entry) → record it as the baseline;
 *   - drift (hash != manifest) → REVERT to the baseline snapshot and
 *     re-record. This self-heals an out-of-band edit to evals.json (e.g. a
 *     model that Wrote the file directly, bypassing the applier).
 *
 * Tamper-EVIDENT, self-healing, NOT a cryptographic boundary (MJ1): a model
 * that also rewrites the manifest + baseline defeats it. The hard backstop
 * is T1_LIVE OFF. Best-effort and never throws — the Stop hook is fail-open.
 *
 * MAJOR 2 — a first-sight (or snapshot-less drift) evals.json appeared OUT OF
 * BAND (never through the sanctioned applier, which records its own baseline
 * directly). We do NOT silently trust it: it must pass the same fail-closed
 * PII/secret scan the sanctioned path runs BEFORE it can become a baseline.
 * Un-clean bytes are QUARANTINED (reported, not recorded) so pre-seeding a
 * poisoned evals.json can never become a trusted baseline.
 */
export function sweepEvalIntegrity(
  skillsRoot: string,
  stateDir: string,
  opts: { now?: () => number } = {},
): SweepReport {
  const report: SweepReport = {
    recorded: [],
    healed: [],
    ok: [],
    quarantined: [],
  };
  const adoptIfTrusted = (slug: string, skillDir: string): void => {
    if (evalsBaselineTrusted(skillDir)) {
      recordEvalBaseline(stateDir, slug, skillDir, opts);
      report.recorded.push(slug);
    } else {
      // Un-sanctioned bytes that fail the PII/secret scan — refuse to trust.
      report.quarantined.push(slug);
    }
  };
  for (const { slug, skillDir } of listSkillsWithEvals(skillsRoot)) {
    try {
      const status = verifyEvalIntegrity(stateDir, slug, skillDir);
      if (status === "missing") {
        // First sight — could have been written out-of-band (Bash redirect).
        adoptIfTrusted(slug, skillDir);
      } else if (status === "drift") {
        const snap = baselineEvalsPath(stateDir, slug);
        if (existsSync(snap)) {
          // A SANCTIONED snapshot exists → revert to it (already scanned when
          // it was recorded). Self-heals the out-of-band edit.
          copyFileSync(snap, evalsJsonPath(skillDir));
          // Re-record so the manifest matches the restored bytes.
          recordEvalBaseline(stateDir, slug, skillDir, opts);
          report.healed.push(slug);
        } else {
          // No snapshot to restore from → the current bytes are un-sanctioned;
          // adopt them ONLY if they pass the scan, else quarantine (never
          // silently trust drift we can't revert).
          adoptIfTrusted(slug, skillDir);
        }
      } else {
        report.ok.push(slug);
      }
    } catch {
      /* fail-open per skill; a sweep error must not block the turn */
    }
  }
  return report;
}
