import { describe, it, expect } from "vitest";

import { parseLitellmConfig } from "./header-passthrough-guard.js";
import {
  canReadComposeMounts,
  detectMissingCallbackMounts,
  extractComposeBindTargets,
  extractCustomCallbackModules,
} from "./callback-mount-guard.js";

const PACER_CONFIG = `
litellm_settings:
  callbacks: ["custom_pacing.pacer_instance"]
`;

/** The compose Coolify generated on 2026-08-09: correct image, pacer mount
 *  gone. This is the exact shape that crash-looped the proxy. */
const COMPOSE_WITHOUT_PACER = `
services:
  litellm:
    image: 'ghcr.io/berriai/litellm-database:v1.95.0'
    volumes:
      - '/data/coolify/services/svc/litellm-config.yaml:/app/config.yaml'
  redis:
    image: 'redis:7-alpine'
`;

const COMPOSE_WITH_PACER = `
services:
  litellm:
    image: 'ghcr.io/berriai/litellm-database:v1.95.0'
    volumes:
      - '/data/coolify/services/svc/litellm-config.yaml:/app/config.yaml'
      - '/data/coolify/services/svc/custom_pacing.py:/app/custom_pacing.py'
`;

/** Coolify's `docker_compose_raw` source form — the file the mount must
 *  actually be restored in, and therefore a shape the guard has to read. */
const COMPOSE_LONG_FORM = `
services:
  litellm:
    volumes:
      -
        type: bind
        source: ./litellm-config.yaml
        target: /app/config.yaml
      -
        type: bind
        source: ./custom_pacing.py
        target: /app/custom_pacing.py
`;

describe("extractCustomCallbackModules", () => {
  it("picks up a `<module>.<attr>` custom callback", () => {
    const mods = extractCustomCallbackModules(parseLitellmConfig(PACER_CONFIG));
    expect(mods).toEqual([{ module: "custom_pacing", reference: "custom_pacing.pacer_instance" }]);
  });

  it("ignores built-in bare-token callbacks, which need no mount", () => {
    const parsed = parseLitellmConfig(`
litellm_settings:
  callbacks: ["prometheus", "datadog"]
`);
    expect(extractCustomCallbackModules(parsed)).toEqual([]);
  });

  it("reads success_callback and failure_callback too, and de-duplicates", () => {
    const parsed = parseLitellmConfig(`
litellm_settings:
  success_callback: ["custom_pacing.pacer_instance"]
  failure_callback: ["custom_pacing.pacer_instance"]
`);
    expect(extractCustomCallbackModules(parsed)).toHaveLength(1);
  });

  it("skips dotted package paths, which a single-file mount cannot satisfy", () => {
    const parsed = parseLitellmConfig(`
litellm_settings:
  callbacks: ["pkg.mod.instance"]
`);
    expect(extractCustomCallbackModules(parsed)).toEqual([]);
  });

  it("returns nothing for a config with no litellm_settings", () => {
    expect(extractCustomCallbackModules(parseLitellmConfig("model_list: []"))).toEqual([]);
    expect(extractCustomCallbackModules(null)).toEqual([]);
  });
});

describe("extractComposeBindTargets", () => {
  it("reads the short string form Coolify generates", () => {
    expect(extractComposeBindTargets(COMPOSE_WITH_PACER)).toContain("/app/custom_pacing.py");
  });

  it("reads the long object form docker_compose_raw uses", () => {
    expect(extractComposeBindTargets(COMPOSE_LONG_FORM)).toContain("/app/custom_pacing.py");
  });

  it("handles a read-only suffix", () => {
    const targets = extractComposeBindTargets(`
services:
  litellm:
    volumes:
      - '/host/custom_pacing.py:/app/custom_pacing.py:ro'
`);
    expect(targets).toContain("/app/custom_pacing.py");
  });

  it("returns null on unparseable YAML rather than throwing", () => {
    expect(extractComposeBindTargets("\tnot: [valid")).toBeNull();
  });

  it("returns null when there is no services mapping — 'cannot tell', not 'no mounts'", () => {
    expect(extractComposeBindTargets("model_list: []")).toBeNull();
  });

  it("returns an EMPTY set when services parse but declare no volumes", () => {
    const targets = extractComposeBindTargets(`
services:
  litellm:
    image: 'ghcr.io/berriai/litellm-database:v1.95.0'
`);
    expect(targets).not.toBeNull();
    expect(targets?.size).toBe(0);
  });
});

describe("canReadComposeMounts", () => {
  it("is false for absent or unreadable compose, true for a parseable one", () => {
    expect(canReadComposeMounts(null)).toBe(false);
    expect(canReadComposeMounts("\tnot: [valid")).toBe(false);
    expect(canReadComposeMounts("model_list: []")).toBe(false);
    expect(canReadComposeMounts(COMPOSE_WITHOUT_PACER)).toBe(true);
  });
});

describe("detectMissingCallbackMounts", () => {
  it("flags the 2026-08-09 outage: pacer declared, mount dropped", () => {
    const violations = detectMissingCallbackMounts(
      parseLitellmConfig(PACER_CONFIG),
      COMPOSE_WITHOUT_PACER,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].module).toBe("custom_pacing");
    expect(violations[0].expectedTarget).toBe("/app/custom_pacing.py");
    // The finding must point at the real fix site, not the generated file.
    expect(violations[0].detail).toContain("docker_compose_raw");
    expect(violations[0].detail).toContain("ModuleNotFoundError");
  });

  it("passes once the mount is restored", () => {
    expect(
      detectMissingCallbackMounts(parseLitellmConfig(PACER_CONFIG), COMPOSE_WITH_PACER),
    ).toEqual([]);
  });

  it("passes for a config that uses only built-in callbacks", () => {
    const parsed = parseLitellmConfig(`
litellm_settings:
  callbacks: ["prometheus"]
`);
    expect(detectMissingCallbackMounts(parsed, COMPOSE_WITHOUT_PACER)).toEqual([]);
  });

  it("stays quiet when the compose is unavailable — never a fabricated violation", () => {
    expect(detectMissingCallbackMounts(parseLitellmConfig(PACER_CONFIG), null)).toEqual([]);
    expect(detectMissingCallbackMounts(parseLitellmConfig(PACER_CONFIG), "\tnot: [valid")).toEqual(
      [],
    );
    expect(detectMissingCallbackMounts(parseLitellmConfig(PACER_CONFIG), "model_list: []")).toEqual(
      [],
    );
  });

  it("FLAGS a compose that parses but declares no volumes at all", () => {
    // The worst case of the 2026-08-09 regression: Coolify drops the whole
    // hand-added `volumes:` block, not one line. An earlier revision treated
    // "no mounts found" as "cannot tell" and stayed silent here.
    const violations = detectMissingCallbackMounts(
      parseLitellmConfig(PACER_CONFIG),
      `
services:
  litellm:
    image: 'ghcr.io/berriai/litellm-database:v1.95.0'
`,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].module).toBe("custom_pacing");
  });
});
