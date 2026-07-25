import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyShmSize,
  classifyExtractionLogs,
  checkHindsightContainerHealth,
  classifyToolContract,
  classifyHindsightHealthProbe,
  checkHindsightHealthEndpoint,
  classifyConsolidationBacklog,
  classifyDirectiveCount,
  MAX_DIRECTIVES,
  DIRECTIVE_WARN_THRESHOLD,
  classifyAutohealStatus,
  classifyLlmVerification,
  classifyHindsightDataVolumeMounts,
  classifyHindsightNetworkMode,
  classifyLiteLlmReachability,
  CONSOLIDATION_BACKLOG_WARN,
  CONSOLIDATION_BACKLOG_FAIL,
  type AdvertisedTool,
  MIN_HINDSIGHT_SHM_BYTES,
} from "../src/cli/doctor-memory.js";
import { EXPECTED_HINDSIGHT_TOOLS } from "../src/memory/hindsight-tools.js";

/** The golden snapshot, reshaped into the advertised-tool form the doctor probe
 *  produces — so the unit test exercises the classifier against REAL server
 *  data without a live server. */
function snapshotAdvertised(): AdvertisedTool[] {
  const snap = JSON.parse(
    readFileSync(resolve(__dirname, "fixtures", "hindsight-tools-list.snapshot.json"), "utf-8"),
  ) as { tools: Record<string, { required: string[] }> };
  return Object.entries(snap.tools).map(([name, s]) => ({ name, required: s.required }));
}

describe("classifyToolContract — live contract-drift detector", () => {
  it("ALL OK against the real server surface (no drift today)", () => {
    const results = classifyToolContract(snapshotAdvertised());
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("ok");
    expect(results[0].name).toBe("hindsight contract");
  });

  it("catches a MISSING TOOL (a rename/removal — the delete_memory/update_memory class)", () => {
    // Drop create_mental_model from the advertised set (simulates an upstream rename).
    const advertised = snapshotAdvertised().filter((t) => t.name !== "create_mental_model");
    const results = classifyToolContract(advertised);
    const fail = results.find((r) => r.name === "hindsight contract: create_mental_model");
    expect(fail?.status).toBe("fail");
    expect(fail?.detail).toMatch(/no longer advertises it/);
  });

  it("catches a REQUIRED-ARG drift (the query->source_query class)", () => {
    // Server now ALSO requires a new arg switchroom doesn't track.
    const advertised = snapshotAdvertised().map((t) =>
      t.name === "create_mental_model" ? { ...t, required: [...t.required, "owner_id"] } : t,
    );
    const results = classifyToolContract(advertised);
    const fail = results.find((r) => r.name === "hindsight contract: create_mental_model");
    expect(fail?.status).toBe("fail");
    expect(fail?.detail).toMatch(/now requires \[owner_id\]/);
  });

  it("every tool in EXPECTED_HINDSIGHT_TOOLS is present in the snapshot (no stale const entries)", () => {
    const names = new Set(snapshotAdvertised().map((t) => t.name));
    for (const tool of Object.keys(EXPECTED_HINDSIGHT_TOOLS)) {
      expect(names.has(tool), `${tool} in EXPECTED_HINDSIGHT_TOOLS but not the snapshot`).toBe(true);
    }
  });
});

describe("classifyConsolidationBacklog (#2903 fix 5.3)", () => {
  it("ok when the queue is drained", () => {
    const r = classifyConsolidationBacklog(0);
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/drained/);
  });

  it("ok (not warn) just below the warn threshold", () => {
    const r = classifyConsolidationBacklog(CONSOLIDATION_BACKLOG_WARN - 1);
    expect(r.status).toBe("ok");
  });

  it("warns once the queue crosses the warn threshold", () => {
    const r = classifyConsolidationBacklog(CONSOLIDATION_BACKLOG_WARN);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain(`${CONSOLIDATION_BACKLOG_WARN} pending`);
  });

  it("fails when the queue is deep enough to be wedged", () => {
    const r = classifyConsolidationBacklog(CONSOLIDATION_BACKLOG_FAIL);
    expect(r.status).toBe("fail");
    expect(r.fix).toBeDefined();
  });

  it("includes the oldest-op age when it is known", () => {
    const r = classifyConsolidationBacklog(CONSOLIDATION_BACKLOG_WARN, 7200);
    expect(r.detail).toMatch(/oldest 120m old/);
  });

  it("omits the age clause when age is unknown (REST /stats has no per-op age — #2847)", () => {
    const r = classifyConsolidationBacklog(CONSOLIDATION_BACKLOG_WARN, null);
    expect(r.detail).not.toMatch(/oldest/);
  });
});

