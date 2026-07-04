/**
 * Unit tests for #2781 — `provisionLiteLLMKeys` must degrade a vault-broker
 * that is UNREACHABLE (an environment limitation: hostd's in-container
 * `switchroom apply` has no broker socket mounted, by construction) to a
 * WARNING instead of a per-agent scaffold failure. Pre-fix, every agent got
 * "x litellm/<agent>: vault-broker unreachable — agent will not get routing
 * env." recorded in `failures[]`, apply exited 1 (12/12 "failed"), and
 * hostd's config_propose_edit post-apply reconcile rolled back EVERY edit —
 * so Telegram "Always allow" persists never saved.
 *
 * Genuine provisioning errors (broker reachable, bad admin_key ref / vault
 * write denial) must STAY failures.
 *
 * The broker/provision/yaml modules are lazily imported inside
 * `provisionLiteLLMKeys`, so `vi.mock` intercepts them cleanly here without
 * touching the rest of apply.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { provisionLiteLLMKeys, formatScaffoldFailureResolution } from "./apply.js";
import type { SwitchroomConfig } from "../config/schema.js";
import type { ScaffoldFailure } from "./apply.js";

const getViaBrokerStructured = vi.fn();
const putViaBroker = vi.fn();
vi.mock("../vault/broker/client.js", () => ({
  getViaBrokerStructured: (...a: unknown[]) => getViaBrokerStructured(...a),
  putViaBroker: (...a: unknown[]) => putViaBroker(...a),
}));

const ensureTeam = vi.fn();
const ensureKey = vi.fn();
vi.mock("../litellm/provision.js", () => ({
  ensureTeam: (...a: unknown[]) => ensureTeam(...a),
  ensureKey: (...a: unknown[]) => ensureKey(...a),
}));

function makeConfig(): SwitchroomConfig {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "123:TEST", forum_chat_id: "-1001" },
    litellm: {
      enabled: true,
      base_url: "http://127.0.0.1:4010",
      admin_key: "sk-master-test",
      team: "switchroom",
    },
    agents: {
      clerk: { litellm: { enabled: true } },
    },
  } as unknown as SwitchroomConfig;
}

function makeSinks() {
  const out: string[] = [];
  const errs: string[] = [];
  const failures: ScaffoldFailure[] = [];
  return {
    out,
    errs,
    failures,
    ctx: {
      writeOut: (s: string) => void out.push(s),
      writeErr: (s: string) => void errs.push(s),
      failures,
    },
  };
}

describe("provisionLiteLLMKeys — broker-unreachable degrades to warning (#2781)", () => {
  let prevPass: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    prevPass = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    process.env.SWITCHROOM_VAULT_PASSPHRASE = "test-passphrase";
  });

  afterEach(() => {
    if (prevPass === undefined) delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    else process.env.SWITCHROOM_VAULT_PASSPHRASE = prevPass;
  });

  it("unreachable broker → WARNING, not a scaffold failure (agent keeps prior routing env)", async () => {
    getViaBrokerStructured.mockResolvedValue({
      kind: "unreachable",
      msg: "connect ENOENT /run/switchroom/vault-broker.sock",
    });

    const { ctx, failures, errs } = makeSinks();
    await provisionLiteLLMKeys(makeConfig(), ["clerk"], undefined, ctx);

    // The load-bearing assertion: NO failure recorded → apply exits 0.
    expect(failures).toEqual([]);
    // The operator still sees a loud-but-yellow warning naming the agent.
    const err = errs.join("");
    expect(err).toMatch(/litellm\/clerk: vault-broker unreachable/);
    expect(err).toMatch(/previous routing env/);
    // Nothing was provisioned (we never got past the idempotency probe).
    expect(ensureKey).not.toHaveBeenCalled();
    expect(putViaBroker).not.toHaveBeenCalled();
  });

  it("unreachable broker on the NULL-passphrase probe path → warning, not failure", async () => {
    delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    getViaBrokerStructured.mockResolvedValue({
      kind: "unreachable",
      msg: "no broker socket",
    });

    const { ctx, failures, errs } = makeSinks();
    // `home` points at a dir with no auto-unlock blob → passphrase null.
    await provisionLiteLLMKeys(makeConfig(), ["clerk"], undefined, {
      ...ctx,
      home: "/nonexistent-home-for-test",
    });

    expect(failures).toEqual([]);
    expect(errs.join("")).toMatch(/vault-broker unreachable/);
    expect(errs.join("")).toMatch(/previous routing env/);
  });

  it("null passphrase + broker REACHABLE + key not found → still a failure (fail-open guard)", async () => {
    delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    getViaBrokerStructured.mockResolvedValue({ kind: "not_found" });

    const { ctx, failures } = makeSinks();
    await provisionLiteLLMKeys(makeConfig(), ["clerk"], undefined, {
      ...ctx,
      home: "/nonexistent-home-for-test",
    });

    expect(failures.some((f) => f.agent === "clerk")).toBe(true);
    expect(failures.find((f) => f.agent === "clerk")!.message).toMatch(
      /passphrase/i,
    );
  });

  it("broker reachable, admin_key vault ref unresolvable → genuine failure is KEPT", async () => {
    const config = makeConfig();
    (config as { litellm: { admin_key: string } }).litellm.admin_key =
      "vault:litellm/admin-key";
    // Probe for the agent key: not provisioned. Admin ref resolve: not found.
    getViaBrokerStructured
      .mockResolvedValueOnce({ kind: "not_found" }) // litellm/clerk/api-key
      .mockResolvedValueOnce({ kind: "not_found" }); // litellm/admin-key ref

    const { ctx, failures } = makeSinks();
    await provisionLiteLLMKeys(config, ["clerk"], undefined, ctx);

    expect(failures).toHaveLength(1);
    expect(failures[0].agent).toBe("clerk");
    expect(failures[0].message).toMatch(/admin_key vault ref .* did not resolve/);
  });
});

describe("formatScaffoldFailureResolution — permission epilogue gating (#2781)", () => {
  it("prints the 0700/sudo guidance only for permission (EACCES) failures", () => {
    const out = formatScaffoldFailureResolution(
      [{ agent: "alice", message: "EACCES: permission denied, open '.../start.sh'" }],
      0,
      1,
    );
    expect(out).toMatch(/mode 0700/);
    expect(out).toMatch(/Re-run interactively/);
  });

  it("non-permission failures get a generic pointer, NOT the 0700 misdiagnosis", () => {
    const out = formatScaffoldFailureResolution(
      [
        {
          agent: "clerk",
          message: "litellm: vault-broker unreachable; cannot provision key.",
        },
      ],
      11,
      12,
    );
    expect(out).toMatch(/Scaffolded 11\/12.*1 failed/s);
    expect(out).toMatch(/see the per-agent error lines above/);
    expect(out).not.toMatch(/mode 0700/);
    expect(out).not.toMatch(/privilege/);
    expect(out).not.toMatch(/--compose-only/);
  });
});
