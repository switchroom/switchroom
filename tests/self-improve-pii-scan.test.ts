import { describe, it, expect } from "vitest";
import { scanForPII, summarizeFindings } from "../src/self-improve/pii-scan.js";

describe("scanForPII", () => {
  it("passes clean prose with no findings", () => {
    const r = scanForPII("keep the tone terse and skip the preamble");
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it("flags an email and masks it (never emits the raw address)", () => {
    const raw = "alice.smith@example.com";
    const r = scanForPII(`contact ${raw} please`);
    expect(r.ok).toBe(false);
    const f = r.findings.find((x) => x.kind === "email");
    expect(f).toBeDefined();
    expect(f!.excerpt).not.toContain(raw);
    expect(f!.excerpt).toMatch(/^\w\*\*\*@\*\*\*\.\w+$/);
  });

  it("flags E.164 and separated phone numbers, masked to last 4", () => {
    for (const p of ["+14155552671", "415-555-2671", "(415) 555-2671"]) {
      const r = scanForPII(`call ${p} now`);
      const f = r.findings.find((x) => x.kind === "phone");
      expect(f, p).toBeDefined();
      expect(f!.excerpt).toBe("***2671");
    }
  });

  it("does NOT flag a bare 10-digit run (id / version noise)", () => {
    // No separators / no + prefix — deliberately not treated as a phone.
    const r = scanForPII("build 4155552671 shipped");
    expect(r.findings.some((f) => f.kind === "phone")).toBe(false);
  });

  it("flags a dashed US SSN", () => {
    const r = scanForPII("ssn 123-45-6789 on file");
    const f = r.findings.find((x) => x.kind === "ssn");
    expect(f).toBeDefined();
    expect(f!.excerpt).toBe("***6789");
  });

  it("flags a Luhn-valid card but not a Luhn-invalid candidate", () => {
    const good = scanForPII("card 4111 1111 1111 1111");
    expect(good.findings.some((f) => f.kind === "card")).toBe(true);
    const bad = scanForPII("num 4111 1111 1111 1112"); // fails Luhn
    expect(bad.findings.some((f) => f.kind === "card")).toBe(false);
  });

  it("flags a secret via the shared detector and never emits its bytes", () => {
    const secret = "sk-ant-api03-" + "A".repeat(80);
    const r = scanForPII(`token ${secret}`);
    const f = r.findings.find((x) => x.kind === "secret");
    expect(f).toBeDefined();
    expect(f!.rule).toBeTruthy();
    expect(f!.excerpt).not.toContain(secret);
    expect(f!.excerpt).toMatch(/^\[secret:.+\]$/);
  });

  it("summarizeFindings groups by kind with counts", () => {
    const r = scanForPII("a@b.com and 415-555-2671");
    const s = summarizeFindings(r.findings);
    expect(s).toMatch(/email/);
    expect(s).toMatch(/phone/);
  });
});
