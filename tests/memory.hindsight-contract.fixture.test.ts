/**
 * Hindsight MCP contract — offline regression guard (no server).
 *
 * Closes the bug class that bit 5 callsites over 2026-06-06..07: switchroom
 * calling a renamed/removed tool or a renamed/dropped arg, silently. Three
 * cross-checks against the committed golden snapshot of the live tools/list:
 *
 *  1. EXPECTED_HINDSIGHT_TOOLS agrees with the captured server truth (no drift
 *     between the hand-maintained const and the snapshot).
 *  2. Every TS callsite calls a real tool, sends all required args, and sends
 *     NO arg the server doesn't accept (the silent-drop class — types,
 *     retain_mission — that an isError check can never catch).
 *  3. Every prompt-/hook-named tool is a real server tool (the delete_memory
 *     guidance bug, #4).
 *
 * When the offline const/snapshot disagree with reality, refresh the snapshot
 * from the live server and reconcile EXPECTED_HINDSIGHT_TOOLS — the diff IS the
 * upstream contract change you need to handle.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EXPECTED_HINDSIGHT_TOOLS,
  HINDSIGHT_TS_CALLSITES,
  HINDSIGHT_PROMPT_TOOLS,
  HINDSIGHT_HOOK_TOOLS,
  HINDSIGHT_MIN_API_VERSION,
} from "../src/memory/hindsight-tools.js";
import {
  FALLBACK_TOOL_TABLE,
  SYNTHESIZED_TOOL_NAMES,
  buildFallbackToolsList,
} from "../src/cli/hindsight-mcp-shim.js";

interface Snapshot {
  _meta?: { count?: number; hindsight_api_version?: string };
  tools: Record<string, { required: string[]; props: string[] }>;
}
const snapshot = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures", "hindsight-tools-list.snapshot.json"), "utf-8"),
) as Snapshot;

/** Tool count on the hindsight surface switchroom targets (0.8.4; 0.8.5 and
 *  0.8.6 add and remove none — all three wheels register 32). */
const HINDSIGHT_TOOL_COUNT = 32;

/**
 * The `api_version` the pinned hindsight image resolves to, read out of
 * `docker/Dockerfile.hindsight`'s machine-read marker rather than duplicated
 * here — a second hand-maintained copy is a third thing to forget.
 */
