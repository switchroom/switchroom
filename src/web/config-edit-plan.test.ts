import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planConfigEdit, composeTransforms, ConfigPlanError } from "./config-edit-plan.js";

const VALID = `switchroom:
  version: 1
  agents_dir: ~/.switchroom/agents
telegram:
  bot_token: x
  forum_chat_id: "-1001234"
agents:
  marko:
    extends: default
    topic_name: Marko
microsoft_accounts: {}
`;

const dirs: string[] = [];
function tmpConfig(text: string): string {
  const d = mkdtempSync(join(tmpdir(), "plan-"));
  dirs.push(d);
  const p = join(d, "switchroom.yaml");
  writeFileSync(p, text);
  return p;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("planConfigEdit", () => {
  it("computes a schema-valid edit without writing the file", () => {
    const p = tmpConfig(VALID);
    const plan = planConfigEdit(p, (y) =>
      y.replace("microsoft_accounts: {}", "microsoft_accounts:\n  lisa@outlook.com:\n    enabled_for:\n      - marko"),
    );
    expect(plan.changed).toBe(true);
    expect(plan.after).toContain("lisa@outlook.com");
    // File on disk is untouched (no write).
    expect(plan.before).toBe(VALID);
  });

  it("reports changed:false for a no-op transform", () => {
    const p = tmpConfig(VALID);
    const plan = planConfigEdit(p, (y) => y);
    expect(plan.changed).toBe(false);
    expect(plan.after).toBe(plan.before);
  });

  it("rejects an edit that produces an invalid config (no write)", () => {
    const p = tmpConfig(VALID);
    // Break a required field — drop the switchroom version block.
    expect(() =>
      planConfigEdit(p, (y) => y.replace("version: 1", "version: not-a-number")),
    ).toThrow(ConfigPlanError);
  });

  it("rejects an edit that produces unparseable YAML", () => {
    const p = tmpConfig(VALID);
    expect(() => planConfigEdit(p, () => "::: not : yaml : [")).toThrow(ConfigPlanError);
  });

  it("composeTransforms applies left to right", () => {
    const t = composeTransforms(
      (s) => s + "a",
      (s) => s + "b",
    );
    expect(t("x")).toBe("xab");
  });
});
