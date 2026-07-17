/**
 * Multi-account-per-agent Microsoft 365 — schema + normalizer + slug tests.
 *
 * Covers the additive, backward-compatible schema (singular `account` XOR
 * plural `accounts[]`), the shared `normalizeMicrosoftBindings` drift guard,
 * and the deterministic slug/key derivation. See
 * reference/rfcs/microsoft-multi-account-per-agent.md §2.1, §3.
 */

import { describe, expect, it } from "vitest";

import { AgentMicrosoftWorkspaceConfigSchema, SwitchroomConfigSchema } from "./schema.js";
import {
  normalizeMicrosoftBindings,
  microsoftAccountSlug,
  ms365McpKeyForBinding,
  isMultiAccount,
  bindingsForAgent,
} from "./microsoft-workspace-acl.js";

describe("AgentMicrosoftWorkspaceConfigSchema — accept forms", () => {
  it("accepts the singular `account` form (back-compat)", () => {
    const r = AgentMicrosoftWorkspaceConfigSchema.safeParse({
      account: "Lisa@Outlook.com",
      org_mode: true,
    });
    expect(r.success).toBe(true);
    // normalized to lowercase
    expect(r.success && r.data?.account).toBe("lisa@outlook.com");
  });

  it("accepts singular `account` with block-level `tools`", () => {
    const r = AgentMicrosoftWorkspaceConfigSchema.safeParse({
      account: "lisa@outlook.com",
      tools: ["list-drives", "get-drive-item"],
    });
    expect(r.success).toBe(true);
  });

  it("accepts the plural `accounts[]` form with per-binding tools", () => {
    const r = AgentMicrosoftWorkspaceConfigSchema.safeParse({
      accounts: [
        { account: "alice@example.com", tools: ["list-drives"] },
        { account: "bob@example.com", tools: ["list-mail-messages"], org_mode: true },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data?.accounts?.[0].account).toBe("alice@example.com");
  });
});

describe("AgentMicrosoftWorkspaceConfigSchema — reject forms", () => {
  it("rejects BOTH singular `account` and plural `accounts` present", () => {
    const r = AgentMicrosoftWorkspaceConfigSchema.safeParse({
      account: "lisa@outlook.com",
      accounts: [{ account: "other@outlook.com" }],
    });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues.some((i) => /not both/.test(i.message))).toBe(true);
  });

  it("rejects a duplicate account inside `accounts[]`", () => {
    const r = AgentMicrosoftWorkspaceConfigSchema.safeParse({
      accounts: [
        { account: "dupe@outlook.com" },
        { account: "Dupe@Outlook.com" }, // same after normalize
      ],
    });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues.some((i) => /duplicate account/.test(i.message))).toBe(true);
  });

  it("rejects block-level `tools` together with `accounts`", () => {
    const r = AgentMicrosoftWorkspaceConfigSchema.safeParse({
      tools: ["list-drives"],
      accounts: [{ account: "a@outlook.com" }],
    });
    expect(r.success).toBe(false);
    expect(
      !r.success && r.error.issues.some((i) => /block-level `tools`/.test(i.message)),
    ).toBe(true);
  });

  it("rejects empty `accounts: []`", () => {
    const r = AgentMicrosoftWorkspaceConfigSchema.safeParse({ accounts: [] });
    expect(r.success).toBe(false);
  });

  it("rejects empty `tools: []`", () => {
    const r = AgentMicrosoftWorkspaceConfigSchema.safeParse({
      account: "a@outlook.com",
      tools: [],
    });
    expect(r.success).toBe(false);
  });

  it("Finding 4 — rejects tool tokens with regex metacharacters (singular + plural)", () => {
    // An unescaped metacharacter would reach softeria's --enabled-tools regex
    // and can throw on `new RegExp(...)`, crashing the launcher into a restart
    // loop. The schema must reject it at load time.
    for (const bad of ["send-mail|(", "mail.*", "cal[endar", "back\\slash"]) {
      const singular = AgentMicrosoftWorkspaceConfigSchema.safeParse({
        account: "a@outlook.com",
        tools: [bad],
      });
      expect(singular.success).toBe(false);
      const plural = AgentMicrosoftWorkspaceConfigSchema.safeParse({
        accounts: [{ account: "a@outlook.com", tools: [bad] }],
      });
      expect(plural.success).toBe(false);
    }
    // Legitimate lowercase kebab-case tokens still pass.
    const ok = AgentMicrosoftWorkspaceConfigSchema.safeParse({
      accounts: [{ account: "a@outlook.com", tools: ["mail", "calendar", "send-mail"] }],
    });
    expect(ok.success).toBe(true);
  });
});

