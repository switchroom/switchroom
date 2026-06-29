import { describe, expect, it } from "vitest";
import { INJECT_ALLOWLIST, INJECT_BLOCKLIST } from "../agents/inject.js";

// switchroomCommandsCatalog is not exported — test its contracts via
// the inject allowlist/blocklist that the routing logic depends on.

describe("switchroomCommandsCatalog invariants", () => {
  // The catalog pairs that route through injectSlashCommand (tmux).
  // These MUST be in INJECT_ALLOWLIST — if they drift off, slash.exec
  // will fall through to injectInbound and deliver them as text.
  const REPL_CATALOG_COMMANDS = ["/compact", "/clear", "/model", "/status", "/memory", "/usage"];

  it("catalog REPL commands are all in INJECT_ALLOWLIST", () => {
    for (const cmd of REPL_CATALOG_COMMANDS) {
      expect(INJECT_ALLOWLIST.has(cmd), `${cmd} must be in INJECT_ALLOWLIST`).toBe(true);
    }
  });

  // /effort must NOT be in the catalog — raw inject leaves a blocking modal open.
  it("/effort is in INJECT_BLOCKLIST (confirms it was correctly excluded from catalog)", () => {
    expect(INJECT_BLOCKLIST.has("/effort")).toBe(true);
  });

  // /restart and /new must NOT be in the catalog — they need the grammy
  // bot.command handler path, not injectInbound.
  it("/restart is not in INJECT_ALLOWLIST (confirms it belongs to grammy, not inject)", () => {
    expect(INJECT_ALLOWLIST.has("/restart")).toBe(false);
  });

  it("/new is not in INJECT_ALLOWLIST (confirms it belongs to grammy, not inject)", () => {
    expect(INJECT_ALLOWLIST.has("/new")).toBe(false);
  });
});

describe("slash.exec routing logic", () => {
  // Verify the allowlist/blocklist membership that drives the two-path routing.
  // The actual dispatch is integration-tested; here we pin the routing table
  // so future allowlist changes are caught before they silently break the UI.

  it("blocklist check takes precedence over allowlist", () => {
    // No command should ever appear in both — that would be a bug in inject.ts.
    for (const cmd of INJECT_BLOCKLIST) {
      expect(
        INJECT_ALLOWLIST.has(cmd),
        `${cmd} appears in both INJECT_ALLOWLIST and INJECT_BLOCKLIST`,
      ).toBe(false);
    }
  });

  it("REPL path: /memory, /status, /usage, /clear, /compact, /model route via allowlist", () => {
    const replCommands = ["/memory", "/status", "/usage", "/clear", "/compact", "/model"];
    for (const cmd of replCommands) {
      expect(INJECT_ALLOWLIST.has(cmd), `${cmd} missing from allowlist`).toBe(true);
      expect(INJECT_BLOCKLIST.has(cmd), `${cmd} should not be blocked`).toBe(false);
    }
  });

  it("gateway-text path: /vault, /auth, /doctor, /whoami, /logs, /version, /commands are not allowlisted", () => {
    const gatewayCommands = ["/vault", "/auth", "/doctor", "/whoami", "/logs", "/version", "/commands"];
    for (const cmd of gatewayCommands) {
      expect(INJECT_ALLOWLIST.has(cmd), `${cmd} should NOT be in allowlist`).toBe(false);
      expect(INJECT_BLOCKLIST.has(cmd), `${cmd} should NOT be blocked`).toBe(false);
    }
  });

  it("blocked path: /effort, /login, /logout, /exit, /quit are refused", () => {
    const blocked = ["/effort", "/login", "/logout", "/exit", "/quit"];
    for (const cmd of blocked) {
      expect(INJECT_BLOCKLIST.has(cmd), `${cmd} must be blocked`).toBe(true);
    }
  });
});
