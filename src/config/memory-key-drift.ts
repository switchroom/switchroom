import { z } from "zod";
import { AgentMemorySchema, ProfileSchema } from "./schema.js";

/**
 * Unknown / retired keys under `memory` (and its `recall` / `retain`
 * sub-objects) in switchroom.yaml.
 *
 * The `memory.recall` / `memory.retain` zod objects are NON-strict: a key the
 * schema does not declare is silently STRIPPED at parse time (zod's default
 * object behaviour). No error, no warning, and `switchroom doctor` says
 * nothing — the operator's `switchroom.yaml` reads as though the knob is set
 * and it has zero effect. This is the same defect class #3763 closed on the
 * `hindsight.env` surface ({@link findUnmanagedHindsightEnvKeys}), on a
 * different schema (#3773).
 *
 * A REMOVED knob is strictly worse than a merely-unknown one: the operator has
 * positive evidence they once configured it. `memory.recall.min_overlap` is
 * live proof — the lexical-overlap recall gate it tuned was deleted outright in
 * #3761, so a fleet carrying `min_overlap: 0.15` today parses cleanly and does
 * nothing. The retired-key maps below let such a key carry a SPECIFIC message
 * ("removed in #3761 …") instead of a generic "unknown key".
 *
 * We deliberately do NOT make the objects `.strict()`: the issue explicitly
 * rejects turning an unknown key into a hard config-parse boot failure on every
 * agent. Detection surfaced as a doctor/apply WARNING is the durable half — the
 * key list keeps growing, so a mechanism that reports "you wrote a key nothing
 * reads" beats enumerating today's gaps.
 */

/**
 * Extract the declared field names of a possibly-wrapped zod object schema.
 *
 * The memory schema wraps its objects in `.optional()` / `.describe()` (and
 * `mental_models` in a `.superRefine()` ZodEffects at the level above), so the
 * shape is not reachable by a bare `.shape`. Unwrap those layers until we hit
 * the `ZodObject`, then return its keys. Deriving the known set FROM the schema
 * — rather than hand-maintaining a parallel list — is the deterministic half:
 * a knob added to `AgentMemorySchema` is automatically "known" here, so this
 * check can never false-fire on a key the schema itself accepts.
 */
function unwrapObjectNode(
  schema: z.ZodTypeAny | undefined,
): { shape?: Record<string, z.ZodTypeAny> } | undefined {
  let s: unknown = schema;
  // Peel ZodOptional / ZodNullable / ZodDefault (innerType) and ZodEffects
  // (schema) wrappers until the underlying ZodObject — the node that exposes a
  // `.shape` — is reached. Version-agnostic: keyed on the presence of `.shape`
  // / `_def.innerType` rather than the `_def.typeName` / `_def.type`
  // discriminator, which differs across zod 3.x internals.
  for (let i = 0; s && i < 10; i++) {
    const node = s as {
      shape?: Record<string, z.ZodTypeAny>;
      _def?: { innerType?: unknown; schema?: unknown };
    };
    if (node.shape && typeof node.shape === "object") {
      return node;
    }
    if (node._def?.innerType) {
      s = node._def.innerType;
      continue;
    }
    if (node._def?.schema) {
      s = node._def.schema;
      continue;
    }
    break;
  }
  return undefined;
}

function objectShapeKeys(schema: z.ZodTypeAny | undefined): Set<string> {
  const node = unwrapObjectNode(schema);
  return node?.shape ? new Set(Object.keys(node.shape)) : new Set();
}

function memoryChildSchema(
  memorySchema: z.ZodTypeAny | undefined,
  child: "recall" | "retain",
): z.ZodTypeAny | undefined {
  return unwrapObjectNode(memorySchema)?.shape?.[child];
}

/**
 * The set of keys accepted under `memory` / `memory.recall` / `memory.retain`,
 * derived per TIER from the schema that actually parses that tier — so the
 * known set can never drift as knobs are added.
 *
 * Two tiers, two DISTINCT schemas:
 *
 *  - `agent` — a per-agent `agents.<name>.memory` block, parsed by
 *    {@link AgentMemorySchema}.
 *  - `mirror` — a `defaults.memory` / `profiles.<name>.memory` block, parsed by
 *    the SEPARATE inline mirror object inside `profileFields` (reached here via
 *    `ProfileSchema.shape.memory`). The mirror is DELIBERATELY narrower — e.g.
 *    `mental_models` is per-agent only and is not mirrored — so a key that is
 *    valid per-agent can still be silently stripped at the defaults/profile
 *    tier. Diffing that tier against the per-agent set would falsely clear it;
 *    we must diff against the mirror's own declared keys.
 */
export type MemoryTier = "agent" | "mirror";

interface TierKnownKeys {
  readonly memory: ReadonlySet<string>;
  readonly recall: ReadonlySet<string>;
  readonly retain: ReadonlySet<string>;
}

function tierKnownKeys(memorySchema: z.ZodTypeAny | undefined): TierKnownKeys {
  return {
    memory: objectShapeKeys(memorySchema),
    recall: objectShapeKeys(memoryChildSchema(memorySchema, "recall")),
    retain: objectShapeKeys(memoryChildSchema(memorySchema, "retain")),
  };
}

