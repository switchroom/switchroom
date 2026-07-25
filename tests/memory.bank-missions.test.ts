import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  updateBankMissions,
  DEFAULT_RETAIN_MISSION,
  SUPERSEDED_RETAIN_MISSIONS,
  isUpgradableRetainMission,
  decideRetainMissionUpgrade,
  fetchBankRetainMission,
  resolveBankMissionExtras,
  PROFILE_MEMORY_DEFAULTS,
} from "../src/memory/hindsight.js";
import {
  reconcileAgent,
  scaffoldAgent,
  flushPendingBankOps,
  __resetPendingBankOpsForTests,
  __pendingBankOpsCountForTests,
} from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";
import { AgentMemorySchema } from "../src/config/schema.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/** Drive updateBankMissions with a two-call mock and return the update_bank args. */
async function captureUpdateBankArgs(
  missions: Parameters<typeof updateBankMissions>[2],
): Promise<Record<string, unknown>> {
  const mockFetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, headers: new Map() } as any)
    .mockResolvedValueOnce({ ok: true } as any);
  const result = await updateBankMissions("http://test.local/mcp/", "test-bank", missions, {
    fetchImpl: mockFetch as any,
  });
  expect(result).toEqual({ ok: true });
  return JSON.parse(mockFetch.mock.calls[1][1].body).params.arguments;
}

// N2a (PR #3529 review): the in-flight bank-op registry is a module global.
// The scaffold/reconcile describes below start real chains, so without this
// every later test — notably "resolves immediately when nothing is in flight"
// — inherits the previous ones' entries.
beforeEach(() => {
  __resetPendingBankOpsForTests();
});

