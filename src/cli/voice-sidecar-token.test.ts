/**
 * Unit tests for the voice-sidecar token → compose `.env` writer (PR-B2).
 *
 * The vault/broker interaction is injected (resolveOrSeedToken) so this
 * test NEVER touches the real broker or the operator's vault — it only
 * exercises the `.env` write/cleanup + verdict gating.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  composeEnvPath,
  provisionVoiceSidecarToken,
  VOICE_SIDECAR_TOKEN_ENV,
} from "./voice-sidecar-token.js";

let dir: string;
const noop = () => {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "voice-token-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("provisionVoiceSidecarToken", () => {
  it("writes <composeDir>/.env with the token on a local verdict", async () => {
    const composePath = join(dir, "docker-compose.yml");
    await provisionVoiceSidecarToken(composePath, dir, {
      writeOut: noop,
      writeErr: noop,
      voiceEngine: "local",
      resolveOrSeedToken: async () => "abc123token",
    });
    const envPath = composeEnvPath(composePath);
    expect(existsSync(envPath)).toBe(true);
    expect(readFileSync(envPath, "utf-8")).toBe(`${VOICE_SIDECAR_TOKEN_ENV}=abc123token\n`);
    // 0600 — the token is a secret.
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("does NOT write a .env on a cloud verdict", async () => {
    const composePath = join(dir, "docker-compose.yml");
    await provisionVoiceSidecarToken(composePath, dir, {
      writeOut: noop,
      writeErr: noop,
      voiceEngine: "cloud",
      resolveOrSeedToken: async () => "should-not-be-used",
    });
    expect(existsSync(composeEnvPath(composePath))).toBe(false);
  });

  it("removes a stale token .env when the verdict flips to cloud", async () => {
    const composePath = join(dir, "docker-compose.yml");
    const envPath = composeEnvPath(composePath);
    writeFileSync(envPath, `${VOICE_SIDECAR_TOKEN_ENV}=old\n`);
    await provisionVoiceSidecarToken(composePath, dir, {
      writeOut: noop,
      writeErr: noop,
      voiceEngine: "cloud",
    });
    expect(existsSync(envPath)).toBe(false);
  });

  it("leaves an operator-managed .env (no token var) untouched on cloud", async () => {
    const composePath = join(dir, "docker-compose.yml");
    const envPath = composeEnvPath(composePath);
    writeFileSync(envPath, "OPERATOR_THING=1\n");
    await provisionVoiceSidecarToken(composePath, dir, {
      writeOut: noop,
      writeErr: noop,
      voiceEngine: "cloud",
    });
    expect(existsSync(envPath)).toBe(true);
    expect(readFileSync(envPath, "utf-8")).toBe("OPERATOR_THING=1\n");
  });

  it("upserts only the token key, preserving operator-placed lines", async () => {
    const composePath = join(dir, "docker-compose.yml");
    const envPath = composeEnvPath(composePath);
    // Operator-managed .env with an unrelated key and a stale token value.
    writeFileSync(envPath, `OPERATOR_THING=1\n${VOICE_SIDECAR_TOKEN_ENV}=stale\nKEEP=2\n`);
    await provisionVoiceSidecarToken(composePath, dir, {
      writeOut: noop,
      writeErr: noop,
      voiceEngine: "local",
      resolveOrSeedToken: async () => "freshtoken",
    });
    const body = readFileSync(envPath, "utf-8");
    // Token line replaced in place; the operator's other lines survive.
    expect(body).toContain(`${VOICE_SIDECAR_TOKEN_ENV}=freshtoken`);
    expect(body).not.toContain("stale");
    expect(body).toContain("OPERATOR_THING=1");
    expect(body).toContain("KEEP=2");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("appends the token key when the .env exists without it", async () => {
    const composePath = join(dir, "docker-compose.yml");
    const envPath = composeEnvPath(composePath);
    writeFileSync(envPath, "OPERATOR_THING=1\n");
    await provisionVoiceSidecarToken(composePath, dir, {
      writeOut: noop,
      writeErr: noop,
      voiceEngine: "local",
      resolveOrSeedToken: async () => "freshtoken",
    });
    expect(readFileSync(envPath, "utf-8")).toBe(
      `OPERATOR_THING=1\n${VOICE_SIDECAR_TOKEN_ENV}=freshtoken\n`,
    );
  });

  it("does not write (and does not throw) when the token can't be resolved", async () => {
    const composePath = join(dir, "docker-compose.yml");
    let warned = false;
    await provisionVoiceSidecarToken(composePath, dir, {
      writeOut: noop,
      writeErr: () => {
        warned = true;
      },
      voiceEngine: "local",
      resolveOrSeedToken: async () => null,
    });
    expect(existsSync(composeEnvPath(composePath))).toBe(false);
    // resolveOrSeedToken itself owns the warning; here it returned null
    // silently, so we just assert no .env and no throw.
    expect(warned).toBe(false);
  });
});