function pinnedHindsightApiVersion(): string {
  const dockerfile = readFileSync(
    resolve(__dirname, "..", "docker", "Dockerfile.hindsight"),
    "utf-8",
  );
  const hits = dockerfile.match(/^#\s*switchroom:hindsight-api-version=(\S+)\s*$/gm) ?? [];
  expect(
    hits.length,
    "docker/Dockerfile.hindsight must carry exactly one `# switchroom:hindsight-api-version=<v>` " +
      "marker naming the api_version its pinned digest resolves to",
  ).toBe(1);
  return hits[0].split("=")[1].trim();
}

describe("hindsight contract — golden snapshot integrity", () => {
  it(`the snapshot captures all ${HINDSIGHT_TOOL_COUNT} server tools`, () => {
    expect(Object.keys(snapshot.tools).length).toBe(HINDSIGHT_TOOL_COUNT);
  });

  it("_meta.count is not decorative — it matches the tools actually captured", () => {
    expect(snapshot._meta?.count).toBe(Object.keys(snapshot.tools).length);
  });

  /**
   * THE SNAPSHOT MUST NOT RUN AHEAD OF THE PINNED IMAGE.
   *
   * A snapshot captured from (or forward-patched to) a newer server than the
   * one the repo ships is not harmlessly optimistic. `FALLBACK_TOOL_TABLE` is
   * built from this file and is the manifest an agent's tools/list returns on a
   * cold boot; hindsight drops an unknown ARGUMENT silently (isError:false, and
   * the response is byte-identical to the call without it, verified live on
   * 0.8.4). So a forward-patched prop makes an agent issue e.g. a tag-scoped
   * `list_memories` and receive the UNFILTERED list believing it was filtered.
   *
   * A previous revision of this branch shipped exactly that: `_meta` stamped
   * 0.8.5 with `list_memories.tags`, `list_memories.tags_match` and
   * `create_mental_model.tags_match` bolted on, while
   * docker/Dockerfile.hindsight pinned 0.8.4. This assertion is what makes that
   * un-shippable rather than merely regrettable, and it is what forces a
   * re-capture when #3768 bumps the image.
   */
  it("_meta.hindsight_api_version equals the api_version docker/Dockerfile.hindsight pins", () => {
    expect(
      snapshot._meta?.hindsight_api_version,
      "the committed MCP contract must describe the image this repo actually ships — " +
        "re-capture tests/fixtures/hindsight-tools-list.snapshot.json from the pinned " +
        "image (and reconcile FALLBACK_TOOL_TABLE) in the same commit as an image bump",
    ).toBe(pinnedHindsightApiVersion());
  });

  /**
   * The 0.8.4 → 0.8.5 delta, pinned by name in BOTH directions.
   *
   * These three props are the entire tool-surface difference between the two
   * wheels (verified by dumping `create_mcp_server(...)`'s registration surface
   * inside each pinned digest: 32 tools either way, no tool added or removed).
   * Naming them keeps the mutation-guard the 0.8.4 revision of this test
   * provided — a snapshot forward-patched to 0.8.5 while the image pins 0.8.4
   * still reds here even if `_meta` is edited to match — while adding the
   * mirror obligation: on 0.8.5 the props must actually BE captured, so a
   * marker bumped without a re-capture cannot pass.
   */
  it("carries exactly the tag props the pinned wheel registers — neither ahead nor behind", () => {
    const pinned = pinnedHindsightApiVersion();
    const shouldHaveTagProps = pinned !== "0.8.4";
    const has = (tool: string, prop: string) =>
      (snapshot.tools[tool]?.props as string[]).includes(prop);
    for (const [tool, prop] of [
      ["list_memories", "tags"],
      ["list_memories", "tags_match"],
      ["create_mental_model", "tags_match"],
    ] as const) {
      expect(
        has(tool, prop),
        shouldHaveTagProps
          ? `${tool}.${prop} exists on ${pinned} but is missing from the snapshot — ` +
            "the marker was bumped without re-capturing the fixture from the pinned image"
          : `${tool}.${prop} does not exist on ${pinned}; advertising it makes the shim's ` +
            "cold-boot manifest promise a filter the server silently ignores",
      ).toBe(shouldHaveTagProps);
    }
  });

  /**
   * The 0.8.5 → 0.8.6 delta, pinned by name in BOTH directions.
   *
   * `reflect.apply_all_directives` (upstream #3013) is the ENTIRE tool-surface
   * difference between the 0.8.5 and 0.8.6 wheels — derived by dumping
   * `create_mcp_server(memory, multi_bank=True)`'s registration surface inside
   * each pinned digest, with the 0.8.5 run reproducing this fixture's previous
   * revision byte-for-byte before the 0.8.6 run was trusted.
   *
   * Pinned both ways for the same reason the 0.8.4→0.8.5 assertion above is:
   *  - on a pre-0.8.6 pin, advertising it would make an agent send an argument
   *    the server drops SILENTLY (isError:false) while believing directive
   *    scope was widened — and, because FALLBACK_TOOL_TABLE doubles as the
   *    tools/CALL allowlist, would wave that argument through the guard;
   *  - on the 0.8.6 pin it must actually BE captured, so bumping the version
   *    marker without re-capturing the fixture cannot pass.
   */
  it("carries reflect.apply_all_directives exactly when the pinned wheel registers it", () => {
    const pinned = pinnedHindsightApiVersion();
    const shouldHaveFlag = pinned !== "0.8.4" && pinned !== "0.8.5";
    expect(
      (snapshot.tools["reflect"]?.props as string[]).includes("apply_all_directives"),
      shouldHaveFlag
        ? "reflect.apply_all_directives exists on " + pinned + " but is missing from the " +
          "snapshot — the marker was bumped without re-capturing the fixture from the pinned image"
        : "reflect.apply_all_directives does not exist on " + pinned + "; advertising it makes " +
          "the shim's cold-boot manifest promise a directive-scope switch the server ignores",
    ).toBe(shouldHaveFlag);
  });

  it("HINDSIGHT_MIN_API_VERSION names the version this snapshot was captured from", () => {
    // The doctor version-skew check compares the LIVE server against this
    // constant. If the constant and the snapshot drift apart, doctor reports
    // "contract matches" while the contract it is defending was captured from
    // a different server — the check silently stops being a check. Chained to
    // the assertion above, this transitively pins the floor to the image
    // docker/Dockerfile.hindsight actually ships.
    expect(
      snapshot._meta?.hindsight_api_version,
      "re-capturing the snapshot must bump HINDSIGHT_MIN_API_VERSION (and vice versa)",
    ).toBe(HINDSIGHT_MIN_API_VERSION);
  });

  it("EXPECTED_HINDSIGHT_TOOLS agrees with the captured server truth (required-args, no const/snapshot drift)", () => {
    for (const [tool, spec] of Object.entries(EXPECTED_HINDSIGHT_TOOLS)) {
      const real = snapshot.tools[tool];
      expect(real, `expected tool '${tool}' is not in the snapshot — refresh the snapshot / fix the const`).toBeDefined();
      // The hand-maintained `required` intent must match the server exactly.
      // A server rename of a required arg (the source_query class) reds here.
      expect(
        [...spec.required].sort(),
        `'${tool}' required-args drifted from the server (renamed/added/removed upstream)`,
      ).toEqual([...real.required].sort());
    }
  });
});

/**
 * The shim's first-boot fallback manifest is what an agent's tools/list returns
 * when hindsight has never been reachable in that session. If it drifts below
 * the real surface, the affected tools are INVISIBLE to the agent and the
 * symptom is indistinguishable from an upstream removal.
 *
 * That is not hypothetical: the table shipped 29 tools against a 32-tool server
 * for weeks, hiding `update_memory`, `invalidate_memory` and
 * `clear_mental_model` — the tools `switchroom memory demote` and vault-sweep
 * reach for — plus six accepted props. Byte-equality with the snapshot is the
 * deterministic fix; a comment saying "keep these in sync" is not.
 */
describe("hindsight contract — the shim fallback manifest mirrors the snapshot", () => {
  it("advertises exactly the snapshot's tool set (no missing tool, no phantom)", () => {
    expect(Object.keys(FALLBACK_TOOL_TABLE).sort()).toEqual(
      Object.keys(snapshot.tools).sort(),
    );
  });

  /**
   * The shim-synthesized carve-out, asserted rather than asserted-away.
   *
   * `FALLBACK_TOOL_TABLE` remains a byte-faithful description of the pinned
   * image (test above) — the synthesized tools deliberately are NOT in it.
   * That set is FIVE, not two: the two directive-retirement tools plus the
   * three knowledge-page reads. The loop below iterates
   * `SYNTHESIZED_TOOL_NAMES` rather than a hard-coded pair, so it covers
   * whatever the table holds. What they DO ride in on is the served manifest,
   * so the two tests here pin the boundary:
   *
   *  1. no synthesized name may exist upstream. If an image bump registers a
   *     real `deactivate_directive` or `search_knowledge_pages`, this reds and
   *     the synthesis gets retired instead of silently shadowing the backend's
   *     version (which would accept a `bank_id` the shim's deliberately does
   *     not).
   *  2. the served manifest must be exactly snapshot ∪ synthesized. A tool
   *     added to either table without review changes that set and reds here,
   *     which is what stops "over-reporting" creeping back in under the
   *     synthesis banner.
   */
  it("no shim-synthesized tool is one the pinned image registers", () => {
    for (const name of SYNTHESIZED_TOOL_NAMES) {
      expect(
        Object.keys(snapshot.tools),
        `'${name}' now exists upstream — the shim must stop synthesizing it ` +
          `(a synthesized tool shadowing a real one hides the real schema)`,
      ).not.toContain(name);
    }
  });

  it("the served cold-boot manifest is exactly the snapshot plus the synthesized tools", () => {
    const served = buildFallbackToolsList().tools.map((t) => t.name).sort();
    expect(served).toEqual(
      [...Object.keys(snapshot.tools), ...SYNTHESIZED_TOOL_NAMES].sort(),
    );
  });

  for (const tool of Object.keys(snapshot.tools).sort()) {
    it(`${tool}: fallback required+props match the snapshot exactly`, () => {
      const [required, props] = FALLBACK_TOOL_TABLE[tool];
      expect(
        [...required].sort(),
        `fallback '${tool}' required-args drifted from the snapshot`,
      ).toEqual([...snapshot.tools[tool].required].sort());
      expect(
        [...props].sort(),
        `fallback '${tool}' accepted props drifted from the snapshot — a prop ` +
          `missing here is a capability the agent cannot see on first boot`,
      ).toEqual([...snapshot.tools[tool].props].sort());
    });
  }
});

describe("hindsight contract — every TS callsite satisfies the tool schema", () => {
  for (const cs of HINDSIGHT_TS_CALLSITES) {
    it(`${cs.where} → ${cs.tool}(${cs.argKeys.join(",")}) is contract-valid`, () => {
      const real = snapshot.tools[cs.tool];
      // (a) the tool exists.
      expect(real, `${cs.where} calls '${cs.tool}' which the server does not advertise (phantom/renamed)`).toBeDefined();
      // (b) every required arg is sent.
      for (const req of real.required) {
        expect(
          cs.argKeys,
          `${cs.where} omits required arg '${req}' of '${cs.tool}' → the call silently no-ops`,
        ).toContain(req);
      }
      // (c) NO arg sent that the server doesn't accept (silently dropped),
      //     except args explicitly declared unsupported — those are asserted
      //     separately below so the exemption self-invalidates.
      const exempt = new Set(cs.knownUnsupportedArgs ?? []);
      for (const sent of cs.argKeys) {
        if (exempt.has(sent)) continue;
        expect(
          real.props,
          `${cs.where} sends '${sent}' which '${cs.tool}' does NOT accept → SILENTLY DROPPED (isError can't catch this)`,
        ).toContain(sent);
      }
    });

    if (cs.knownUnsupportedArgs?.length) {
      it(`${cs.where} → ${cs.tool}: declared-unsupported args are still unsupported upstream`, () => {
        const real = snapshot.tools[cs.tool];
        expect(real).toBeDefined();
        for (const arg of cs.knownUnsupportedArgs!) {
          expect(
            real.props,
            `'${arg}' is now an accepted prop of '${cs.tool}' — the upstream gap ` +
              `that broke ${cs.where} has CLOSED. Drop the knownUnsupportedArgs ` +
              `exemption and un-break the feature it was blocking.`,
          ).not.toContain(arg);
        }
      });
    }
  }
});

describe("hindsight contract — prompt + hook only name real tools", () => {
  it("every mcp__hindsight__<tool> the model is instructed to use is a real server tool (incident #4)", () => {
    for (const tool of HINDSIGHT_PROMPT_TOOLS) {
      expect(snapshot.tools[tool], `guidance names mcp__hindsight__${tool} which is not a real server tool`).toBeDefined();
    }
  });

  it("every tool the user-profile-refresh hook calls is a real server tool", () => {
    for (const tool of HINDSIGHT_HOOK_TOOLS) {
      expect(snapshot.tools[tool], `the refresh hook calls '${tool}' which is not a real server tool`).toBeDefined();
    }
  });
});
