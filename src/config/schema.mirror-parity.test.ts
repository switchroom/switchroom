import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  AgentSchema,
  AgentMemorySchema,
  AgentDefaultsSchema,
  ProfileSchema,
  HindsightConfigSchema,
  HindsightPerOpLlmSchema,
} from "./schema.js";
import { mergeAgentConfig, resolveAgentConfig } from "./merge.js";

/**
 * ── The class-killer parity test (#3909 / #3779 / #3687) ────────────────────
 *
 * switchroom's cascade has a recurring, silent failure class: a per-agent
 * schema field (AgentMemorySchema, HindsightPerOpLlmSchema) grows a new key,
 * but the DEFAULTS/PROFILE-tier mirror inside `profileFields` — or the GLOBAL
 * `hindsight.llm` object — is never updated to match. Because those mirror
 * objects are plain `z.object`s, an unmirrored key is STRIPPED at parse (Zod
 * drops unknown keys) AND the merge clause that would cascade it becomes a
 * no-op. The knob looks accepted in yaml and silently does nothing. This is the
 * #3773 class (resources.tmp_size), the #3909 class (memory.retain), the #3779
 * class (recall.types/skip_trivial/topic_filter_mode), and the missing
 * memory-level missions/disposition.
 *
 * A per-key parse test only guards the keys someone remembered to write. This
 * test instead shape-DIFFS `Object.keys` of each canonical per-agent sub-object
 * against its mirror and FAILS on ANY asymmetry — so a FUTURE key added to the
 * per-agent schema without a matching mirror breaks CI immediately, with a
 * message naming the drifted keys. It is anchored by object SHAPE, not by line.
 */

