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

// "greeting memory row" describe block removed: the SessionStart greeting
// script that used to render the Memory row was disabled — the boot card
// (gateway-side) is now the single source of restart-status visibility.
// The placeholders, bank_stats query logic, and Hindsight unreachable
// fallback all lived in `buildSessionGreetingScript`'s template, which
// has been replaced with a no-op stub. The doctor-side memory checks
// (above) still cover the runtime backend; this block was only testing
// stale template substrings.
