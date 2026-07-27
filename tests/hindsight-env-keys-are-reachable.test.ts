import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  HINDSIGHT_PERF_ENV_KEYS,
  findUnmanagedHindsightEnvKeys,
  resolveHindsightPerfOverrides,
} from "../src/setup/hindsight-perf-defaults.js";
import { checkHindsightEnvKeysAreManaged } from "../src/cli/doctor.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

/**
 * The bug these tests guard.
 *
 * Five (in fact eight) Hindsight tuning knobs were emitted unconditionally on
 * BOTH launch paths — the `docker run` argv and the compose snippet — from
 * bare constants compiled into the CLI bundle, and were absent from
 * HINDSIGHT_PERF_ENV_KEYS. `resolveHindsightPerfOverrides` skips any key
 * outside that set, so a `hindsight.env` line for one of them was DISCARDED:
 * no error, no warning, the operator simply believed they had changed
 * something they had not.
 *
 * So the assertions here are about REACHABILITY — "does a yaml line actually
 * change the value the container is launched with" — not about the constants
 * existing. A test that only checked the constants' values would stay green
 * with the keys still unreachable, which is precisely the bug.
 */

const PROMOTED = [
  ["HINDSIGHT_API_RERANKER_LOCAL_BUCKET_BATCHING", "false"],
  ["HINDSIGHT_API_RERANKER_MAX_CANDIDATES", "300"],
  ["HINDSIGHT_API_RERANKER_LOCAL_MAX_CONCURRENT", "2"],
  ["HINDSIGHT_API_RECALL_MAX_CONCURRENT", "16"],
  ["HINDSIGHT_API_REFLECT_WALL_TIMEOUT", "900"],
  ["HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS", "2"],
  ["HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT", "8"],
  ["HINDSIGHT_API_CONSOLIDATION_MAX_MEMORIES_PER_ROUND", "1000"],
] as const;

describe("promoted container-env keys are reachable from switchroom.yaml", () => {
  it.each(PROMOTED)("a `hindsight.env` line for %s is honoured", (key, value) => {
    // Before the promotion this returned an empty map for every one of these:
    // the key was skipped, and the container kept switchroom's compiled value.
    const got = resolveHindsightPerfOverrides({ [key]: value });
    expect(got.get(key)).toBe(value);
  });

  it("every promoted key is a MANAGED key, not just a constant", () => {
    for (const [key] of PROMOTED) {
      expect(HINDSIGHT_PERF_ENV_KEYS.has(key), `${key} must be managed`).toBe(true);
    }
  });

  it("no perf knob is pinned outside the managed block on either launch path", () => {
    // The durable half of this fix. Promoting today's eight keys does not stop
    // a ninth being hard-pinned next month — the defect recurs at the point
    // someone adds a `-e HINDSIGHT_API_...` literal. So assert the INVARIANT:
    // every HINDSIGHT_API_* var emitted from src/setup/hindsight.ts is either
    // derived (port, provider, model, worker identity, the asserted LLM
    // budget) or flows through the managed resolvers.
    //
    // A new hard-pinned tuning knob fails here and has to justify itself.
    const src = readFileSync(
      join(import.meta.dirname, "..", "src", "setup", "hindsight.ts"),
      "utf-8",
    );

    // Vars switchroom derives rather than tunes. These are NOT operator knobs:
    // overriding them would break the container's own wiring, which is the
    // stated reason the resolvers are scoped rather than a blanket passthrough.
    const DERIVED = new Set([
      "HINDSIGHT_API_PORT",
      "HINDSIGHT_API_LLM_PROVIDER",
      "HINDSIGHT_API_LLM_MODEL",
      "HINDSIGHT_API_WORKER_ID",
      "HINDSIGHT_API_MCP_STATELESS",
    ]);

    const pinned = new Set<string>();
    for (const m of src.matchAll(/`(?:\s+- )?(HINDSIGHT_API_[A-Z0-9_]+)=\$\{/g)) {
      pinned.add(m[1]!);
    }

    const offenders = [...pinned].filter((k) => !DERIVED.has(k)).sort();
    expect(
      offenders,
      "these HINDSIGHT_API_* vars are hard-pinned in hindsight.ts, so a " +
        "`hindsight.env` line for them is silently dropped — route them " +
        "through HINDSIGHT_PERF_DEFAULTS_UNGATED instead",
    ).toEqual([]);
  });
});

describe("an unreachable `hindsight.env` key fails loudly", () => {
  const cfg = (env: Record<string, string>) =>
    ({ hindsight: { env } }) as unknown as SwitchroomConfig;

  it("names the offending key instead of dropping it silently", () => {
    const r = checkHindsightEnvKeysAreManaged(
      cfg({ HINDSIGHT_API_TOTALLY_MADE_UP: "1" }),
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("HINDSIGHT_API_TOTALLY_MADE_UP");
    // The point of the row: say the value does not reach the container.
    expect(r.detail).toContain("silently discarded");
  });

  it("catches a typo in a real key, which is the likeliest way to hit this", () => {
    const r = checkHindsightEnvKeysAreManaged(
      cfg({ HINDSIGHT_API_RERANKER_MAX_CANDIDATE: "50" }),
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("HINDSIGHT_API_RERANKER_MAX_CANDIDATE");
  });

  it("passes a key that is genuinely managed", () => {
    const r = checkHindsightEnvKeysAreManaged(
      cfg({ HINDSIGHT_API_RERANKER_MAX_CANDIDATES: "50" }),
    );
    expect(r.status).toBe("ok");
  });

  it("accepts the pg sizing keys, which live in a different managed set", () => {
    // Regression guard: scoping the check to HINDSIGHT_PERF_ENV_KEYS alone
    // would FAIL every host that sizes pg0 — a false alarm on correct config
    // teaches operators to ignore the row.
    const r = checkHindsightEnvKeysAreManaged(
      cfg({ SWITCHROOM_HINDSIGHT_PG_SHARED_BUFFERS: "4GB" }),
    );
    expect(r.status).toBe("ok");
  });

  it("is quiet when no overrides are set at all", () => {
    expect(checkHindsightEnvKeysAreManaged({} as SwitchroomConfig).status).toBe("ok");
    expect(findUnmanagedHindsightEnvKeys(undefined)).toEqual([]);
  });

  it("reports every offender, sorted, not just the first", () => {
    expect(
      findUnmanagedHindsightEnvKeys({ ZZZ_NOPE: "1", AAA_NOPE: "2" }),
    ).toEqual(["AAA_NOPE", "ZZZ_NOPE"]);
  });
});
