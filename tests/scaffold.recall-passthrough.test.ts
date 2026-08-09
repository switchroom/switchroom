import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
import {
  resolveHindsightRecallPassthrough,
  RECALL_PASSTHROUGH_DEFAULTS,
  RECALL_PASSTHROUGH_ERROR_MARKER,
  HINDSIGHT_RECALL_TAG_WEIGHT_SEED,
  HINDSIGHT_RECALL_PROMPT_PREAMBLE_DEFAULT,
} from "../src/setup/hindsight-recall-passthrough.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * #3841 — `memory.recall.*` passthrough for the recall knobs that previously
 * had no switchroom.yaml surface.
 *
 * Two properties are load-bearing and both are asserted on OUTCOMES (the
 * rendered `start.sh`, the scaffolded `settings.json`, a real `sh` evaluating
 * the exported line), never on "the code ran":
 *
 *  1. **Zero behaviour change when unset.** Each default must equal the value
 *     the fleet already resolved through DEFAULTS -> settings.json -> (no env).
 *     Pinned whole-line, and cross-checked against the vendored plugin itself so
 *     a vendor bump that moves a default reds here instead of silently
 *     re-tuning every agent.
 *  2. **The value that reaches the plugin is the value the operator wrote.**
 *     A knob that renders empty, renders unquoted, or renders under a name
 *     `config.py` does not read fails SILENTLY at runtime — `_cast_env` is
 *     fail-open, so the plugin default stands while switchroom.yaml reads as
 *     though it were in force.
 */

const VENDOR_SETTINGS = JSON.parse(
  readFileSync(join(__dirname, "..", "vendor", "hindsight-memory", "settings.json"), "utf-8"),
) as Record<string, unknown>;

const VENDOR_CONFIG_PY = readFileSync(
  join(__dirname, "..", "vendor", "hindsight-memory", "scripts", "lib", "config.py"),
  "utf-8",
);

/** Pull a `"key": True/False,` literal out of config.py's DEFAULTS block. */
function vendorDefaultBool(key: string): boolean {
  const m = VENDOR_CONFIG_PY.match(new RegExp(`^\\s*"${key}":\\s*(True|False),`, "m"));
  if (!m) throw new Error(`config.py has no DEFAULTS entry for ${key}`);
  return m[1] === "True";
}

function exportedLine(startSh: string, name: string): string {
  const m = startSh.match(new RegExp(`^export ${name}=(.*)$`, "m"));
  if (!m) throw new Error(`start.sh does not export ${name}`);
  return m[1];
}

/** Evaluate one exported line with a real shell and read the value back. */
function shellValueOf(startSh: string, name: string): string {
  const line = `export ${name}=${exportedLine(startSh, name)}`;
  return execFileSync("sh", ["-c", `${line}; printf '%s' "$${name}"`], {
    encoding: "utf-8",
  });
}

