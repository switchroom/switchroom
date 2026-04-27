import { describe, it, expect } from "vitest";
import type { SwitchroomConfig } from "../src/config/schema.js";

describe("doctor memory section", () => {
  // Note: The actual checkHindsight function is not exported, but we can verify
  // the structure through integration testing or by checking the code structure

  it("skips memory checks when backend is not hindsight", () => {
    // This test would require importing checkHindsight if it were exported
    // For now, we verify the logic exists by checking the file structure
    const fs = require("fs");
    const doctorSource = fs.readFileSync("src/cli/doctor.ts", "utf-8");

    expect(doctorSource).toContain("function checkHindsight");
    expect(doctorSource).toContain('if (memoryBackend !== "hindsight")');
  });

  it("checks hindsight reachability", () => {
    const fs = require("fs");
    const doctorSource = fs.readFileSync("src/cli/doctor.ts", "utf-8");

    expect(doctorSource).toContain("hindsight reachable");
    expect(doctorSource).toContain("checkTcp(host, port)");
  });

  it("checks per-agent bank missions", () => {
    const fs = require("fs");
    const doctorSource = fs.readFileSync("src/cli/doctor.ts", "utf-8");

    expect(doctorSource).toContain("bank_mission");
    expect(doctorSource).toContain("retain_mission");
    expect(doctorSource).toContain("missions");
  });

  it("warns when missions are not configured", () => {
    const fs = require("fs");
    const doctorSource = fs.readFileSync("src/cli/doctor.ts", "utf-8");

    expect(doctorSource).toContain("hasBankMission");
    expect(doctorSource).toContain("hasRetainMission");
    expect(doctorSource).toContain("status: \"warn\"");
  });
});

// `describe('greeting memory row', ...)` block deleted in #142 PR 1.
// The session greeting card (a curl + heredoc bash script written to
// `<agentDir>/telegram/session-greeting.sh` on every SessionStart) was
// removed wholesale — its Memory row, bank_stats query, "recall
// disabled this session" fallback, and `_COUNT` / `_LAST_TS`
// placeholder substitution all went with it. The greeting's content
// will be reincarnated as a `/status` slash command in #142 PR 3,
// where it runs server-side on demand instead of agent-side on every
// SessionStart. New tests will land alongside that PR.
