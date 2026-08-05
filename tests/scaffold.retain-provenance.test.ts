import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { installHindsightPlugin } from "../src/agents/scaffold.js";
import {
  RETAIN_PROVENANCE_TAG,
  RETAIN_PROVENANCE_TAG_SCOPE_PATTERN,
  RETAIN_TAGS_DEFAULT,
  SELF_IMPROVE_CORRECTION_TAG,
  SELF_IMPROVE_CORRECTION_PENDING_FILE,
} from "../src/memory/hindsight-retain-provenance.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

/**
 * Provenance on auto-retained transcript content.
 *
 * The defect: the Stop-hook retain posted the transcript window with
 * `tags: ["<session-uuid>"]` and a `session_id` in `metadata`. Hindsight's
 * metadata is NOT filterable (tags are), and a raw UUID carries no semantics,
 * so a memory unit extracted out of the agent's own synthesis was
 * indistinguishable from a curated fact at recall/reflect time.
 *
 * These tests assert the OUTCOME an operator can observe: what lands in the
 * agent's deployed `settings.json`, and — in the paired Python test
 * `vendor/hindsight-memory/scripts/tests/test_retain_provenance_tag.py` — what
 * lands in the retain payload and its observation scope.
 */
describe("hindsight retain — transcript provenance tag", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `scaffold-retain-prov-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function deployedSettings(agentMemory?: unknown): Record<string, unknown> {
    const config = {
      agents: { probe: agentMemory ? { memory: agentMemory } : {} },
      memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
      telegram: { bot_token: "t", forum_chat_id: "c" },
    } as unknown as SwitchroomConfig;
    const res = installHindsightPlugin("probe", tmpDir, config);
    expect(res).not.toBeNull();
    const p = join(tmpDir, ".claude", "plugins", "hindsight-memory", "settings.json");
    expect(existsSync(p)).toBe(true);
    return JSON.parse(readFileSync(p, "utf-8"));
  }

  it("stamps the provenance tag into every agent's deployed settings.json, with zero config", () => {
    const s = deployedSettings();
    expect(s.retainTags).toEqual(["{session_id}", RETAIN_PROVENANCE_TAG]);
  });

  it("keeps {session_id} — the provenance tag is appended, not substituted", () => {
    // The session tag is load-bearing in two places: `switchroom memory`
    // surfaces it, and the curated observation-scope strategy recognises it as
    // volatile. Dropping it would silently change scope computation.
    const s = deployedSettings();
    expect(s.retainTags).toContain("{session_id}");
  });

  it("is byte-stable across repeated installs (no settings.json churn per apply)", () => {
    const first = JSON.stringify(deployedSettings().retainTags);
    const second = JSON.stringify(deployedSettings().retainTags);
    expect(second).toBe(first);
  });

  it("the tag follows the documented <kind>:<name> convention and is not a UUID", () => {
    // https://hindsight.vectorize.io/best-practices — "Tags: Naming
    // Conventions". A stable semantic tag is what makes a recall/reflect filter
    // written once keep working; a per-session UUID never can.
    expect(RETAIN_PROVENANCE_TAG).toMatch(/^[a-z]+:[a-z-]+$/);
    expect(RETAIN_PROVENANCE_TAG).not.toMatch(
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    );
  });

  it("RETAIN_TAGS_DEFAULT is the single source for the stamp", () => {
    expect([...RETAIN_TAGS_DEFAULT]).toEqual(deployedSettings().retainTags);
  });

  /**
   * Scope-neutrality drift guard. `observationScopeStrategy: "curated"` derives
   * a retain's consolidation scope from its STABLE tags — so a stable tag that
   * reaches scope computation moves every future retain out of the bank-wide
   * `"shared"` scope into a fresh `[["source:transcript"]]` partition, cutting
   * new observations off from every observation already consolidated. The
   * vendored `config.py` must exclude it. This is the half of the contract that
   * lives in Python; if the pattern is dropped there, the tag silently becomes a
   * scope migration.
   */
  it("the vendored config.py excludes the provenance tag from the consolidation scope", () => {
    const configPy = readFileSync(
      resolve(
        __dirname,
        "..",
        "vendor",
        "hindsight-memory",
        "scripts",
        "lib",
        "config.py",
      ),
      "utf-8",
    );
    const start = configPy.indexOf("DEFAULT_VOLATILE_SCOPE_PATTERNS = (");
    expect(start).toBeGreaterThan(-1);
    // The tuple's own entries contain `)` (the sub-agent UUID pattern), so the
    // terminator is the closing paren at column 0, not the first `)`.
    const block = configPy.slice(start, configPy.indexOf("\n)", start));
    expect(block).toContain(RETAIN_PROVENANCE_TAG_SCOPE_PATTERN);
    // ...and the pattern actually matches the tag switchroom stamps.
    expect(new RegExp(RETAIN_PROVENANCE_TAG_SCOPE_PATTERN).test(RETAIN_PROVENANCE_TAG)).toBe(
      true,
    );
  });

  /**
   * PR4 slice 4a cross-language pin. The self-improve Stop hook (TS) writes the
   * correction sentinel by NAME and the vendored retain hook (Python) reads it
   * by NAME and stamps the tag by VALUE — two separate processes that share only
   * these two strings. If either copy drifts, correction turns silently stop
   * being tagged and PR5's synthesis goes blind. This guards both halves against
   * the TS source of truth.
   */
  it("retain.py pins the correction sentinel filename and tag to the TS constants", () => {
    const retainPy = readFileSync(
      resolve(
        __dirname,
        "..",
        "vendor",
        "hindsight-memory",
        "scripts",
        "retain.py",
      ),
      "utf-8",
    );
    expect(retainPy).toContain(
      `SELF_IMPROVE_CORRECTION_PENDING_FILE = "${SELF_IMPROVE_CORRECTION_PENDING_FILE}"`,
    );
    expect(retainPy).toContain(
      `SELF_IMPROVE_CORRECTION_TAG = "${SELF_IMPROVE_CORRECTION_TAG}"`,
    );
  });

  /**
   * The correction tag is STABLE, by contract — the opposite of the provenance
   * tag's forced-volatile treatment. It rides only rare correction turns, so it
   * SHOULD reach the consolidation scope (grouping those turns into their own
   * `[["self-improve:correction"]]` partition for PR5). It must therefore NOT
   * match any volatile scope pattern, and in particular not `^source:`.
   */
  it("the correction tag is stable — excluded by NO volatile scope pattern", () => {
    expect(RETAIN_PROVENANCE_TAG_SCOPE_PATTERN).toBe("^source:");
    expect(new RegExp(RETAIN_PROVENANCE_TAG_SCOPE_PATTERN).test(SELF_IMPROVE_CORRECTION_TAG)).toBe(
      false,
    );
    // Same <kind>:<name> shape as the provenance tag, distinct namespace.
    expect(SELF_IMPROVE_CORRECTION_TAG).toMatch(/^[a-z-]+:[a-z-]+$/);
    expect(SELF_IMPROVE_CORRECTION_TAG).not.toBe(RETAIN_PROVENANCE_TAG);
  });

  it("the provenance tag is addressable by the existing recall tag-weight surface", () => {
    // "Make recall able to act on it" concretely means: an operator can name the
    // tag in the `memory.recall.tag_weights` cascade and it reaches the plugin.
    // No new override syntax — the #3841 surface already does this.
    const s = deployedSettings({ recall: { tag_weights: { [RETAIN_PROVENANCE_TAG]: 0.9 } } });
    expect(s.retainTags).toContain(RETAIN_PROVENANCE_TAG);
    // The seed stamp is unchanged by an operator weight (the env export merges);
    // what matters here is that the schema accepts the tag at all.
    expect(s.recallTagWeights).toBeDefined();
  });
});
