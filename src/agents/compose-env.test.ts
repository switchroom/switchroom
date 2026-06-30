/**
 * Unit tests for composeEnvFileArgs — the #2700 fix that makes fleet
 * `docker compose` commands load the compose-adjacent `.env` (holding
 * VOICE_SIDECAR_TOKEN) via an explicit `--env-file`, which compose does
 * NOT do automatically for a `-f`-specified file outside the CWD.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { composeEnvFileArgs, composeEnvPath } from "./compose-env.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compose-env-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("composeEnvFileArgs", () => {
  it("returns --env-file pointing at the compose-adjacent .env when present", () => {
    const composePath = join(dir, "docker-compose.yml");
    const envPath = composeEnvPath(composePath);
    writeFileSync(envPath, "VOICE_SIDECAR_TOKEN=abc\n");
    expect(composeEnvFileArgs(composePath)).toEqual(["--env-file", envPath]);
  });

  it("returns [] when the .env is absent (cloud host, no sidecar)", () => {
    const composePath = join(dir, "docker-compose.yml");
    expect(composeEnvFileArgs(composePath)).toEqual([]);
  });

  it("derives the .env beside the compose file, not the CWD", () => {
    const composePath = join(dir, "compose", "docker-compose.yml");
    expect(composeEnvPath(composePath)).toBe(join(dir, "compose", ".env"));
  });
});
