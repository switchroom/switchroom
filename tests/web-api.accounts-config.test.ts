import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  handleGetAccounts,
  handleGetAgentAccounts,
  handleGetAgentConfig,
} from "../src/web/api.js";
import {
  writeAccountCredentials,
  writeAccountMeta,
} from "../src/auth/account-store.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

let home: string;

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  home = resolve(tmpdir(), `switchroom-web-api-${stamp}`);
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const FAR_FUTURE = Date.now() + 24 * 60 * 60 * 1000;

function seedAccount(label: string, opts: { expired?: boolean; quotaUntil?: number } = {}) {
  writeAccountCredentials(
    label,
    {
      claudeAiOauth: {
        accessToken: "tok",
        refreshToken: "refresh",
        expiresAt: opts.expired ? Date.now() - 1000 : FAR_FUTURE,
        subscriptionType: "max",
      },
    },
    home,
  );
  writeAccountMeta(
    label,
    {
      createdAt: Date.now(),
      subscriptionType: "max",
      quotaExhaustedUntil: opts.quotaUntil,
      lastRefreshedAt: Date.now() - 60_000,
    },
    home,
  );
}

function configWith(agent: { name: string; accounts?: string[] }): SwitchroomConfig {
  const cfg: SwitchroomConfig = {
    agents: {
      [agent.name]: {
        topic_name: "Topic",
        schedule: [],
        ...(agent.accounts ? { auth: { accounts: agent.accounts } } : {}),
      },
    },
  } as unknown as SwitchroomConfig;
  return cfg;
}

describe("handleGetAccounts", () => {
  it("returns empty array when no accounts exist", () => {
    expect(handleGetAccounts(home)).toEqual([]);
  });

  it("returns AccountInfo for each account in the global store", () => {
    seedAccount("alpha");
    seedAccount("beta", { expired: true });
    const out = handleGetAccounts(home);
    expect(out.map((a) => a.label).sort()).toEqual(["alpha", "beta"]);
    const alpha = out.find((a) => a.label === "alpha");
    const beta = out.find((a) => a.label === "beta");
    expect(alpha?.health).toBe("healthy");
    expect(beta?.health).toBe("expired");
  });

  it("reflects quota-exhausted health when quotaExhaustedUntil is in the future", () => {
    seedAccount("gamma", { quotaUntil: Date.now() + 60_000 });
    const out = handleGetAccounts(home);
    expect(out[0].health).toBe("quota-exhausted");
  });
});

describe("handleGetAgentAccounts", () => {
  it("returns empty assigned + details when agent has no auth.accounts", () => {
    const cfg = configWith({ name: "klanker" });
    const out = handleGetAgentAccounts(cfg, "klanker", home);
    expect(out.assigned).toEqual([]);
    expect(out.details).toEqual([]);
  });

  it("returns assigned labels in declared order with cross-referenced details", () => {
    seedAccount("primary");
    seedAccount("fallback");
    const cfg = configWith({ name: "klanker", accounts: ["primary", "fallback"] });
    const out = handleGetAgentAccounts(cfg, "klanker", home);
    expect(out.assigned).toEqual(["primary", "fallback"]);
    expect(out.details.map((d) => d.label)).toEqual(["primary", "fallback"]);
    expect(out.details[0].health).toBe("healthy");
  });

  it("omits missing accounts from details but keeps them in assigned", () => {
    seedAccount("primary");
    const cfg = configWith({ name: "klanker", accounts: ["primary", "ghost"] });
    const out = handleGetAgentAccounts(cfg, "klanker", home);
    expect(out.assigned).toEqual(["primary", "ghost"]);
    expect(out.details.map((d) => d.label)).toEqual(["primary"]);
  });
});

describe("handleGetAgentConfig", () => {
  it("returns the resolved cascaded agent config", () => {
    const cfg = configWith({ name: "klanker", accounts: ["primary"] });
    const out = handleGetAgentConfig(cfg, "klanker");
    expect(out.topic_name).toBe("Topic");
    expect(out.auth?.accounts).toEqual(["primary"]);
  });

  it("merges defaults into the agent layer", () => {
    const cfg: SwitchroomConfig = {
      defaults: { model: "sonnet" },
      agents: {
        klanker: { topic_name: "T", schedule: [] },
      },
    } as unknown as SwitchroomConfig;
    const out = handleGetAgentConfig(cfg, "klanker");
    expect(out.model).toBe("sonnet");
  });
});
