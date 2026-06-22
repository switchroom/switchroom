import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OVERAGE_EXHAUSTED_REASONS } from "./account-eligibility.js";

/**
 * DRIFT GUARD for the duplicated `OVERAGE_EXHAUSTED_REASONS` allowlist.
 *
 * The informational allowlist of `overageDisabledReason` values that indicate
 * "no overage headroom" (NOT serve-blocking) is declared in TWO places because
 * the telegram-plugin can't import across the broker package boundary cleanly:
 *   - src/auth/broker/account-eligibility.ts      (broker, the source of truth)
 *   - telegram-plugin/auth-snapshot-format.ts     (plugin, a verbatim replica)
 *
 * These reasons are informational only — they MUST NOT gate serving or failover.
 *
 * This test FAILS if a future author edits one literal without the other
 * (adding/removing a reason in just one copy), so the divergence is caught in
 * `npm run lint`/vitest rather than in production failover.
 */

const here = dirname(fileURLToPath(import.meta.url));
const brokerSrc = resolve(here, "account-eligibility.ts");
const pluginSrc = resolve(here, "../../../telegram-plugin/auth-snapshot-format.ts");

/**
 * Extract the string members of the FIRST
 * `OVERAGE_EXHAUSTED_REASONS = new Set([...])` literal in a source file.
 * Order-insensitive: returns a Set so comparison ignores ordering/whitespace.
 */
function extractAllowlistLiteral(filePath: string): Set<string> {
  const text = readFileSync(filePath, "utf8");
  const m = text.match(
    /OVERAGE_EXHAUSTED_REASONS\s*=\s*new Set<[^>]*>\(\s*\[([^\]]*)\]/,
  );
  if (!m) {
    throw new Error(
      `Could not find a OVERAGE_EXHAUSTED_REASONS = new Set([...]) literal in ${filePath}`,
    );
  }
  const inner = m[1];
  const members = [...inner.matchAll(/['"]([^'"]+)['"]/g)].map((g) => g[1]);
  return new Set(members);
}

describe("OVERAGE_EXHAUSTED_REASONS cross-package drift guard", () => {
  it("broker and telegram-plugin source literals are identical sets", () => {
    const brokerLiteral = extractAllowlistLiteral(brokerSrc);
    const pluginLiteral = extractAllowlistLiteral(pluginSrc);
    // Deep set-equality: a reason added to one copy but not the other fails here.
    expect(pluginLiteral).toEqual(brokerLiteral);
  });

  it("the broker's runtime Set matches its own source literal (sanity)", () => {
    expect(extractAllowlistLiteral(brokerSrc)).toEqual(
      OVERAGE_EXHAUSTED_REASONS,
    );
  });

  it("both copies are exactly {out_of_credits} today", () => {
    const expected = new Set(["out_of_credits"]);
    expect(extractAllowlistLiteral(brokerSrc)).toEqual(expected);
    expect(extractAllowlistLiteral(pluginSrc)).toEqual(expected);
    expect(OVERAGE_EXHAUSTED_REASONS).toEqual(expected);
  });
});