const AGENT_KNOWN = tierKnownKeys(AgentMemorySchema);
// `ProfileSchema.shape.memory` is the inline `profileFields.memory` mirror —
// the exact schema the defaults/profile tier is parsed by.
const MIRROR_KNOWN = tierKnownKeys(ProfileSchema.shape.memory);

const KNOWN_BY_TIER: Readonly<Record<MemoryTier, TierKnownKeys>> = {
  agent: AGENT_KNOWN,
  mirror: MIRROR_KNOWN,
};

/**
 * The keys the PER-AGENT `memory` / `memory.recall` / `memory.retain` declare.
 * Derived from the schema at module load so they cannot drift out of sync.
 * (Mirror-tier sets are on {@link KNOWN_BY_TIER}.)
 */
export const KNOWN_MEMORY_KEYS: ReadonlySet<string> = AGENT_KNOWN.memory;
export const KNOWN_MEMORY_RECALL_KEYS: ReadonlySet<string> = AGENT_KNOWN.recall;
export const KNOWN_MEMORY_RETAIN_KEYS: ReadonlySet<string> = AGENT_KNOWN.retain;

/** Mirror-tier (defaults / profiles.*) declared key sets. */
export const KNOWN_MIRROR_MEMORY_KEYS: ReadonlySet<string> = MIRROR_KNOWN.memory;
export const KNOWN_MIRROR_MEMORY_RECALL_KEYS: ReadonlySet<string> =
  MIRROR_KNOWN.recall;
export const KNOWN_MIRROR_MEMORY_RETAIN_KEYS: ReadonlySet<string> =
  MIRROR_KNOWN.retain;

/**
 * Keys the schema once declared and no longer does. Value = the specific
 * message to surface, ideally naming the removing PR and the replacement (or
 * that there is none). Keeps a retired knob from reading as a generic typo.
 */
export const RETIRED_MEMORY_KEYS: Readonly<Record<string, string>> = {};
export const RETIRED_MEMORY_RECALL_KEYS: Readonly<Record<string, string>> = {
  min_overlap:
    "removed in #3761 — the lexical-overlap recall gate it tuned was deleted " +
    "outright, with no replacement floor; delete the line",
};
export const RETIRED_MEMORY_RETAIN_KEYS: Readonly<Record<string, string>> = {};

export type MemoryKeyScope = "memory" | "memory.recall" | "memory.retain";

export interface UnknownMemoryKey {
  /** Which memory sub-object the key sits under. */
  scope: MemoryKeyScope;
  /** The offending key name. */
  key: string;
  /**
   * A specific message when the key is a KNOWN-retired knob (naming the PR /
   * replacement); undefined for a merely-unrecognized key.
   */
  replacement?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function diffScope(
  obj: unknown,
  scope: MemoryKeyScope,
  known: ReadonlySet<string>,
  retired: Readonly<Record<string, string>>,
  out: UnknownMemoryKey[],
): void {
  if (!isPlainObject(obj)) return;
  for (const key of Object.keys(obj)) {
    if (known.has(key)) continue;
    out.push(
      key in retired
        ? { scope, key, replacement: retired[key] }
        : { scope, key },
    );
  }
}

/**
 * Diff a RAW (pre-zod-parse) `memory` object's keys — and those of its
 * `recall` / `retain` sub-objects — against the declared keys of the schema
 * that ACTUALLY parses this tier.
 *
 * `tier` selects that schema (default `"agent"`):
 *  - `"agent"` for a per-agent `agents.<name>.memory` block ({@link AgentMemorySchema}).
 *  - `"mirror"` for a `defaults.memory` / `profiles.<name>.memory` block, which
 *    is parsed by the narrower inline mirror inside `profileFields`. Passing the
 *    wrong tier is the false-all-clear bug this parameter exists to prevent: a
 *    key valid per-agent but absent from the mirror (e.g. `mental_models`) is
 *    silently stripped at the defaults/profile tier, and diffing it against the
 *    per-agent set would wrongly report it clean.
 *
 * Pure and total: takes the raw parsed-yaml `memory` value, returns the
 * offending keys (empty when everything is recognized), sorted scope-then-key
 * for stable output. Retired keys carry their specific `replacement` message
 * regardless of tier (a removed knob is dead at every tier). The caller decides
 * how loud to be.
 *
 * MUST be fed the raw yaml object, not a parsed `SwitchroomConfig.memory`:
 * zod has already stripped the unknown keys off the latter, so a parsed config
 * would always report clean — which is precisely the silent bug.
 */
export function findUnknownMemoryKeys(
  memory: unknown,
  tier: MemoryTier = "agent",
): UnknownMemoryKey[] {
  if (!isPlainObject(memory)) return [];
  const known = KNOWN_BY_TIER[tier];
  const out: UnknownMemoryKey[] = [];
  diffScope(memory, "memory", known.memory, RETIRED_MEMORY_KEYS, out);
  diffScope(
    memory.recall,
    "memory.recall",
    known.recall,
    RETIRED_MEMORY_RECALL_KEYS,
    out,
  );
  diffScope(
    memory.retain,
    "memory.retain",
    known.retain,
    RETIRED_MEMORY_RETAIN_KEYS,
    out,
  );
  return out.sort((a, b) =>
    a.scope === b.scope ? a.key.localeCompare(b.key) : a.scope.localeCompare(b.scope),
  );
}
