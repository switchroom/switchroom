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

describe("scanLitellmConfig — paired-timeout-budget drift (Fix B guard)", () => {
  it("live timeouts matching the declaration → ok, no findings", () => {
    const res = withYaml(`
model_list:
  - model_name: gpt-oss-20b
    litellm_params: { model: a, timeout: 90 }
  - model_name: gpt-oss-20b-openrouter
    litellm_params: { model: b, timeout: 60 }
  - model_name: gpt-oss-20b-retain
    litellm_params: { model: c, timeout: 200 }
  - model_name: gpt-oss-20b-retain-openrouter
    litellm_params: { model: d, timeout: 90 }
`);
    expect(res.status).toBe("ok");
    expect(res.findings).toEqual([]);
  });

  it("a half that moved alone → violation the ledger can escalate", () => {
    // The 2026-07-25/26 defect class, made loud: the operator edits one
    // per-deployment timeout on the host and nothing else changes. Before this
    // guard, every client budget on the lane was silently wrong.
    const res = withYaml(`
model_list:
  - model_name: gpt-oss-20b-retain
    litellm_params: { model: c, timeout: 200 }
  - model_name: gpt-oss-20b-retain-openrouter
    litellm_params: { model: d, timeout: 150 }
`);
    expect(res.status).toBe("violation");
    expect(res.findings).toHaveLength(1);
    const f = res.findings[0];
    expect(f.signal).toBe("litellm-timeout-budget-drift");
    expect(f.agent).toBe(LITELLM_PROXY_PSEUDO_AGENT);
    expect(f.turn_id).toBe("litellm-timeout:retain:gpt-oss-20b-retain-openrouter");
    expect(f.log_pointer).toContain(PATH);
    expect(f.log_pointer).toContain("150s");
    expect(f.log_pointer).toContain("90s");
    const m = mapSignal(f.signal);
    expect(m.job_spec).toBe("fleet-stays-healthy");
    expect(m.failure_mode).toBe("drift");
    expect(m.severity).toBe(3);
  });

  it("a group with no timeout at all → violation (it inherits request_timeout)", () => {
    const res = withYaml(`
model_list:
  - model_name: gpt-oss-20b-openrouter
    litellm_params: { model: b }
`);
    expect(res.status).toBe("violation");
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].log_pointer).toContain("carries NO per-deployment timeout");
  });

  it("reports BOTH invariants from one file read, without either masking the other", () => {
    const res = withYaml(`
litellm_settings:
  forward_client_headers_to_llm_api: true
model_list:
  - model_name: gpt-oss-20b
    litellm_params: { model: a, timeout: 45 }
`);
    expect(res.status).toBe("violation");
    expect(res.findings.map((f) => f.signal).sort()).toEqual([
      "litellm-header-passthrough-misconfig",
      "litellm-timeout-budget-drift",
    ]);
  });

  it("logs the drift violation so it is visible in the scan output", () => {
    const logs: string[] = [];
    withYaml(
      `
model_list:
  - model_name: gpt-oss-20b
    litellm_params: { model: a, timeout: 45 }
`,
      (m) => logs.push(m),
    );
    expect(logs.some((l) => /VIOLATION.*gpt-oss-20b/.test(l))).toBe(true);
  });
});

/**
 * Custom-callback mount coherence (2026-08-09 outage). These drive the real
 * sensor with fakes only at the fs boundary, and assert the OUTCOME the ledger
 * consumes — the failure here was a composition between config and compose, so
 * a unit test of the guard alone would not have caught it.
 */
