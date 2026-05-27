import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decide, ACK_SENT_MARKER, type HookInput } from "./ack-first-pretool.js";

describe("ack-first-pretool — decide()", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ack-first-pretool-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  describe("reply tools always allowed", () => {
    it("allows mcp__switchroom-telegram__reply with no ack flag present", () => {
      const input: HookInput = {
        tool_name: "mcp__switchroom-telegram__reply",
        tool_input: { chat_id: "1", text: "hi" },
      };
      expect(decide(input, stateDir)).toEqual({ decision: "allow" });
    });

    it("allows mcp__switchroom-telegram__stream_reply with no ack flag present", () => {
      const input: HookInput = {
        tool_name: "mcp__switchroom-telegram__stream_reply",
        tool_input: { chat_id: "1", text: "hi" },
      };
      expect(decide(input, stateDir)).toEqual({ decision: "allow" });
    });
  });

  describe("non-reply tools gated on ack flag", () => {
    it("blocks WebSearch when no ack flag exists", () => {
      const input: HookInput = {
        tool_name: "WebSearch",
        tool_input: { query: "test" },
      };
      const result = decide(input, stateDir);
      expect(result.decision).toBe("block");
      expect(result.reason).toMatch(/acknowledgement/);
      expect(result.reason).toMatch(/mcp__switchroom-telegram__reply/);
    });

    it("blocks Bash when no ack flag exists", () => {
      const input: HookInput = {
        tool_name: "Bash",
        tool_input: { command: "ls" },
      };
      expect(decide(input, stateDir).decision).toBe("block");
    });

    it("allows non-reply tools once the ack flag is present", () => {
      writeFileSync(join(stateDir, ACK_SENT_MARKER), "");
      const tools = [
        "WebSearch",
        "WebFetch",
        "Bash",
        "Read",
        "mcp__google-workspace__list_drive_files",
        "Task",
      ];
      for (const tool_name of tools) {
        expect(decide({ tool_name }, stateDir).decision).toBe("allow");
      }
    });

    it("blocks again after the flag is removed (turn-restart simulation)", () => {
      writeFileSync(join(stateDir, ACK_SENT_MARKER), "");
      expect(decide({ tool_name: "Bash" }, stateDir).decision).toBe("allow");
      // turn_started clears the flag
      rmSync(join(stateDir, ACK_SENT_MARKER));
      expect(decide({ tool_name: "Bash" }, stateDir).decision).toBe("block");
    });
  });

  describe("fail-open shape", () => {
    it("allows when stateDir is undefined (misconfigured agent)", () => {
      expect(decide({ tool_name: "Bash" }, undefined).decision).toBe("allow");
    });

    it("allows when stateDir is empty string", () => {
      expect(decide({ tool_name: "Bash" }, "").decision).toBe("allow");
    });

    it("blocks (not crashes) when stateDir path is unreadable but tool is non-reply", () => {
      // Pointing at a non-existent dir: existsSync(.../ack-sent.flag) just
      // returns false. So the hook blocks — same as the "no ack yet" case.
      const phantom = join(stateDir, "does-not-exist");
      expect(decide({ tool_name: "Bash" }, phantom).decision).toBe("block");
    });

    it("allows reply tools even with undefined stateDir", () => {
      expect(
        decide({ tool_name: "mcp__switchroom-telegram__reply" }, undefined)
          .decision,
      ).toBe("allow");
    });

    it("allows when tool_name is missing (protocol-error → fail-open)", () => {
      // A Claude Code protocol error (no tool_name) shouldn't gate
      // anything — we don't know what we'd be gating. Fail-open per
      // the file-doc.
      expect(decide({}, stateDir).decision).toBe("allow");
      expect(decide({ tool_name: "" }, stateDir).decision).toBe("allow");
    });
  });
});