describe("DEFAULT_RETAIN_MISSION", () => {
  it("focuses extraction on durable, cross-conversation signal", () => {
    expect(DEFAULT_RETAIN_MISSION).toContain("durable facts");
    expect(DEFAULT_RETAIN_MISSION).toContain("user preferences and standing rules");
    expect(DEFAULT_RETAIN_MISSION).toContain("ongoing projects and recurring commitments");
  });

  // Regression for the 2026-07-19 fleet review (REPORT.md finding B1):
  // live banks were dominated by transient in-flight task narration
  // ("P6 worker paused waiting on its PR") rather than durable facts.
  it("explicitly excludes in-flight workflow/process narration", () => {
    expect(DEFAULT_RETAIN_MISSION).toContain("In-flight workflow/process narration");
    expect(DEFAULT_RETAIN_MISSION).toContain("retain the outcome only once the task completes");
  });

  // Regression for the 2026-07-25 retain-noise pass. The extraction model is a
  // small local gpt-oss-20b: a general "ignore transient operational details"
  // principle did NOT stop it storing transcript traces, hindsight's own batch
  // failures (UUID inline), prompt restatements, or undated transient state.
  // Each bullet below corresponds to a unit actually found in a production bank.
  it("enumerates the concrete noise classes a small extraction model must drop", () => {
    // "The assistant used ToolSearch to query for hindsight bank statistics"
    expect(DEFAULT_RETAIN_MISSION).toContain("Agent tool-use traces");
    // "Batch retain operation with ID fcf86589-… failed, processing 1 item."
    expect(DEFAULT_RETAIN_MISSION).toMatch(/UUIDs/);
    expect(DEFAULT_RETAIN_MISSION).toMatch(/Hindsight's own errors, retries, backlogs, or internal state/);
    // "User wants to identify pending/failed consolidation…"
    expect(DEFAULT_RETAIN_MISSION).toContain("Restatements of the user's current request");
    // "User has no unread mail" — stored with no timestamp, recalls forever.
    expect(DEFAULT_RETAIN_MISSION).toMatch(/Transient state .* unless the fact is explicitly dated/);
  });

  // The exclusions above are load-bearing but dangerous alone: an
  // exclusion-only mission made gpt-oss-20b return a degenerate/empty response
  // on chatty-but-real turns in the 6-window live sample. The positive
  // counterweight is what keeps genuine preferences flowing.
  it("keeps a positive counterweight so exclusions cannot starve extraction", () => {
    expect(DEFAULT_RETAIN_MISSION).toContain(
      "A preference revealed by a request is durable",
    );
  });

  // Drift guard: the vendored plugin pushes settings.json's `retainMission`
  // through lib/bank.py ensure_bank_mission the first time it sees a bank, so
  // a divergence here means which mission shapes extraction depends on
  // scaffold-vs-plugin ordering. Same pattern as the MAX_DIRECTIVES guard.
  it("is pinned byte-for-byte to the vendored plugin's settings.json retainMission", () => {
    const settings = JSON.parse(
      readFileSync(
        resolve(__dirname, "..", "vendor", "hindsight-memory", "settings.json"),
        "utf-8",
      ),
    );
    expect(settings.retainMission).toBe(DEFAULT_RETAIN_MISSION);
  });
});

describe("scaffold seed wiring", () => {
  // Structural backstop for the 2026-07-25 re-review H1 fix. `switchroom
  // apply` re-scaffolds EVERY existing agent and never calls reconcile, so
  // NEITHER site may seed the default unconditionally: both must route through
  // decideRetainMissionUpgrade (via resolveRetainMissionPush), which refuses to
  // clobber a customized mission.
  //
  // N6 (PR #3529 review): the old form counted the literal
  // "?? DEFAULT_RETAIN_MISSION" (expect 0) and "await resolveRetainMissionPush("
  // (expect 2). That missed every other spelling of the same bug
  // (`x || DEFAULT_RETAIN_MISSION`, a ternary, a local alias) and broke on
  // benign refactors that merely move a call. The durable invariant is
  // stronger and spelling-independent: scaffold.ts must not USE the constant
  // at all — the only legitimate consumer is resolveRetainMissionPush, which
  // lives in src/memory/hindsight.ts. The behavioural proof of the decision
  // itself is the reconcileAgent and scaffoldAgent describes below, which
  // exercise the unset / superseded / customized / yaml-override / read-failure
  // branches at both real call sites; the fixed call count added nothing on top
  // of that, so it is dropped rather than re-encoded.
  it("never references DEFAULT_RETAIN_MISSION outside its import", () => {
    const scaffoldSource = readFileSync(
      resolve(__dirname, "..", "src", "agents", "scaffold.ts"),
      "utf-8",
    );
    const offenders = scaffoldSource
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      // Drop the import statement and comments — only executable references
      // to the constant can seed a mission.
      .filter(({ line }) => line.includes("DEFAULT_RETAIN_MISSION"))
      .filter(({ line }) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
      .filter(({ line }) => !/^\s*import\b/.test(line) && !line.includes('from "../memory/'))
      .map(({ line, n }) => `scaffold.ts:${n}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });
});

// --- 2026-07-25 review finding 1: the mission upgrade must reach live banks ---

describe("SUPERSEDED_RETAIN_MISSIONS registry", () => {
  it("never contains the current default (that would make every apply a no-op decision)", () => {
    expect(SUPERSEDED_RETAIN_MISSIONS).not.toContain(DEFAULT_RETAIN_MISSION);
  });

  // L1 (2026-07-25 re-review): the registry is append-only by convention only
  // — pinning entry [2] alone let [0]/[1] be edited or reordered silently. An
  // edit to a historical entry stops matching the bank text it was written for
  // and silently downgrades that bank's mission to "customized, never upgrade".
  // Pin length + every entry verbatim: appending is a one-line test change,
  // editing or reordering is a deliberate, visible one.
  it("pins every historical entry verbatim and in order (append-only)", () => {
    expect(SUPERSEDED_RETAIN_MISSIONS).toEqual([
      // 3e028eeb3 (2026-05) — the vendored plugin's original settings.json
      // `retainMission`, pushed bank-side by lib/bank.py ensure_bank_mission.
      "Extract technical decisions, architectural choices, user preferences, project context, and people/tool relationships. Ignore routine greetings and transient operational details.",
      // d7c406994 (#458) — first switchroom-seeded DEFAULT_RETAIN_MISSION.
      "Extract user preferences, ongoing projects, recurring commitments, " +
        "important context, and durable facts that should help across future " +
        "conversations. Skip one-off chatter and temporary task noise.",
      // 9a9b7176c (#3418) — added the in-flight-narration carve-out. The text
      // every live bank was carrying as of 2026-07-25.
      "Extract user preferences, ongoing projects, recurring commitments, " +
        "important context, and durable facts that should help across future " +
        "conversations. Skip one-off chatter and temporary task noise, " +
        "including in-flight workflow/process narration (a sub-task started, " +
        "paused, or is still running) — only retain the outcome once a task " +
        "actually completes or a decision is made.",
    ]);
    expect(SUPERSEDED_RETAIN_MISSIONS).toHaveLength(3);
  });

  it("carries the 2026-07-19 text every live bank was found holding on 2026-07-25", () => {
    // Read verbatim off the fleet REST config surface during the review.
    const live =
      "Extract user preferences, ongoing projects, recurring commitments, " +
      "important context, and durable facts that should help across future " +
      "conversations. Skip one-off chatter and temporary task noise, " +
      "including in-flight workflow/process narration (a sub-task started, " +
      "paused, or is still running) — only retain the outcome once a task " +
      "actually completes or a decision is made.";
    expect(SUPERSEDED_RETAIN_MISSIONS).toContain(live);
    expect(isUpgradableRetainMission(live)).toBe(true);
  });

  it("treats an unset mission as upgradable and a customized one as not", () => {
    expect(isUpgradableRetainMission(null)).toBe(true);
    expect(isUpgradableRetainMission("")).toBe(true);
    expect(isUpgradableRetainMission("   ")).toBe(true);
    expect(isUpgradableRetainMission("Only remember what Ken says about cricket.")).toBe(false);
    // A byte-level edit of a known default is a customization, not a default.
    expect(isUpgradableRetainMission(SUPERSEDED_RETAIN_MISSIONS[0] + " ")).toBe(false);
  });
});

describe("decideRetainMissionUpgrade", () => {
  it("upgrades a superseded default to the current one", () => {
    for (const old of SUPERSEDED_RETAIN_MISSIONS) {
      expect(decideRetainMissionUpgrade(undefined, old)).toEqual({
        action: "upgrade",
        mission: DEFAULT_RETAIN_MISSION,
      });
    }
  });

  it("leaves a customized mission alone", () => {
    expect(decideRetainMissionUpgrade(undefined, "hand-written mission")).toEqual({
      action: "none",
    });
  });

  it("does nothing when the bank already carries the current default", () => {
    expect(decideRetainMissionUpgrade(undefined, DEFAULT_RETAIN_MISSION)).toEqual({
      action: "none",
    });
  });

  it("operator yaml wins outright, even over a customized bank mission", () => {
    expect(decideRetainMissionUpgrade("from yaml", "hand-written mission")).toEqual({
      action: "config",
      mission: "from yaml",
    });
  });
});

describe("fetchBankRetainMission", () => {
  it("reads config.retain_mission off the REST config surface (NOT MCP get_bank)", async () => {
    let seen = "";
    const fetchImpl = vi.fn(async (url: string) => {
      seen = url;
      return {
        ok: true,
        json: async () => ({ config: { retain_mission: "current text" } }),
      } as any;
    });
    const r = await fetchBankRetainMission("http://h:18888/mcp/", "a b", {
      fetchImpl: fetchImpl as any,
    });
    expect(seen).toBe("http://h:18888/v1/default/banks/a%20b/config");
    expect(r).toEqual({ ok: true, mission: "current text" });
  });

  it("returns mission null only when the key is present but null (genuinely unset)", async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: true, json: async () => ({ config: { retain_mission: null } }) }) as any,
    );
    expect(await fetchBankRetainMission("http://h/mcp/", "b", { fetchImpl: fetchImpl as any }))
      .toEqual({ ok: true, mission: null });
  });

  // M1 (2026-07-25 re-review): an unrecognised 200 body must NOT read as
  // "unset". isUpgradableRetainMission(null) is true, so the loose behaviour
  // would push the default over every customized mission fleet-wide the day
  // Hindsight renests or renames the field.
  it("reports failure — not 'unset' — when config is missing or the key is absent", async () => {
    const shapes = [
      {}, // no config at all
      { config: null }, // config explicitly null
      { config: {} }, // config present, retain_mission key absent
      { config: { retain_mission: 42 } }, // key present, wrong type
    ];
    for (const body of shapes) {
      const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => body }) as any);
      expect(
        await fetchBankRetainMission("http://h/mcp/", "b", { fetchImpl: fetchImpl as any }),
      ).toEqual({ ok: false, reason: "Unexpected shape" });
    }
  });

  it("reports failure rather than throwing on a non-2xx", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }) as any);
    expect(await fetchBankRetainMission("http://h/mcp/", "b", { fetchImpl: fetchImpl as any }))
      .toEqual({ ok: false, reason: "HTTP 503" });
  });
});

/**
 * End-to-end outcome test for review finding 1.
 *
 * The headline of the original PR — a rewritten DEFAULT_RETAIN_MISSION —
 * reached NO existing agent, because `reconcileAgent` pushed `retain_mission`
 * only when the operator had set one in yaml. These tests drive the real
 * `reconcileAgent` against a stubbed Hindsight and assert what actually goes
 * out on the wire.
 *
 * Verified to bite (2026-07-25):
 *  - reverting `src/agents/scaffold.ts` to the pre-fix reconcile block fails
 *    "PUSHES the current default…" (no retain_mission on the wire at all).
 *  - making `decideRetainMissionUpgrade` push unconditionally — the naive
 *    version of this fix — fails "does NOT clobber…". That test cannot fail
 *    on the pre-fix code (which pushed nothing); its job is to pin the guard
 *    that makes the new push safe.
 */
describe("reconcileAgent — retain_mission upgrade on existing banks", () => {
  const telegramConfig: TelegramConfig = {
    bot_token: "123456:ABC-DEF",
    forum_chat_id: "-1001234567890",
  };
  const switchroomConfig: SwitchroomConfig = {
    agents: {},
    telegram: telegramConfig,
    defaults: {},
    memory: { backend: "hindsight", config: { url: "http://hindsight.test/mcp/" } },
  } as unknown as SwitchroomConfig;

  const realFetch = globalThis.fetch;
  let tmpDir = "";

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  /**
   * Stub Hindsight: MCP create_bank/update_bank succeed, and the REST config
   * endpoint reports `currentMission`. Resolves with the update_bank args once
   * the fire-and-forget mission push lands (reconcile does not await it).
   */
  function stubHindsight(
    currentMission: string | null,
    config: AgentConfig,
  ): Promise<Record<string, unknown>> {
    // Scaffold FIRST, memory disabled, so the fresh-agent seed path issues no
    // Hindsight traffic that could be mistaken for the reconcile push.
    tmpDir = mkdtempSync(resolve(tmpdir(), "switchroom-retain-mission-"));
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    let resolveArgs: (a: Record<string, unknown>) => void;
    const seen = new Promise<Record<string, unknown>>((r) => (resolveArgs = r));
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith("/config")) {
        return {
          ok: true,
          json: async () => ({ config: { retain_mission: currentMission } }),
        } as any;
      }
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body?.params?.name === "update_bank") {
        resolveArgs(body.params.arguments as Record<string, unknown>);
      }
      return {
        ok: true,
        headers: new Map(),
        text: async () => JSON.stringify({ result: { isError: false, content: [] } }),
      } as any;
    }) as any;
    return seen;
  }

  function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
      extends: "default",
      topic_name: "Test Topic",
      schedule: [],
      ...overrides,
    } as AgentConfig;
  }

  /**
   * Scaffold the agent dir with memory DISABLED (so the fresh-agent seed path
   * issues no Hindsight traffic and cannot be mistaken for the reconcile
   * push), then reconcile with the hindsight-enabled config.
   */
  function runReconcile(config: AgentConfig) {
    reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
  }

  it("PUSHES the current default when the bank holds a superseded default", async () => {
    const config = makeAgentConfig();
    const seen = stubHindsight(
      SUPERSEDED_RETAIN_MISSIONS[SUPERSEDED_RETAIN_MISSIONS.length - 1],
      config,
    );
    runReconcile(config);
    const args = await seen;
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBe(
      DEFAULT_RETAIN_MISSION,
    );
  }, 15_000);

  it("does NOT clobber an operator-customized bank mission", async () => {
    const config = makeAgentConfig({ memory: { reflect_mission: "persona" } } as Partial<AgentConfig>);
    const seen = stubHindsight("Remember only what Ken says about cricket.", config);
    runReconcile(config);
    const args = await seen;
    expect(args.config_updates).toBeDefined();
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBeUndefined();
  }, 15_000);

  it("pushes the operator's yaml retain_mission verbatim when set", async () => {
    const config = makeAgentConfig({
      memory: { retain_mission: "operator text" },
    } as Partial<AgentConfig>);
    const seen = stubHindsight(SUPERSEDED_RETAIN_MISSIONS[0], config);
    runReconcile(config);
    const args = await seen;
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBe("operator text");
  }, 15_000);
});

/**
 * End-to-end outcome test for the 2026-07-25 RE-review finding H1.
 *
 * `switchroom apply` calls `scaffoldAgent` for EVERY agent on every run — it
 * never calls `reconcileAgent` (src/cli/apply.ts:1512). So the reconcile-side
 * guard above was unreachable on the path operators actually run: scaffold
 * pushed `retain_mission: userRetainMission ?? DEFAULT_RETAIN_MISSION`
 * unconditionally, clobbering a customized mission on an existing bank.
 *
 * These tests drive the real `scaffoldAgent` with hindsight ENABLED against a
 * stubbed Hindsight and assert what goes out on the wire.
 *
 * Verified to bite (2026-07-25): with scaffold's unconditional
 * `?? DEFAULT_RETAIN_MISSION` seed restored, "does NOT clobber…" fails with
 * the received value being DEFAULT_RETAIN_MISSION.
 */
describe("scaffoldAgent — retain_mission against an existing bank", () => {
  const telegramConfig: TelegramConfig = {
    bot_token: "123456:ABC-DEF",
    forum_chat_id: "-1001234567890",
  };
  const switchroomConfig: SwitchroomConfig = {
    agents: {},
    telegram: telegramConfig,
    defaults: {},
    memory: { backend: "hindsight", config: { url: "http://hindsight.test/mcp/" } },
  } as unknown as SwitchroomConfig;

  const realFetch = globalThis.fetch;
  let tmpDir = "";

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  /**
   * Stub Hindsight and run a scaffold of an ALREADY-SCAFFOLDED agent dir (the
   * `switchroom apply` shape: apply re-scaffolds every existing agent). The
   * first scaffold runs with memory disabled so it issues no Hindsight traffic
   * that could be mistaken for the second one's push.
   *
   * `readOk: false` simulates the REST config read failing (a transient
   * Hindsight hiccup) — the branch that must NOT clobber.
   */
  function runScaffoldOnExisting(
    config: AgentConfig,
    currentMission: string | null,
    opts: { readOk?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    tmpDir = mkdtempSync(resolve(tmpdir(), "switchroom-scaffold-retain-"));
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    let resolveArgs: (a: Record<string, unknown>) => void;
    const seen = new Promise<Record<string, unknown>>((r) => (resolveArgs = r));
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith("/config")) {
        if (opts.readOk === false) return { ok: false, status: 503 } as any;
        return {
          ok: true,
          json: async () => ({ config: { retain_mission: currentMission } }),
        } as any;
      }
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body?.params?.name === "update_bank") {
        resolveArgs(body.params.arguments as Record<string, unknown>);
      }
      return {
        ok: true,
        headers: new Map(),
        text: async () => JSON.stringify({ result: { isError: false, content: [] } }),
      } as any;
    }) as any;
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
    return seen;
  }

  function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
      extends: "default",
      topic_name: "Test Topic",
      schedule: [],
      ...overrides,
    } as AgentConfig;
  }

  it("does NOT clobber an operator-customized bank mission on re-scaffold", async () => {
    const config = makeAgentConfig({
      memory: { reflect_mission: "persona" },
    } as Partial<AgentConfig>);
    const args = await runScaffoldOnExisting(config, "CUSTOM operator mission");
    expect(args.config_updates).toBeDefined();
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBeUndefined();
  }, 15_000);

  it("UPGRADES a bank still carrying a superseded default", async () => {
    const config = makeAgentConfig();
    const args = await runScaffoldOnExisting(
      config,
      SUPERSEDED_RETAIN_MISSIONS[SUPERSEDED_RETAIN_MISSIONS.length - 1],
    );
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBe(
      DEFAULT_RETAIN_MISSION,
    );
  }, 15_000);

  it("seeds the default into a genuinely fresh bank (mission unset)", async () => {
    const config = makeAgentConfig();
    const args = await runScaffoldOnExisting(config, null);
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBe(
      DEFAULT_RETAIN_MISSION,
    );
  }, 15_000);

  it("pushes the operator's yaml retain_mission verbatim, over a customized bank", async () => {
    const config = makeAgentConfig({
      memory: { retain_mission: "operator text" },
    } as Partial<AgentConfig>);
    const args = await runScaffoldOnExisting(config, "CUSTOM operator mission");
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBe("operator text");
  }, 15_000);

  // L3: the read-failure branches. A transient Hindsight hiccup must never be
  // read as "unset" (which isUpgradableRetainMission treats as upgradable).
  it("read fails + no yaml mission → pushes NO retain_mission", async () => {
    const config = makeAgentConfig({
      memory: { reflect_mission: "persona" },
    } as Partial<AgentConfig>);
    const args = await runScaffoldOnExisting(config, null, { readOk: false });
    expect(args.config_updates).toBeDefined();
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBeUndefined();
  }, 15_000);

  it("read fails + yaml mission set → still pushes the config mission", async () => {
    const config = makeAgentConfig({
      memory: { retain_mission: "operator text" },
    } as Partial<AgentConfig>);
    const args = await runScaffoldOnExisting(config, null, { readOk: false });
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBe("operator text");
  }, 15_000);

  /**
   * N1 (PR #3529 review): post-upgrade steady state is "nothing to update" —
   * the `default` profile contributes no mission extras, the bank carries a
   * customized retain_mission, and no bank_mission is configured. The scaffold
   * site used to fire `update_bank` with `{}` anyway (two HTTP round-trips per
   * agent per apply) and print a green success line for a call that changed
   * nothing. Reconcile already guarded on emptiness; scaffold now does too.
   */
  function runScaffoldNoOp(config: AgentConfig): Promise<{
    updateBankCalls: number;
    logs: string[];
  }> {
    tmpDir = mkdtempSync(resolve(tmpdir(), "switchroom-scaffold-noop-"));
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    let updateBankCalls = 0;
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith("/config")) {
        return {
          ok: true,
          json: async () => ({ config: { retain_mission: "CUSTOM operator mission" } }),
        } as any;
      }
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body?.params?.name === "update_bank") updateBankCalls += 1;
      return {
        ok: true,
        headers: new Map(),
        text: async () => JSON.stringify({ result: { isError: false, content: [] } }),
      } as any;
    }) as any;

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
    return flushPendingBankOps(10_000).then(() => {
      logSpy.mockRestore();
      return { updateBankCalls, logs };
    });
  }

  it("sends NO update_bank when there is nothing to update", async () => {
    const { updateBankCalls } = await runScaffoldNoOp(makeAgentConfig());
    expect(updateBankCalls).toBe(0);
  }, 15_000);

  it("prints no 'Bank missions updated' line when nothing was updated", async () => {
    const { logs } = await runScaffoldNoOp(makeAgentConfig());
    expect(logs.some((l) => l.includes("Bank missions updated"))).toBe(false);
  }, 15_000);

  it("still updates (and says so) when the profile contributes mission extras", async () => {
    const config = makeAgentConfig({
      memory: { reflect_mission: "persona" },
    } as Partial<AgentConfig>);
    const { updateBankCalls, logs } = await runScaffoldNoOp(config);
    expect(updateBankCalls).toBe(1);
    expect(logs.some((l) => l.includes("Bank missions updated"))).toBe(true);
  }, 15_000);
});

/**
 * L2 (2026-07-25 re-review): scaffold/reconcile start their bank-op chain
 * fire-and-forget because both functions are synchronous. Node normally drains
 * it, but `runApply` hard-`process.exit()`s (codes 4/5/6) in vault phases that
 * run AFTER the scaffold loop, which would truncate an in-flight push — and
 * the new retain-mission read widened that window. `flushPendingBankOps` makes
 * the drain deterministic; apply awaits it right after the scaffold loop.
 */
describe("flushPendingBankOps", () => {
  const telegramConfig: TelegramConfig = {
    bot_token: "123456:ABC-DEF",
    forum_chat_id: "-1001234567890",
  };
  const switchroomConfig: SwitchroomConfig = {
    agents: {},
    telegram: telegramConfig,
    defaults: {},
    memory: { backend: "hindsight", config: { url: "http://hindsight.test/mcp/" } },
  } as unknown as SwitchroomConfig;

  const realFetch = globalThis.fetch;
  let tmpDir = "";

  afterEach(async () => {
    await flushPendingBankOps(5_000);
    globalThis.fetch = realFetch;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  it("resolves immediately when nothing is in flight", async () => {
    // The beforeEach reset guarantees the registry really is empty, so a zero
    // budget is a genuine discriminator: only the size===0 early return can
    // return true here. With a leftover chain this would resolve false.
    expect(__pendingBankOpsCountForTests()).toBe(0);
    expect(await flushPendingBankOps(0)).toBe(true);
  });

  // N2b: entries must self-evict on settle, otherwise a long-lived process
  // (setup / agent / doctor / rename / the reconcile bridge all push, none
  // flush) grows the registry by one promise per scaffold, forever.
  it("drops settled chains without anyone calling the flush", async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), "switchroom-evict-"));
    globalThis.fetch = (async (url: any) => {
      if (String(url).endsWith("/config")) {
        return { ok: true, json: async () => ({ config: { retain_mission: null } }) } as any;
      }
      return {
        ok: true,
        headers: new Map(),
        text: async () => JSON.stringify({ result: { isError: false, content: [] } }),
      } as any;
    }) as any;

    const config = { extends: "default", topic_name: "T", schedule: [] } as unknown as AgentConfig;
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
    expect(__pendingBankOpsCountForTests()).toBe(1);

    const deadline = Date.now() + 10_000;
    while (__pendingBankOpsCountForTests() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(__pendingBankOpsCountForTests()).toBe(0);
  }, 20_000);

  it("waits for the mission push a synchronous scaffold left in flight", async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), "switchroom-flush-"));
    let updatePushed = false;
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      // A slow Hindsight: every call takes a beat, so the push is genuinely
      // still in flight when scaffoldAgent returns.
      await new Promise((r) => setTimeout(r, 20));
      if (u.endsWith("/config")) {
        return { ok: true, json: async () => ({ config: { retain_mission: null } }) } as any;
      }
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body?.params?.name === "update_bank") updatePushed = true;
      return {
        ok: true,
        headers: new Map(),
        text: async () => JSON.stringify({ result: { isError: false, content: [] } }),
      } as any;
    }) as any;

    const config = { extends: "default", topic_name: "T", schedule: [] } as unknown as AgentConfig;
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
    // scaffoldAgent is synchronous: the push has NOT landed on return.
    expect(updatePushed).toBe(false);

    expect(await flushPendingBankOps(10_000)).toBe(true);
    // After the flush it has — this is exactly what apply's exit paths needed.
    expect(updatePushed).toBe(true);
  }, 20_000);

  it("returns false rather than hanging when the chain outlives the deadline", async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), "switchroom-flush-slow-"));
    globalThis.fetch = (async () => {
      await new Promise((r) => setTimeout(r, 3_000));
      return { ok: true, headers: new Map(), json: async () => ({ config: { retain_mission: null } }), text: async () => "{}" } as any;
    }) as any;

    const config = { extends: "default", topic_name: "T", schedule: [] } as unknown as AgentConfig;
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
    expect(await flushPendingBankOps(50)).toBe(false);
  }, 20_000);
});

describe("updateBankMissions", () => {
  it("calls update_bank with both missions when provided", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "test-session"]]),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
      } as any);

    const result = await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      {
        bank_mission: "Test bank mission",
        retain_mission: "Test retain mission",
      },
      { fetchImpl: mockFetch as any, timeoutMs: 5000 }
    );

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Check initialize call
    const initCall = mockFetch.mock.calls[0];
    expect(initCall[0]).toBe("http://test.local/mcp/");
    const initBody = JSON.parse(initCall[1].body);
    expect(initBody.method).toBe("initialize");

    // Check tools/call update_bank
    const toolCall = mockFetch.mock.calls[1];
    const toolBody = JSON.parse(toolCall[1].body);
    expect(toolBody.method).toBe("tools/call");
    expect(toolBody.params.name).toBe("update_bank");
    // retain_mission is NOT a top-level update_bank arg (the server silently
    // drops it) — it is a config field routed through config_updates.
    expect(toolBody.params.arguments).toEqual({
      bank_id: "test-bank",
      mission: "Test bank mission",
      config_updates: { retain_mission: "Test retain mission" },
    });
  });

  it("omits config_updates when only bank_mission is set (no retain_mission)", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "test-session"]]),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
      } as any);

    await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      { bank_mission: "Only bank mission" },
      { fetchImpl: mockFetch as any }
    );

    const toolCall = mockFetch.mock.calls[1];
    const toolBody = JSON.parse(toolCall[1].body);
    expect(toolBody.params.arguments).toEqual({
      bank_id: "test-bank",
      mission: "Only bank mission",
    });
  });

  it("returns error when Hindsight returns 5xx", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as any);

    const result = await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      { bank_mission: "Test" },
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: false, reason: "HTTP 500" });
  });

  it("returns error on timeout", async () => {
    const mockFetch = vi.fn().mockImplementation((_url: any, init: any) => {
      return new Promise((resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        const timer = setTimeout(
          () => resolve({ ok: true, headers: new Map() } as any),
          10000
        );
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const result = await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      { bank_mission: "Test" },
      { fetchImpl: mockFetch as any, timeoutMs: 100 }
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Timeout");
  });

  it("tolerates a stateless server (no mcp-session-id) and proceeds without the header", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map(), // stateless: no mcp-session-id
      } as any)
      .mockResolvedValueOnce({
        ok: true,
      } as any);

    const result = await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      { bank_mission: "Test" },
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const toolHeaders = mockFetch.mock.calls[1][1].headers;
    expect("mcp-session-id" in toolHeaders).toBe(false);
  });

  it("returns error on network failure", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("Network error"));

    const result = await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      { bank_mission: "Test" },
      { fetchImpl: mockFetch as any }
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Network error");
  });

  // --- Phase 2: reflect_mission / observations_mission / disposition ---

  it("routes reflect_mission + observations_mission through config_updates", async () => {
    const args = await captureUpdateBankArgs({
      reflect_mission: "You are a legal analyst.",
      observations_mission: "Synthesise obligations and risks.",
    });
    // reflect_mission is explicit → NO top-level `mission` (they target the
    // same engine field; explicit reflect_mission wins deterministically).
    expect(args).toEqual({
      bank_id: "test-bank",
      config_updates: {
        reflect_mission: "You are a legal analyst.",
        observations_mission: "Synthesise obligations and risks.",
      },
    });
    expect("mission" in args).toBe(false);
  });

  it("flattens disposition to disposition_* integer config fields", async () => {
    const args = await captureUpdateBankArgs({
      disposition: { skepticism: 4, literalism: 5, empathy: 2 },
    });
    expect(args.config_updates).toEqual({
      disposition_skepticism: 4,
      disposition_literalism: 5,
      disposition_empathy: 2,
    });
  });

  it("omits unset disposition traits from config_updates", async () => {
    const args = await captureUpdateBankArgs({ disposition: { empathy: 5 } });
    expect(args.config_updates).toEqual({ disposition_empathy: 5 });
  });

  it("keeps the legacy top-level mission route for a bare bank_mission", async () => {
    const args = await captureUpdateBankArgs({ bank_mission: "Persona X" });
    expect(args).toEqual({ bank_id: "test-bank", mission: "Persona X" });
  });

  it("reflect_mission wins over bank_mission (drops the top-level mission)", async () => {
    const args = await captureUpdateBankArgs({
      bank_mission: "legacy persona",
      reflect_mission: "explicit persona",
    });
    expect("mission" in args).toBe(false);
    expect(args.config_updates).toEqual({ reflect_mission: "explicit persona" });
  });

  it("omits config_updates entirely when only a bank_mission is set", async () => {
    const args = await captureUpdateBankArgs({ bank_mission: "just persona" });
    expect("config_updates" in args).toBe(false);
  });
});

describe("resolveBankMissionExtras", () => {
  it("returns built-in profile defaults when config is empty", () => {
    expect(resolveBankMissionExtras(undefined, "health-coach")).toEqual({
      disposition: { skepticism: 2, literalism: 2, empathy: 5 },
      observations_mission: PROFILE_MEMORY_DEFAULTS["health-coach"].observations_mission,
    });
  });

  it("returns nothing for a profile without defaults and no config", () => {
    expect(resolveBankMissionExtras(undefined, "default")).toEqual({});
    expect(resolveBankMissionExtras({}, "some-unknown-profile")).toEqual({});
  });

  it("merges disposition per-key: config trait overrides, others inherit profile", () => {
    const extras = resolveBankMissionExtras({ disposition: { empathy: 1 } }, "health-coach");
    expect(extras.disposition).toEqual({ skepticism: 2, literalism: 2, empathy: 1 });
  });

  it("config observations_mission overrides the profile default wholesale", () => {
    const extras = resolveBankMissionExtras(
      { observations_mission: "custom" },
      "health-coach",
    );
    expect(extras.observations_mission).toBe("custom");
  });

  it("passes reflect_mission straight through (no profile default for it)", () => {
    const extras = resolveBankMissionExtras({ reflect_mission: "hi" }, "coding");
    expect(extras.reflect_mission).toBe("hi");
    // coding still contributes its disposition default
    expect(extras.disposition).toEqual({ skepticism: 4, literalism: 5, empathy: 2 });
  });
});

describe("AgentMemorySchema — Phase 2 fields", () => {
  it("accepts reflect_mission, observations_mission, and in-range disposition", () => {
    const parsed = AgentMemorySchema.parse({
      collection: "b",
      reflect_mission: "r",
      observations_mission: "o",
      disposition: { skepticism: 1, literalism: 3, empathy: 5 },
    });
    expect(parsed.disposition).toEqual({ skepticism: 1, literalism: 3, empathy: 5 });
  });

  it("rejects disposition traits outside 1-5", () => {
    expect(() =>
      AgentMemorySchema.parse({ collection: "b", disposition: { empathy: 6 } }),
    ).toThrow();
    expect(() =>
      AgentMemorySchema.parse({ collection: "b", disposition: { skepticism: 0 } }),
    ).toThrow();
  });

  it("rejects non-integer disposition traits", () => {
    expect(() =>
      AgentMemorySchema.parse({ collection: "b", disposition: { literalism: 2.5 } }),
    ).toThrow();
  });
});
