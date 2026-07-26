/**
 * Unit tests for the apply-time reconciliation of the hindsight virtual key's
 * MODEL ALLOWLIST.
 *
 * The bug: `apply` short-circuited on "a key exists in the vault" and checked
 * nothing else, while the allowlist that decides whether that key can actually
 * CALL anything lives only in the proxy's Postgres token row. So a DB rebuild
 * (or a lane added to `switchroom.yaml` after the key was minted) left declared
 * lanes rejected at request auth, with no error anywhere — just no traffic.
 * These tests pin the reconciliation's OUTCOME, including the two ways it could
 * do harm: truncating an operator's entries, and touching a key it shouldn't.
 */

import { describe, it, expect, vi } from "vitest";
import { reconcileHindsightKeyAllowlist, resolveConfigSecret } from "./apply.js";
import type { SwitchroomConfig } from "../config/schema.js";

const PROXY_MODELS = [
  "gpt-oss-20b",
  "gpt-oss-20b-openrouter",
  "gpt-oss-20b-retain",
  "gpt-oss-20b-retain-openrouter",
  "gpt-oss-20b-consolidation",
  "gpt-oss-120b",
];

/** The allowlist the live key actually carried on 2026-07-26. */
const LIVE_ALLOWLIST_20260726 = [
  "gpt-oss-20b",
  "gpt-oss-20b-openrouter",
  "gpt-oss-120b",
  "claude-sonnet-5-openrouter",
];

/**
 * Three litellm-routed lanes, all presenting the SAME declared key.
 *
 * Every op names its `api_key` explicitly, because that is the only way a lane
 * has an identifiable key at all: switchroom emits no global
 * `HINDSIGHT_API_LLM_API_KEY` (`src/cli/setup.ts` records it as "no longer
 * used"), and the global `hindsight.llm` block has no `api_key` field in the
 * schema, so an op that declares none presents nothing this code can name. That
 * case is covered separately below, and must NOT reconcile a key by proxy.
 */
function cfg(llmOver: Record<string, unknown> = {}): SwitchroomConfig {
  return {
    litellm: { enabled: true, base_url: "http://h", admin_key: "sk-master" },
    memory: { backend: "hindsight" },
    hindsight: {
      llm: {
        provider: "litellm",
        retain: { model: "openai/gpt-oss-20b-retain", api_key: "sk-hindsight" },
        reflect: { model: "openai/gpt-oss-20b", api_key: "sk-hindsight" },
        consolidation: {
          model: "openai/gpt-oss-20b-consolidation",
          api_key: "sk-hindsight",
        },
        ...llmOver,
      },
    },
  } as unknown as SwitchroomConfig;
}

