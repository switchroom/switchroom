/**
 * Fleet-health LiteLLM config sensor — the load-bearing I2 enforcement point.
 * Asserts the four design fixtures (good / global-flag / openrouter-flag /
 * absent-file) plus the skip-notice and the finding shape the ledger consumes.
 */

import { describe, it, expect } from "vitest";

import {
  scanLitellmConfig,
  resolveLitellmConfigPath,
  LITELLM_PROXY_PSEUDO_AGENT,
} from "./litellm-config-sensor.js";
import { mapSignal } from "./mapping.js";

const PATH = "/fake/litellm-config.yaml";

function withYaml(yaml: string, log?: (m: string) => void) {
  return scanLitellmConfig({
    path: PATH,
    existsFn: () => true,
    readFn: () => yaml,
    log,
    nowIso: "2026-07-19T00:00:00.000Z",
  });
}

describe("resolveLitellmConfigPath", () => {
  it("returns null when neither arg nor env is set (no hard-coded default)", () => {
    delete process.env.LITELLM_CONFIG_PATH;
    expect(resolveLitellmConfigPath()).toBeNull();
  });
  it("reads the LITELLM_CONFIG_PATH env when set", () => {
    process.env.LITELLM_CONFIG_PATH = "/env/path.yaml";
    expect(resolveLitellmConfigPath()).toBe("/env/path.yaml");
    delete process.env.LITELLM_CONFIG_PATH;
  });
  it("honors an explicit override arg over the env", () => {
    process.env.LITELLM_CONFIG_PATH = "/env/path.yaml";
    expect(resolveLitellmConfigPath("/explicit.yaml")).toBe("/explicit.yaml");
    delete process.env.LITELLM_CONFIG_PATH;
  });
});

describe("scanLitellmConfig", () => {
  it("no path (env unset, no override) → skipped with a VISIBLE notice", () => {
    delete process.env.LITELLM_CONFIG_PATH;
    const logs: string[] = [];
    const res = scanLitellmConfig({
      existsFn: () => {
        throw new Error("existsFn must not be called when no path resolves");
      },
      log: (m) => logs.push(m),
    });
    expect(res.status).toBe("skipped");
    expect(res.findings).toEqual([]);
    expect(logs.some((l) => /SKIPPED.*LITELLM_CONFIG_PATH unset/.test(l))).toBe(true);
  });

  it("absent file → skipped with a VISIBLE notice, no findings", () => {
    const logs: string[] = [];
    const res = scanLitellmConfig({
      path: PATH,
      existsFn: () => false,
      log: (m) => logs.push(m),
    });
    expect(res.status).toBe("skipped");
    expect(res.findings).toEqual([]);
    expect(logs.some((l) => /SKIPPED.*absent/.test(l))).toBe(true);
  });

  it("good config → ok, no findings", () => {
    const res = withYaml(`
model_group_settings:
  claude-opus-4:
    forward_client_headers_to_llm_api: true
  sonnet:
    forward_client_headers_to_llm_api: true
`);
    expect(res.status).toBe("ok");
    expect(res.findings).toEqual([]);
  });

  it("global flag → violation finding attributed to the proxy pseudo-agent", () => {
    const res = withYaml(`
litellm_settings:
  forward_client_headers_to_llm_api: true
`);
    expect(res.status).toBe("violation");
    expect(res.findings).toHaveLength(1);
    const f = res.findings[0];
    expect(f.signal).toBe("litellm-header-passthrough-misconfig");
    expect(f.agent).toBe(LITELLM_PROXY_PSEUDO_AGENT);
    expect(f.log_pointer).toContain(PATH);
    // the finding routes to the subscription-honesty job at severity 3.
    const m = mapSignal(f.signal);
    expect(m.job_spec).toBe("keep-my-subscription-honest");
    expect(m.severity).toBe(3);
  });

  it("openrouter flag → violation", () => {
    const res = withYaml(`
model_group_settings:
  claude-sonnet-5-openrouter:
    forward_client_headers_to_llm_api: true
`);
    expect(res.status).toBe("violation");
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].turn_id).toContain("claude-sonnet-5-openrouter");
  });

  it("unparseable YAML → skipped (never crashes the scan)", () => {
    const res = withYaml("{ a: 1, b: [unclosed");
    expect(res.status).toBe("skipped");
  });
});
