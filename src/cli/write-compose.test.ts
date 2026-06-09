/**
 * writeComposeFile — the single source of truth shared by `apply` and the
 * `agent restart` reconcile path. Pins: the written compose carries the
 * release pin's image tag, and the changed/previousImageTag drift signals
 * are correct. Writes to an isolated tmpdir — never ~/.switchroom.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwitchroomConfig } from "../config/schema.js";
import { writeComposeFile } from "./write-compose.js";

function mkConfig(pin?: string): SwitchroomConfig {
  return {
    telegram: { bot_token: "x", forum_chat_id: "-100" },
    ...(pin ? { release: { pin } } : {}),
    agents: { clerk: { extends: "default" } },
  } as unknown as SwitchroomConfig;
}

describe("writeComposeFile", () => {
  it("writes the compose with the release pin's image tag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-"));
    const composePath = join(dir, "compose", "docker-compose.yml");
    const r = await writeComposeFile({ config: mkConfig("v0.14.92"), composePath, switchroomConfigPath: undefined });
    expect(r.imageTag).toBe("v0.14.92");
    expect(r.changed).toBe(true);
    expect(r.previousImageTag).toBeNull(); // first write, no prior file
    const content = readFileSync(composePath, "utf8");
    expect(content).toContain("switchroom-agent:v0.14.92");
  });

  it("reports the previous image tag + changed=true when the pin moves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-"));
    const composePath = join(dir, "docker-compose.yml");
    await writeComposeFile({ config: mkConfig("v0.14.91"), composePath, switchroomConfigPath: undefined });
    const r = await writeComposeFile({ config: mkConfig("v0.14.92"), composePath, switchroomConfigPath: undefined });
    expect(r.previousImageTag).toBe("v0.14.91");
    expect(r.imageTag).toBe("v0.14.92");
    expect(r.changed).toBe(true);
    expect(readFileSync(composePath, "utf8")).toContain("switchroom-agent:v0.14.92");
  });

  it("changed=false when re-writing the same pin (idempotent)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-"));
    const composePath = join(dir, "docker-compose.yml");
    await writeComposeFile({ config: mkConfig("v0.14.92"), composePath, switchroomConfigPath: undefined });
    const r = await writeComposeFile({ config: mkConfig("v0.14.92"), composePath, switchroomConfigPath: undefined });
    expect(r.changed).toBe(false);
    expect(r.previousImageTag).toBe("v0.14.92");
  });
});