describe("classifyDirectiveCount (workstream C2 — directive pile-up + truncation surfacing)", () => {
  it("no row when the directive fetch failed / count is unknown", () => {
    expect(classifyDirectiveCount(null, "bank coach")).toBeNull();
  });

  it("no row at or below the warn threshold (avoids one ok line per bank)", () => {
    expect(classifyDirectiveCount(0, "bank coach")).toBeNull();
    expect(classifyDirectiveCount(DIRECTIVE_WARN_THRESHOLD, "bank coach")).toBeNull();
  });

  it("WARNs at 25 (one past the warn threshold, still under the cap)", () => {
    const r = classifyDirectiveCount(DIRECTIVE_WARN_THRESHOLD + 1, "bank coach");
    expect(r).not.toBeNull();
    expect(r!.status).toBe("warn");
    expect(r!.name).toBe("bank coach directives");
    expect(r!.detail).toContain(`${DIRECTIVE_WARN_THRESHOLD + 1} active directives`);
    expect(r!.detail).toContain(`MAX_DIRECTIVES=${MAX_DIRECTIVES}`);
  });

  it("still WARNs (not FAILs) exactly at the cap — nothing is truncated yet", () => {
    const r = classifyDirectiveCount(MAX_DIRECTIVES, "bank coach");
    expect(r!.status).toBe("warn");
  });

  it("FAILs one past the cap and surfaces the MAX_DIRECTIVES truncation", () => {
    const r = classifyDirectiveCount(MAX_DIRECTIVES + 1, "bank coach");
    expect(r).not.toBeNull();
    expect(r!.status).toBe("fail");
    expect(r!.detail).toContain(`${MAX_DIRECTIVES + 1} active directives`);
    expect(r!.detail).toMatch(/truncated/i);
    expect(r!.detail).toContain(`MAX_DIRECTIVES=${MAX_DIRECTIVES}`);
    // one past the cap = 1 directive dropped from the recall block.
    expect(r!.detail).toContain("1 lowest-priority directive");
    expect(r!.fix).toBeDefined();
  });

  it("reports the correct truncated count as the overflow grows", () => {
    const r = classifyDirectiveCount(MAX_DIRECTIVES + 5, "bank coach");
    expect(r!.status).toBe("fail");
    expect(r!.detail).toContain("5 lowest-priority directive");
  });

  it("TS MAX_DIRECTIVES pins the Python constant in vendor/hindsight-memory (drift guard)", () => {
    const py = readFileSync(
      resolve(__dirname, "..", "vendor", "hindsight-memory", "scripts", "lib", "directives.py"),
      "utf-8",
    );
    const m = py.match(/^MAX_DIRECTIVES\s*=\s*(\d+)\s*$/m);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(MAX_DIRECTIVES);
  });
});

describe("classifyShmSize", () => {
  it("fails on Docker's 64MB default (the 2026-06-06 outage cause)", () => {
    const r = classifyShmSize(67108864); // 64 MiB
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/64MB/);
    expect(r.detail).toMatch(/No space left on device/);
    expect(r.fix).toMatch(/shm/i);
  });

  it("passes on the 2g the fix sets", () => {
    const r = classifyShmSize(2 * 1024 * 1024 * 1024);
    expect(r.status).toBe("ok");
    expect(r.detail).toBe("2g");
  });

  it("passes at exactly the 1g floor", () => {
    expect(classifyShmSize(MIN_HINDSIGHT_SHM_BYTES).status).toBe("ok");
    expect(classifyShmSize(MIN_HINDSIGHT_SHM_BYTES - 1).status).toBe("fail");
  });
});

