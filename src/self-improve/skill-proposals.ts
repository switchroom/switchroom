/**
 * Agent self-improvement — the SKILL-PROPOSAL store (#2670, "one-tap
 * self-improvement").
 *
 * The weekly skill-synthesis cron drafts a proposed personal skill from
 * accumulated signal but MUST NOT write it. Instead it persists the full
 * draft bundle here; a one-tap Telegram card surfaces it; the operator's
 * tap authorizes the write through the existing personal-skill pipeline
 * (so the just-merged `scanBundleForSecrets` gate runs — #2671).
 *
 * Two backing files under the agent's state dir, mirroring the issues /
 * pending-queue sinks:
 *   <stateDir>/skill-proposals.jsonl           — append-only proposals,
 *     each carrying the FULL drafted SKILL.md bundle, target slug,
 *     edit-vs-new, evidence, and lifecycle state.
 *   <stateDir>/skill-proposals-rejected.jsonl  — rejection fingerprints,
 *     so a dismissed proposal is not re-proposed every week (dedup).
 *
 * Append-only: a proposal is an event the operator actions out-of-band.
 * Lifecycle transitions (approved / rejected) are recorded by appending a
 * new record with the same `id` and a later `status`; `readProposals`
 * collapses to the latest state per id (last-writer-wins).
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { SkillFileMap } from "../cli/skill-common.js";

export const PROPOSALS_FILE = "skill-proposals.jsonl";
export const REJECTED_FILE = "skill-proposals-rejected.jsonl";

/** Default suppression window for a rejected proposal (90 days). */
export const REJECTION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Jaccard overlap above which two proposals are "the same proposal". */
export const PROPOSAL_SIM_THRESHOLD = 0.5;

export type ProposalStatus = "pending" | "approved" | "rejected";

export interface SkillProposal {
  /** Stable id; the card's callback_data carries this. */
  id: string;
  /** ISO timestamp when proposed. */
  created_at: string;
  /** Lifecycle state (latest record per id wins). */
  status: ProposalStatus;
  /** Target personal-skill slug (without the `personal-` prefix). */
  skill_slug: string;
  /** True = create a new skill; false = edit an existing personal skill. */
  is_new: boolean;
  /** One-line lesson the skill captures (operator-facing). */
  lesson: string;
  /** The full drafted skill bundle (SKILL.md + optional files). */
  draft: SkillFileMap;
  /** Short human-readable evidence (e.g. "seen across 3 sessions"). */
  evidence: string;
  /** Chat the card should post to (gateway fills/uses this to route). */
  chat_id?: number;
}

/** One rejection fingerprint, used to suppress re-proposals. */
export interface RejectionFingerprint {
  /** ISO timestamp of the rejection. */
  rejected_at: string;
  /** The proposal id that was rejected (provenance). */
  proposal_id: string;
  /** Target slug, for a fast exact-match pre-filter. */
  skill_slug: string;
  /** Normalized content-word set of the proposal (lesson + SKILL.md). */
  words: string[];
}

function proposalsPath(stateDir: string): string {
  return join(stateDir, PROPOSALS_FILE);
}

function rejectedPath(stateDir: string): string {
  return join(stateDir, REJECTED_FILE);
}

function ensureDir(stateDir: string): void {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true, mode: 0o755 });
  }
}

function appendLine(path: string, obj: unknown): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, JSON.stringify(obj) + "\n");
  } finally {
    closeSync(fd);
  }
}

function readLines<T>(path: string, isValid: (v: unknown) => v is T): T[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isValid(parsed)) out.push(parsed);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

function isProposalRecord(v: unknown): v is SkillProposal {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as SkillProposal).id === "string" &&
    typeof (v as SkillProposal).skill_slug === "string" &&
    typeof (v as SkillProposal).draft === "object"
  );
}

function isRejectionRecord(v: unknown): v is RejectionFingerprint {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as RejectionFingerprint).proposal_id === "string" &&
    Array.isArray((v as RejectionFingerprint).words)
  );
}

/**
 * Read all proposals, collapsing to the latest record per id
 * (last-writer-wins on lifecycle transitions).
 */
