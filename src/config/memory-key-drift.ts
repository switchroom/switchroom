import { z } from "zod";
import { AgentMemorySchema } from "./schema.js";

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
function objectShapeKeys(schema: z.ZodTypeAny | undefined): Set<string> {
  let s: unknown = schema;
  // Peel ZodOptional / ZodNullable / ZodDefault (innerType) and ZodEffects
  // (schema) wrappers until the underlying ZodObject — the node that exposes a
  // `.shape` — is reached. Version-agnostic: keyed on the presence of `.shape`
  // / `_def.innerType` rather than the `_def.typeName` / `_def.type`
  // discriminator, which differs across zod 3.x internals.
  for (let i = 0; s && i < 10; i++) {
    const node = s as {
      shape?: Record<string, unknown>;
      _def?: { innerType?: unknown; schema?: unknown };
    };
    if (node.shape && typeof node.shape === "object") {
      return new Set(Object.keys(node.shape));
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
  return new Set();
}

function memoryChildSchema(child: "recall" | "retain"): z.ZodTypeAny | undefined {
  const memoryObj = (
    AgentMemorySchema as unknown as {
      _def?: { innerType?: { shape?: Record<string, z.ZodTypeAny> } };
    }
  )._def?.innerType;
  return memoryObj?.shape?.[child];
}

const MEMORY_SHAPE = objectShapeKeys(AgentMemorySchema);
const MEMORY_RECALL_SHAPE = objectShapeKeys(memoryChildSchema("recall"));
const MEMORY_RETAIN_SHAPE = objectShapeKeys(memoryChildSchema("retain"));

/**
 * The keys `memory` / `memory.recall` / `memory.retain` currently declare.
 * Derived from the schema at module load so they cannot drift out of sync.
 */
export const KNOWN_MEMORY_KEYS: ReadonlySet<string> = MEMORY_SHAPE;
export const KNOWN_MEMORY_RECALL_KEYS: ReadonlySet<string> = MEMORY_RECALL_SHAPE;
export const KNOWN_MEMORY_RETAIN_KEYS: ReadonlySet<string> = MEMORY_RETAIN_SHAPE;

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
 * `recall` / `retain` sub-objects — against the schema's declared keys.
 *
 * Pure and total: takes the raw parsed-yaml `memory` value, returns the
 * offending keys (empty when everything is recognized), sorted scope-then-key
 * for stable output. Retired keys carry their specific `replacement` message.
 * The caller (`switchroom doctor` / `apply`) decides how loud to be; per the
 * issue it is a WARNING, never a hard fail.
 *
 * MUST be fed the raw yaml object, not a parsed `SwitchroomConfig.memory`:
 * zod has already stripped the unknown keys off the latter, so a parsed config
 * would always report clean — which is precisely the silent bug.
 */
export function findUnknownMemoryKeys(memory: unknown): UnknownMemoryKey[] {
  if (!isPlainObject(memory)) return [];
  const out: UnknownMemoryKey[] = [];
  diffScope(memory, "memory", KNOWN_MEMORY_KEYS, RETIRED_MEMORY_KEYS, out);
  diffScope(
    memory.recall,
    "memory.recall",
    KNOWN_MEMORY_RECALL_KEYS,
    RETIRED_MEMORY_RECALL_KEYS,
    out,
  );
  diffScope(
    memory.retain,
    "memory.retain",
    KNOWN_MEMORY_RETAIN_KEYS,
    RETIRED_MEMORY_RETAIN_KEYS,
    out,
  );
  return out.sort((a, b) =>
    a.scope === b.scope ? a.key.localeCompare(b.key) : a.scope.localeCompare(b.scope),
  );
}