describe("classifyExtractionLogs", () => {
  it("fails on shm exhaustion in logs (write path down)", () => {
    const logs = [
      "2026-06-06 03:50:00 INFO worker starting",
      'could not resize shared memory segment "/PostgreSQL.1644583554" to 533794816 bytes: No space left on device',
    ].join("\n");
    const r = classifyExtractionLogs(logs);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/shared-memory exhaustion/);
  });

  it("fails on the LLM-provider error with 0 successful extractions (quota/auth)", () => {
    const logs = [
      "ERROR - hindsight_api.engine.providers.claude_code_llm - Claude Code error after 4 attempts: Claude Code returned an error result: success",
      "WARNING - hindsight_api.engine.retain.fact_extraction - Content extraction failed (skipping)",
      "Extract facts: 0 facts, 0 chunks from 1 contents in 17.401s",
      "Extract facts: 0 facts, 0 chunks from 1 contents in 18.100s",
    ].join("\n");
    const r = classifyExtractionLogs(logs);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/extract 0 facts|failing/);
    expect(r.fix).toMatch(/quota|account|auth-broker/i);
  });

  it("warns on sustained 0-fact extractions with no clear error", () => {
    const logs = Array.from({ length: 4 }, () => "Extract facts: 0 facts, 0 chunks from 1 contents in 9s").join("\n");
    expect(classifyExtractionLogs(logs).status).toBe("warn");
  });

  it("is OK when extractions are succeeding (post-fix)", () => {
    const logs = [
      "Extract facts: 5 facts, 1 chunks from 1 contents in 18.503s",
      "Extract facts: 6 facts, 1 chunks from 1 contents in 20.031s",
      // a single transient error amid successes must NOT flip it to fail
      "Claude Code returned an error result: success",
    ].join("\n");
    const r = classifyExtractionLogs(logs);
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/healthy/);
  });

  it("is OK (not failing) when there's simply no recent extraction activity", () => {
    expect(classifyExtractionLogs("worker idle\nno jobs").status).toBe("ok");
  });
});

describe("classifyAutohealStatus (#2910 host-side autoheal surface)", () => {
  it("no restart events → ok", () => {
    const r = classifyAutohealStatus("hindsight-autoheal event=started target=switchroom-hindsight");
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("no auto-restarts");
  });

  it("disabled → ok with disabled detail", () => {
    const r = classifyAutohealStatus("hindsight-autoheal event=disabled target=switchroom-hindsight");
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("disabled");
  });

  it("restart(s) but no give-up → warn with the count", () => {
    const logs = [
      "hindsight-autoheal event=restart_issued attempt=1",
      "hindsight-autoheal event=restart_ok attempt=1",
      "hindsight-autoheal event=restart_issued attempt=2",
    ].join("\n");
    const r = classifyAutohealStatus(logs);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("2 time(s)");
  });

  it("give-up event → fail (loop-guarded, not restart-looping)", () => {
    const logs = [
      "hindsight-autoheal event=restart_issued attempt=1",
      "hindsight-autoheal event=restart_issued attempt=2",
      "hindsight-autoheal event=restart_issued attempt=3",
      "hindsight-autoheal event=gave_up restarts=3 window_s=3600",
    ].join("\n");
    const r = classifyAutohealStatus(logs);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("GAVE UP after 3");
    expect(r.detail).toContain("NOT restart-");
  });
});