export function readProposals(stateDir: string): SkillProposal[] {
  const all = readLines(proposalsPath(stateDir), isProposalRecord);
  const byId = new Map<string, SkillProposal>();
  for (const p of all) byId.set(p.id, p); // later lines overwrite
  return [...byId.values()];
}

/** Look up a single proposal by id (latest state). */
export function getProposal(
  stateDir: string,
  id: string,
): SkillProposal | undefined {
  return readProposals(stateDir).find((p) => p.id === id);
}

// ─── Fingerprinting (rejection dedup) ───────────────────────────────

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "you", "your", "are",
  "was", "but", "not", "use", "via", "into", "from", "all", "any",
  "can", "has", "have", "will", "should", "when", "then", "than",
  "skill", "personal", "step", "steps", "always", "never", "agent",
]);

/** Content-word set of a proposal: lesson + SKILL.md body, lowercased,
 *  stripped of punctuation + stopwords. Tolerant of re-wording. */
export function proposalContentWords(p: {
  lesson: string;
  draft: SkillFileMap;
}): Set<string> {
  const text = `${p.lesson}\n${p.draft["SKILL.md"] ?? ""}`;
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/** Jaccard overlap of two word sets (0..1). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

// ─── Writes ─────────────────────────────────────────────────────────

/**
 * Persist a new pending proposal. Returns the stored record (with id +
 * timestamp). Caller should check `isSuppressed` first to honour the
 * rejection-dedup window.
 */
export function enqueueProposal(
  stateDir: string,
  input: Omit<SkillProposal, "id" | "created_at" | "status">,
  opts: { now?: () => number } = {},
): SkillProposal {
  const now = opts.now ?? Date.now;
  ensureDir(stateDir);
  const proposal: SkillProposal = {
    id: randomUUID(),
    created_at: new Date(now()).toISOString(),
    status: "pending",
    ...input,
  };
  appendLine(proposalsPath(stateDir), proposal);
  return proposal;
}

/** Record a lifecycle transition (approved / rejected) for a proposal. */
export function setProposalStatus(
  stateDir: string,
  id: string,
  status: ProposalStatus,
  opts: { now?: () => number } = {},
): SkillProposal | undefined {
  const cur = getProposal(stateDir, id);
  if (!cur) return undefined;
  const now = opts.now ?? Date.now;
  const next: SkillProposal = { ...cur, status };
  appendLine(proposalsPath(stateDir), next);
  if (status === "rejected") {
    recordRejection(stateDir, cur, { now });
  }
  return next;
}

/** Write a rejection fingerprint so this proposal isn't re-surfaced. */
export function recordRejection(
  stateDir: string,
  proposal: Pick<SkillProposal, "id" | "lesson" | "draft" | "skill_slug">,
  opts: { now?: () => number } = {},
): void {
  const now = opts.now ?? Date.now;
  ensureDir(stateDir);
  const fp: RejectionFingerprint = {
    rejected_at: new Date(now()).toISOString(),
    proposal_id: proposal.id,
    skill_slug: proposal.skill_slug,
    words: [...proposalContentWords(proposal)],
  };
  appendLine(rejectedPath(stateDir), fp);
}

// ─── Suppression check ──────────────────────────────────────────────

/**
 * True iff a candidate proposal matches a still-live rejection
 * fingerprint (same slug OR high content-word overlap, within the TTL).
 * The synthesis path calls this before enqueuing so a dismissed proposal
 * is not re-fired every week.
 */
export function isSuppressed(
  stateDir: string,
  candidate: { lesson: string; draft: SkillFileMap; skill_slug: string },
  opts: { now?: () => number; ttlMs?: number; threshold?: number } = {},
): boolean {
  const now = (opts.now ?? Date.now)();
  const ttl = opts.ttlMs ?? REJECTION_TTL_MS;
  const threshold = opts.threshold ?? PROPOSAL_SIM_THRESHOLD;
  const candWords = proposalContentWords(candidate);
  for (const fp of readLines(rejectedPath(stateDir), isRejectionRecord)) {
    const age = now - new Date(fp.rejected_at).getTime();
    if (!Number.isFinite(age) || age > ttl) continue; // expired
    if (fp.skill_slug === candidate.skill_slug) return true;
    if (jaccard(candWords, new Set(fp.words)) >= threshold) return true;
  }
  return false;
}
