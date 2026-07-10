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
const validateKey = vi.fn();
vi.mock("../litellm/provision.js", () => ({
  ensureTeam: (...a: unknown[]) => ensureTeam(...a),
  ensureKey: (...a: unknown[]) => ensureKey(...a),
  validateKey: (...a: unknown[]) => validateKey(...a),
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

describe("provisionLiteLLMKeys — stored-key validation against the proxy (DB drift)", () => {
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

  it("stored key VALID on the proxy → skip, no re-provision", async () => {
    getViaBrokerStructured.mockResolvedValue({
      kind: "ok",
      entry: { kind: "string", value: "sk-stored" },
    });
    validateKey.mockResolvedValue({ kind: "valid" });

    const { ctx, failures, out } = makeSinks();
    await provisionLiteLLMKeys(makeConfig(), ["clerk"], undefined, ctx);

    expect(failures).toEqual([]);
    expect(ensureKey).not.toHaveBeenCalled();
    expect(putViaBroker).not.toHaveBeenCalled();
    expect(out.join("")).toMatch(/already provisioned \+ validated/);
  });

  it("stored key UNKNOWN on the proxy (DB drift) → re-provision + rewrite vault", async () => {
    getViaBrokerStructured.mockResolvedValue({
      kind: "ok",
      entry: { kind: "string", value: "sk-stale" },
    });
    validateKey.mockResolvedValue({ kind: "unknown" });
    ensureKey.mockResolvedValue({ key: "sk-fresh" });
    putViaBroker.mockResolvedValue({ kind: "ok" });

    const { ctx, failures, errs } = makeSinks();
    await provisionLiteLLMKeys(makeConfig(), ["clerk"], undefined, ctx);

    expect(failures).toEqual([]);
    expect(ensureKey).toHaveBeenCalledTimes(1);
    // The fresh key was written back to the vault.
    expect(putViaBroker).toHaveBeenCalledWith(
      "litellm/clerk/api-key",
      { kind: "string", value: "sk-fresh" },
      expect.objectContaining({ passphrase: "test-passphrase" }),
    );
    expect(errs.join("")).toMatch(/not recognized by the proxy \(DB drift\)/);
  });

  it("proxy UNREACHABLE during validation → keep stored key, warn, never fail (#2781)", async () => {
    getViaBrokerStructured.mockResolvedValue({
      kind: "ok",
      entry: { kind: "string", value: "sk-stored" },
    });
    validateKey.mockResolvedValue({ kind: "unreachable", detail: "ECONNREFUSED" });

    const { ctx, failures, errs } = makeSinks();
    await provisionLiteLLMKeys(makeConfig(), ["clerk"], undefined, ctx);

    expect(failures).toEqual([]);
    expect(ensureKey).not.toHaveBeenCalled();
    expect(putViaBroker).not.toHaveBeenCalled();
    expect(errs.join("")).toMatch(/proxy unreachable during key validation/);
    expect(errs.join("")).toMatch(/keeping the stored key unverified/);
  });
});

describe("provisionLiteLLMKeys — passphrase-less hindsight probe (fix 3)", () => {
  let prevPass: string | undefined;

  function makeHindsightConfig(): SwitchroomConfig {
    return {
      switchroom: { version: 1 },
      telegram: { bot_token: "123:TEST", forum_chat_id: "-1001" },
      litellm: {
        enabled: true,
        base_url: "http://127.0.0.1:4010",
        admin_key: "sk-master-test",
        team: "switchroom",
      },
      memory: { backend: "hindsight" },
      // No litellm-opted agents — isolate the hindsight-service path.
      agents: {},
    } as unknown as SwitchroomConfig;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    prevPass = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    // Force the null-passphrase branch.
    delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
  });

  afterEach(() => {
    if (prevPass === undefined) delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    else process.env.SWITCHROOM_VAULT_PASSPHRASE = prevPass;
  });

  it("hindsight key ALREADY provisioned → NO spurious failure (the fix)", async () => {
    // The probe finds the service key present.
    getViaBrokerStructured.mockResolvedValue({
      kind: "ok",
      entry: { kind: "string", value: "sk-hindsight" },
    });

    const { ctx, failures, out } = makeSinks();
    await provisionLiteLLMKeys(makeHindsightConfig(), [], undefined, {
      ...ctx,
      home: "/nonexistent-home-for-test",
    });

    // Pre-fix this pushed a "hindsight (service)" failure on EVERY passphrase-
    // less apply even though the key was present. It must now be clean.
    expect(failures).toEqual([]);
    expect(out.join("")).toMatch(/litellm\/hindsight: key already provisioned/);
  });

  it("hindsight key genuinely MISSING → still surfaced as a failure", async () => {
    getViaBrokerStructured.mockResolvedValue({ kind: "not_found" });

    const { ctx, failures } = makeSinks();
    await provisionLiteLLMKeys(makeHindsightConfig(), [], undefined, {
      ...ctx,
      home: "/nonexistent-home-for-test",
    });

    expect(failures.some((f) => f.agent === "hindsight (service)")).toBe(true);
  });

  it("hindsight probe UNREACHABLE → degrade to warning, not a failure (#2781 parity)", async () => {
    getViaBrokerStructured.mockResolvedValue({ kind: "unreachable", msg: "no broker socket" });

    const { ctx, failures, errs } = makeSinks();
    await provisionLiteLLMKeys(makeHindsightConfig(), [], undefined, {
      ...ctx,
      home: "/nonexistent-home-for-test",
    });

    expect(failures).toEqual([]);
    expect(errs.join("")).toMatch(/litellm\/hindsight: vault-broker unreachable/);
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