describe("classifyLlmVerification (#3408 boot LLM-verification surface)", () => {
  const FAIL_LINE =
    "2026-07-19 01:31:02,123 - WARNING - hindsight_api.engine.memory_engine - " +
    "LLM connection verification failed for 'default' config: litellm.BadRequestError: " +
    "Invalid model name passed in model=openrouter/google/gemini-3.1-flash-lite. " +
    "Server will start but LLM-dependent operations may fail until the provider is available.";
  const OK_LINE =
    "2026-07-19 03:43:56,055 - INFO - hindsight_api.engine.providers.litellm_llm - " +
    "LiteLLM connection verified successfully";

  it("returns null when no verification event appears in the window (no spurious ok)", () => {
    expect(classifyLlmVerification("some unrelated boot log\nanother line")).toBeNull();
  });

  it("flags a boot verification failure as FAIL, naming the config and error", () => {
    const r = classifyLlmVerification(FAIL_LINE);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("fail");
    expect(r!.detail).toContain("'default'");
    expect(r!.detail).toContain("Invalid model name");
    expect(r!.fix).toContain("model_list");
  });

  it("reports OK when the only verification event is a success", () => {
    const r = classifyLlmVerification(OK_LINE);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("ok");
  });

  it("is last-wins: a later success for the same config clears an earlier failure", () => {
    const r = classifyLlmVerification(`${FAIL_LINE}\n${OK_LINE}`);
    expect(r!.status).toBe("ok");
  });

  it("stays FAIL when a failure follows a success (drifted after a clean boot)", () => {
    const r = classifyLlmVerification(`${OK_LINE}\n${FAIL_LINE}`);
    expect(r!.status).toBe("fail");
    expect(r!.detail).toContain("'default'");
  });

  it("tracks multiple distinct configs independently and names each failing one", () => {
    const retainFail = FAIL_LINE.replace("'default'", "'retain'").replace(
      "gemini-3.1-flash-lite",
      "openrouter/z-ai/glm-legacy",
    );
    const r = classifyLlmVerification(`${OK_LINE}\n${retainFail}`);
    // default cleared by OK_LINE, retain failed → overall FAIL naming retain only.
    expect(r!.status).toBe("fail");
    expect(r!.detail).toContain("'retain'");
    expect(r!.detail).not.toContain("'default'");
  });

  it("matches the Anthropic and llama.cpp provider success phrasings", () => {
    expect(
      classifyLlmVerification("... Anthropic connection verified successfully")!.status,
    ).toBe("ok");
    expect(
      classifyLlmVerification("... llama.cpp LLM verification passed")!.status,
    ).toBe("ok");
  });
});

