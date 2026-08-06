import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  resolveHindsightLlmSecrets,
  diffDroppedHindsightLlmVaultKeys,
  hindsightLlmDroppedKeyWarning,
  hindsightContainerEnvPairs,
  type HindsightLlmConfig,
} from "./hindsight.js";

/**
 * Regression guard for the 2026-08-06 fleet-wide retain outage.
 *
 * `hindsight.llm.<op>.api_key` in switchroom.yaml is a `vault:` virtual-key
 * reference. Vault-ref resolution for it used to happen ONLY in `switchroom
 * apply` (behind the operator passphrase). The `memory setup --recreate` launch
 * and hostd's `refresh-hindsight` rollout step run WITHOUT that resolver, so
 * they baked the LITERAL string `vault:litellm/gpt-oss-key` into the container's
 * HINDSIGHT_API_*_LLM_API_KEY env. LiteLLM rejected it ("Virtual Key
 * expected … start with 'sk-'") and every fact extraction failed.
 *
 * `resolveHindsightLlmSecrets` closes the gap by resolving those refs through
 * the auto-unlocked broker before the emit path ever sees them. These tests
 * assert the api_key is RESOLVED, never passed verbatim — they FAIL against the
 * pre-fix code path, which handed the literal straight to the emitter.
 */
describe("resolveHindsightLlmSecrets", () => {
  // Token-shaped literals built by runtime concat so GitHub Push Protection
  // does not flag the fixtures (see CLAUDE.md § Secrets in tests).
  const VAULT_REF = "vault:litellm/gpt-oss-key";
  const REAL_KEY = "sk-" + "resolved-oss-key-abc123";
  const OTHER_KEY = "sk-" + "reflect-key-def456";

  const brokerOk = (value: string) =>
    vi.fn().mockResolvedValue({ kind: "ok", entry: { kind: "string", value } });

  // The resolver forwards the agent capability token when SWITCHROOM_AGENT_NAME
  // is set; the harness may itself run inside an agent container, so pin the
  // env off for determinism and restore afterwards (mirrors the cp-access-key
  // test's boilerplate).
  let savedName: string | undefined;
  let savedDir: string | undefined;
  beforeEach(() => {
    savedName = process.env.SWITCHROOM_AGENT_NAME;
    savedDir = process.env.SWITCHROOM_AGENTS_DIR;
    delete process.env.SWITCHROOM_AGENT_NAME;
    delete process.env.SWITCHROOM_AGENTS_DIR;
  });
  afterEach(() => {
    if (savedName === undefined) delete process.env.SWITCHROOM_AGENT_NAME;
    else process.env.SWITCHROOM_AGENT_NAME = savedName;
    if (savedDir === undefined) delete process.env.SWITCHROOM_AGENTS_DIR;
    else process.env.SWITCHROOM_AGENTS_DIR = savedDir;
  });

  it("returns undefined when there is no llm config", async () => {
    await expect(resolveHindsightLlmSecrets(undefined)).resolves.toBeUndefined();
  });

  it("resolves a `vault:` global api_key through the broker", async () => {
    const get = brokerOk(REAL_KEY);
    const out = await resolveHindsightLlmSecrets(
      { provider: "openai", model: "gpt-oss-20b", api_key: VAULT_REF },
      { getViaBrokerStructured: get as never },
    );
    expect(out?.api_key).toBe(REAL_KEY);
    // Bare-key call, no token (SWITCHROOM_AGENT_NAME unset) — wire-identical to
    // the host-operator peercred path.
    expect(get).toHaveBeenCalledWith("litellm/gpt-oss-key", {});
    // Non-secret fields survive untouched.
    expect(out?.provider).toBe("openai");
    expect(out?.model).toBe("gpt-oss-20b");
  });

  it("resolves per-op `vault:` api_keys (retain / reflect / consolidation)", async () => {
    const get = vi.fn(async (key: string) => ({
      kind: "ok" as const,
      entry: {
        kind: "string" as const,
        value: key.includes("reflect") ? OTHER_KEY : REAL_KEY,
      },
    }));
    const out = await resolveHindsightLlmSecrets(
      {
        retain: { model: "gpt-oss-20b", api_key: VAULT_REF },
        reflect: { model: "gpt-oss-20b", api_key: "vault:litellm/reflect-key" },
        consolidation: { model: "gpt-oss-20b", api_key: VAULT_REF },
      },
      { getViaBrokerStructured: get as never },
    );
    expect(out?.retain?.api_key).toBe(REAL_KEY);
    expect(out?.reflect?.api_key).toBe(OTHER_KEY);
    expect(out?.consolidation?.api_key).toBe(REAL_KEY);
    // Per-op non-secret fields preserved.
    expect(out?.retain?.model).toBe("gpt-oss-20b");
  });

  it("passes a non-`vault:` literal api_key through without touching the broker", async () => {
    const get = brokerOk("unused");
    const out = await resolveHindsightLlmSecrets(
      { api_key: REAL_KEY },
      { getViaBrokerStructured: get as never },
    );
    expect(out?.api_key).toBe(REAL_KEY);
    expect(get).not.toHaveBeenCalled();
  });

  it("DROPS an unresolvable `vault:` api_key rather than baking the literal", async () => {
    // Fail-safe: a denied / missing / non-string / broker-down ref must never
    // leave the literal `vault:…` string in place. Dropping it makes the op
    // inherit the global / provider default instead of a guaranteed-invalid key.
    for (const get of [
      vi.fn().mockResolvedValue({ kind: "denied" }),
      vi.fn().mockResolvedValue({ kind: "ok", entry: { kind: "json", value: {} } }),
      vi.fn().mockRejectedValue(new Error("broker down")),
    ]) {
      const out = await resolveHindsightLlmSecrets(
        { api_key: VAULT_REF, retain: { api_key: VAULT_REF } },
        { getViaBrokerStructured: get as never },
      );
      expect(out?.api_key).toBeUndefined();
      expect(out?.retain?.api_key).toBeUndefined();
    }
  });

  it("does not mutate the caller's config object", async () => {
    const get = brokerOk(REAL_KEY);
    const input: HindsightLlmConfig = {
      api_key: VAULT_REF,
      retain: { api_key: VAULT_REF },
    };
    await resolveHindsightLlmSecrets(input, { getViaBrokerStructured: get as never });
    // The original still holds the vault ref — the resolver returned a clone.
    expect(input.api_key).toBe(VAULT_REF);
    expect(input.retain?.api_key).toBe(VAULT_REF);
  });

  it("bakes the RESOLVED key into the emit path, never the literal (the bug)", async () => {
    // End-to-end: resolve then emit exactly as the launch path does. On today's
    // bug the config is handed to hindsightContainerEnvPairs VERBATIM, so the
    // emitted env carries the literal `vault:…` string. This asserts the fixed
    // wiring bakes the real `sk-` key into every LLM api_key var.
    const get = brokerOk(REAL_KEY);
    const resolved = await resolveHindsightLlmSecrets(
      {
        provider: "openai",
        api_key: VAULT_REF,
        retain: { api_key: VAULT_REF },
        consolidation: { api_key: VAULT_REF },
      },
      { getViaBrokerStructured: get as never },
    );
    const env = new Map(
      hindsightContainerEnvPairs({ apiPort: 18888, llm: resolved, gpu: false }),
    );
    const apiKeyVars = [
      "HINDSIGHT_API_LLM_API_KEY",
      "HINDSIGHT_API_RETAIN_LLM_API_KEY",
      "HINDSIGHT_API_CONSOLIDATION_LLM_API_KEY",
    ];
    for (const v of apiKeyVars) {
      expect(env.get(v)).toBe(REAL_KEY);
      expect(env.get(v)).not.toContain("vault:");
    }
    // Sanity: no other emitted value smuggled the literal ref through either.
    for (const value of env.values()) {
      expect(value).not.toContain("vault:");
    }
  });
});

