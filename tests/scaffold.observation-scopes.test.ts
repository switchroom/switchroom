import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
import { buildHandoff } from "../src/agents/handoff-summarizer.js";
import { AgentMemorySchema, SwitchroomConfigSchema } from "../src/config/schema.js";
import type { SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";
import {
  OBSERVATION_SCOPES,
  OBSERVATION_SCOPES_ENV,
} from "../src/memory/observation-scopes.js";

/**
 * Per-row Hindsight `observation_scopes` on the retain path.
 *
 * `memory.observation_scopes: shared` makes the plugin stamp every retain
 * with a scope, which sends that item's consolidated observations into ONE
 * global untagged scope instead of a scope per tag — how a set of agents
 * pooling a bank gets merged observations.
 *
 * The knob is OFF by default and must stay invisible when off: no export in
 * start.sh, so the plugin's `observationScopes` stays None and the field
 * never reaches the wire. These tests pin both directions, and the
 * init-vs-reconcile parity that a second hand-built template context makes
 * easy to drift.
 */
describe("memory.observation_scopes plumbing", () => {
  let tmpDir: string;
  let telegram: TelegramConfig;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `obs-scopes-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(tmpDir, { recursive: true });
    telegram = { bot_token: "t", forum_chat_id: "c" };
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function configFor(memory: Record<string, unknown> | undefined): SwitchroomConfig {
    return {
      agents: memory ? ({ probe: { memory } } as never) : {},
      memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
      telegram,
    } as SwitchroomConfig;
  }

  function startShFor(memory: Record<string, unknown> | undefined): string {
    const config = configFor(memory);
    const res = scaffoldAgent("probe", config.agents.probe ?? {}, tmpDir, telegram, config);
    return readFileSync(join(res.agentDir, "start.sh"), "utf-8");
  }

  describe("schema", () => {
    it("accepts memory.observation_scopes as a non-empty string", () => {
      const ok = AgentMemorySchema.safeParse({
        collection: "probe",
        observation_scopes: "shared",
      });
      expect(ok.success).toBe(true);
      if (ok.success) expect(ok.data?.observation_scopes).toBe("shared");
    });

    it("rejects an empty string (an empty scope is a typo, not an opt-out)", () => {
      expect(
        AgentMemorySchema.safeParse({ collection: "probe", observation_scopes: "" }).success,
      ).toBe(false);
    });

    it("accepts every value the engine accepts as a bare string", () => {
      for (const scope of OBSERVATION_SCOPES) {
        const ok = AgentMemorySchema.safeParse({ collection: "probe", observation_scopes: scope });
        expect(ok.success, scope).toBe(true);
      }
    });

    it("REJECTS an off-list value instead of passing it through", () => {
      // A free string would apply clean, reach the wire, and leave the engine
      // falling back to its own default scope — a bank whose observations
      // never merged, discovered months later. `apply` is the cheap gate.
      for (const bad of ["shred", "Shared", "per-tag", "sharedd", "all_combos"]) {
        const res = AgentMemorySchema.safeParse({ collection: "probe", observation_scopes: bad });
        expect(res.success, bad).toBe(false);
      }
    });

    it("REJECTS an off-list value at the defaults tier too", () => {
      expect(() =>
        SwitchroomConfigSchema.parse({
          switchroom: { version: 1, home: "/tmp/does-not-matter" },
          telegram: { bot_token: "t", forum_chat_id: "c" },
          defaults: { memory: { observation_scopes: "shred" } },
          agents: {},
        }),
      ).toThrow();
    });

    it("survives the defaults tier instead of being stripped by the parse", () => {
      // The defaults/profile tier is a SEPARATE zod object; a key missing
      // there is silently dropped, so a fleet-wide setting would vanish
      // before the cascade ever saw it.
      const parsed = SwitchroomConfigSchema.parse({
        switchroom: { version: 1, home: "/tmp/does-not-matter" },
        telegram: { bot_token: "t", forum_chat_id: "c" },
        defaults: { memory: { observation_scopes: "shared" } },
        agents: {},
      });
      expect(parsed.defaults?.memory?.observation_scopes).toBe("shared");
    });
  });

  describe("start.sh", () => {
    it("unset emits NO export — the field never reaches the wire", () => {
      expect(startShFor(undefined)).not.toMatch(/HINDSIGHT_OBSERVATION_SCOPES/);
    });

    it("an unrelated memory block still emits NO export", () => {
      expect(startShFor({ collection: "probe" })).not.toMatch(/HINDSIGHT_OBSERVATION_SCOPES/);
    });

    it("set emits the export with the configured value", () => {
      expect(startShFor({ observation_scopes: "shared" })).toMatch(
        /export HINDSIGHT_OBSERVATION_SCOPES='shared'/,
      );
    });

    it("shell-quotes the value so it cannot inject shell", () => {
      const startSh = startShFor({ observation_scopes: "a'b; rm -rf /" });
      expect(startSh).toContain(
        `export HINDSIGHT_OBSERVATION_SCOPES='a'"'"'b; rm -rf /'`,
      );
      // The injected command must not be reachable as its own statement.
      expect(startSh).not.toMatch(/^\s*rm -rf \//m);
    });

    it("reconcileAgent emits the same export as scaffoldAgent (no init/reconcile drift)", () => {
      const memory = { observation_scopes: "shared" };
      const config = configFor(memory);
      const agentConfig = config.agents.probe ?? {};
      const res = scaffoldAgent("probe", agentConfig, tmpDir, telegram, config);
      const scaffolded = readFileSync(join(res.agentDir, "start.sh"), "utf-8");
      reconcileAgent("probe", agentConfig, tmpDir, telegram, config);
      const reconciled = readFileSync(join(res.agentDir, "start.sh"), "utf-8");
      expect(reconciled).toMatch(/export HINDSIGHT_OBSERVATION_SCOPES='shared'/);
      expect(reconciled).toBe(scaffolded);
    });

    it("reconcileAgent also omits the export when unset", () => {
      const config = configFor(undefined);
      const res = scaffoldAgent("probe", {}, tmpDir, telegram, config);
      reconcileAgent("probe", {}, tmpDir, telegram, config);
      const reconciled = readFileSync(join(res.agentDir, "start.sh"), "utf-8");
      expect(reconciled).not.toMatch(/HINDSIGHT_OBSERVATION_SCOPES/);
    });
  });
});

/**
 * The session-handoff mirror POSTs a real memory into the agent's OWN bank
 * (`/v1/default/banks/<bank>/memories`) from OUTSIDE the vendored plugin, so
 * nothing in `lib/client.py` reaches it. Left unthreaded, an agent set to
 * `shared` pools every memory EXCEPT its session handoffs — one row at the
 * wrong scope, invisible until the bank is already inconsistent.
 */
describe("session-handoff mirror carries the observation scope", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "obs-scopes-handoff-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function mirrorBody(env: NodeJS.ProcessEnv): Promise<Record<string, unknown> | null> {
    const jsonlPath = join(tmp, "turns.jsonl");
    writeFileSync(
      jsonlPath,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
      }) + "\n",
    );
    let captured: Record<string, unknown> | null = null;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body ?? "{}"));
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;
    const status = await buildHandoff({
      jsonlPath,
      agentDir: tmp,
      agentName: "probe",
      hindsightUrl: "http://localhost:9999",
      hindsightBankId: "mybank",
      fetch: fakeFetch,
      env,
    });
    expect(status).toBe("ok");
    return captured;
  }

  it("unset — the body is EXACTLY the pre-feature body", async () => {
    // Full-body equality, not just "the key is absent": an explicit null, an
    // empty-string scope, or any stray field would each be a DIFFERENT request
    // body and would change what the engine stores. The briefing prose itself
    // is pinned by handoff-summarizer.test.ts, so it is echoed rather than
    // duplicated here — every other byte of the body is asserted literally.
    const body = await mirrorBody({});
    const item = (body as { items: Record<string, unknown>[] }).items[0];
    expect(body).toEqual({
      items: [
        {
          content: item.content,
          document_id: "session_handoff",
          tags: ["session_handoff", "probe"],
        },
      ],
      async: true,
    });
    expect(Object.keys(item).sort()).toEqual(["content", "document_id", "tags"]);
  });

  it("set — the scope rides on the item verbatim", async () => {
    const body = await mirrorBody({ [OBSERVATION_SCOPES_ENV]: "shared" });
    const item = (body as { items: Record<string, unknown>[] }).items[0];
    expect(item.observation_scopes).toBe("shared");
    // A bare JSON string, matching the engine's Literal form — not a list.
    expect(JSON.stringify(item.observation_scopes)).toBe('"shared"');
  });

  it("an empty export counts as unset, not as a scope", async () => {
    const body = await mirrorBody({ [OBSERVATION_SCOPES_ENV]: "" });
    const item = (body as { items: Record<string, unknown>[] }).items[0];
    expect("observation_scopes" in item).toBe(false);
  });

  it("an off-list value FAILS CLOSED — nothing is POSTed at all", async () => {
    // Never write this memory at a scope nobody asked for. The sidecars are
    // already on disk, so the next session still reorients.
    expect(await mirrorBody({ [OBSERVATION_SCOPES_ENV]: "shred" })).toBeNull();
  });
});
