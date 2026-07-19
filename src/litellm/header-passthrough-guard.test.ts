/**
 * I2 guard core — LiteLLM header-passthrough OAuth-leak detection.
 * Asserts OUTCOMES on the four canonical fixtures the design calls out
 * (good / global-flag / openrouter-flag / non-Claude group) plus the
 * allowlist boundary and the 4b retry/fallback advisory.
 */

import { describe, it, expect } from "vitest";

import {
  detectHeaderMisconfig,
  detectRetryFallbackGaps,
  isClaudeAllowlistedGroup,
  parseLitellmConfig,
} from "./header-passthrough-guard.js";

const GOOD = `
litellm_settings:
  drop_params: true
model_group_settings:
  claude-opus-4:
    forward_client_headers_to_llm_api: true
  claude-sonnet-5:
    forward_client_headers_to_llm_api: true
  sonnet:
    forward_client_headers_to_llm_api: true
  fable:
    forward_client_headers_to_llm_api: true
  claude-fable-5:
    forward_client_headers_to_llm_api: true
  claude-sonnet-5-openrouter:
    forward_client_headers_to_llm_api: false
  gpt-oss:
    forward_client_headers_to_llm_api: false
`;

const GLOBAL_FLAG = `
litellm_settings:
  forward_client_headers_to_llm_api: true
model_group_settings:
  claude-opus-4:
    forward_client_headers_to_llm_api: true
`;

const OPENROUTER_FLAG = `
litellm_settings:
  drop_params: true
model_group_settings:
  claude-opus-4:
    forward_client_headers_to_llm_api: true
  claude-sonnet-5-openrouter:
    forward_client_headers_to_llm_api: true
`;

const NONCLAUDE_FLAG = `
model_group_settings:
  gpt-oss:
    forward_client_headers_to_llm_api: true
`;

describe("isClaudeAllowlistedGroup", () => {
  it("allows claude-* and the bare sonnet/fable aliases", () => {
    for (const g of ["claude-opus-4", "claude-sonnet-5", "claude-haiku-4", "claude-fable-5", "sonnet", "fable"]) {
      expect(isClaudeAllowlistedGroup(g)).toBe(true);
    }
  });
  it("EXCLUDES *-openrouter even when it matches claude-*", () => {
    expect(isClaudeAllowlistedGroup("claude-sonnet-5-openrouter")).toBe(false);
    expect(isClaudeAllowlistedGroup("sonnet-openrouter")).toBe(false);
  });
  it("rejects non-Claude groups", () => {
    for (const g of ["gpt-oss", "glm", "openrouter/z-ai/glm-5.2", "gemini"]) {
      expect(isClaudeAllowlistedGroup(g)).toBe(false);
    }
  });
});

describe("detectHeaderMisconfig", () => {
  it("good config → no violations", () => {
    expect(detectHeaderMisconfig(parseLitellmConfig(GOOD))).toEqual([]);
  });

  it("global flag under litellm_settings → violation", () => {
    const v = detectHeaderMisconfig(parseLitellmConfig(GLOBAL_FLAG));
    expect(v).toHaveLength(1);
    expect(v[0].scope).toBe("global");
    expect(v[0].detail).toContain("litellm_settings");
  });

  it("flag on *-openrouter group → violation", () => {
    const v = detectHeaderMisconfig(parseLitellmConfig(OPENROUTER_FLAG));
    expect(v).toHaveLength(1);
    expect(v[0].scope).toBe("model_group");
    expect(v[0].group).toBe("claude-sonnet-5-openrouter");
  });

  it("flag on a non-Claude group → violation", () => {
    const v = detectHeaderMisconfig(parseLitellmConfig(NONCLAUDE_FLAG));
    expect(v).toHaveLength(1);
    expect(v[0].group).toBe("gpt-oss");
  });

  it("handles model_group_settings expressed as a list", () => {
    const listForm = `
model_group_settings:
  - model_group: gpt-oss
    forward_client_headers_to_llm_api: true
  - model_group: claude-opus-4
    forward_client_headers_to_llm_api: true
`;
    const v = detectHeaderMisconfig(parseLitellmConfig(listForm));
    expect(v.map((x) => x.group)).toEqual(["gpt-oss"]);
  });

  it("empty / non-object input → no violations (never throws)", () => {
    expect(detectHeaderMisconfig(null)).toEqual([]);
    expect(detectHeaderMisconfig(parseLitellmConfig(""))).toEqual([]);
    expect(detectHeaderMisconfig("just a string")).toEqual([]);
  });
});

describe("detectRetryFallbackGaps (4b advisory)", () => {
  it("warns on a claude group with num_retries>1 and no fallbacks", () => {
    const cfg = `
model_group_settings:
  claude-opus-4:
    num_retries: 3
`;
    const w = detectRetryFallbackGaps(parseLitellmConfig(cfg));
    expect(w).toHaveLength(1);
    expect(w[0].group).toBe("claude-opus-4");
    expect(w[0].numRetries).toBe(3);
  });

  it("no warning when a fallbacks chain covers the group", () => {
    const cfg = `
litellm_settings:
  fallbacks:
    - claude-opus-4: ["claude-sonnet-5"]
model_group_settings:
  claude-opus-4:
    num_retries: 3
`;
    expect(detectRetryFallbackGaps(parseLitellmConfig(cfg))).toEqual([]);
  });

  it("no warning at num_retries<=1", () => {
    const cfg = `
model_group_settings:
  claude-opus-4:
    num_retries: 1
`;
    expect(detectRetryFallbackGaps(parseLitellmConfig(cfg))).toEqual([]);
  });

  it("ignores non-Claude groups", () => {
    const cfg = `
model_group_settings:
  gpt-oss:
    num_retries: 5
`;
    expect(detectRetryFallbackGaps(parseLitellmConfig(cfg))).toEqual([]);
  });
});
