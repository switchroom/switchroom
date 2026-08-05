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
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { EvalCase } from "./eval-cases.js";

export const EVAL_CASE_PROPOSALS_FILE = "eval-case-proposals.jsonl";

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
  return next;
}