/**
 * Minor-1 (follow-up to the 2026-08-06 outage PR): a `vault:` LLM api_key that
 * fails to resolve is DROPPED — correct fail-safe, but silent. The launch paths
 * warn on the drop, symmetric to the cp_access_key warning. These assert the
 * diff finds the drops and the message names the lane + ref without a secret.
 */
describe("diffDroppedHindsightLlmVaultKeys", () => {
  const VAULT_REF = "vault:litellm/gpt-oss-key";
  const REAL_KEY = "sk-" + "resolved-oss-key-abc123";

  it("returns no drops when there is no config", async () => {
    await expect(diffDroppedHindsightLlmVaultKeys(undefined, undefined)).resolves.toEqual([]);
  });

  it("reports a dropped global `vault:` ref (input ref, output undefined)", async () => {
    const drops = await diffDroppedHindsightLlmVaultKeys(
      { api_key: VAULT_REF },
      { api_key: undefined },
    );
    expect(drops).toEqual([{ lane: "global", ref: VAULT_REF }]);
  });

  it("reports each dropped per-op lane by name", async () => {
    const drops = await diffDroppedHindsightLlmVaultKeys(
      {
        retain: { api_key: VAULT_REF },
        reflect: { api_key: "vault:litellm/reflect-key" },
        consolidation: { api_key: VAULT_REF },
      },
      {
        retain: { api_key: undefined },
        reflect: { api_key: undefined },
        consolidation: { api_key: undefined },
      },
    );
    expect(drops.map((d) => d.lane).sort()).toEqual(["consolidation", "reflect", "retain"]);
  });

  it("does NOT report a `vault:` ref that resolved (output has the key)", async () => {
    const drops = await diffDroppedHindsightLlmVaultKeys(
      { api_key: VAULT_REF },
      { api_key: REAL_KEY },
    );
    expect(drops).toEqual([]);
  });

  it("does NOT report a non-`vault:` literal that came back empty", async () => {
    // A plain literal is never a broker drop — only `vault:` refs are reported.
    const drops = await diffDroppedHindsightLlmVaultKeys(
      { api_key: REAL_KEY },
      { api_key: undefined },
    );
    expect(drops).toEqual([]);
  });

  it("does NOT report an unset field", async () => {
    const drops = await diffDroppedHindsightLlmVaultKeys({ provider: "openai" }, { provider: "openai" });
    expect(drops).toEqual([]);
  });
});

describe("hindsightLlmDroppedKeyWarning", () => {
  const VAULT_REF = "vault:litellm/gpt-oss-key";

  it("names the global lane and the `vault:` ref, never a secret", () => {
    const msg = hindsightLlmDroppedKeyWarning({ lane: "global", ref: VAULT_REF });
    expect(msg).toContain("global LLM lane");
    expect(msg).toContain(VAULT_REF);
    expect(msg).toMatch(/did not resolve/);
    expect(msg).not.toContain("sk-");
  });

  it("names a per-op lane", () => {
    const msg = hindsightLlmDroppedKeyWarning({ lane: "retain", ref: VAULT_REF });
    expect(msg).toContain("`retain` LLM op");
    expect(msg).toContain(VAULT_REF);
    expect(msg).not.toContain("sk-");
  });
});
