/**
 * Regression pin for the RFC H container layout: compose emits
 * `SWITCHROOM_ACCOUNTS_DIR=/state/accounts` (`src/agents/compose.ts:1013`)
 * and bind-mounts the host `~/.switchroom/accounts` there. Without
 * honouring the env var, every account-store helper resolves to
 * `${homedir()}/.switchroom/accounts` — `/root/.switchroom/accounts`
 * inside the auth-broker container, where nothing is mounted. The
 * broker silently sees zero accounts and `list-state` / `set-active` /
 * `refresh-account` all return empty results. Tests passing `home`
 * directly never caught this. These tests run the helpers via the
 * process env so the env-var path is actually exercised.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  accountsRoot,
  accountDir,
  accountCredentialsPath,
  accountMetaPath,
} from "./account-store.js";

const FAKE_HOME = "/tmp/fake-home";

describe("accountsRoot + derivatives — SWITCHROOM_ACCOUNTS_DIR env override", () => {
  afterEach(() => {
    delete process.env.SWITCHROOM_ACCOUNTS_DIR;
  });

  it("falls back to `${home}/.switchroom/accounts` when env unset", () => {
    delete process.env.SWITCHROOM_ACCOUNTS_DIR;
    expect(accountsRoot(FAKE_HOME)).toBe(`${FAKE_HOME}/.switchroom/accounts`);
  });

  it("env wins for accountsRoot when set to an absolute path", () => {
    process.env.SWITCHROOM_ACCOUNTS_DIR = "/state/accounts";
    expect(accountsRoot(FAKE_HOME)).toBe("/state/accounts");
  });

  it("env propagates through accountDir / credentialsPath / metaPath", () => {
    process.env.SWITCHROOM_ACCOUNTS_DIR = "/state/accounts";
    expect(accountDir("ken@example.com", FAKE_HOME)).toBe(
      "/state/accounts/ken@example.com",
    );
    expect(accountCredentialsPath("ken@example.com", FAKE_HOME)).toBe(
      "/state/accounts/ken@example.com/credentials.json",
    );
    expect(accountMetaPath("ken@example.com", FAKE_HOME)).toBe(
      "/state/accounts/ken@example.com/meta.json",
    );
  });

  it("env ignored when empty", () => {
    process.env.SWITCHROOM_ACCOUNTS_DIR = "";
    expect(accountsRoot(FAKE_HOME)).toBe(`${FAKE_HOME}/.switchroom/accounts`);
  });

  it("env ignored when not absolute (defensive: refuse relative)", () => {
    process.env.SWITCHROOM_ACCOUNTS_DIR = "relative/path";
    expect(accountsRoot(FAKE_HOME)).toBe(`${FAKE_HOME}/.switchroom/accounts`);
  });
});
