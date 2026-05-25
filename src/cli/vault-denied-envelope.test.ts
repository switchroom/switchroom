/**
 * #1770 Phase 3 — VAULT-BROKER-DENIED structured envelope.
 *
 * Parallels the Phase 2 envelope-shape tests in tests/host-control/.
 * The helper writes a single NDJSON line to stderr prefixed with
 * `VAULT-BROKER-DENIED-ENVELOPE: ` so structured consumers can grep-
 * and-slice while string-matching decoders still see the legacy
 * `VAULT-BROKER-DENIED [<code>]: <msg>` line emitted just before it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeVaultDeniedEnvelope } from "./vault-denied-envelope.js";
import { ErrorEnvelopeSchema } from "../host-control/protocol.js";

let writes: string[];
let originalWrite: typeof process.stderr.write;

beforeEach(() => {
  writes = [];
  originalWrite = process.stderr.write.bind(process.stderr);
  // Replace stderr.write with a capture stub. Avoids vi.spyOn's strict
  // overload-signature typing which fights node's polymorphic `write`.
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array): boolean => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  };
});

afterEach(() => {
  (process.stderr as { write: unknown }).write = originalWrite;
});

describe("writeVaultDeniedEnvelope — envelope shape", () => {
  it("emits a single VAULT-BROKER-DENIED-ENVELOPE: line on stderr", () => {
    writeVaultDeniedEnvelope("fatsecret/client_id", "DENIED", "not in ACL");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^VAULT-BROKER-DENIED-ENVELOPE: /);
    expect(writes[0].endsWith("\n")).toBe(true);
  });

  it("envelope parses cleanly against ErrorEnvelopeSchema", () => {
    writeVaultDeniedEnvelope("github/token", "DENIED", "unit not in ACL");
    const jsonPart = writes[0].replace(/^VAULT-BROKER-DENIED-ENVELOPE: /, "").trimEnd();
    const parsed = JSON.parse(jsonPart);
    const res = ErrorEnvelopeSchema.safeParse(parsed);
    expect(res.success).toBe(true);
  });

  it("fix.kind is request_vault_grant with vault_key populated", () => {
    writeVaultDeniedEnvelope("coolify/api-token", "DENIED", "no grant");
    const jsonPart = writes[0].replace(/^VAULT-BROKER-DENIED-ENVELOPE: /, "").trimEnd();
    const parsed = JSON.parse(jsonPart);
    expect(parsed.v).toBe(1);
    expect(parsed.code).toBe("VAULT-BROKER-DENIED");
    expect(parsed.fix).toEqual({
      kind: "request_vault_grant",
      vault_key: "coolify/api-token",
    });
    expect(parsed.human).toContain("DENIED");
    expect(parsed.human).toContain("no grant");
    expect(typeof parsed.request_id).toBe("string");
    expect(parsed.request_id.length).toBeGreaterThan(0);
  });
});
