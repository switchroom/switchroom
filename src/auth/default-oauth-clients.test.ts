/**
 * Shipped default OAuth client resolution (out-of-box connect).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MICROSOFT_CLIENT_ID,
  resolveMicrosoftClientId,
} from "./default-oauth-clients.js";

const ENV_KEY = "SWITCHROOM_MICROSOFT_CLIENT_ID";

describe("resolveMicrosoftClientId — precedence env → config → default", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it("falls back to the shipped default when neither env nor config is set", () => {
    const r = resolveMicrosoftClientId(undefined);
    expect(r.clientId).toBe(DEFAULT_MICROSOFT_CLIENT_ID);
    expect(r.source).toBe("default");
  });

  it("treats an empty-string config value as unset → default", () => {
    const r = resolveMicrosoftClientId("");
    expect(r.clientId).toBe(DEFAULT_MICROSOFT_CLIENT_ID);
    expect(r.source).toBe("default");
  });

  it("uses the operator config value (BYO app) when present", () => {
    const r = resolveMicrosoftClientId("byo-client-id-1234");
    expect(r.clientId).toBe("byo-client-id-1234");
    expect(r.source).toBe("config");
  });

  it("passes a vault: config reference through verbatim (caller resolves it)", () => {
    const r = resolveMicrosoftClientId("vault:microsoft-oauth-client-id");
    expect(r.clientId).toBe("vault:microsoft-oauth-client-id");
    expect(r.source).toBe("config");
  });

  it("env override wins over config", () => {
    process.env[ENV_KEY] = "env-client-id-9999";
    const r = resolveMicrosoftClientId("byo-client-id-1234");
    expect(r.clientId).toBe("env-client-id-9999");
    expect(r.source).toBe("env");
  });

  it("env override wins over the default (no config)", () => {
    process.env[ENV_KEY] = "env-client-id-9999";
    const r = resolveMicrosoftClientId(undefined);
    expect(r.clientId).toBe("env-client-id-9999");
    expect(r.source).toBe("env");
  });

  it("trims surrounding whitespace on the env value; blank env is ignored", () => {
    process.env[ENV_KEY] = "  spaced-id  ";
    expect(resolveMicrosoftClientId(undefined).clientId).toBe("spaced-id");
    process.env[ENV_KEY] = "   ";
    const blank = resolveMicrosoftClientId(undefined);
    expect(blank.source).toBe("default");
  });

  it("the shipped default is a plausible Entra GUID (public client id)", () => {
    expect(DEFAULT_MICROSOFT_CLIENT_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
