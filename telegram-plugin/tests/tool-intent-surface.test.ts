import { describe, it, expect } from "vitest";
import { deriveIntentSurface } from "../tool-intent-surface.js";

describe("deriveIntentSurface — gateway lifts model's tool intent into framework-voice status", () => {
  describe("tool-class verb mapping", () => {
    it("Bash → running", () => {
      const out = deriveIntentSurface("Bash", { command: "ls -la /var/log" });
      expect(out.text).toContain("<i>running:</i>");
      expect(out.text).toContain("ls -la /var/log");
    });

    it("WebSearch → searching", () => {
      const out = deriveIntentSurface("WebSearch", { query: "Victoria drink driving" });
      expect(out.text).toContain("<i>searching:</i>");
      expect(out.text).toContain("Victoria drink driving");
    });

    it("WebFetch → fetching (hostname extracted)", () => {
      const out = deriveIntentSurface("WebFetch", { url: "https://example.com/a/b" });
      expect(out.text).toContain("<i>fetching:</i>");
      expect(out.text).toContain("example.com");
    });

    it("Read → reading (basename only)", () => {
      const out = deriveIntentSurface("Read", { file_path: "/etc/os-release" });
      expect(out.text).toContain("<i>reading:</i>");
      expect(out.text).toContain("os-release");
      expect(out.text).not.toContain("/etc/");
    });

    it("Write → writing", () => {
      const out = deriveIntentSurface("Write", { file_path: "/tmp/hello.sh" });
      expect(out.text).toContain("<i>writing:</i>");
      expect(out.text).toContain("hello.sh");
    });

    it("Edit / MultiEdit / NotebookEdit → editing", () => {
      for (const t of ["Edit", "MultiEdit", "NotebookEdit"]) {
        expect(
          deriveIntentSurface(t, { file_path: "/a/foo.ts" }).text,
        ).toContain("<i>editing:</i>");
      }
    });

    it("Grep / Glob → searching", () => {
      expect(
        deriveIntentSurface("Grep", { pattern: "TODO", path: "src/" }).text,
      ).toContain("<i>searching:</i>");
      expect(
        deriveIntentSurface("Glob", { pattern: "**/*.ts" }).text,
      ).toContain("<i>searching:</i>");
    });

    it("Task / Agent → dispatching", () => {
      expect(
        deriveIntentSurface("Task", { description: "review the auth code" }).text,
      ).toContain("<i>dispatching:</i>");
    });
  });

  describe("user-facing tools stay quiet (never re-surfaced)", () => {
    const surfaceTools = [
      "mcp__switchroom-telegram__reply",
      "mcp__switchroom-telegram__stream_reply",
      "mcp__switchroom-telegram__edit_message",
      "mcp__switchroom-telegram__react",
      "mcp__switchroom-telegram__send_typing",
      "mcp__switchroom-telegram__progress_update",
    ];
    for (const tool of surfaceTools) {
      it(`returns null for ${tool}`, () => {
        expect(
          deriveIntentSurface(tool, { text: "hi", chat_id: "1" }).text,
        ).toBeNull();
      });
    }
  });

  describe("unknown MCP tools", () => {
    it("uses 'using <tool>' for unknown MCP tool servers", () => {
      const out = deriveIntentSurface(
        "mcp__google-workspace__list_drive_files",
        { folderId: "abc" },
      );
      expect(out.text).toMatch(/<i>using list[ _]drive[ _]files:?<\/i>/);
    });

    it("falls back gracefully when input has no recognisable label field", () => {
      const out = deriveIntentSurface("Bash", { weird: "no-command-here" });
      // No label resolved → verb-only output
      expect(out.text).toBe("<i>running</i>");
    });
  });

  describe("privacy / safety", () => {
    it("escapes HTML in the label so a malicious input can't inject markup", () => {
      const out = deriveIntentSurface("Bash", {
        command: "echo '<script>alert(1)</script>'",
      });
      expect(out.text).not.toContain("<script>");
      expect(out.text).toContain("&lt;script&gt;");
    });

    it("truncates long labels to keep the surface message tight", () => {
      const longCmd = "echo " + "x".repeat(500);
      const out = deriveIntentSurface("Bash", { command: longCmd });
      // toolLabel already truncates Bash to 40 chars; safety cap then
      // bounds anything else to MAX_LABEL_LEN.
      expect((out.text ?? "").length).toBeLessThan(200);
    });

    it("returns null when toolName is empty (defensive)", () => {
      expect(deriveIntentSurface("", { command: "x" }).text).toBeNull();
    });
  });

  describe("precomputed label precedence", () => {
    it("uses precomputed label when present (matches toolLabel's contract)", () => {
      const out = deriveIntentSurface(
        "Bash",
        { command: "ls" },
        "checking the logs",
      );
      expect(out.text).toContain("<i>running:</i>");
      expect(out.text).toContain("checking the logs");
    });
  });
});
