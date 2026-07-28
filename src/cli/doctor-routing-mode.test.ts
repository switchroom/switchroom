/**
 * `switchroom doctor` LiteLLM boot-routing section.
 *
 * The behaviour under test is the one that matters to the operator: an agent
 * whose boot landed on untracked direct-OAuth while its declared routing says
 * it must ride the proxy produces a FAIL row that names the agent and the
 * remediation. The record shape asserted here is the one start.sh actually
 * writes — `tests/scaffold.routing-mode.test.ts` pins the writer.
 */
import { describe, it, expect } from "vitest";

import {
  classifyRoutingMode,
  parseRoutingModeRecord,
  routingModePath,
  runRoutingModeChecks,
} from "./doctor-routing-mode.js";
import type { SwitchroomConfig } from "../config/schema.js";

const AGENTS_DIR = "/nonexistent-test-agents";

function config(...names: string[]): SwitchroomConfig {
  const agents: Record<string, unknown> = {};
  for (const n of names) agents[n] = {};
  return { agents } as unknown as SwitchroomConfig;
}

/** Read seam that serves `files` and throws ENOENT for anything else. */
function reader(files: Record<string, string>) {
  return (p: string): string => {
    if (p in files) return files[p];
    const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
    (err as NodeJS.ErrnoException).code = "ENOENT";
    throw err;
  };
}

const path = (agent: string) => routingModePath(`${AGENTS_DIR}/${agent}`);

/** Byte-for-byte the line start.sh writes (profiles/_base/start.sh.hbs). */
function record(o: {
  mode: string;
  base?: string;
  model?: string;
  litellmOk?: string;
  declared: string;
  ts?: string;
}): string {
  return (
    `mode=${o.mode} base=${o.base ?? "http://127.0.0.1:4010/anthropic"} ` +
    `model=${o.model ?? "opus"} litellm_ok=${o.litellmOk ?? "1"} ` +
    `declared=${o.declared} ts=${o.ts ?? "2026-07-28T18:59:32Z"}\n`
  );
}

describe("parseRoutingModeRecord", () => {
  it("parses a real healthy line", () => {
    const rec = parseRoutingModeRecord(
      "mode=passthrough base=http://127.0.0.1:4010/anthropic model=opus " +
        "litellm_ok=1 declared=passthrough ts=2026-07-28T18:59:32Z\n",
    );
    expect(rec).toEqual({
      mode: "passthrough",
      base: "http://127.0.0.1:4010/anthropic",
      model: "opus",
      litellmOk: "1",
      declared: "passthrough",
      ts: "2026-07-28T18:59:32Z",
    });
  });

  it("parses the stripped line start.sh writes with base=direct", () => {
    const rec = parseRoutingModeRecord(
      "mode=direct-oauth base=direct model=opus litellm_ok=0 " +
        "declared=passthrough ts=2026-07-28T18:59:32Z",
    );
    expect(rec?.mode).toBe("direct-oauth");
    expect(rec?.base).toBe("direct");
    expect(rec?.declared).toBe("passthrough");
  });

  it("tolerates an unknown extra field the writer may grow later", () => {
    const rec = parseRoutingModeRecord(
      "mode=passthrough declared=passthrough future_field=x",
    );
    expect(rec?.mode).toBe("passthrough");
  });

  it("returns null for a truncated record missing the load-bearing fields", () => {
    expect(parseRoutingModeRecord("mode=passthrough base=x")).toBeNull();
    expect(parseRoutingModeRecord("")).toBeNull();
    expect(parseRoutingModeRecord("\n\n")).toBeNull();
    expect(parseRoutingModeRecord("garbage without equals")).toBeNull();
  });
});

describe("classifyRoutingMode", () => {
  it("FAILs when a passthrough-declared agent landed on direct-oauth", () => {
    const v = classifyRoutingMode({
      mode: "direct-oauth",
      base: "direct",
      model: "opus",
      litellmOk: "0",
      declared: "passthrough",
      ts: "2026-07-28T18:59:32Z",
    });
    expect(v?.status).toBe("fail");
    expect(v?.detail).toContain("UNTRACKED");
  });

  it("FAILs for a router-root-declared agent too (fable / sr-* models)", () => {
    const v = classifyRoutingMode({
      mode: "direct-oauth",
      base: "direct",
      model: "fable",
      litellmOk: "0",
      declared: "router-root",
      ts: "",
    });
    expect(v?.status).toBe("fail");
  });

  it("is silent when LiteLLM was never configured (declared=direct-oauth)", () => {
    expect(
      classifyRoutingMode({
        mode: "direct-oauth",
        base: "direct",
        model: "opus",
        litellmOk: "0",
        declared: "direct-oauth",
        ts: "",
      }),
    ).toBeNull();
  });

  it("is silent for a non-untracked divergence — router-root declared, landed passthrough", () => {
    // Still on the proxy, still metered. That divergence is the
    // .session-model-alert relay's business, not a standing doctor FAIL.
    expect(
      classifyRoutingMode({
        mode: "passthrough",
        base: "http://127.0.0.1:4010/anthropic",
        model: "opus",
        litellmOk: "1",
        declared: "router-root",
        ts: "",
      }),
    ).toBeNull();
  });

  it("is silent for a healthy boot", () => {
    expect(
      classifyRoutingMode({
        mode: "passthrough",
        base: "http://127.0.0.1:4010/anthropic",
        model: "opus",
        litellmOk: "1",
        declared: "passthrough",
        ts: "",
      }),
    ).toBeNull();
  });
});

