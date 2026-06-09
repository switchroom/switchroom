import { describe, expect, it } from "vitest";
import {
  checkEgressUrl,
  checkHttpDiffEgress,
  checkSecretBinding,
  isBlockedAddress,
  normalizeHost,
  type EgressAllowlist,
} from "./poll-egress.js";

const ALLOW: EgressAllowlist = {
  hosts: ["api.brevo.com", "API.Example.com"],
  secretBindings: { brevo_api_key: "api.brevo.com", other_key: "api.example.com" },
};

describe("isBlockedAddress — SSRF ranges fail closed", () => {
  it.each([
    "127.0.0.1", "127.5.5.5", "0.0.0.0", "10.0.0.5", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "allows public %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it("non-IP hostnames are not judged here (allowlist decides)", () => {
    expect(isBlockedAddress("api.brevo.com")).toBe(false);
  });
});

describe("checkEgressUrl — scheme + allowlist + IP-literal", () => {
  it("allows an allowlisted https host (case-insensitive)", () => {
    expect(checkEgressUrl("https://api.brevo.com/v3/x", ALLOW).ok).toBe(true);
    expect(checkEgressUrl("https://api.example.com/y", ALLOW).ok).toBe(true);
  });

  it("rejects non-https", () => {
    expect(checkEgressUrl("http://api.brevo.com/x", ALLOW)).toMatchObject({ ok: false });
    expect(checkEgressUrl("file:///etc/passwd", ALLOW)).toMatchObject({ ok: false });
    expect(checkEgressUrl("unix:///run/switchroom/broker/sock", ALLOW)).toMatchObject({ ok: false });
  });

  it("rejects a host not on the allowlist (SSRF to internal name)", () => {
    expect(checkEgressUrl("https://127.0.0.1/gateway", ALLOW)).toMatchObject({ ok: false });
    expect(checkEgressUrl("https://localhost/broker", ALLOW)).toMatchObject({ ok: false });
    expect(checkEgressUrl("https://attacker.com/exfil", ALLOW)).toMatchObject({ ok: false });
    expect(checkEgressUrl("https://hostd.internal/", ALLOW)).toMatchObject({ ok: false });
  });

  it("rejects a blocked IP literal even if its string were allowlisted", () => {
    const a: EgressAllowlist = { hosts: ["127.0.0.1"], secretBindings: {} };
    expect(checkEgressUrl("https://127.0.0.1/x", a)).toMatchObject({ ok: false });
  });

  it("rejects userinfo (credential-smuggling host confusion)", () => {
    expect(checkEgressUrl("https://api.brevo.com@attacker.com/", ALLOW)).toMatchObject({ ok: false });
  });
});

describe("checkSecretBinding — a secret may only go to its bound host", () => {
  it("allows the bound host", () => {
    expect(checkSecretBinding("brevo_api_key", "api.brevo.com", ALLOW).ok).toBe(true);
  });
  it("refuses an unbound secret", () => {
    expect(checkSecretBinding("unbound", "api.brevo.com", ALLOW)).toMatchObject({ ok: false });
  });
  it("refuses a secret sent to the WRONG (even if allowlisted) host — the exfil case", () => {
    expect(checkSecretBinding("brevo_api_key", "api.example.com", ALLOW)).toMatchObject({ ok: false });
  });
});

describe("checkHttpDiffEgress — full pre-fetch gate", () => {
  it("passes a correct (url, secret) pair", () => {
    expect(checkHttpDiffEgress("https://api.brevo.com/v3/x", ["brevo_api_key"], ALLOW).ok).toBe(true);
  });
  it("blocks exfil: an approved Brevo poll trying to carry brevo_api_key to example.com", () => {
    expect(
      checkHttpDiffEgress("https://api.example.com/collect", ["brevo_api_key"], ALLOW),
    ).toMatchObject({ ok: false });
  });
  it("blocks SSRF: a secretless poll to a non-allowlisted host", () => {
    expect(checkHttpDiffEgress("https://169.254.169.254/latest/meta-data", [], ALLOW)).toMatchObject({
      ok: false,
    });
  });
});

describe("normalizeHost", () => {
  it("lowercases, strips trailing dot + brackets", () => {
    expect(normalizeHost("API.Brevo.com.")).toBe("api.brevo.com");
    expect(normalizeHost("[::1]")).toBe("::1");
  });
});