/** Peel ZodOptional / ZodDefault / ZodNullable / ZodEffects to the ZodObject. */
function unwrapToObject(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> {
  let cur: z.ZodTypeAny = schema;
  // Bounded: the deepest wrapper stack in this schema is a couple levels.
  for (let i = 0; i < 10; i++) {
    if (cur instanceof z.ZodObject) return cur as z.ZodObject<z.ZodRawShape>;
    const def = (cur as unknown as { _def: Record<string, unknown> })._def;
    const next = (def.innerType ?? def.schema) as z.ZodTypeAny | undefined;
    if (!next) break;
    cur = next;
  }
  throw new Error("unwrapToObject: never reached a ZodObject");
}

function keysOf(schema: z.ZodTypeAny): string[] {
  return Object.keys(unwrapToObject(schema).shape).sort();
}

/** Keys the mirror DELIBERATELY omits from the per-agent memory shape. */
const INTENTIONAL_MEMORY_MIRROR_EXCLUSIONS = new Set<string>([
  // Per-agent ONLY by design: a mental model must never be fleet-seeded from
  // the defaults/profile tier (see AgentMemorySchema.mental_models). If this
  // exclusion is ever removed, mirror the field AND drop it from this set.
  "mental_models",
  // Per-agent ONLY by design (Memory v2 M1/M3 go-live flag): the rules-block
  // rollout is a deliberate per-agent step, never fleet-seeded from the
  // defaults/profile tier. Excluding it from the profile mirror is both
  // correct AND a darkness safeguard — a defaults-tier value could otherwise
  // flip the flag (and seed the CLAUDE.md deny + tools) across the whole
  // fleet at once. If this exclusion is ever removed, mirror the field AND
  // drop it from this set. See AgentMemorySchema.rules_block.
  "rules_block",
  // Per-agent ONLY by design (Memory v2 M5 go-live flag, Surface B: orientation
  // -at-boot): enabling orientation is a deliberate per-agent canary step gated
  // on the agent's own m2-residue measurement + an operator-created `orientation`
  // model (carve-M5 §7), never fleet-seeded. Same darkness safeguard as
  // rules_block — a defaults-tier value could otherwise flip the injection on
  // for the whole fleet at once. NOTE: the sibling `orientation_cadence_hours`
  // IS mirrored (it is a safe cost/tiering knob); only enablement is excluded.
  // If this exclusion is ever removed, mirror the field AND drop it from this set.
  "orientation",
  // Per-agent ONLY by design (Memory v2 M5): the optional per-turn re-inject
  // cadence is a per-agent cost dial (~55M tok/30d at every-turn) that only a
  // measured late-session-loss case should ever set. Never fleet-seeded — a
  // defaults-tier value would silently multiply token spend across every agent.
  // See AgentMemorySchema.orientation_reinject_turns.
  "orientation_reinject_turns",
]);

describe("profileFields mirror ↔ per-agent schema parity (class-killer)", () => {
  const perAgentMemory = unwrapToObject(AgentMemorySchema).shape;
  const profileMemory = unwrapToObject(ProfileSchema.shape.memory).shape;
  const defaultsMemory = unwrapToObject(
    unwrapToObject(AgentDefaultsSchema).shape.memory,
  ).shape;

  it("memory top-level: mirror == per-agent minus intentional exclusions", () => {
    const expected = Object.keys(perAgentMemory)
      .filter((k) => !INTENTIONAL_MEMORY_MIRROR_EXCLUSIONS.has(k))
      .sort();
    const mirror = Object.keys(profileMemory).sort();
    // Directional messages so a failure names exactly what drifted.
    const missingFromMirror = expected.filter((k) => !mirror.includes(k));
    const extraInMirror = mirror.filter((k) => !expected.includes(k));
    expect(
      { missingFromMirror, extraInMirror },
      "profileFields.memory drifted from AgentMemorySchema — add the mirror " +
        "(or, for a deliberate omission, add it to " +
        "INTENTIONAL_MEMORY_MIRROR_EXCLUSIONS)",
    ).toEqual({ missingFromMirror: [], extraInMirror: [] });
  });

  it("defaults tier mirror matches the profile tier mirror (same source)", () => {
    // Both are built from `profileFields`, but assert it rather than assume it.
    expect(Object.keys(defaultsMemory).sort()).toEqual(
      Object.keys(profileMemory).sort(),
    );
  });

  it("memory.recall: mirror keys == per-agent recall keys (strict)", () => {
    const perAgent = keysOf((perAgentMemory as Record<string, z.ZodTypeAny>).recall);
    const mirror = keysOf((profileMemory as Record<string, z.ZodTypeAny>).recall);
    expect(mirror, "profileFields.memory.recall drifted from AgentMemorySchema.recall").toEqual(perAgent);
  });

  it("memory.retain: mirror keys == per-agent retain keys (strict)", () => {
    const perAgent = keysOf((perAgentMemory as Record<string, z.ZodTypeAny>).retain);
    const mirror = keysOf((profileMemory as Record<string, z.ZodTypeAny>).retain);
    expect(mirror, "profileFields.memory.retain drifted from AgentMemorySchema.retain").toEqual(perAgent);
  });

  it("memory.disposition: mirror keys == per-agent disposition keys (strict)", () => {
    const perAgent = keysOf((perAgentMemory as Record<string, z.ZodTypeAny>).disposition);
    const mirror = keysOf((profileMemory as Record<string, z.ZodTypeAny>).disposition);
    expect(mirror, "profileFields.memory.disposition drifted from AgentMemorySchema.disposition").toEqual(perAgent);
  });

  it("hindsight.llm (global): every per-op LLM field is mirrored on the global object (#3687)", () => {
    const perOp = keysOf(HindsightPerOpLlmSchema);
    const global = keysOf(HindsightConfigSchema.shape.llm);
    const missing = perOp.filter((k) => !global.includes(k));
    expect(
      missing,
      "global hindsight.llm is missing per-op passthrough field(s) — copy the " +
        "field def from HindsightPerOpLlmSchema",
    ).toEqual([]);
    // Guard the two this PR added explicitly, so a future revert is loud.
    expect(global).toContain("base_url");
    expect(global).toContain("api_key");
  });
});

/**
 * Parse + merge survival: a value set at the DEFAULTS tier for every newly
 * mirrored key must survive `parse` (not be stripped) AND survive
 * `mergeAgentConfig` (cascade into an agent that omits it). A shape-diff proves
 * the KEY exists; these prove the VALUE actually flows.
 */
describe("newly mirrored keys survive parse + merge cascade", () => {
  const defaults = AgentDefaultsSchema.parse({
    memory: {
      recall: {
        types: ["world", "experience"],
        skip_trivial: false,
        topic_filter_mode: "hard-filter",
        max_memories: 9,
      },
      retain: { every_n_turns: 7, overlap_turns: 4 },
      bank_mission: "bm",
      reflect_mission: "rm",
      reflect_budget: "mid",
      reflect_max_tokens: 2048,
      retain_mission: "rtm",
      observations_mission: "om",
      disposition: { skepticism: 5, literalism: 2 },
    },
  });

  it("defaults tier: every mirrored key survives parse (not stripped)", () => {
    const m = defaults!.memory!;
    expect(m.recall?.types).toEqual(["world", "experience"]);
    expect(m.recall?.skip_trivial).toBe(false);
    expect(m.recall?.topic_filter_mode).toBe("hard-filter");
    expect(m.retain?.every_n_turns).toBe(7);
    expect(m.retain?.overlap_turns).toBe(4);
    expect(m.bank_mission).toBe("bm");
    expect(m.reflect_mission).toBe("rm");
    expect(m.reflect_budget).toBe("mid");
    expect(m.reflect_max_tokens).toBe(2048);
    expect(m.retain_mission).toBe("rtm");
    expect(m.observations_mission).toBe("om");
    expect(m.disposition?.skepticism).toBe(5);
    expect(m.disposition?.literalism).toBe(2);
  });

  it("profile tier: retain + missions survive parse", () => {
    const p = ProfileSchema.parse({
      memory: {
        retain: { every_n_turns: 2 },
        recall: { skip_trivial: true },
        observations_mission: "pm",
      },
    });
    expect(p.memory?.retain?.every_n_turns).toBe(2);
    expect(p.memory?.recall?.skip_trivial).toBe(true);
    expect(p.memory?.observations_mission).toBe("pm");
  });

  it("cascade: an agent that omits the keys inherits them from defaults", () => {
    const agent = AgentSchema.parse({
      topic_name: "ops",
      memory: { collection: "ops-bank" },
    });
    const merged = mergeAgentConfig(defaults, agent);
    const m = merged.memory!;
    expect(m.recall?.types).toEqual(["world", "experience"]);
    expect(m.recall?.topic_filter_mode).toBe("hard-filter");
    expect(m.retain?.every_n_turns).toBe(7);
    expect(m.retain?.overlap_turns).toBe(4);
    expect(m.bank_mission).toBe("bm");
    expect(m.reflect_mission).toBe("rm");
    expect(m.reflect_budget).toBe("mid");
    expect(m.reflect_max_tokens).toBe(2048);
    expect(m.retain_mission).toBe("rtm");
    expect(m.observations_mission).toBe("om");
    expect(m.disposition?.skepticism).toBe(5);
  });

  it("cascade: per-agent reflect_budget/reflect_max_tokens override the defaults (via resolveAgentConfig)", () => {
    const agent = AgentSchema.parse({
      topic_name: "ops",
      memory: { collection: "ops-bank", reflect_budget: "high", reflect_max_tokens: 512 },
    });
    // Inheritance path: an agent that OMITS them picks up the defaults.
    const inherited = resolveAgentConfig(defaults, undefined, AgentSchema.parse({
      topic_name: "ops",
      memory: { collection: "ops-bank" },
    }));
    expect(inherited.memory?.reflect_budget).toBe("mid");
    expect(inherited.memory?.reflect_max_tokens).toBe(2048);
    // Override path: per-agent wins over the fleet default.
    const overridden = resolveAgentConfig(defaults, undefined, agent);
    expect(overridden.memory?.reflect_budget).toBe("high");
    expect(overridden.memory?.reflect_max_tokens).toBe(512);
  });

  it("rejects an invalid reflect_budget enum value at parse", () => {
    expect(() =>
      AgentMemorySchema.parse({ reflect_budget: "turbo" }),
    ).toThrow();
    // The defaults-tier mirror must reject it too (not silently strip).
    expect(() =>
      AgentDefaultsSchema.parse({ memory: { reflect_budget: "turbo" } }),
    ).toThrow();
  });

  it("cascade: retain + disposition per-key merge (agent overrides one, inherits siblings)", () => {
    const agent = AgentSchema.parse({
      topic_name: "ops",
      memory: {
        collection: "ops-bank",
        retain: { every_n_turns: 1 },
        disposition: { empathy: 4 },
      },
    });
    const merged = mergeAgentConfig(defaults, agent);
    const m = merged.memory!;
    // retain: agent wins on every_n_turns, inherits overlap_turns from defaults.
    expect(m.retain?.every_n_turns).toBe(1);
    expect(m.retain?.overlap_turns).toBe(4);
    // disposition: agent wins on empathy, inherits skepticism/literalism.
    expect(m.disposition?.empathy).toBe(4);
    expect(m.disposition?.skepticism).toBe(5);
    expect(m.disposition?.literalism).toBe(2);
  });
});

/**
 * Global hindsight.llm base_url / api_key survive parse (#3687). The env
 * EMISSION is covered in src/setup — here we only prove the schema accepts and
 * retains the two new global fields rather than stripping them.
 */
describe("hindsight.llm global base_url / api_key survive parse (#3687)", () => {
  it("accepts and retains both fields on the global llm object", () => {
    const cfg = HindsightConfigSchema.parse({
      llm: {
        provider: "litellm",
        model: "openrouter/some/model",
        base_url: "http://127.0.0.1:4010",
        api_key: "vault:litellm/hindsight/api-key",
      },
    });
    expect(cfg.llm?.base_url).toBe("http://127.0.0.1:4010");
    expect(cfg.llm?.api_key).toBe("vault:litellm/hindsight/api-key");
  });
});
