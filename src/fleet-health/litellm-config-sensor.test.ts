/**
 * Fleet-health LiteLLM config sensor — the load-bearing I2 enforcement point.
 * Asserts the four design fixtures (good / global-flag / openrouter-flag /
 * absent-file) plus the skip-notice and the finding shape the ledger consumes.
 */

import { describe, it, expect } from "vitest";

import type { DiscoverFn } from "./litellm-config-sensor.js";
import {
  scanLitellmConfig,
  resolveLitellmConfigPath,
  LITELLM_PROXY_PSEUDO_AGENT,
} from "./litellm-config-sensor.js";
import {
  COOLIFY_SERVICES_DIR,
  discoverLiveLitellmConfigPath,
} from "../litellm/header-passthrough-guard.js";
import { mapSignal } from "./mapping.js";

const PATH = "/fake/litellm-config.yaml";

/** Hermetic stand-in for live-config discovery on a host with no live proxy.
 *  Injected wherever a test exercises path RESOLUTION, so the assertion never
 *  depends on whether this machine happens to run the real LiteLLM proxy. */
const NO_LIVE_CONFIG: DiscoverFn = () => ({
  path: null,
  reason: "no-services-dir",
  candidates: [],
});

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
  it("honors an explicit override arg over the env", () => {
    process.env.LITELLM_CONFIG_PATH = "/env/path.yaml";
    expect(resolveLitellmConfigPath("/explicit.yaml")).toBe("/explicit.yaml");
    delete process.env.LITELLM_CONFIG_PATH;
  });
  it("honors the env var over discovery", () => {
    process.env.LITELLM_CONFIG_PATH = "/env/path.yaml";
    expect(resolveLitellmConfigPath()).toBe("/env/path.yaml");
    delete process.env.LITELLM_CONFIG_PATH;
  });
  it("falls through to discovery, which returns null off-host (never a bogus path)", () => {
    delete process.env.LITELLM_CONFIG_PATH;
    // Discovery is INJECTED, not read from the host: on a machine that really
    // does run the live proxy, the real scan finds a config and this assertion
    // would fail for reasons that have nothing to do with the logic under test.
    expect(resolveLitellmConfigPath(undefined, NO_LIVE_CONFIG)).toBe(null);
  });
  it("uses the discovered path when discovery finds exactly one live config", () => {
    delete process.env.LITELLM_CONFIG_PATH;
    expect(
      resolveLitellmConfigPath(undefined, () => ({
        path: "/svc/theproxy/litellm-config.yaml",
        reason: "found",
        candidates: ["/svc/theproxy/litellm-config.yaml"],
      })),
    ).toBe("/svc/theproxy/litellm-config.yaml");
  });
});

describe("discoverLiveLitellmConfigPath (no hardcoded service id — KEN-125 scrub)", () => {
  // The service dir is named by a deployment-specific Coolify service id.
  // Hardcoding it would leak a host identifier into a public repo, so the
  // exported constant must stop at the services dir itself.
  it("exposes only the services dir, with no service-id segment baked in", () => {
    expect(COOLIFY_SERVICES_DIR).toBe("/data/coolify/services");
    expect(COOLIFY_SERVICES_DIR.startsWith("/host/")).toBe(false);
    // Nothing that looks like a Coolify service id (long lowercase-alnum slug).
    expect(COOLIFY_SERVICES_DIR).not.toMatch(/\/[a-z0-9]{16,}/);
  });

  it("finds the single service dir that owns a litellm-config.yaml", () => {
    const res = discoverLiveLitellmConfigPath({
      servicesDir: "/svc",
      readdirFn: () => ["someotherservice", "theproxy"],
      existsFn: (p) => p === "/svc/theproxy/litellm-config.yaml",
    });
    expect(res.reason).toBe("found");
    expect(res.path).toBe("/svc/theproxy/litellm-config.yaml");
  });

  it("returns null + no-services-dir when the services dir is absent (CI/dev)", () => {
    const res = discoverLiveLitellmConfigPath({
      servicesDir: "/svc",
      readdirFn: () => {
        throw new Error("ENOENT");
      },
    });
    expect(res.reason).toBe("no-services-dir");
    expect(res.path).toBe(null);
  });

  it("returns null + not-found when no service dir owns the config", () => {
    const res = discoverLiveLitellmConfigPath({
      servicesDir: "/svc",
      readdirFn: () => ["a", "b"],
      existsFn: () => false,
    });
    expect(res.reason).toBe("not-found");
    expect(res.path).toBe(null);
  });

  it("refuses to guess when several candidates exist → ambiguous, path null", () => {
    const res = discoverLiveLitellmConfigPath({
      servicesDir: "/svc",
      readdirFn: () => ["one", "two"],
      existsFn: (p) => p.endsWith("/litellm-config.yaml"),
    });
    expect(res.reason).toBe("ambiguous");
    expect(res.path).toBe(null);
    expect(res.candidates).toHaveLength(2);
  });

  it("is deterministic regardless of readdir ordering", () => {
    const forward = discoverLiveLitellmConfigPath({
      servicesDir: "/svc",
      readdirFn: () => ["b", "a"],
      existsFn: (p) => p.endsWith("/litellm-config.yaml"),
    });
    const reverse = discoverLiveLitellmConfigPath({
      servicesDir: "/svc",
      readdirFn: () => ["a", "b"],
      existsFn: (p) => p.endsWith("/litellm-config.yaml"),
    });
    expect(forward.candidates).toEqual(reverse.candidates);
  });
});

describe("scanLitellmConfig", () => {
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

  it("unresolvable live path → skipped with a VISIBLE notice, never a silent pass", () => {
    delete process.env.LITELLM_CONFIG_PATH;
    const logs: string[] = [];
    const res = scanLitellmConfig({
      discoverFn: NO_LIVE_CONFIG, // hermetic: never consults the host's real fs
      existsFn: () => true, // would pass if the null path were not short-circuited
      readFn: () => "litellm_settings:\n  forward_client_headers_to_llm_api: true\n",
      log: (m) => logs.push(m),
    });
    expect(res.status).toBe("skipped");
    expect(res.path).toBe(null);
    expect(res.findings).toEqual([]);
    expect(logs.some((l) => /SKIPPED.*no live config discoverable/.test(l))).toBe(true);
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

  it("bare `opus` group with the flag → ok, no findings (Anthropic OAuth passthrough)", () => {
    // Regression: the live proxy gained a bare `opus` group routing to
    // anthropic/claude-opus-5 (2026-07-25). It was missing from the allowlist,
    // so the sensor reported a violation and would have escalated a bogus L0
    // finding into the priority ledger.
    const res = withYaml(`
model_group_settings:
  opus:
    forward_client_headers_to_llm_api: true
  claude-opus-5:
    forward_client_headers_to_llm_api: true
`);
    expect(res.findings).toEqual([]);
    expect(res.status).toBe("ok");
  });

  it("`opus-openrouter` with the flag → violation (the suffix hole stays closed)", () => {
    const res = withYaml(`
model_group_settings:
  opus-openrouter:
    forward_client_headers_to_llm_api: true
`);
    expect(res.status).toBe("violation");
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].turn_id).toContain("opus-openrouter");
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