describe("normalizeMicrosoftBindings — the drift guard", () => {
  it("maps the singular form to a one-element list identical to explicit plural", () => {
    const singular = normalizeMicrosoftBindings({
      account: "lisa@outlook.com",
      tools: ["list-drives"],
      org_mode: true,
    });
    const plural = normalizeMicrosoftBindings({
      accounts: [{ account: "lisa@outlook.com", tools: ["list-drives"], org_mode: true }],
    });
    expect(singular).toEqual(plural);
    expect(singular).toEqual([
      { account: "lisa@outlook.com", tools: ["list-drives"], org_mode: true },
    ]);
  });

  it("lowercases the account and returns [] for an empty block", () => {
    expect(normalizeMicrosoftBindings({ account: "A@B.com" })[0].account).toBe("a@b.com");
    expect(normalizeMicrosoftBindings(undefined)).toEqual([]);
    expect(normalizeMicrosoftBindings({})).toEqual([]);
  });
});

describe("microsoftAccountSlug + ms365McpKeyForBinding", () => {
  it("produces a stable, [a-z0-9-] slug", () => {
    const slug = microsoftAccountSlug("Alice@Example.com");
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug).toBe(microsoftAccountSlug("alice@example.com"));
  });

  it("does NOT collide for two emails sharing a local-part", () => {
    expect(microsoftAccountSlug("lisa@a.com")).not.toBe(microsoftAccountSlug("lisa@b.com"));
  });

  it("keeps the bare `ms-365` key for single-account and `ms-365-<slug>` for multi", () => {
    const single = { account: "lisa@outlook.com" };
    expect(isMultiAccount(single)).toBe(false);
    expect(ms365McpKeyForBinding(single, "lisa@outlook.com")).toBe("ms-365");

    const multi = {
      accounts: [{ account: "a@x.com" }, { account: "b@y.com" }],
    };
    expect(isMultiAccount(multi)).toBe(true);
    expect(ms365McpKeyForBinding(multi, "a@x.com")).toBe(`ms-365-${microsoftAccountSlug("a@x.com")}`);
  });
});

describe("SwitchroomConfigSchema — two-part binding validation (plural)", () => {
  const base = {
    switchroom: { version: 1 },
    telegram: { bot_token: "x", forum_chat_id: "1" },
  };

  it("accepts a plural config where every bound account enables the agent", () => {
    const r = SwitchroomConfigSchema.safeParse({
      ...base,
      agents: {
        marko: {
          topic_name: "Marko",
          microsoft_workspace: {
            accounts: [
              { account: "alice@example.com", tools: ["list-drives"] },
              { account: "bob@example.com", tools: ["list-mail-messages"] },
            ],
          },
        },
      },
      microsoft_accounts: {
        "alice@example.com": { enabled_for: ["marko"] },
        "bob@example.com": { enabled_for: ["marko"] },
      },
    });
    expect(r.success).toBe(true);
  });

  it("rejects at load time when a bound account omits the agent from enabled_for[]", () => {
    const r = SwitchroomConfigSchema.safeParse({
      ...base,
      agents: {
        marko: {
          topic_name: "Marko",
          microsoft_workspace: {
            accounts: [
              { account: "alice@example.com" },
              { account: "bob@example.com" },
            ],
          },
        },
      },
      microsoft_accounts: {
        "alice@example.com": { enabled_for: ["marko"] },
        "bob@example.com": { enabled_for: ["clerk"] }, // NOT marko
      },
    });
    expect(r.success).toBe(false);
    expect(
      !r.success &&
        r.error.issues.some(
          (i) => /binds Microsoft account 'bob@example.com'/.test(i.message),
        ),
    ).toBe(true);
  });
});

describe("bindingsForAgent — twin-key gate applied per account", () => {
  it("returns only bindings whose account lists the agent in enabled_for[]", () => {
    const mw = {
      accounts: [{ account: "a@x.com" }, { account: "b@y.com" }],
    };
    const microsoftAccounts = {
      "a@x.com": { enabled_for: ["marko"] },
      "b@y.com": { enabled_for: ["someone-else"] },
    };
    const out = bindingsForAgent("marko", mw, microsoftAccounts);
    expect(out.map((b) => b.account)).toEqual(["a@x.com"]);
  });
});
