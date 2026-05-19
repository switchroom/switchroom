/**
 * Google Workspace / Drive ACL predicates.
 *
 * `shouldEmitGdriveMcp` is the shared scaffold↔broker gate (relocated
 * here from scaffold-integration so the broker can share it without the
 * hindsight layer). `isGoogleClientCredentialKeyForAgent` is the broker
 * clause that completes RFC G §4.4: it grants a Drive-enabled agent
 * read access to the OAuth client credential the config binds to it,
 * which is otherwise broker-denied (the launcher can't spawn the gdrive
 * MCP — the exact fleet-wide production failure this fixes).
 */

import { describe, expect, it } from "vitest";
import type { SwitchroomConfig } from "./schema.js";
import {
  shouldEmitGdriveMcp,
  vaultRefKey,
  isGoogleClientCredentialKeyForAgent,
} from "./google-workspace-acl.js";

describe("shouldEmitGdriveMcp — broker-ACL contract", () => {
  // The same config that makes the scaffold emit the gdrive entry MUST
  // be the config under which the broker would return a Google account.
  // Broker logic (src/auth/broker/server.ts opGoogleGetCredentials):
  //   account = agents.<name>.google_workspace.account  (must be set)
  //   ACL     = google_accounts[account].enabled_for[].includes(name)
  // shouldEmitGdriveMcp encodes exactly that — these cases pin both
  // sides to one predicate.

  it("emits when account set AND agent in enabled_for[] (broker would return creds)", () => {
    expect(
      shouldEmitGdriveMcp("carrie", "you@example.com", {
        "you@example.com": { enabled_for: ["clerk", "carrie"] },
      }),
    ).toBe(true);
  });

  it("does NOT emit when agent has no google_workspace.account (broker → ACCOUNT_NOT_FOUND)", () => {
    expect(
      shouldEmitGdriveMcp("carrie", undefined, {
        "you@example.com": { enabled_for: ["carrie"] },
      }),
    ).toBe(false);
  });

  it("does NOT emit when the referenced account isn't in google_accounts", () => {
    expect(
      shouldEmitGdriveMcp("carrie", "you@example.com", {
        "other@gmail.com": { enabled_for: ["carrie"] },
      }),
    ).toBe(false);
  });

  it("does NOT emit when agent NOT in enabled_for[] (broker → FORBIDDEN)", () => {
    expect(
      shouldEmitGdriveMcp("carrie", "you@example.com", {
        "you@example.com": { enabled_for: ["clerk"] },
      }),
    ).toBe(false);
  });

  it("does NOT emit when google_accounts is entirely absent", () => {
    expect(shouldEmitGdriveMcp("carrie", "you@example.com", undefined)).toBe(
      false,
    );
  });

  it("normalizes account case/whitespace the same way the schema + broker do", () => {
    // Schema lowercases+trims both the per-agent account and the
    // google_accounts keys; the predicate must agree post-normalization.
    expect(
      shouldEmitGdriveMcp("carrie", "  You@Example.com  ", {
        "you@example.com": { enabled_for: ["carrie"] },
      }),
    ).toBe(true);
  });

  it("treats an empty-string account as not configured", () => {
    expect(
      shouldEmitGdriveMcp("carrie", "   ", {
        "you@example.com": { enabled_for: ["carrie"] },
      }),
    ).toBe(false);
  });
});

describe("vaultRefKey — bare key extraction (mirrors the bot_token clause)", () => {
  it("extracts the key from a plain vault: ref", () => {
    expect(vaultRefKey("vault:google/client-secret")).toBe(
      "google/client-secret",
    );
  });

  it("strips a #scope suffix the same way the bot_token clause does", () => {
    expect(vaultRefKey("vault:google/client-secret#read")).toBe(
      "google/client-secret",
    );
  });

  it("returns null for a literal (non-vault) value — no broker needed", () => {
    expect(vaultRefKey("GOCSPX-literal-secret")).toBeNull();
  });

  it("returns null for an empty key (`vault:`)", () => {
    expect(vaultRefKey("vault:")).toBeNull();
    expect(vaultRefKey("vault:#scope")).toBeNull();
  });

  it("returns null for non-string / absent values", () => {
    expect(vaultRefKey(undefined)).toBeNull();
    expect(vaultRefKey(null)).toBeNull();
    expect(vaultRefKey(42)).toBeNull();
    expect(vaultRefKey("")).toBeNull();
  });
});

/**
 * Build a SwitchroomConfig with the Google Workspace surface populated.
 * Mirrors the real shape: top-level `google_workspace` (client creds are
 * top-level only per schema) + `google_accounts` (enabled_for[]) +
 * per-agent `agents.<name>.google_workspace.account`.
 */
