import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SwitchroomConfig } from "../config/schema.js";
import { resolveWebhookSecretFromVault } from "./server.js";

/**
 * `resolveWebhookSecretFromVault` is the receiver-side resolver that fixes
 * the "no secret in vault" 401 for CLI-enabled webhooks (the secret lives in
 * the vault under webhook/<agent>/<source>, but the route used to read only
 * webhook-secrets.json). These pin the fail-closed contract: a missing /
 * unreachable broker must yield null (→ the route returns 401), never throw
 * (which would 500 the webhook endpoint). The happy path + the operator-read
 * requirement are proven by the broker scope tests (src/vault/broker/
 * scope.test.ts) and live e2e on deploy.
 */
describe("resolveWebhookSecretFromVault — fail-closed", () => {
  function configWithBrokerSocket(socket: string): SwitchroomConfig {
    return {
      vault: { broker: { enabled: true, socket } },
    } as unknown as SwitchroomConfig;
  }

  it("returns null (does not throw) when the broker socket does not exist", async () => {
    const dead = join(tmpdir(), `switchroom-no-such-broker-${process.pid}.sock`);
    const result = await resolveWebhookSecretFromVault(
      "clerk",
      "linear",
      configWithBrokerSocket(dead),
    );
    expect(result).toBeNull();
  });

  it("returns null for an unknown source against a dead broker", async () => {
    // NB: deliberately an explicit dead socket — NOT an unconfigured broker.
    // With no socket configured, resolveBrokerSocketPath defaults to the
    // host operator socket, which on a live switchroom host would connect to
    // the real broker (test-isolation hazard per CLAUDE.md). Always pin a
    // throwaway path here.
    const dead = join(tmpdir(), `switchroom-no-such-broker-2-${process.pid}.sock`);
    const result = await resolveWebhookSecretFromVault(
      "clerk",
      "nonexistent-source",
      configWithBrokerSocket(dead),
    );
    expect(result).toBeNull();
  });
});