describe("scanLitellmConfig — custom callback mount coherence", () => {
  const CONFIG_PATH = "/svc/p/litellm-config.yaml";
  const COMPOSE_PATH = "/svc/p/docker-compose.yml";
  const PACER_CONFIG = `
litellm_settings:
  callbacks: ["custom_pacing.pacer_instance"]
`;

  /** Serve the config at CONFIG_PATH and whatever `compose` is at the sibling
   *  docker-compose.yml. `compose: null` means the file is absent. */
  function scan(config: string, compose: string | null, logs: string[] = []) {
    const res = scanLitellmConfig({
      path: CONFIG_PATH,
      existsFn: (p) => (p === COMPOSE_PATH ? compose !== null : true),
      readFn: (p) => {
        if (p === COMPOSE_PATH) {
          if (compose === null) throw new Error("ENOENT");
          return compose;
        }
        return config;
      },
      log: (m) => logs.push(m),
      nowIso: "2026-08-09T00:00:00.000Z",
    });
    return { res, logs };
  }

  it("derives the compose path as a sibling of the config", () => {
    const seen: string[] = [];
    scanLitellmConfig({
      path: CONFIG_PATH,
      existsFn: (p) => {
        seen.push(p);
        return true;
      },
      readFn: () => PACER_CONFIG,
      nowIso: "2026-08-09T00:00:00.000Z",
    });
    expect(seen).toContain(COMPOSE_PATH);
  });

  it("raises a ledger finding when the declared pacer has no bind mount", () => {
    const { res } = scan(
      PACER_CONFIG,
      `
services:
  litellm:
    volumes:
      - '/svc/p/litellm-config.yaml:/app/config.yaml'
`,
    );
    expect(res.status).toBe("violation");
    const f = res.findings.find((x) => x.signal === "litellm-callback-mount-missing");
    expect(f).toBeDefined();
    expect(f!.agent).toBe(LITELLM_PROXY_PSEUDO_AGENT);
    expect(f!.turn_id).toBe("litellm-callback-mount:custom_pacing");
    expect(f!.log_pointer).toContain(COMPOSE_PATH);
    expect(f!.log_pointer).toContain("docker_compose_raw");
    // and it must be a signal the ledger can actually classify
    expect(mapSignal(f!.signal)).toBeDefined();
  });

  it("passes when the mount is present", () => {
    const { res } = scan(
      PACER_CONFIG,
      `
services:
  litellm:
    volumes:
      - '/svc/p/custom_pacing.py:/app/custom_pacing.py'
`,
    );
    expect(res.findings.some((f) => f.signal === "litellm-callback-mount-missing")).toBe(false);
  });

  it("flags a compose that parses but declares no volumes at all", () => {
    const { res } = scan(
      PACER_CONFIG,
      `
services:
  litellm:
    image: 'ghcr.io/berriai/litellm-database:v1.95.0'
`,
    );
    expect(res.findings.some((f) => f.signal === "litellm-callback-mount-missing")).toBe(true);
  });

  it("SKIPS visibly, never passes, when the compose is absent", () => {
    const { res, logs } = scan(PACER_CONFIG, null);
    expect(res.findings.some((f) => f.signal === "litellm-callback-mount-missing")).toBe(false);
    expect(logs.some((l) => /callback-mount check SKIPPED/.test(l))).toBe(true);
    expect(logs.some((l) => /every custom callback module is/.test(l))).toBe(false);
  });

  it("SKIPS visibly, never claims OK, when the compose is unparseable", () => {
    const { res, logs } = scan(PACER_CONFIG, "\tnot: [valid");
    expect(res.findings.some((f) => f.signal === "litellm-callback-mount-missing")).toBe(false);
    expect(logs.some((l) => /callback-mount check SKIPPED/.test(l))).toBe(true);
    expect(logs.some((l) => /every custom callback module is/.test(l))).toBe(false);
  });
});

