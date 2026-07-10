/**
 * Pure (no-network) helpers for the agent-proposes → human-approves
 * mental-model curation flow (hindsight Phase 5, stacked on #2874).
 *
 * #2874 shipped the operator-DECLARED half: a per-agent
 * `memory.mental_models[]` config that `ensureDeclaredMentalModels`
 * materialises at scaffold/reconcile. This module is the persistence
 * primitive for the SECOND half: when an agent PROPOSES a model and the
 * operator taps Approve, the proposed model must become a first-class
 * DECLARED model — i.e. it must land in `agents.<agent>.memory.mental_models[]`
 * in switchroom.yaml so the exact same #2874 ensure/reconcile path
 * consumes it. Nothing bespoke: the approved proposal is just a new
 * declared model.
 *
 * The persist reuses the proven `config_propose_edit` apply+reconcile
 * machinery (hostd is the sole config writer — the leash). So this module
 * only has to produce a git-apply-compatible unified diff that appends the
 * declared model to the agent's block. We build `after` with the
 * structure-preserving `yaml` document API and diff it against the live
 * `before` bytes with the same `git diff --no-index` family hostd applies
 * with (see src/web/config-diff.ts) — so the patch round-trips.
 *
 * Deliberately no I/O here beyond the git-diff subprocess in
 * `generateUnifiedDiff`; callers read the raw config bytes and feed them in.
 */

import { parseDocument } from "yaml";
import { generateUnifiedDiff } from "../../src/web/config-diff.js";

/**
 * Decode the canonical six HTML/XML entities to their literal characters — the
 * config-write-boundary layer of the #2976 defense-in-depth.
 *
 * SCOPE / reachability (be honest about which half is load-bearing):
 *   - `source_query` decode is the REACHABLE half. A model can copy escaped
 *     entities out of its Telegram-HTML-rendered context into a proposal's
 *     free-form `source_query`, and undecoded it would steer recall on `R&amp;D`
 *     instead of `R&D` — a durable, silent corruption of a memory-integrity
 *     field. Normalizing here means an escaped query can never LAND in
 *     `memory.mental_models[]`.
 *   - `name` decode is REDUNDANT belt-and-suspenders. The `mental_model_propose`
 *     gateway tool already slug-validates `name` against
 *     /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/ BEFORE this runs, so an entity-bearing
 *     name is rejected upstream and can't reach here. It's kept only so this
 *     write boundary is self-contained if that gate ever moves.
 *   - The observed in-NAME corruption (`Nutrition Protocol &amp; Deficit Status`,
 *     klanker 2026-07-06) actually arrived via the DIRECT `create_mental_model`
 *     Hindsight tool (`ensureMentalModel`, undecoded), NOT this propose path.
 *     That vector is OUT OF SCOPE here — covered by the steering.ts context-
 *     hygiene + in-service `Dockerfile.hindsight` normalization follow-ups.
 *
 * SINGLE PASS by design (matches issue #2976's success criteria): a
 * double-escaped `R&amp;amp;D` decodes ONE layer to `R&amp;D`, not all the way
 * to `R&D` — we only undo the escaping switchroom itself applied when it
 * rendered the model's prior output, never the user's literal intent. `&amp;`
 * is decoded LAST so `&amp;lt;` collapses to `&lt;` (one layer), not `<`.
 *
 * Accepted tradeoff: a `source_query` a human genuinely intended to contain a
 * literal `&amp;` / `&lt;` / etc. (rare — a reflection question, not markup)
 * will have that one layer decoded. Steering queries reading as escaped HTML is
 * the far more common and more harmful case, so we optimize for it.
 */
