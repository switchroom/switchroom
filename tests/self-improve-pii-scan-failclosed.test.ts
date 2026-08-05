import { describe, it, expect, vi } from "vitest";

// #4411 — the fail-closed-on-scan-error contract: when the underlying secret
// engine THROWS, `scanForPII` must NOT wave the content through. It reports the
// failure as a synthetic `scan-error` finding and returns `ok: false`, so the
// fail-closed caller (add/apply-eval-case, evalsBaselineTrusted) rejects rather
// than silently allowing un-scanned bytes.
//
// The mock is hoisted for the whole file, so this lives in its own module to
// avoid poisoning the happy-path scan tests in self-improve-pii-scan.test.ts.
vi.mock("../telegram-plugin/secret-detect/index.js", () => ({
  detectSecrets: () => {
    throw new Error("boom: secret engine exploded");
  },
}));

import { scanForPII } from "../src/self-improve/pii-scan.js";

describe("scanForPII fail-closed on scan error", () => {
  it("a throwing secret engine yields ok:false with a scan-error finding (never a silent allow)", () => {
    const r = scanForPII("this text would otherwise be clean prose");
    // Fail-closed: uncertainty (an engine error) blocks, it does not pass.
    expect(r.ok).toBe(false);
    const err = r.findings.find((f) => f.kind === "scan-error");
    expect(err).toBeDefined();
    // The excerpt is masked/bounded, never raw content.
    expect(err!.excerpt).toMatch(/scan failed/i);
  });

  it("even empty-string input does not short-circuit past a broken engine into allow", () => {
    // Empty input is the ONLY legitimate ok:true short-circuit; a non-empty
    // string with a broken engine must block.
    const r = scanForPII("contains something");
    expect(r.ok).toBe(false);
  });
});
