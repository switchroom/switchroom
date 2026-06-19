import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * End-to-end: the `users:` + `serves`/`knows` config (RFC user-concept.md)
 * resolves through scaffoldAgent → resolveUsers() → the same emit paths the
 * raw maps use: `serves` → HINDSIGHT_SENDER_BANKS_JSON in start.sh,
 * `knows` → recallAdditionalBanks in the plugin settings.json.
 */
describe("user concept — serves/knows wire through scaffold", () => {
  let tmpDir: string;
  const telegram = { bot_token: "t", forum_chat_id: "c" } as TelegramConfig;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `user-concept-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serves → sender env; knows → additional banks", () => {
    const config = {
      users: {
        ken: { telegram_ids: ["mekenthompson"], profile_bank: "ken-profile" },
        lisa: { telegram_ids: ["8201250670"], profile_bank: "lisa-profile" },
      },
      agents: { clerk: { topic_name: "Clerk", serves: ["ken"], knows: ["lisa", "kids-profile"] } },
      memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
      telegram,
    } as unknown as SwitchroomConfig;

    const res = scaffoldAgent("clerk", config.agents.clerk as never, tmpDir, telegram, config);

    // serves Ken → speaker-routing sender map in start.sh
    const startSh = readFileSync(join(res.agentDir, "start.sh"), "utf-8");
    const m = startSh.match(/export HINDSIGHT_SENDER_BANKS_JSON=(.+)/);
    expect(m, "sender env should be emitted from serves").not.toBeNull();
    expect(JSON.parse(m![1].replace(/^'/, "").replace(/'$/, ""))).toEqual({
      mekenthompson: "ken-profile",
    });

    // knows Lisa + kids → subject banks in settings.json
    const settings = JSON.parse(
      readFileSync(
        join(res.agentDir, ".claude", "plugins", "hindsight-memory", "settings.json"),
        "utf-8",
      ),
    );
    expect((settings.recallAdditionalBanks as string[]).sort()).toEqual([
      "kids-profile",
      "lisa-profile",
    ]);
  });
});