export function decodeCanonicalEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * A proposed mental model, in the same snake_case shape the
 * `memory.mental_models[]` schema (#2874) accepts. `name` + `source_query`
 * are required; the knobs are opt-in and only serialised when set (a minimal
 * declaration is the schema-clean default).
 */
export interface MentalModelProposeSpec {
  name: string;
  source_query: string;
  refresh_after_consolidation?: boolean;
  max_tokens?: number;
}

export type BuildDiffResult =
  | { ok: true; diff: string; after: string }
  | { ok: false; error: "agent-not-found" | "duplicate" | "no-change" | "parse-error"; detail: string };

/**
 * Read the NAMES of the models already DECLARED in
 * `agents.<agentName>.memory.mental_models[]` of raw config text. Used for the
 * duplicate-name guard so a proposal for an already-declared model is rejected
 * BEFORE a card is ever posted. Returns [] when the agent has no declared
 * models (or the block/keys are absent). Never throws — a parse failure yields
 * [] so the caller degrades to the (also-guarded) build step.
 */
export function readDeclaredMentalModelNames(
  configText: string,
  agentName: string,
): string[] {
  if (!configText || !agentName) return [];
  let js: unknown;
  try {
    js = parseDocument(configText, { merge: false, strict: false }).toJS();
  } catch {
    return [];
  }
  const models = navigateMentalModels(js, agentName);
  if (!Array.isArray(models)) return [];
  return models
    .map((m) => (m && typeof m === "object" ? (m as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === "string");
}

function navigateMentalModels(js: unknown, agentName: string): unknown {
  if (!js || typeof js !== "object") return undefined;
  const agents = (js as Record<string, unknown>).agents;
  if (!agents || typeof agents !== "object") return undefined;
  const agent = (agents as Record<string, unknown>)[agentName];
  if (!agent || typeof agent !== "object") return undefined;
  const memory = (agent as Record<string, unknown>).memory;
  if (!memory || typeof memory !== "object") return undefined;
  return (memory as Record<string, unknown>).mental_models;
}

/**
 * Build a git-apply-compatible unified diff that APPENDS `spec` to the target
 * agent's `memory.mental_models[]` in raw `configText`. Creates the
 * `memory:` / `mental_models:` keys if absent. Returns a structured error
 * (never throws) when:
 *   - the agent block is absent (`agent-not-found`) — we never invent one;
 *   - a model with the same name is already declared (`duplicate`) — the
 *     schema's idempotent-ensure key must stay unique;
 *   - the edit is a no-op (`no-change`);
 *   - the config doesn't parse (`parse-error`).
 *
 * Only fields that are set on `spec` are serialised, matching the minimal,
 * schema-clean create payload #2874 emits.
 */
export function buildMentalModelAppendDiff(args: {
  configText: string;
  agentName: string;
  spec: MentalModelProposeSpec;
  /** Injectable git binary for tests (defaults to "git"). */
  gitBin?: string;
}): BuildDiffResult {
  const { configText, agentName, spec } = args;

  let doc;
  try {
    doc = parseDocument(configText, { merge: false, strict: false });
  } catch (e) {
    return { ok: false, error: "parse-error", detail: (e as Error).message };
  }
  if (doc.errors && doc.errors.length > 0) {
    return { ok: false, error: "parse-error", detail: doc.errors[0]!.message };
  }

  // The agent block must already exist — a proposal never scaffolds a new
  // agent, only augments the caller's own declared models.
  if (doc.getIn(["agents", agentName]) === undefined) {
    return {
      ok: false,
      error: "agent-not-found",
      detail: `agents.${agentName} not present in config`,
    };
  }

  // Duplicate-name guard (defense-in-depth; the executor also checks up front
  // so it never even posts a card for a dupe). Compare on the DECODED name so a
  // re-propose of an entity-escaped variant collides with the already-stored
  // literal (#2976) rather than sneaking in a corrupted twin.
  const decodedName = decodeCanonicalEntities(spec.name);
  const existing = readDeclaredMentalModelNames(configText, agentName);
  if (existing.includes(decodedName)) {
    return {
      ok: false,
      error: "duplicate",
      detail: `mental model "${decodedName}" is already declared for ${agentName}`,
    };
  }

  // #2976 write-boundary normalization: decode any HTML/XML entities the model
  // may have copied out of its own escaped context so the LITERAL characters
  // land in config — never `&amp;` / `&lt;` etc. The load-bearing target is the
  // free-form `source_query`; the `name` decode is redundant with the gateway
  // slug gate (an entity-bearing name is rejected upstream) and kept only so
  // this boundary is self-contained. Duplicate-name guard runs on the decoded
  // name above.
  const name = decodedName;
  const source_query = decodeCanonicalEntities(spec.source_query);

  // Assemble the minimal, schema-clean declaration node.
  const item: Record<string, unknown> = {
    name,
    source_query,
  };
  if (spec.refresh_after_consolidation !== undefined) {
    item.refresh_after_consolidation = spec.refresh_after_consolidation;
  }
  if (spec.max_tokens !== undefined) {
    item.max_tokens = spec.max_tokens;
  }

  // Append into agents.<agent>.memory.mental_models[], creating the
  // intermediate mapping/sequence if they don't exist yet. `addIn` on an
  // absent path creates the sequence; when it exists we push onto it.
  const path = ["agents", agentName, "memory", "mental_models"];
  const seq = doc.getIn(path);
  if (seq === undefined) {
    doc.setIn(path, [item]);
  } else {
    doc.addIn(path, item);
  }

  const after = String(doc);
  if (after === configText) {
    return { ok: false, error: "no-change", detail: "append produced no change" };
  }

  const diff = generateUnifiedDiff(configText, after, "switchroom.yaml", args.gitBin ?? "git");
  if (diff === "") {
    return { ok: false, error: "no-change", detail: "diff was empty" };
  }
  return { ok: true, diff, after };
}
