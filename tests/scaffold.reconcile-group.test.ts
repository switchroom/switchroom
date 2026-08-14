import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { reconcileConfiguredGroup } from "../src/agents/scaffold.js";
import type { AgentConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * reconcileConfiguredGroup — idempotently registers the agent's configured
 * supergroup into access.json (the marko-class fix: access.json is
 * writeIfMissing, so a supergroup added to switchroom.yaml after first
 * scaffold never registered and the gateway dropped its messages as
 * group_unknown). Must be strictly additive + non-destructive.
 */

const SG = "-1001234567890";
const FLEET_FORUM = "-1003852747971"; // a DIFFERENT chat — the shared fleet forum
const agent = (overrides: Partial<AgentConfig> = {}): AgentConfig =>
  ({ extends: "default", ...overrides } as unknown as AgentConfig);
// supergroup-owned: per-agent channels.telegram.chat_id override (the prod shape)
const ownedAgent = (chat_id: string, overrides: Partial<AgentConfig> = {}): AgentConfig =>
  ({ extends: "default", channels: { telegram: { chat_id } }, ...overrides } as unknown as AgentConfig);
const tg = (forum_chat_id: string): TelegramConfig =>
  ({ forum_chat_id } as unknown as TelegramConfig);

let dir: string;
let accessPath: string;
const writeAccess = (obj: unknown) => writeFileSync(accessPath, JSON.stringify(obj, null, 2));
const readAccess = () => JSON.parse(readFileSync(accessPath, "utf-8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reconcile-group-"));
  accessPath = join(dir, "access.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("reconcileConfiguredGroup", () => {
  it("adds the configured supergroup with smart defaults (requireMention:false, all topics)", () => {
    writeAccess({ dmPolicy: "allowlist", allowFrom: ["111", "222"] });
    reconcileConfiguredGroup(accessPath, agent(), tg(SG));
    const a = readAccess();
    expect(a.groups[SG]).toEqual({ requireMention: false, allowFrom: ["111", "222"] });
  });

  it("registers the per-agent chat_id OVERRIDE, not the fleet forum_chat_id (the marko case)", () => {
    // supergroup-owned: channels.telegram.chat_id (SG) must win over the
    // shared fleet forum (FLEET_FORUM). Registering the fleet chat would
    // both miss marko's owned group AND re-introduce the #1002 boot-probe
    // 404 against a chat the bot isn't a member of.
    writeAccess({ dmPolicy: "allowlist", allowFrom: ["111"] });
    reconcileConfiguredGroup(accessPath, ownedAgent(SG), tg(FLEET_FORUM));
    const a = readAccess();
    expect(a.groups[SG]).toEqual({ requireMention: false, allowFrom: ["111"] });
    expect(a.groups[FLEET_FORUM]).toBeUndefined();
  });

  it("registers the owned chat even with no fleet forum_chat_id at all", () => {
    writeAccess({ dmPolicy: "allowlist", allowFrom: ["111"] });
    reconcileConfiguredGroup(accessPath, ownedAgent(SG), tg(""));
    expect(readAccess().groups[SG]).toEqual({ requireMention: false, allowFrom: ["111"] });
  });

  it("preserves existing allowFrom, OTHER groups, and runtime fields (pairings)", () => {
    writeAccess({
      dmPolicy: "allowlist",
      allowFrom: ["111", "222"],
      groups: { "-5164217975": { requireMention: false, allowFrom: ["111"] } },
      pending: { abc123: { senderId: "999", chatId: "999" } },
      stickers: { ok: "CAAC..." },
    });
    reconcileConfiguredGroup(accessPath, agent(), tg(SG));
    const a = readAccess();
    expect(Object.keys(a.groups).sort()).toEqual([SG, "-5164217975"]);
    expect(a.groups["-5164217975"]).toEqual({ requireMention: false, allowFrom: ["111"] });
    expect(a.allowFrom).toEqual(["111", "222"]);
    expect(a.pending).toEqual({ abc123: { senderId: "999", chatId: "999" } });
    expect(a.stickers).toEqual({ ok: "CAAC..." });
  });

  it("does NOT overwrite an existing policy for the same group (operator override survives)", () => {
    writeAccess({
      dmPolicy: "allowlist",
      allowFrom: ["111"],
      groups: { [SG]: { requireMention: true, allowFrom: ["111"], topic_deny: [42] } },
    });
    reconcileConfiguredGroup(accessPath, agent(), tg(SG));
    expect(readAccess().groups[SG]).toEqual({ requireMention: true, allowFrom: ["111"], topic_deny: [42] });
  });

  it("is idempotent — a second run changes nothing", () => {
    writeAccess({ dmPolicy: "allowlist", allowFrom: ["111"] });
    reconcileConfiguredGroup(accessPath, agent(), tg(SG));
    const first = readFileSync(accessPath, "utf-8");
    reconcileConfiguredGroup(accessPath, agent(), tg(SG));
    expect(readFileSync(accessPath, "utf-8")).toBe(first);
  });

  it("no-ops for dm_only agents", () => {
    writeAccess({ dmPolicy: "allowlist", allowFrom: ["111"] });
    reconcileConfiguredGroup(accessPath, agent({ dm_only: true }), tg(SG));
    expect(readAccess().groups).toBeUndefined();
  });

  it("no-ops when no real forum chat is in scope (empty / sentinel)", () => {
    writeAccess({ dmPolicy: "allowlist", allowFrom: ["111"] });
    reconcileConfiguredGroup(accessPath, agent(), tg(""));
    reconcileConfiguredGroup(accessPath, agent(), tg("0"));
    expect(readAccess().groups).toBeUndefined();
  });

  it("no-ops when access.json is absent (fresh agent — buildAccessJson owns it)", () => {
    expect(existsSync(accessPath)).toBe(false);
    reconcileConfiguredGroup(accessPath, agent(), tg(SG));
    expect(existsSync(accessPath)).toBe(false);
  });
});