describe("runRoutingModeChecks", () => {
  it("is silent for a fleet of healthy agents", () => {
    const results = runRoutingModeChecks(config("alpha", "beta"), {
      agentsDir: AGENTS_DIR,
      readFile: reader({
        [path("alpha")]: record({ mode: "passthrough", declared: "passthrough" }),
        [path("beta")]: record({
          mode: "router-root",
          base: "http://127.0.0.1:4010",
          model: "fable",
          declared: "router-root",
        }),
      }),
    });
    expect(results).toEqual([]);
  });

  it("is silent for an agent that has never written a record", () => {
    const results = runRoutingModeChecks(config("alpha"), {
      agentsDir: AGENTS_DIR,
      readFile: reader({}),
    });
    expect(results).toEqual([]);
  });

  it("FAILs the stripped agent, names it, and leaves its healthy peers silent", () => {
    const results = runRoutingModeChecks(config("alpha", "beta", "gamma"), {
      agentsDir: AGENTS_DIR,
      readFile: reader({
        [path("alpha")]: record({ mode: "passthrough", declared: "passthrough" }),
        [path("beta")]: record({
          mode: "direct-oauth",
          base: "direct",
          litellmOk: "0",
          declared: "passthrough",
          ts: "2026-07-29T02:11:00Z",
        }),
        [path("gamma")]: record({ mode: "passthrough", declared: "passthrough" }),
      }),
    });

    expect(results).toHaveLength(1);
    const [row] = results;
    expect(row.status).toBe("fail");
    expect(row.name).toBe("litellm routing: beta");
    expect(row.detail).toContain("direct-oauth");
    expect(row.detail).toContain("UNTRACKED");
    expect(row.detail).toContain("2026-07-29T02:11:00Z");
    // The remediation must say the fix does not land until a RESTART — a key
    // provisioned mid-session changes nothing, the strip is a boot decision.
    expect(row.fix).toContain("switchroom apply");
    expect(row.fix?.toUpperCase()).toContain("RESTART");
  });

  it("WARNs — never silently passes — when the record is unreadable", () => {
    const results = runRoutingModeChecks(config("alpha"), {
      agentsDir: AGENTS_DIR,
      readFile: () => {
        const err = new Error("EACCES: permission denied");
        (err as NodeJS.ErrnoException).code = "EACCES";
        throw err;
      },
    });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("warn");
    expect(results[0].detail).toContain("EACCES");
  });

  it("WARNs — never silently passes — when the record is malformed", () => {
    const results = runRoutingModeChecks(config("alpha"), {
      agentsDir: AGENTS_DIR,
      readFile: reader({ [path("alpha")]: "mode=passthrough\n" }),
    });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("warn");
    expect(results[0].detail).toContain("malformed");
  });

  it("returns nothing for a config with no agents", () => {
    expect(
      runRoutingModeChecks({ agents: {} } as unknown as SwitchroomConfig, {
        agentsDir: AGENTS_DIR,
        readFile: reader({}),
      }),
    ).toEqual([]);
  });

  it("WARNs once when the agents dir cannot be resolved", () => {
    // resolveAgentsDir dereferences config.switchroom.agents_dir; a config
    // with no switchroom block throws, and the check must degrade to a single
    // visible warn row rather than crashing doctor or claiming health.
    // The container-mode env override would short-circuit that throw, so
    // clear it for the duration of this case.
    const saved = process.env.SWITCHROOM_AGENTS_DIR;
    delete process.env.SWITCHROOM_AGENTS_DIR;
    try {
      const results = runRoutingModeChecks(config("alpha"), {
        agentsDir: undefined,
        readFile: reader({}),
      });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("warn");
      expect(results[0].detail).toContain("agents directory");
    } finally {
      if (saved !== undefined) process.env.SWITCHROOM_AGENTS_DIR = saved;
    }
  });
});
