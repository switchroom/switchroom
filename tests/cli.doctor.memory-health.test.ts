import { describe, it, expect } from "vitest";
import {
  classifyShmSize,
  classifyExtractionLogs,
  checkHindsightContainerHealth,
  MIN_HINDSIGHT_SHM_BYTES,
} from "../src/cli/doctor-memory.js";

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

describe("checkHindsightContainerHealth (docker wrapper)", () => {
  it("silently skips when the container isn't a local docker container", () => {
    const exec = () => { throw new Error("No such container"); };
    expect(checkHindsightContainerHealth({ exec })).toEqual([]);
  });

  it("classifies shm + logs when docker is available", () => {
    const exec = (_cmd: string, args: string[]) => {
      if (args.includes("inspect")) return "2147483648\n";
      if (args.includes("logs")) return "Extract facts: 4 facts, 1 chunks from 1 contents in 12s";
      return "";
    };
    const results = checkHindsightContainerHealth({ exec });
    expect(results.map((r) => r.name)).toEqual(["hindsight shm-size", "hindsight extraction"]);
    expect(results.every((r) => r.status === "ok")).toBe(true);
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
