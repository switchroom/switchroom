import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findUnknownMemoryKeys,
  KNOWN_MEMORY_RECALL_KEYS,
  KNOWN_MEMORY_KEYS,
  KNOWN_MIRROR_MEMORY_KEYS,
  RETIRED_MEMORY_RECALL_KEYS,
} from "../src/config/memory-key-drift.js";
import { checkMemoryKeysAreKnown } from "../src/cli/doctor.js";
import { loadConfig } from "../src/config/loader.js";

/**
 * The bug these tests guard (#3773).
 *
 * `memory.recall` / `memory.retain` are NON-strict zod objects: a key the
 * schema does not declare is silently STRIPPED at parse time. No error, no
 * warning, and `switchroom doctor` used to say nothing — so a `switchroom.yaml`
 * line reads as configured and has zero effect. A REMOVED knob
 * (`memory.recall.min_overlap`, whose recall gate was deleted in #3761) is
 * worse: the operator has positive evidence they once set it.
 *
 * These assert the OUTCOME the fix owes: the config still PARSES (no `.strict()`
 * hard-fail) AND a doctor FAIL row (mirroring the sibling `hindsight env keys`
 * row — no benign reading of the state) names the offending agent + key, with a
 * specific message for a retired knob. A FAIL row only makes `switchroom
 * doctor` exit non-zero; it does NOT refuse to boot the fleet.
 */

let tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

function writeTempConfig(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), "switchroom-memkey-test-"));
  tempRoots.push(root);
  const path = join(root, "switchroom.yaml");
  writeFileSync(path, yaml);
  return path;
}

const BASE = `
switchroom:
  version: 1
telegram:
  bot_token: "x"
  forum_chat_id: "1"
agents: {}
`.trim();

describe("findUnknownMemoryKeys: pure diff against the schema", () => {
  it("derives the known key set from the schema, not a hand-list", () => {
    // Regression guard for the deterministic half: if the schema keys stop
    // being reachable, every real key would falsely warn.
    expect(KNOWN_MEMORY_RECALL_KEYS.has("min_score")).toBe(true);
    expect(KNOWN_MEMORY_RECALL_KEYS.has("max_memories")).toBe(true);
    expect(KNOWN_MEMORY_KEYS.has("collection")).toBe(true);
    // The retired knob is NOT in the current schema.
    expect(KNOWN_MEMORY_RECALL_KEYS.has("min_overlap")).toBe(false);
  });

  it("is silent on a fully-recognized memory block", () => {
    expect(
      findUnknownMemoryKeys({
        collection: "x",
        auto_recall: true,
        recall: { max_memories: 6, min_score: 0.01 },
        retain: { every_n_turns: 3 },
      }),
    ).toEqual([]);
  });

  it("flags a removed knob with its specific retired message", () => {
    const found = findUnknownMemoryKeys({ recall: { min_overlap: 0.15 } });
    expect(found).toHaveLength(1);
    expect(found[0].scope).toBe("memory.recall");
    expect(found[0].key).toBe("min_overlap");
    expect(found[0].replacement).toBe(RETIRED_MEMORY_RECALL_KEYS.min_overlap);
    expect(found[0].replacement).toContain("#3761");
  });

  it("flags a plain typo with no replacement message", () => {
    const found = findUnknownMemoryKeys({ recall: { max_memoryes: 6 } });
    expect(found).toHaveLength(1);
    expect(found[0].key).toBe("max_memoryes");
    expect(found[0].replacement).toBeUndefined();
  });

  it("covers the top-level memory object and retain sibling too", () => {
    const found = findUnknownMemoryKeys({
      bogus_top: true,
      retain: { every_n_turns: 3, made_up: 1 },
    });
    expect(found.map((f) => `${f.scope}.${f.key}`).sort()).toEqual([
      "memory.bogus_top",
      "memory.retain.made_up",
    ]);
  });

  it("is total on non-object / empty input", () => {
    expect(findUnknownMemoryKeys(undefined)).toEqual([]);
    expect(findUnknownMemoryKeys("nope")).toEqual([]);
    expect(findUnknownMemoryKeys({})).toEqual([]);
  });
});

/**
 * Tier coverage (MAJOR 2 / the false-all-clear class).
 *
 * `defaults.memory` and `profiles.*.memory` are parsed by a DISTINCT, narrower
 * inline mirror schema — not `AgentMemorySchema`. A key that is valid per-agent
 * but absent from the mirror is silently stripped at the defaults/profile tier;
 * diffing that tier against the per-agent key set would falsely clear it.
 * `mental_models` is the canonical proof: per-agent ONLY by design, never
 * mirrored.
 */