describe("scanLitellmConfig — passthrough shadow-mount version coherence", () => {
  const CONFIG_PATH = "/svc/p/litellm-config.yaml";
  const COMPOSE_PATH = "/svc/p/docker-compose.yml";
  const PACER_CONFIG = `
litellm_settings:
  callbacks: ["custom_pacing.pacer_instance"]
`;
  const PASSTHROUGH_TARGET =
    "/app/.venv/lib/python3.13/site-packages/litellm/proxy/pass_through_endpoints/" +
    "llm_provider_handlers/anthropic_passthrough_logging_handler.py";

  /** Compose with both mounts present and correct for a python3.13 image. */
  const COMPOSE_313 = `
services:
  litellm:
    volumes:
      - '/svc/p/custom_pacing.py:/app/custom_pacing.py'
      - '/svc/p/anthropic_passthrough_logging_handler.py:${PASSTHROUGH_TARGET}'
`;

  /** Inject the live image's python version so the suite never touches docker. */
  function scan(compose: string | null, pyVersion: string | null, logs: string[] = []) {
    const res = scanLitellmConfig({
      path: CONFIG_PATH,
      existsFn: (p) => (p === COMPOSE_PATH ? compose !== null : true),
      readFn: (p) => {
        if (p === COMPOSE_PATH) {
          if (compose === null) throw new Error("ENOENT");
          return compose;
        }
        return PACER_CONFIG;
      },
      pythonVersionFn: () => pyVersion,
      log: (m) => logs.push(m),
      nowIso: "2026-08-09T00:00:00.000Z",
    });
    return { res, logs };
  }

  it("raises a ledger finding when a 3.13 shadow mount runs on a 3.14 image", () => {
    // The bug: an image bumped to python 3.14 moves site-packages, the 3.13
    // mount lands at an inert path, and the passthrough patch silently drops.
    const { res } = scan(COMPOSE_313, "3.14");
    expect(res.status).toBe("violation");
    const f = res.findings.find((x) => x.signal === "litellm-passthrough-mount-stale");
    expect(f).toBeDefined();
    expect(f!.agent).toBe(LITELLM_PROXY_PSEUDO_AGENT);
    expect(f!.turn_id).toBe("litellm-passthrough-mount:3.13->3.14");
    expect(f!.log_pointer).toContain(COMPOSE_PATH);
    expect(f!.log_pointer).toContain("docker_compose_raw");
    expect(f!.log_pointer).toContain("SILENTLY dropped");
    // and it must be a signal the ledger can actually classify
    expect(mapSignal(f!.signal)).toBeDefined();
  });

  it("passes when the shadow mount matches the live image's python version", () => {
    const { res } = scan(COMPOSE_313, "3.13");
    expect(res.findings.some((f) => f.signal === "litellm-passthrough-mount-stale")).toBe(false);
  });

  it("SKIPS visibly, never claims OK, when the image python version is unresolvable", () => {
    const { res, logs } = scan(COMPOSE_313, null);
    expect(res.findings.some((f) => f.signal === "litellm-passthrough-mount-stale")).toBe(false);
    expect(logs.some((l) => /passthrough-mount check SKIPPED/.test(l))).toBe(true);
    expect(logs.some((l) => /every versioned site-packages shadow/.test(l))).toBe(false);
  });

  it("does not flag a compose with no versioned shadow mounts", () => {
    const compose = `
services:
  litellm:
    volumes:
      - '/svc/p/custom_pacing.py:/app/custom_pacing.py'
`;
    const { res } = scan(compose, "3.14");
    expect(res.findings.some((f) => f.signal === "litellm-passthrough-mount-stale")).toBe(false);
  });

  it("skips the python-version resolve (no docker, no SKIP/OK log) when there is no versioned mount to check", () => {
    // Gating fix: resolving the live image's python version costs two
    // `docker exec`s, so it must not run — and must not emit a misleading
    // "could not resolve" SKIP — on a compose that has zero versioned mounts.
    const compose = `
services:
  litellm:
    volumes:
      - '/svc/p/custom_pacing.py:/app/custom_pacing.py'
`;
    let pythonVersionCalls = 0;
    const logs: string[] = [];
    const res = scanLitellmConfig({
      path: CONFIG_PATH,
      existsFn: (p) => (p === COMPOSE_PATH ? true : true),
      readFn: (p) => (p === COMPOSE_PATH ? compose : PACER_CONFIG),
      pythonVersionFn: () => {
        pythonVersionCalls += 1;
        return "3.14";
      },
      log: (m) => logs.push(m),
      nowIso: "2026-08-09T00:00:00.000Z",
    });
    expect(pythonVersionCalls).toBe(0);
    expect(res.findings.some((f) => f.signal === "litellm-passthrough-mount-stale")).toBe(false);
    expect(logs.some((l) => /passthrough-mount check SKIPPED/.test(l))).toBe(false);
    expect(logs.some((l) => /every versioned site-packages shadow/.test(l))).toBe(false);
  });
});
