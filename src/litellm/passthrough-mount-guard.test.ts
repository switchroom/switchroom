import { describe, it, expect } from "vitest";

import {
  detectStalePassthroughMounts,
  extractVersionedSitePackagesMounts,
} from "./passthrough-mount-guard.js";

/** The passthrough patch mount as it exists today: a shadow of the real file
 *  inside the interpreter's site-packages, hard-coding `python3.13`. */
const PASSTHROUGH_TARGET =
  "/app/.venv/lib/python3.13/site-packages/litellm/proxy/pass_through_endpoints/" +
  "llm_provider_handlers/anthropic_passthrough_logging_handler.py";

/** Coolify's `docker_compose_raw` long object form — the shape the mount is
 *  actually declared in, and therefore the shape the guard has to read. */
const COMPOSE_WITH_313_PATCH = `
services:
  litellm:
    image: 'ghcr.io/berriai/litellm-database:v1.95.0'
    volumes:
      -
        type: bind
        source: ./custom_pacing.py
        target: /app/custom_pacing.py
      -
        type: bind
        source: ./anthropic_passthrough_logging_handler.py
        target: ${PASSTHROUGH_TARGET}
`;

/** The same patch mount in Coolify's generated short-string form. */
const COMPOSE_SHORT_FORM = `
services:
  litellm:
    volumes:
      - '/data/coolify/services/svc/anthropic_passthrough_logging_handler.py:${PASSTHROUGH_TARGET}'
`;

describe("extractVersionedSitePackagesMounts", () => {
  it("pulls the versioned shadow mount and its hard-coded python version", () => {
    const mounts = extractVersionedSitePackagesMounts(COMPOSE_WITH_313_PATCH);
    expect(mounts).toEqual([
      { target: PASSTHROUGH_TARGET, declaredPythonVersion: "3.13" },
    ]);
  });

  it("reads the short string form too", () => {
    const mounts = extractVersionedSitePackagesMounts(COMPOSE_SHORT_FORM);
    expect(mounts).toEqual([
      { target: PASSTHROUGH_TARGET, declaredPythonVersion: "3.13" },
    ]);
  });

  it("ignores the bare-module callback mount, which carries no version", () => {
    const mounts = extractVersionedSitePackagesMounts(`
services:
  litellm:
    volumes:
      - '/host/custom_pacing.py:/app/custom_pacing.py'
`);
    expect(mounts).toEqual([]);
  });

  it("ignores an UNversioned site-packages path (no pythonX.Y to validate)", () => {
    const mounts = extractVersionedSitePackagesMounts(`
services:
  litellm:
    volumes:
      - '/host/patch.py:/usr/local/lib/site-packages/litellm/patch.py'
`);
    expect(mounts).toEqual([]);
  });

  it("returns null on 'cannot tell' (no services mapping), never an empty pass", () => {
    expect(extractVersionedSitePackagesMounts("model_list: []")).toBeNull();
    expect(extractVersionedSitePackagesMounts("\tnot: [valid")).toBeNull();
  });
});

describe("detectStalePassthroughMounts", () => {
  it("ALARMS: a python3.13 shadow mount on an image that actually ships 3.14", () => {
    // This is the exact bug the guard exists to catch — a minor-version image
    // bump moves site-packages to python3.14/ while the mount still targets
    // python3.13/, so the patch lands at an inert path and silently drops.
    const violations = detectStalePassthroughMounts(COMPOSE_WITH_313_PATCH, "3.14");
    expect(violations).toHaveLength(1);
    expect(violations[0].target).toBe(PASSTHROUGH_TARGET);
    expect(violations[0].declaredPythonVersion).toBe("3.13");
    expect(violations[0].actualPythonVersion).toBe("3.14");
    // The finding must point at the real fix site, not the generated file, and
    // name the silent-drop nature so the operator understands the stakes.
    expect(violations[0].detail).toContain("docker_compose_raw");
    expect(violations[0].detail).toContain("SILENTLY dropped");
    expect(violations[0].detail).toContain("python3.14/");
  });

  it("passes when the mount's version matches the live image", () => {
    expect(detectStalePassthroughMounts(COMPOSE_WITH_313_PATCH, "3.13")).toEqual([]);
  });

  it("alarms on the short-string form too", () => {
    const violations = detectStalePassthroughMounts(COMPOSE_SHORT_FORM, "3.14");
    expect(violations).toHaveLength(1);
    expect(violations[0].declaredPythonVersion).toBe("3.13");
  });

  it("stays quiet when the image's actual python version cannot be resolved", () => {
    // No fabricated violation: a stale shadow mount is a silent-drop hazard, so
    // guessing the image version would defeat the point.
    expect(detectStalePassthroughMounts(COMPOSE_WITH_313_PATCH, null)).toEqual([]);
  });

  it("stays quiet when the compose is unavailable or unreadable", () => {
    expect(detectStalePassthroughMounts(null, "3.14")).toEqual([]);
    expect(detectStalePassthroughMounts("\tnot: [valid", "3.14")).toEqual([]);
    expect(detectStalePassthroughMounts("model_list: []", "3.14")).toEqual([]);
  });

  it("does not flag a config whose only mounts are unversioned", () => {
    const compose = `
services:
  litellm:
    volumes:
      - '/host/custom_pacing.py:/app/custom_pacing.py'
`;
    expect(detectStalePassthroughMounts(compose, "3.14")).toEqual([]);
  });
});