describe("recall passthrough (#3841)", () => {
  let tmpDir: string;
  let telegram: TelegramConfig;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `recall-passthrough-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(tmpDir, { recursive: true });
    telegram = { bot_token: "t", forum_chat_id: "c" };
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function scaffold(agentConfig: AgentConfig): { startSh: string; agentDir: string } {
    const config = {
      agents: { probe: agentConfig },
      memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
      telegram,
    } as unknown as SwitchroomConfig;
    const res = scaffoldAgent("probe", agentConfig, tmpDir, telegram, config);
    return {
      startSh: readFileSync(join(res.agentDir, "start.sh"), "utf-8"),
      agentDir: res.agentDir,
    };
  }

  function withRecall(recall: Record<string, unknown>): AgentConfig {
    return { memory: { collection: "probe", recall } } as unknown as AgentConfig;
  }

  describe("defaults are the values the fleet already runs", () => {
    it("matches the vendored plugin's settings.json for every key it ships", () => {
      // A vendor bump that changes one of these must red HERE, loudly, rather
      // than silently re-tuning every agent through switchroom's export (which
      // outranks settings.json).
      expect(RECALL_PASSTHROUGH_DEFAULTS.budget).toBe(VENDOR_SETTINGS.recallBudget);
      expect(RECALL_PASSTHROUGH_DEFAULTS.maxTokens).toBe(VENDOR_SETTINGS.recallMaxTokens);
      expect(RECALL_PASSTHROUGH_DEFAULTS.contextTurns).toBe(VENDOR_SETTINGS.recallContextTurns);
      expect(RECALL_PASSTHROUGH_DEFAULTS.roles).toEqual(VENDOR_SETTINGS.recallRoles);
      expect(RECALL_PASSTHROUGH_DEFAULTS.maxQueryChars).toBe(VENDOR_SETTINGS.recallMaxQueryChars);
      expect(RECALL_PASSTHROUGH_DEFAULTS.transcriptTailBytes).toBe(
        VENDOR_SETTINGS.recallTranscriptTailBytes,
      );
      expect(RECALL_PASSTHROUGH_DEFAULTS.tags).toEqual(VENDOR_SETTINGS.recallTags);
      expect(RECALL_PASSTHROUGH_DEFAULTS.tagsMatch).toBe(VENDOR_SETTINGS.recallTagsMatch);
      expect(RECALL_PASSTHROUGH_DEFAULTS.additionalBankFilters).toEqual(
        VENDOR_SETTINGS.recallAdditionalBankFilters,
      );
      expect(HINDSIGHT_RECALL_PROMPT_PREAMBLE_DEFAULT).toBe(VENDOR_SETTINGS.recallPromptPreamble);
      // settings.json ships `recallTagGroups: null`; `_load_settings_file`
      // drops nulls, so the effective value is config.py's None. `{}` is the
      // same thing to recall.py (`or None`) and, unlike `null`, assigns.
      expect(VENDOR_SETTINGS.recallTagGroups).toBeNull();
      expect(RECALL_PASSTHROUGH_DEFAULTS.tagGroups).toEqual({});
    });

    it("resolves the recall budget to mid when nothing overrides it", () => {
      // Outcome assertion on the resolved value, not just the code path: with
      // no memory.recall config the fleet default is `mid` (the low->mid tune).
      expect(resolveHindsightRecallPassthrough(undefined).budget).toBe("mid");
      expect(resolveHindsightRecallPassthrough({}).budget).toBe("mid");
    });

    it("lets an explicit per-agent budget override the new mid default", () => {
      // Precedence still holds after the default moved: an agent that pins its
      // own budget keeps winning. `low` is the exact case that must survive the
      // default flip (env HINDSIGHT_RECALL_BUDGET is exported from this resolved
      // value and outranks settings.json in config.py's cascade).
      expect(resolveHindsightRecallPassthrough({ budget: "low" }).budget).toBe("low");
      expect(resolveHindsightRecallPassthrough({ budget: "high" }).budget).toBe("high");
      const { startSh } = scaffold(withRecall({ budget: "low" }));
      expect(startSh).toContain("export HINDSIGHT_RECALL_BUDGET=low\n");
    });

    it("matches config.py DEFAULTS for the keys settings.json does not ship", () => {
      expect(VENDOR_SETTINGS.recallPreferObservations).toBeUndefined();
      expect(VENDOR_SETTINGS.recallTranscriptFallback).toBeUndefined();
      expect(VENDOR_SETTINGS.recallParallel).toBeUndefined();
      expect(RECALL_PASSTHROUGH_DEFAULTS.preferObservations).toBe(
        vendorDefaultBool("recallPreferObservations"),
      );
      expect(RECALL_PASSTHROUGH_DEFAULTS.transcriptFallback).toBe(
        vendorDefaultBool("recallTranscriptFallback"),
      );
      expect(RECALL_PASSTHROUGH_DEFAULTS.parallel).toBe(vendorDefaultBool("recallParallel"));
    });

    it("carries the same sidechain tag-weight seed the settings.json stamp writes", () => {
      // One literal, two channels. If they drift, the env export (which wins)
      // silently overrides the stamp.
      const { agentDir } = scaffold({ memory: { collection: "probe" } } as unknown as AgentConfig);
      const settings = JSON.parse(
        readFileSync(
          join(agentDir, ".claude", "plugins", "hindsight-memory", "settings.json"),
          "utf-8",
        ),
      ) as Record<string, unknown>;
      expect(settings.recallTagWeights).toEqual({ ...HINDSIGHT_RECALL_TAG_WEIGHT_SEED });
      expect(RECALL_PASSTHROUGH_DEFAULTS.tagWeights).toEqual({ ...HINDSIGHT_RECALL_TAG_WEIGHT_SEED });
    });
  });

  describe("an agent with no memory.recall config", () => {
    it("exports every knob at exactly today's effective value", () => {
      const { startSh } = scaffold({} as AgentConfig);
      // Whole-line matches including the trailing newline: `toContain("=1")`
      // would also be satisfied by a rendered `=1024`, so a changed default
      // could sail through a substring assertion.
      expect(startSh).toContain("export HINDSIGHT_RECALL_BUDGET=mid\n");
      expect(startSh).toContain("export HINDSIGHT_RECALL_MAX_TOKENS=1024\n");
      expect(startSh).toContain("export HINDSIGHT_RECALL_PREFER_OBSERVATIONS=true\n");
      expect(startSh).toContain("export HINDSIGHT_RECALL_CONTEXT_TURNS=2\n");
      expect(startSh).toContain(`export HINDSIGHT_RECALL_ROLES='["user","assistant"]'\n`);
      expect(startSh).toContain("export HINDSIGHT_RECALL_MAX_QUERY_CHARS=800\n");
      expect(startSh).toContain("export HINDSIGHT_RECALL_TRANSCRIPT_TAIL_BYTES=262144\n");
      expect(startSh).toContain(`export HINDSIGHT_RECALL_TAGS='[]'\n`);
      expect(startSh).toContain("export HINDSIGHT_RECALL_TAGS_MATCH=any\n");
      expect(startSh).toContain(`export HINDSIGHT_RECALL_TAG_GROUPS='{}'\n`);
      expect(startSh).toContain(`export HINDSIGHT_RECALL_TAG_WEIGHTS='{"sidechain":0.8}'\n`);
      expect(startSh).toContain(`export HINDSIGHT_RECALL_ADDITIONAL_BANK_FILTERS='{}'\n`);
      expect(startSh).toContain("export HINDSIGHT_RECALL_TRANSCRIPT_FALLBACK=true\n");
      expect(startSh).toContain("export HINDSIGHT_RECALL_PARALLEL=true\n");
      expect(shellValueOf(startSh, "HINDSIGHT_RECALL_PROMPT_PREAMBLE")).toBe(
        HINDSIGHT_RECALL_PROMPT_PREAMBLE_DEFAULT,
      );
    });

    it("never renders an empty assignment", () => {
      // `_cast_env("", int)` returns None and config.py SKIPS the assignment,
      // so an empty export is indistinguishable from no export — and a stale
      // ~/.hindsight/claude-code.json wins again with every other test green.
      // A typo'd handlebars path renders empty rather than throwing, which is
      // exactly how this regression arrives.
      const { startSh } = scaffold({} as AgentConfig);
      const empties = startSh
        .split("\n")
        .filter((l) => /^export HINDSIGHT_RECALL_[A-Z_]+=$/.test(l));
      expect(empties).toEqual([]);
    });
  });

  describe("an operator-set value reaches the plugin", () => {
    it("exports each scalar knob as configured", () => {
      const { startSh } = scaffold(
        withRecall({
          budget: "high",
          max_tokens: 2048,
          prefer_observations: false,
          context_turns: 1,
          max_query_chars: 400,
          transcript_tail_bytes: 0,
          transcript_fallback: false,
          parallel: false,
          tags_match: "all_strict",
        }),
      );
      expect(startSh).toContain("export HINDSIGHT_RECALL_BUDGET=high\n");
      expect(startSh).toContain("export HINDSIGHT_RECALL_MAX_TOKENS=2048\n");
      expect(startSh).toContain("export HINDSIGHT_RECALL_PREFER_OBSERVATIONS=false\n");
      expect(startSh).toContain("export HINDSIGHT_RECALL_CONTEXT_TURNS=1\n");
      expect(startSh).toContain("export HINDSIGHT_RECALL_MAX_QUERY_CHARS=400\n");
      expect(startSh).toContain("export HINDSIGHT_RECALL_TRANSCRIPT_TAIL_BYTES=0\n");
      expect(startSh).toContain("export HINDSIGHT_RECALL_TRANSCRIPT_FALLBACK=false\n");
      expect(startSh).toContain("export HINDSIGHT_RECALL_PARALLEL=false\n");
      expect(startSh).toContain("export HINDSIGHT_RECALL_TAGS_MATCH=all_strict\n");
    });

    it("serialises lists as JSON, not as a bare shell word", () => {
      const { startSh } = scaffold(withRecall({ roles: ["user"], tags: ["profile", "ken"] }));
      expect(shellValueOf(startSh, "HINDSIGHT_RECALL_ROLES")).toBe('["user"]');
      expect(shellValueOf(startSh, "HINDSIGHT_RECALL_TAGS")).toBe('["profile","ken"]');
    });

    it("serialises the structured knobs as JSON the plugin can parse", () => {
      const { startSh } = scaffold(
        withRecall({
          tag_groups: [["a", "b"], ["c"]],
          tag_weights: { lesson: 0.5 },
          additional_bank_filters: {
            "ken-profile": { tags: ["profile"], tags_match: "all" },
          },
        }),
      );
      expect(JSON.parse(shellValueOf(startSh, "HINDSIGHT_RECALL_TAG_GROUPS"))).toEqual([
        ["a", "b"],
        ["c"],
      ]);
      // Merged over the seed, not replacing it: a single unrelated weight must
      // not silently un-demote delegated sub-agent memories.
      expect(JSON.parse(shellValueOf(startSh, "HINDSIGHT_RECALL_TAG_WEIGHTS"))).toEqual({
        sidechain: 0.8,
        lesson: 0.5,
      });
      // Translated into the camelCase keys recall.py reads off the map
      // (recall.py:2018-2023) — the yaml surface is snake_case.
      expect(
        JSON.parse(shellValueOf(startSh, "HINDSIGHT_RECALL_ADDITIONAL_BANK_FILTERS")),
      ).toEqual({ "ken-profile": { recallTags: ["profile"], recallTagsMatch: "all" } });
    });

    it("lets an explicit sidechain weight neutralise the seed", () => {
      const { startSh } = scaffold(withRecall({ tag_weights: { sidechain: 1 } }));
      expect(JSON.parse(shellValueOf(startSh, "HINDSIGHT_RECALL_TAG_WEIGHTS"))).toEqual({
        sidechain: 1,
      });
    });

    it("survives a preamble containing shell metacharacters", () => {
      // Free-form operator text on an `export` line. Unquoted, a single quote
      // or a `$(...)` would either break the boot or execute.
      const nasty = `It's $(rm -rf /) \`backtick\` "quoted" $HOME`;
      const { startSh } = scaffold(withRecall({ prompt_preamble: nasty }));
      expect(shellValueOf(startSh, "HINDSIGHT_RECALL_PROMPT_PREAMBLE")).toBe(nasty);
    });
  });

  describe("reconcile emits the same knobs as scaffold", () => {
    // `reconcileAgentInner` hand-builds its own template context instead of
    // going through buildWorkspaceContext. A knob wired into only one of them
    // renders EMPTY on the other path — handlebars resolves an unknown path to
    // "" rather than throwing — and an empty export is skipped by `_cast_env`,
    // handing the knob back to ~/.hindsight/claude-code.json. Caught in CI on
    // the first push of this feature, so it is not hypothetical.
    it("renders byte-identical recall exports on both paths", () => {
      const agentConfig = withRecall({
        budget: "mid",
        max_tokens: 2048,
        prefer_observations: false,
        context_turns: 3,
        roles: ["user"],
        prompt_preamble: "Past context — it's yours:",
        tags: ["profile"],
        tags_match: "all_strict",
        tag_groups: { core: ["profile"] },
        tag_weights: { lesson: 1.4 },
        additional_bank_filters: { "ken-profile": { tags: ["profile"] } },
        transcript_fallback: false,
        transcript_tail_bytes: 4096,
        max_query_chars: 400,
        parallel: false,
      });
      const config = {
        agents: { probe: agentConfig },
        memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
        telegram,
      } as unknown as SwitchroomConfig;

      const res = scaffoldAgent("probe", agentConfig, tmpDir, telegram, config);
      const startShPath = join(res.agentDir, "start.sh");
      const scaffolded = readFileSync(startShPath, "utf-8");
      reconcileAgent("probe", agentConfig, tmpDir, telegram, config);
      const reconciled = readFileSync(startShPath, "utf-8");

      const recallLines = (sh: string) =>
        sh.split("\n").filter((l) => l.startsWith("export HINDSIGHT_RECALL_"));
      // Named explicitly, so a knob that silently drops off BOTH paths still
      // reds — an equality check alone would call two identical gaps a pass.
      const names = (sh: string) =>
        recallLines(sh).map((l) => l.slice("export ".length).split("=")[0]);
      for (const name of [
        "HINDSIGHT_RECALL_BUDGET",
        "HINDSIGHT_RECALL_MAX_TOKENS",
        "HINDSIGHT_RECALL_PREFER_OBSERVATIONS",
        "HINDSIGHT_RECALL_CONTEXT_TURNS",
        "HINDSIGHT_RECALL_ROLES",
        "HINDSIGHT_RECALL_PROMPT_PREAMBLE",
        "HINDSIGHT_RECALL_MAX_QUERY_CHARS",
        "HINDSIGHT_RECALL_TRANSCRIPT_TAIL_BYTES",
        "HINDSIGHT_RECALL_TRANSCRIPT_FALLBACK",
        "HINDSIGHT_RECALL_TAGS",
        "HINDSIGHT_RECALL_TAGS_MATCH",
        "HINDSIGHT_RECALL_TAG_GROUPS",
        "HINDSIGHT_RECALL_TAG_WEIGHTS",
        "HINDSIGHT_RECALL_ADDITIONAL_BANK_FILTERS",
        "HINDSIGHT_RECALL_PARALLEL",
      ]) {
        expect(names(scaffolded)).toContain(name);
        expect(names(reconciled)).toContain(name);
      }
      expect(recallLines(reconciled)).toEqual(recallLines(scaffolded));
      expect(recallLines(reconciled).some((l) => /=$/.test(l))).toBe(false);
    });
  });

  describe("invalid config fails loudly at scaffold time", () => {
    // `_cast_env` is fail-open: a value it cannot cast is DROPPED and the
    // plugin default silently stands. So a bad knob has to red the apply.
    const cases: Array<[string, Record<string, unknown>]> = [
      ["budget outside the enum", { budget: "medium" }],
      ["tags_match outside the enum", { tags_match: "either" }],
      ["non-integer context_turns", { context_turns: 1.5 }],
      ["zero max_tokens", { max_tokens: 0 }],
      ["negative transcript_tail_bytes", { transcript_tail_bytes: -1 }],
      ["a non-numeric tag weight", { tag_weights: { lesson: "heavy" } }],
      ["a negative tag weight", { tag_weights: { lesson: -1 } }],
      ["tag_groups that are not tag arrays", { tag_groups: ["a", "b"] }],
      ["a non-string role", { roles: [42] }],
      // These two CAST cleanly and assign, so the plugin default does not save
      // you: empty roles means no transcript turn qualifies to build the query
      // from, and an empty banner puts recalled memories in the prompt with
      // nothing framing them as memories.
      ["an empty roles list", { roles: [] }],
      ["an empty prompt_preamble", { prompt_preamble: "" }],
      ["a whitespace-only prompt_preamble", { prompt_preamble: "   " }],
      ["a bank filter that is not a map", { additional_bank_filters: { bank: "profile" } }],
      [
        "a bank filter with an illegal tags_match",
        { additional_bank_filters: { bank: { tags_match: "either" } } },
      ],
    ];
    for (const [label, recall] of cases) {
      it(`rejects ${label}`, () => {
        expect(() => scaffold(withRecall(recall))).toThrow(RECALL_PASSTHROUGH_ERROR_MARKER);
      });
    }

    it("names the offending key in the message", () => {
      expect(() => resolveHindsightRecallPassthrough({ budget: "medium" })).toThrow(
        /memory\.recall\.budget/,
      );
      expect(() =>
        resolveHindsightRecallPassthrough({
          additional_bank_filters: { "ken-profile": { tags: [""] } },
        } as never),
      ).toThrow(/additional_bank_filters\.ken-profile\.tags/);
    });
  });
});