describe("findUnknownMemoryKeys: tier-aware known-key set", () => {
  it("mental_models is known per-agent but NOT at the defaults/profile mirror tier", () => {
    // Sanity-anchor the divergence at the schema level so this test can't rot
    // into a tautology if the sets ever collapse together.
    expect(KNOWN_MEMORY_KEYS.has("mental_models")).toBe(true);
    expect(KNOWN_MIRROR_MEMORY_KEYS.has("mental_models")).toBe(false);
  });

  it("agent tier clears a mental_models block; mirror tier flags it as stripped", () => {
    const block = { mental_models: { foo: { source_query: "q" } } };
    // Per-agent: mental_models is a real key — no drift.
    expect(findUnknownMemoryKeys(block, "agent")).toEqual([]);
    // Defaults/profile tier: the mirror strips it, so it must be caught —
    // exactly the tier that a per-agent-only diff would have falsely cleared.
    const mirror = findUnknownMemoryKeys(block, "mirror");
    expect(mirror).toHaveLength(1);
    expect(mirror[0].scope).toBe("memory");
    expect(mirror[0].key).toBe("mental_models");
    expect(mirror[0].replacement).toBeUndefined();
  });

  it("defaults to the agent tier when no tier is given", () => {
    expect(findUnknownMemoryKeys({ mental_models: {} })).toEqual([]);
  });

  it("a key mirrored by PR-02 is clean at BOTH tiers (no false-fire)", () => {
    // recall.min_score / retain.every_n_turns are now present in the mirror
    // (PR-02). Reconcile: neither tier should flag them.
    const block = {
      recall: { min_score: 0.01 },
      retain: { every_n_turns: 3 },
    };
    expect(findUnknownMemoryKeys(block, "agent")).toEqual([]);
    expect(findUnknownMemoryKeys(block, "mirror")).toEqual([]);
  });
});

describe("checkMemoryKeysAreKnown: parses-clean AND fails (the #3773 outcome)", () => {
  const yamlWithRetiredKnob = `${BASE.replace(
    "agents: {}",
    `agents:
  klanker:
    bot_token: "vault:k-bot"
    forum_chat_id: 1
    topic_name: "klanker"
    memory:
      collection: klanker
      recall:
        max_memories: 6
        min_overlap: 0.15`,
  )}`;

  it("the config with a removed knob still PARSES (no .strict() hard-fail)", () => {
    const path = writeTempConfig(yamlWithRetiredKnob);
    expect(() => loadConfig(path)).not.toThrow();
    const config = loadConfig(path);
    // And zod has silently stripped it — which is exactly why a raw-yaml doctor
    // row is needed: the parsed config looks clean.
    expect(
      (config.agents.klanker?.memory?.recall as Record<string, unknown>)?.min_overlap,
    ).toBeUndefined();
  });

  it("the doctor row FAILs, names the agent, the key, and the replacement", () => {
    const path = writeTempConfig(yamlWithRetiredKnob);
    const r = checkMemoryKeysAreKnown(path);
    // FAIL, not WARN — mirrors the sibling `hindsight env keys` row; a FAIL row
    // only makes `switchroom doctor` exit non-zero, it does not block boot.
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("klanker");
    expect(r.detail).toContain("min_overlap");
    expect(r.detail).toContain("#3761");
  });

  it("is OK when every memory key is recognized", () => {
    const path = writeTempConfig(
      `${BASE.replace(
        "agents: {}",
        `agents:
  klanker:
    bot_token: "vault:k-bot"
    forum_chat_id: 1
    topic_name: "klanker"
    memory:
      collection: klanker
      recall:
        max_memories: 6
        min_score: 0.01`,
      )}`,
    );
    expect(checkMemoryKeysAreKnown(path).status).toBe("ok");
  });

  it("also catches a dead key at the defaults tier, naming it", () => {
    const path = writeTempConfig(
      `${BASE}
defaults:
  memory:
    recall:
      min_overlap: 0.2`,
    );
    const r = checkMemoryKeysAreKnown(path);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("defaults");
    expect(r.detail).toContain("min_overlap");
  });

  it("catches a key valid per-agent but stripped by the defaults-tier mirror", () => {
    // `mental_models` is per-agent ONLY — never mirrored. Set at the defaults
    // tier it is silently stripped at parse (the #3773 class). A per-agent-only
    // diff would FALSELY clear it; the tier-aware check must flag it.
    const path = writeTempConfig(
      `${BASE}
defaults:
  memory:
    mental_models:
      seeded:
        source_query: "q"`,
    );
    const r = checkMemoryKeysAreKnown(path);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("defaults");
    expect(r.detail).toContain("mental_models");
  });

  it("does NOT flag mental_models when set per-agent (valid there)", () => {
    const path = writeTempConfig(
      `${BASE.replace(
        "agents: {}",
        `agents:
  klanker:
    bot_token: "vault:k-bot"
    forum_chat_id: 1
    topic_name: "klanker"
    memory:
      collection: klanker
      mental_models:
        seeded:
          source_query: "q"`,
      )}`,
    );
    expect(checkMemoryKeysAreKnown(path).status).toBe("ok");
  });

  it("is a no-op (OK) on an unreadable config path rather than throwing", () => {
    const r = checkMemoryKeysAreKnown(
      join(tmpdir(), "switchroom-does-not-exist-xyz", "switchroom.yaml"),
    );
    expect(r.status).toBe("ok");
  });
});
