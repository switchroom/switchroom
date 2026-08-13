/**
 * Agent self-improvement — the EVAL-CASE proposal store (RFC amendment
 * §"corrections as eval cases").
 *
 * An eval case never lands silently: the CLI proposes it, a one-tap Telegram
 * card surfaces it, and the operator's tap authorizes a DETERMINISTIC apply
 * (the gateway runs `switchroom self-improve apply-eval-case` on tap — it does
 * NOT inject a model turn, so the case lands byte-exact as approved). This
 * store is the durable record the card's callback and the applier read.
 *
 * Mirrors skill-proposals.ts: append-only jsonl under the agent state dir,
 * last-writer-wins on lifecycle transitions.
 *
 * HONESTY (RFC amendment MJ2): the applier checks `status === "approved"`
 * before writing, but this is DEFENSE-IN-DEPTH, not an authorization
 * boundary — this file lives in the agent-writable state dir, so a model
 * could flip the status itself. The real authorization is the operator's tap
 * (only the gateway's callback handler sets `approved`, and only that handler
 * invokes the applier). The status check just stops an applier invocation
 * with no matching proposal, or a stale/rejected one, from writing.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { EvalCase } from "./eval-cases.js";
import { REJECTION_TTL_MS } from "./skill-proposals.js";

export const EVAL_CASE_PROPOSALS_FILE = "eval-case-proposals.jsonl";

/**
 * Bound the on-disk store. This file is append-only (one line per enqueue,
 * one more per lifecycle transition) and, since the gateway now consults it
 * on EVERY proposal to honour dismissals, it is a read-per-proposal hot
 * path — an unbounded file is unbounded parse cost. Mirrors MAX_PENDING in
 * telegram-plugin/gateway/missed-approvals-store.ts.
 *
 * The cap counts DISTINCT proposals, applied separately to still-live
 * rejections and to everything else, so the file settles at <= 2x this many
 * lines. The split is the point: a naive drop-oldest trim could discard a
 * rejection and silently un-suppress a card the operator already dismissed.
 * Every rejection inside REJECTION_TTL_MS is retained; older ones no longer
 * suppress anything, so dropping them is lossless.
 */
export const MAX_EVAL_CASE_PROPOSALS = 200;

export type EvalCaseProposalStatus = "pending" | "approved" | "rejected";

export interface EvalCaseProposal {
  /** Stable id; the card's callback_data carries this. */
  id: string;
  created_at: string;
  status: EvalCaseProposalStatus;
  /** Target skill slug. */
  skill_slug: string;
  /** Absolute path to the skill bundle dir (resolved at propose time, so the
   *  applier writes exactly where the CLI validated). */
  skill_dir: string;
  /** The eval case to append (byte-exact through to apply). */
  case: EvalCase;
  /** Prompt fingerprint (dedup + operator-facing provenance). */
  fingerprint: string;
  /** Route the case to the held-out sink instead of evals.json. */
  held_out: boolean;
  /** Chat the card should post to. */
  chat_id?: number;
}

function proposalsPath(stateDir: string): string {
  return join(stateDir, EVAL_CASE_PROPOSALS_FILE);
}

function ensureDir(stateDir: string): void {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o755 });
}

function appendLine(path: string, obj: unknown): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, JSON.stringify(obj) + "\n");
  } finally {
    closeSync(fd);
  }
}

function isRecord(v: unknown): v is EvalCaseProposal {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as EvalCaseProposal).id === "string" &&
    typeof (v as EvalCaseProposal).skill_slug === "string" &&
    !!(v as EvalCaseProposal).case &&
    typeof (v as EvalCaseProposal).case === "object"
  );
}

/** Read all proposals, collapsing to the latest record per id. */
export function readEvalCaseProposals(stateDir: string): EvalCaseProposal[] {
  const p = proposalsPath(stateDir);
  if (!existsSync(p)) return [];
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return [];
  }
  const byId = new Map<string, EvalCaseProposal>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) byId.set(parsed.id, parsed);
    } catch {
      /* skip malformed */
    }
  }
  return [...byId.values()];
}

/**
 * The subset of `all` the bound retains: every rejection still inside the
 * suppression TTL (capped, newest-first, so a runaway loop can't blow the
 * bound either), plus the newest non-suppressing records. Relative order is
 * preserved so a compacted file reads back in the same order as before.
 */
function withinBound(
  all: EvalCaseProposal[],
  now: number,
): EvalCaseProposal[] {
  const isLiveRejection = (r: EvalCaseProposal): boolean => {
    if (r.status !== "rejected") return false;
    const age = now - new Date(r.created_at).getTime();
    // Unparseable timestamp: keep it. A record that can't be aged must not be
    // silently dropped — suppression treats it as expired, which is the safe
    // direction there, but deleting it is irreversible.
    return !Number.isFinite(age) || age <= REJECTION_TTL_MS;
  };
  const keepTail = (rows: EvalCaseProposal[]): EvalCaseProposal[] =>
    rows.length > MAX_EVAL_CASE_PROPOSALS
      ? rows.slice(rows.length - MAX_EVAL_CASE_PROPOSALS)
      : rows;
  const keep = new Set<string>([
    ...keepTail(all.filter(isLiveRejection)).map((r) => r.id),
    ...keepTail(all.filter((r) => !isLiveRejection(r))).map((r) => r.id),
  ]);
  return all.filter((r) => keep.has(r.id));
}

/**
 * Rewrite the store as one line per retained proposal, when it has grown past
 * the bound. Called only from the append paths: the gateway is the sole writer
 * (the CLI proposes over IPC), so a rewrite never races an append from another
 * process. Best-effort — a failed compaction leaves the append-only file
 * exactly as it was.
 */
function compactIfOversized(stateDir: string, now: number): void {
  const path = proposalsPath(stateDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= MAX_EVAL_CASE_PROPOSALS * 2) return;
  const kept = withinBound(readEvalCaseProposals(stateDir), now);
  if (kept.length >= lines.length) return; // nothing to gain
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, kept.map((r) => JSON.stringify(r) + "\n").join(""), {
      encoding: "utf-8",
      mode: 0o644,
    });
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
  }
}

export function getEvalCaseProposal(
  stateDir: string,
  id: string,
): EvalCaseProposal | undefined {
  return readEvalCaseProposals(stateDir).find((p) => p.id === id);
}

/** Persist a new pending proposal. Returns the stored record. */
export function enqueueEvalCaseProposal(
  stateDir: string,
  input: Omit<EvalCaseProposal, "id" | "created_at" | "status">,
  opts: { now?: () => number } = {},
): EvalCaseProposal {
  const now = opts.now ?? Date.now;
  ensureDir(stateDir);
  const proposal: EvalCaseProposal = {
    id: randomUUID(),
    created_at: new Date(now()).toISOString(),
    status: "pending",
    ...input,
  };
  appendLine(proposalsPath(stateDir), proposal);
  compactIfOversized(stateDir, now());
  return proposal;
}

/** Record a lifecycle transition (approved / rejected). */
export function setEvalCaseProposalStatus(
  stateDir: string,
  id: string,
  status: EvalCaseProposalStatus,
): EvalCaseProposal | undefined {
  const cur = getEvalCaseProposal(stateDir, id);
  if (!cur) return undefined;
  const next: EvalCaseProposal = { ...cur, status };
  appendLine(proposalsPath(stateDir), next);
  compactIfOversized(stateDir, Date.now());
  return next;
}