function gwConfig(opts: {
  agentName: string;
  account?: string;
  enabledFor?: string[];
  clientSecret?: string;
  clientId?: string;
  gdriveOptOut?: boolean;
  includeAgent?: boolean;
}): SwitchroomConfig {
  const {
    agentName,
    account = "you@example.com",
    enabledFor = [agentName],
    clientSecret = "vault:google/client-secret",
    clientId,
    gdriveOptOut = false,
    includeAgent = true,
  } = opts;
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    google_accounts: { [account]: { enabled_for: enabledFor } },
    google_workspace: {
      google_client_id: clientId,
      google_client_secret: clientSecret,
    },
    agents: includeAgent
      ? {
          [agentName]: {
            topic_name: agentName,
            google_workspace: { account },
            ...(gdriveOptOut ? { mcp_servers: { gdrive: false } } : {}),
          },
        }
      : {},
  } as unknown as SwitchroomConfig;
}

describe("isGoogleClientCredentialKeyForAgent — RFC G §4.4 completion", () => {
  it("grants a Drive-enabled agent the client-secret vault key even with NO schedule (the prod regression)", () => {
    // klanker/ziggy in prod: enabled_for + account set, zero schedule
    // entries → before this clause the launcher was broker-denied
    // 'google/client-secret' and the gdrive MCP never spawned.
    const cfg = gwConfig({ agentName: "klanker" });
    expect(
      isGoogleClientCredentialKeyForAgent(cfg, "klanker", "google/client-secret"),
    ).toBe(true);
  });

  it("grants the client-id vault key too (symmetric with client-secret)", () => {
    const cfg = gwConfig({
      agentName: "klanker",
      clientId: "vault:google/client-id",
    });
    expect(
      isGoogleClientCredentialKeyForAgent(cfg, "klanker", "google/client-id"),
    ).toBe(true);
  });

  it("honours a #scope suffix on the configured ref", () => {
    const cfg = gwConfig({
      agentName: "klanker",
      clientSecret: "vault:google/client-secret#read",
    });
    expect(
      isGoogleClientCredentialKeyForAgent(cfg, "klanker", "google/client-secret"),
    ).toBe(true);
  });

  it("denies an agent NOT in enabled_for[] (same gate as the scaffold)", () => {
    const cfg = gwConfig({ agentName: "klanker", enabledFor: ["clerk"] });
    expect(
      isGoogleClientCredentialKeyForAgent(cfg, "klanker", "google/client-secret"),
    ).toBe(false);
  });

  it("denies when the agent has no google_workspace.account", () => {
    const cfg = gwConfig({ agentName: "klanker" });
    // Strip the per-agent account.
    (cfg.agents as Record<string, { google_workspace?: unknown }>)[
      "klanker"
    ].google_workspace = undefined;
    expect(
      isGoogleClientCredentialKeyForAgent(cfg, "klanker", "google/client-secret"),
    ).toBe(false);
  });

  it("denies an unrelated key (does not blanket-grant)", () => {
    const cfg = gwConfig({ agentName: "klanker" });
    expect(
      isGoogleClientCredentialKeyForAgent(cfg, "klanker", "stripe/api-key"),
    ).toBe(false);
  });

  it("does NOT grant when the client secret is a literal, not a vault: ref", () => {
    // A literal is read straight from config by the launcher; the broker
    // is never asked, so there is nothing to (and we must not) grant.
    const cfg = gwConfig({
      agentName: "klanker",
      clientSecret: "GOCSPX-literal-value",
    });
    expect(
      isGoogleClientCredentialKeyForAgent(
        cfg,
        "klanker",
        "GOCSPX-literal-value",
      ),
    ).toBe(false);
  });

  it("respects the mcp_servers: { gdrive: false } hard opt-out", () => {
    const cfg = gwConfig({ agentName: "klanker", gdriveOptOut: true });
    expect(
      isGoogleClientCredentialKeyForAgent(cfg, "klanker", "google/client-secret"),
    ).toBe(false);
  });

  it("denies an unknown agent", () => {
    const cfg = gwConfig({ agentName: "klanker", includeAgent: false });
    expect(
      isGoogleClientCredentialKeyForAgent(cfg, "klanker", "google/client-secret"),
    ).toBe(false);
  });

  it("denies when google_workspace is entirely absent", () => {
    const cfg = gwConfig({ agentName: "klanker" });
    (cfg as { google_workspace?: unknown }).google_workspace = undefined;
    expect(
      isGoogleClientCredentialKeyForAgent(cfg, "klanker", "google/client-secret"),
    ).toBe(false);
  });
});