describe("checkHindsightContainerHealth (docker wrapper)", () => {
  it("silently skips when the container isn't a local docker container", () => {
    const exec = () => { throw new Error("No such container"); };
    expect(checkHindsightContainerHealth({ exec })).toEqual([]);
  });

  it("classifies shm + logs + autoheal when docker is available", () => {
    const exec = (_cmd: string, args: string[]) => {
      if (args.includes("inspect") && args.some((a) => String(a).includes("ShmSize"))) {
        return "2147483648\n";
      }
      if (args.includes("inspect") && args.some((a) => String(a).includes("StartedAt"))) {
        return "2020-01-01T00:00:00Z\n";
      }
      if (args.includes("inspect") && args.some((a) => String(a).includes("NetworkMode"))) {
        return "host\n";
      }
      if (args.includes("inspect") && args.some((a) => String(a).includes("Config.Env"))) {
        return "HINDSIGHT_API_RETAIN_LLM_BASE_URL=http://127.0.0.1:4010/v1\n";
      }
      if (args.includes("inspect")) return "2147483648\n";
      if (args.includes("ps")) return "switchroom-hindsight\n";
      if (_cmd === "bash") return ""; // LiteLLM /dev/tcp probe succeeds
      if (args.includes("switchroom-hindsight-autoheal")) {
        return "hindsight-autoheal event=started target=switchroom-hindsight";
      }
      if (args.includes("logs")) return "Extract facts: 4 facts, 1 chunks from 1 contents in 12s";
      return "";
    };
    const results = checkHindsightContainerHealth({ exec });
    const names = results.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining([
      "hindsight shm-size",
      "hindsight extraction",
      "hindsight autoheal",
    ]));
    expect(names).toEqual(expect.arrayContaining([
      "hindsight data-volume exclusive",
      "hindsight network mode",
      "hindsight LiteLLM reachability",
    ]));
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("skips the autoheal line when the sidecar container isn't present", () => {
    const exec = (_cmd: string, args: string[]) => {
      if (args.includes("switchroom-hindsight-autoheal")) throw new Error("No such container");
      if (args.includes("inspect") && args.some((a) => String(a).includes("ShmSize"))) {
        return "2147483648\n";
      }
      if (args.includes("inspect") && args.some((a) => String(a).includes("StartedAt"))) {
        return "2020-01-01T00:00:00Z\n";
      }
      if (args.includes("inspect") && args.some((a) => String(a).includes("NetworkMode"))) {
        return "bridge\n";
      }
      if (args.includes("inspect") && args.some((a) => String(a).includes("Config.Env"))) {
        return "HINDSIGHT_API_LLM_PROVIDER=claude-code\n";
      }
      if (args.includes("inspect")) return "2147483648\n";
      if (args.includes("ps")) return "switchroom-hindsight\n";
      if (args.includes("logs")) return "Extract facts: 4 facts, 1 chunks from 1 contents in 12s";
      return "";
    };
    const results = checkHindsightContainerHealth({ exec });
    const names = results.map((r) => r.name);
    expect(names).not.toContain("hindsight autoheal");
    expect(names).toEqual(expect.arrayContaining([
      "hindsight shm-size",
      "hindsight extraction",
    ]));
  });

  it("surfaces an autoheal give-up as a FAIL line", () => {
    const exec = (_cmd: string, args: string[]) => {
      if (args.includes("inspect")) return "2147483648\n";
      if (args.includes("switchroom-hindsight-autoheal")) {
        return [
          "hindsight-autoheal event=restart_issued attempt=1",
          "hindsight-autoheal event=restart_issued attempt=2",
          "hindsight-autoheal event=restart_issued attempt=3",
          "hindsight-autoheal event=gave_up restarts=3",
        ].join("\n");
      }
      if (args.includes("logs")) return "Extract facts: 4 facts, 1 chunks from 1 contents in 12s";
      return "";
    };
    const results = checkHindsightContainerHealth({ exec });
    expect(results.find((r) => r.name === "hindsight autoheal")?.status).toBe("fail");
  });

  it("surfaces a broken backend (small shm + failing extraction) that MCP reachability would miss", () => {
    const exec = (_cmd: string, args: string[]) => {
      if (args.includes("inspect")) return "67108864\n"; // 64MB
      if (args.includes("logs")) return "Claude Code returned an error result: success\nExtract facts: 0 facts, 0 chunks from 1 contents in 17s";
      return "";
    };
    const results = checkHindsightContainerHealth({ exec });
    expect(results.find((r) => r.name === "hindsight shm-size")?.status).toBe("fail");
    expect(results.find((r) => r.name === "hindsight extraction")?.status).toBe("fail");
  });
});

// ─── Memory-down /health signal (2026-07 outage) ─────────────────────────────
//
// The outage was invisible: hindsight crash-looped on an occupied port while
// auto-recall/retain failed silently (no user-facing error). A GET /health
// check makes the outage LOUD in `switchroom doctor`.
describe("classifyHindsightHealthProbe — memory-down signal", () => {
  it("200 → ok", () => {
    const r = classifyHindsightHealthProbe(200, 18888);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("18888");
  });

  it("null (connection refused / crash-loop) → fail, names the silent-outage risk", () => {
    const r = classifyHindsightHealthProbe(null, 18888);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/down or crash-looping|silently/i);
    expect(r.fix).toContain("switchroom memory");
  });

  it("non-200 (e.g. 503) → fail", () => {
    const r = classifyHindsightHealthProbe(503, 18888);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("503");
  });
});

describe("checkHindsightHealthEndpoint — async probe wrapper", () => {
  it("derives /health from the MCP url and reports ok on 200", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (u: string | URL) => {
      seen.push(String(u));
      return { status: 200 } as Response;
    }) as unknown as typeof fetch;
    const r = await checkHindsightHealthEndpoint("http://127.0.0.1:18888/mcp/", { fetchImpl });
    expect(seen[0]).toBe("http://127.0.0.1:18888/health");
    expect(r.status).toBe("ok");
  });

  it("a rejected fetch (container down) fails closed to a loud fail", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:18888");
    }) as unknown as typeof fetch;
    const r = await checkHindsightHealthEndpoint("http://127.0.0.1:18888/mcp/", { fetchImpl });
    expect(r.status).toBe("fail");
  });
});