/** Only `/v1/models` goes through fetch; validate/update are injected. */
const modelsFetch = (models = PROXY_MODELS) =>
  (async () =>
    new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

function harness(over: Partial<Parameters<typeof reconcileHindsightKeyAllowlist>[0]> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const validateKey = vi.fn(async () => ({
    kind: "valid" as const,
    teamId: "t",
    models: LIVE_ALLOWLIST_20260726,
  }));
  const updateKeyModels = vi.fn(async (opts: { models: string[] }) => {
    void opts;
    return { kind: "ok" as const };
  });
  return {
    out,
    err,
    validateKey,
    updateKeyModels,
    args: {
      baseUrl: "http://h",
      masterKey: "sk-master",
      config: cfg(),
      validateKey,
      updateKeyModels,
      resolveSecret: async (ref: string) =>
        ref.startsWith("vault:") ? `resolved:${ref.slice(6)}` : ref,
      writeOut: (s: string) => out.push(s),
      writeErr: (s: string) => err.push(s),
      fetchFn: modelsFetch(),
      ...over,
    } as Parameters<typeof reconcileHindsightKeyAllowlist>[0],
  };
}

describe("reconcileHindsightKeyAllowlist", () => {
  it("grants the declared lanes the key could NOT reach, and says so", async () => {
    const h = harness();
    await reconcileHindsightKeyAllowlist(h.args);

    expect(h.updateKeyModels).toHaveBeenCalledTimes(1);
    const sent = h.updateKeyModels.mock.calls[0]![0];
    expect(sent.models).toContain("gpt-oss-20b-retain");
    expect(sent.models).toContain("gpt-oss-20b-consolidation");
    expect(h.out.join("")).toContain("gpt-oss-20b-retain");
    expect(h.out.join("")).toContain("key not allowed to access model");
  });

  it("UNIONS — it never truncates entries switchroom does not manage", async () => {
    // `claude-sonnet-5-openrouter` is not derivable from the hindsight config.
    // Writing only the derived set would REVOKE it — turning a routine apply
    // into an outage for whatever else shares the key.
    const h = harness();
    await reconcileHindsightKeyAllowlist(h.args);
    const sent = h.updateKeyModels.mock.calls[0]![0];
    for (const kept of LIVE_ALLOWLIST_20260726) {
      expect(sent.models).toContain(kept);
    }
  });

  it("does NOT write when the key already reaches every declared lane", async () => {
    const h = harness({
      validateKey: vi.fn(async () => ({
        kind: "valid" as const,
        teamId: "t",
        models: [
          ...LIVE_ALLOWLIST_20260726,
          "gpt-oss-20b-retain",
          "gpt-oss-20b-consolidation",
        ],
      })),
    } as never);
    await reconcileHindsightKeyAllowlist(h.args);
    expect(h.updateKeyModels).not.toHaveBeenCalled();
    expect(h.out.join("")).toContain("reaches all 3 declared model group(s)");
    expect(h.err).toEqual([]);
  });

  it("does NOT restrict an unrestricted key", async () => {
    // `[]` is LiteLLM's "inherit team/proxy access". Writing the derived set
    // over it is a silent DOWNGRADE dressed up as a fix.
    const h = harness({
      validateKey: vi.fn(async () => ({ kind: "valid" as const, teamId: "t", models: [] })),
    } as never);
    await reconcileHindsightKeyAllowlist(h.args);
    expect(h.updateKeyModels).not.toHaveBeenCalled();
    expect(h.out.join("")).toContain("unrestricted");
  });

  it("does nothing when the proxy does not recognise the stored key", async () => {
    // DB drift is handled by the provisioning path, which has the right
    // remedy. Never re-provision or write an allowlist from here — and do not
    // say it twice, so this stays a quiet informational line, not a warning.
    const h = harness({
      validateKey: vi.fn(async () => ({ kind: "unknown" as const })),
    } as never);
    await reconcileHindsightKeyAllowlist(h.args);
    expect(h.updateKeyModels).not.toHaveBeenCalled();
    expect(h.err).toEqual([]);
    expect(h.out.join("")).toContain("does not recognise this key");
  });

  it("WARNs — not '(skipped)' — when the key's allowlist cannot be READ", async () => {
    // `/v1/models` answered a moment ago, so a failure at `/key/info` is not a
    // dead proxy: the allowlist simply was not looked at. Printing the same
    // calm "(skipped)" line as the healthy path is how an unperformed check
    // passes for a performed one — the reporting defect this PR is about.
    const h = harness({
      validateKey: vi.fn(async () => ({
        kind: "unreachable" as const,
        detail: "HTTP 502: bad gateway",
      })),
    } as never);
    await reconcileHindsightKeyAllowlist(h.args);
    expect(h.updateKeyModels).not.toHaveBeenCalled();
    const e = h.err.join("");
    expect(e).toContain("left unverified");
    expect(e).toContain("HTTP 502");
    expect(h.out.join("")).not.toContain("skipped");
  });

  it("warns and leaves the key alone when the model list cannot be read", async () => {
    const h = harness({
      fetchFn: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await reconcileHindsightKeyAllowlist(h.args);
    expect(h.updateKeyModels).not.toHaveBeenCalled();
    expect(h.err.join("")).toContain("left unverified");
  });

  it("warns LOUDLY, with a manual remedy, when the update itself fails", async () => {
    const h = harness({
      updateKeyModels: vi.fn(async () => ({ kind: "error" as const, detail: "HTTP 403" })),
    } as never);
    await reconcileHindsightKeyAllowlist(h.args);
    const e = h.err.join("");
    expect(e).toContain("CANNOT reach");
    expect(e).toContain("HTTP 403");
    expect(e).toContain("/key/update");
    // The remedy must not print the secret itself.
    expect(e).not.toContain("sk-hindsight");
  });

  it("never demands a model the proxy does not serve", async () => {
    // A config typo is #3407's defect with #3407's message. Granting a
    // nonexistent group here would write garbage into the allowlist and
    // produce a second, worse error.
    const h = harness({ fetchFn: modelsFetch(["gpt-oss-20b"]) });
    await reconcileHindsightKeyAllowlist(h.args);
    expect(h.updateKeyModels).not.toHaveBeenCalled();
  });
});

/**
 * The reconciliation is only worth anything if it fixes the key the failing
 * lane PRESENTS. A `provider: litellm` op sends `hindsight.llm.<op>.api_key`
 * (`HINDSIGHT_API_<OP>_LLM_API_KEY`); the provisioned `litellm/hindsight/api-key`
 * authenticates the claude-code passthrough instead. They are different keys on
 * a live fleet, so granting the provisioned one and declaring victory leaves the
 * lane exactly as broken as before — a false OK on the defect this code exists
 * to remove.
 */
describe("reconcileHindsightKeyAllowlist — which key gets fixed", () => {
  it("writes to the key the lane PRESENTS, not the provisioned service key", async () => {
    const h = harness({
      config: cfg({ retain: { model: "openai/gpt-oss-20b-retain", api_key: "sk-lane" } }),
    } as never);
    await reconcileHindsightKeyAllowlist(h.args);

    const keysWritten = h.updateKeyModels.mock.calls.map(
      (c) => (c[0] as unknown as { key: string }).key,
    );
    expect(keysWritten).toContain("sk-lane");
    const laneCall = h.updateKeyModels.mock.calls.find(
      (c) => (c[0] as unknown as { key: string }).key === "sk-lane",
    )!;
    expect(laneCall[0].models).toContain("gpt-oss-20b-retain");
    // And the retain lane must NOT be granted on the provisioned key, which
    // that lane never presents.
    const provisioned = h.updateKeyModels.mock.calls.find(
      (c) => (c[0] as unknown as { key: string }).key === "sk-hindsight",
    );
    expect(provisioned?.[0].models ?? []).not.toContain("gpt-oss-20b-retain");
  });

  it("validates the lane's own key, so a healthy service key cannot mask a broken lane", async () => {
    const h = harness({
      config: cfg({ retain: { model: "openai/gpt-oss-20b-retain", api_key: "sk-lane" } }),
    } as never);
    await reconcileHindsightKeyAllowlist(h.args);
    const probed = (
      h.validateKey.mock.calls as unknown as Array<[{ key: string }]>
    ).map((c) => c[0].key);
    expect(probed).toContain("sk-lane");
  });

  it("resolves a `vault:` api_key rather than presenting the reference verbatim", async () => {
    const h = harness({
      config: cfg({
        retain: { model: "openai/gpt-oss-20b-retain", api_key: "vault:litellm/lane" },
      }),
    } as never);
    await reconcileHindsightKeyAllowlist(h.args);
    const probed = (
      h.validateKey.mock.calls as unknown as Array<[{ key: string }]>
    ).map((c) => c[0].key);
    expect(probed).toContain("resolved:litellm/lane");
    expect(probed).not.toContain("vault:litellm/lane");
  });

  it("WARNs — never silently skips — when a lane's api_key cannot be resolved", async () => {
    const h = harness({
      config: cfg({ retain: { model: "openai/gpt-oss-20b-retain", api_key: "vault:nope" } }),
      resolveSecret: async (ref: string) => (ref.startsWith("vault:") ? null : ref),
    } as never);
    await reconcileHindsightKeyAllowlist(h.args);
    expect(h.err.join("")).toContain("could not resolve the api_key");
    expect(h.err.join("")).toContain("hindsight.llm.retain");
  });

  it("does NOT reconcile a key by proxy for a lane that declares no api_key", async () => {
    // A `provider: litellm` op with no `api_key` presents a credential nothing
    // here can name — verified against the running stack: switchroom emits no
    // global `HINDSIGHT_API_LLM_API_KEY`, hindsight reads that name as a bare
    // `os.getenv` with no default (`config.py`, `llm_api_key=`), `litellm` sits
    // in the engine's `_PROVIDERS_WITHOUT_API_KEY` set so nothing raises, and
    // the provider omits the key entirely (`if self.api_key:` in
    // `providers/litellm_llm.py`). Widening the PROVISIONED service key on such
    // a lane's behalf grants a key the lane never sends: an apply that reports
    // a green "+ granted" line and changes nothing about the outage.
    const h = harness({
      config: cfg({
        retain: { model: "openai/gpt-oss-20b-retain" }, // no api_key
        reflect: undefined,
        consolidation: undefined,
      }),
    } as never);
    await reconcileHindsightKeyAllowlist(h.args);

    // Nothing probed, nothing written — not even a read of some other key.
    expect(h.validateKey).not.toHaveBeenCalled();
    expect(h.updateKeyModels).not.toHaveBeenCalled();
    // And it says why, naming the config that would make the lane checkable.
    const e = h.err.join("");
    expect(e).toContain("hindsight.llm.retain");
    expect(e).toContain("declares no `api_key`");
    expect(e).toContain("hindsight.llm.<op>.api_key");
    // Must not imply the provisioned key covers it — that is the false
    // attribution this branch exists to prevent.
    expect(e).toContain("is NOT a fallback");
  });

  it("still reconciles the KEYED lanes when a sibling lane declares no api_key", async () => {
    // The keyless lane is unverifiable; the ones with a key are not, and must
    // not be dragged down with it.
    const h = harness({
      config: cfg({
        retain: { model: "openai/gpt-oss-20b-retain" }, // no api_key
        reflect: undefined,
        consolidation: {
          model: "openai/gpt-oss-20b-consolidation",
          api_key: "sk-consolidation",
        },
      }),
    } as never);
    await reconcileHindsightKeyAllowlist(h.args);
    const keysWritten = h.updateKeyModels.mock.calls.map(
      (c) => (c[0] as unknown as { key: string }).key,
    );
    expect(keysWritten).toEqual(["sk-consolidation"]);
    expect(h.updateKeyModels.mock.calls[0]![0].models).toContain(
      "gpt-oss-20b-consolidation",
    );
    expect(h.updateKeyModels.mock.calls[0]![0].models).not.toContain("gpt-oss-20b-retain");
  });

  it("reconciles EACH distinct key, not just the first one it finds", async () => {
    const h = harness({
      config: cfg({
        retain: { model: "openai/gpt-oss-20b-retain", api_key: "sk-retain" },
        consolidation: {
          model: "openai/gpt-oss-20b-consolidation",
          api_key: "sk-consolidation",
        },
      }),
    } as never);
    await reconcileHindsightKeyAllowlist(h.args);
    const keysWritten = h.updateKeyModels.mock.calls.map(
      (c) => (c[0] as unknown as { key: string }).key,
    );
    expect(new Set(keysWritten)).toEqual(new Set(["sk-retain", "sk-consolidation"]));
  });
});

describe("resolveConfigSecret", () => {
  it("returns a literal admin_key unchanged, without touching the broker", async () => {
    const broker = vi.fn();
    expect(await resolveConfigSecret("sk-literal", broker as never)).toBe("sk-literal");
    expect(broker).not.toHaveBeenCalled();
  });

  it("reads a vault: reference through the broker", async () => {
    const broker = vi.fn(async () => ({
      kind: "ok" as const,
      entry: { kind: "string" as const, value: "sk-from-vault" },
    }));
    expect(await resolveConfigSecret("vault:litellm/admin", broker as never)).toBe(
      "sk-from-vault",
    );
    expect(broker).toHaveBeenCalledWith("litellm/admin");
  });

  it("returns null — not a throw — when the broker denies or the entry is not a string", async () => {
    // A denied grant must degrade to "skip reconciliation", never fail an
    // apply that is otherwise fine.
    expect(
      await resolveConfigSecret("vault:litellm/admin", (async () => ({
        kind: "denied" as const,
      })) as never),
    ).toBeNull();
    expect(
      await resolveConfigSecret("vault:litellm/admin", (async () => ({
        kind: "ok" as const,
        entry: { kind: "json" as const, value: {} },
      })) as never),
    ).toBeNull();
  });
});
