/**
 * `GET /api/status` — that the string fields carry the REAL values.
 *
 * The parity fixture can only assert `typeof === "string"`, which is satisfied
 * by `""` for every field. That floor is what let `null` be the bug and would
 * equally let a blanket empty-string stub through. This file pins the values.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHermesRest } from "./hermes-adapter.js";
import { VERSION, COMMIT_DATE } from "../build-info.js";
import type { SwitchroomConfig } from "../config/schema.js";

const CONFIG = { agents: { alpha: {} } } as unknown as SwitchroomConfig;

let configFile = "";
let previousConfigEnv: string | undefined;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "sr-hermes-status-"));
  process.env.SWITCHROOM_AGENTS_DIR = dir;
  configFile = join(dir, "switchroom.yaml");
  writeFileSync(configFile, "agents:\n  alpha: {}\n");
  previousConfigEnv = process.env.SWITCHROOM_CONFIG;
  process.env.SWITCHROOM_CONFIG = configFile;
});

afterAll(() => {
  if (previousConfigEnv === undefined) delete process.env.SWITCHROOM_CONFIG;
  else process.env.SWITCHROOM_CONFIG = previousConfigEnv;
});

async function status(): Promise<Record<string, unknown>> {
  const res = await handleHermesRest("GET", "/api/status", CONFIG, "");
  expect(res!.status).toBe(200);
  return res!.body as Record<string, unknown>;
}

describe("GET /api/status string fields", () => {
  it("config_path is the switchroom.yaml this process actually resolved", async () => {
    // Not merely a string: the settings pane shows this path to the operator,
    // so a blank or invented one is worse than useless.
    expect((await status()).config_path).toBe(configFile);
  });

  it("config_path falls back to '' rather than throwing when there is no config file", async () => {
    const saved = process.env.SWITCHROOM_CONFIG;
    process.env.SWITCHROOM_CONFIG = join(tmpdir(), "sr-hermes-status-absent", "nope.yaml");
    try {
      const body = await status();
      // findConfigFile still walks cwd and ~/.switchroom, so the assertion that
      // holds on every host is: a string, never null, and the route answers 200.
      expect(typeof body.config_path).toBe("string");
    } finally {
      process.env.SWITCHROOM_CONFIG = saved;
    }
  });

  it("version and release_date come from the build, not from a placeholder", async () => {
    const body = await status();
    expect(body.version).toBe(VERSION);
    expect(body.release_date).toBe(COMMIT_DATE ?? "");
    // The pre-fix values, pinned so a revert is loud.
    expect(body.version).not.toBe("switchroom");
    expect(body.release_date).not.toBeNull();
  });

  it("env_path is an empty string — switchroom has no env file — never null", async () => {
    const body = await status();
    expect(body.env_path).toBe("");
  });

  it("no field StatusResponse declares as a bare string is null", async () => {
    const body = await status();
    for (const field of ["config_path", "env_path", "release_date", "hermes_home", "version"]) {
      expect(body[field], `StatusResponse.${field}`).not.toBeNull();
      expect(typeof body[field]).toBe("string");
    }
  });
});