describe("hindsight dual-writer + LiteLLM silent-outage classifiers (2026-07-19)", () => {
  it("fails when a canary twin also mounts the live data volume", () => {
    const r = classifyHindsightDataVolumeMounts([
      "switchroom-hindsight",
      "switchroom-hindsight-old-v01833",
    ]);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/multiple containers/);
    expect(r.fix).toBeDefined();
  });

  it("ok when only the canonical hindsight container mounts the volume", () => {
    const r = classifyHindsightDataVolumeMounts(["switchroom-hindsight"]);
    expect(r.status).toBe("ok");
  });

  it("fails NetworkMode=bridge when LiteLLM is configured", () => {
    const r = classifyHindsightNetworkMode("bridge", true);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/bridge/);
    expect(r.fix).toMatch(/memory --restart/);
  });

  it("ok NetworkMode=host when LiteLLM is configured", () => {
    expect(classifyHindsightNetworkMode("host", true).status).toBe("ok");
  });

  it("ok non-host network when LiteLLM is NOT configured", () => {
    expect(classifyHindsightNetworkMode("bridge", false).status).toBe("ok");
  });

  it("fails LiteLLM reachability when TCP probe misses", () => {
    const r = classifyLiteLlmReachability(false, "127.0.0.1:4010");
    expect(r?.status).toBe("fail");
    expect(r?.detail).toMatch(/127\.0\.0\.1:4010/);
  });

  it("ok when TCP probe hits; null when skipped", () => {
    expect(classifyLiteLlmReachability(true, "127.0.0.1:4010")?.status).toBe("ok");
    expect(classifyLiteLlmReachability(null, "x")).toBeNull();
  });

  it("does NOT treat bare ANTHROPIC_BASE_URL alone as LiteLLM configured", () => {
    const exec = (_cmd: string, args: string[]) => {
      if (args.includes("inspect") && args.some((a) => String(a).includes("ShmSize"))) {
        return "2147483648\n";
      }
      if (args.includes("inspect") && args.some((a) => String(a).includes("StartedAt"))) {
        return "2020-01-01T00:00:00Z\n";
      }
      if (args.includes("inspect") && args.some((a) => String(a).includes("NetworkMode"))) {
        return "bridge\n";
      }
      if (args.includes("inspect") && args.some((a) => String(a).includes("Config.Env"))) {
        // Residual / non-litellm anthropic base — must NOT trip network-mode fail.
        return "ANTHROPIC_BASE_URL=https://api.anthropic.com\nHINDSIGHT_API_LLM_PROVIDER=claude-code\n";
      }
      if (args.includes("inspect")) return "2147483648\n";
      if (args.includes("ps")) return "switchroom-hindsight\n";
      if (args.includes("switchroom-hindsight-autoheal")) throw new Error("No such container");
      if (args.includes("logs")) return "Extract facts: 4 facts, 1 chunks from 1 contents in 12s";
      return "";
    };
    const results = checkHindsightContainerHealth({ exec });
    const net = results.find((r) => r.name === "hindsight network mode");
    expect(net?.status).toBe("ok");
    expect(results.find((r) => r.name === "hindsight LiteLLM reachability")).toBeUndefined();
  });

  it("treats ANTHROPIC_BASE_URL on :4010 /anthropic as LiteLLM configured", () => {
    const exec = (_cmd: string, args: string[]) => {
      if (args.includes("inspect") && args.some((a) => String(a).includes("ShmSize"))) {
        return "2147483648\n";
      }
      if (args.includes("inspect") && args.some((a) => String(a).includes("StartedAt"))) {
        return "2020-01-01T00:00:00Z\n";
      }
      if (args.includes("inspect") && args.some((a) => String(a).includes("NetworkMode"))) {
        return "bridge\n";
      }
      if (args.includes("inspect") && args.some((a) => String(a).includes("Config.Env"))) {
        return "ANTHROPIC_BASE_URL=http://127.0.0.1:4010/anthropic\n";
      }
      if (args.includes("inspect")) return "2147483648\n";
      if (args.includes("ps")) return "switchroom-hindsight\n";
      if (_cmd === "bash") throw new Error("refused");
      if (args.includes("switchroom-hindsight-autoheal")) throw new Error("No such container");
      if (args.includes("logs")) return "Extract facts: 4 facts, 1 chunks from 1 contents in 12s";
      return "";
    };
    const results = checkHindsightContainerHealth({ exec });
    expect(results.find((r) => r.name === "hindsight network mode")?.status).toBe("fail");
    expect(results.find((r) => r.name === "hindsight LiteLLM reachability")?.status).toBe("fail");
  });
});
