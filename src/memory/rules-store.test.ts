import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAuditChain, CHAIN_GENESIS } from "../util/audit-hashchain.js";
import { parseRulesBlock, RULES_BLOCK_BEGIN, RULES_BLOCK_END } from "./rules-block.js";
import {
  createRule,
  retireRule,
  editYoursContent,
  verifyIntegrity,
  listRules,
  BudgetExceededError,
  MarkerBlockOverlapError,
  InvalidRuleError,
} from "./rules-store.js";

const MARKER = "# --- Yours (preserved across apply) ---";

let agentDir: string;

function claudeMdPath() {
  return join(agentDir, "CLAUDE.md");
}
function mutationLogPath() {
  return join(agentDir, "memory", "rules-mutation.log");
}
function archivePath() {
  return join(agentDir, "memory", "rules-archive.md");
}

function seedAgent(yoursBody = "This space is yours.") {
  writeFileSync(
    claudeMdPath(),
    `# Managed section\n\nsome rendered template content\n\n${MARKER}\n\n${yoursBody}\n`,
    "utf-8",
  );
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "rules-store-test-"));
  seedAgent();
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("T1 — round-trip create/retire", () => {
  it("createRule: the block carries the new rule with id/source/created_at populated, one chained log row", () => {
    const { rule } = createRule(agentDir, {
      text: "Always run tests before merging.",
      source: "telegram",
      actor: "klanker",
    });

    expect(rule.id).toBe("R-01");
    expect(rule.source).toBe("telegram");
    expect(rule.created_at).toBeTruthy();

    const onDisk = readFileSync(claudeMdPath(), "utf-8");
    const parsed = parseRulesBlock(onDisk);
    expect(parsed!.rules).toEqual([rule]);

    const logText = readFileSync(mutationLogPath(), "utf-8");
    const verify = verifyAuditChain(logText, CHAIN_GENESIS);
    expect(verify.ok).toBe(true);
    expect(verify.rows).toBe(1);
  });

  it("retireRule: rule absent from block, present in archive with status retired", () => {
    const { rule } = createRule(agentDir, {
      text: "Always run tests before merging.",
      source: "telegram",
      actor: "klanker",
    });

    retireRule(agentDir, rule.id, { actor: "klanker" });

    const onDisk = readFileSync(claudeMdPath(), "utf-8");
    const parsed = parseRulesBlock(onDisk);
    expect(parsed!.rules.find((r) => r.id === rule.id)).toBeUndefined();

    const archive = readFileSync(archivePath(), "utf-8");
    expect(archive).toContain(`## ${rule.id} (status: retired)`);
    expect(archive).toContain("Always run tests before merging.");

    const logText = readFileSync(mutationLogPath(), "utf-8");
    const verify = verifyAuditChain(logText, CHAIN_GENESIS);
    expect(verify.ok).toBe(true);
    expect(verify.rows).toBe(2);
  });

  it("retireRule with supersededBy records it in the archive entry", () => {
    const first = createRule(agentDir, {
      text: "Old rule text.",
      source: "telegram",
      actor: "klanker",
    }).rule;
    const second = createRule(agentDir, {
      text: "New rule text.",
      source: "telegram",
      actor: "klanker",
    }).rule;

    retireRule(agentDir, first.id, { actor: "klanker", supersededBy: second.id });

    const archive = readFileSync(archivePath(), "utf-8");
    expect(archive).toContain(`superseded-by: ${second.id}`);
  });
});

describe("T2 — hash-chain break localizes the exact tamper", () => {
  it("verifyIntegrity reports brokenAtLine===1 and a reason string when row 1's body is rewritten", () => {
    createRule(agentDir, { text: "First rule.", source: "telegram", actor: "klanker" });
    createRule(agentDir, { text: "Second rule.", source: "telegram", actor: "klanker" });

    const logText = readFileSync(mutationLogPath(), "utf-8");
    const lines = logText.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);

    // Tamper: rewrite row 1's body (parse, mutate a domain field, keep
    // the original chain fields so the corruption is a body edit, not
    // a truncation — the exact case verifyAuditChain's "hash mismatch"
    // reason targets).
    const row1 = JSON.parse(lines[0]);
    row1.action = "retire"; // was "create" — body mutated post-hoc
    lines[0] = JSON.stringify(row1);
    writeFileSync(mutationLogPath(), lines.join("\n") + "\n", "utf-8");

    const result = verifyIntegrity(agentDir);
    expect(result.ok).toBe(false);
    expect(result.chainBrokenAtLine).toBe(1);
    expect(result.chainReason).toMatch(/hash mismatch/);
  });
});

describe("T3 (store half) — tamper detection surfaces a diff-bearing detail", () => {
  it("verifyIntegrity FAILs with a detail naming the sentinel mismatch when the block is hand-edited", () => {
    const { rule } = createRule(agentDir, {
      text: "Original rule text.",
      source: "telegram",
      actor: "klanker",
    });

    // Tamper: hand-edit the block bytes directly on disk (bypassing the tool).
    const before = readFileSync(claudeMdPath(), "utf-8");
    const tampered = before.replace("Original rule text.", "Tampered rule text.");
    writeFileSync(claudeMdPath(), tampered, "utf-8");

    const result = verifyIntegrity(agentDir);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("sentinel mismatch");
    expect(result.detail.length).toBeGreaterThan(0);
    // Never a bare boolean-only signal — the whole point is a human-visible diff.
    void rule;
  });
});

describe("T4 — budget refusal leaves the file byte-identical", () => {
  it("createRule throws BudgetExceededError and writes nothing when the block would exceed 6144 bytes", () => {
    const before = readFileSync(claudeMdPath(), "utf-8");
    const logExistedBefore = existsSync(mutationLogPath());

    const hugeText = "x".repeat(7000);
    expect(() =>
      createRule(agentDir, { text: hugeText, source: "telegram", actor: "klanker" }),
    ).toThrow(BudgetExceededError);

    const after = readFileSync(claudeMdPath(), "utf-8");
    expect(after).toBe(before);
    expect(existsSync(mutationLogPath())).toBe(logExistedBefore);
  });
});

describe("T6 — edit-Yours guard", () => {
  it("succeeds writing non-block free text, round-tripping through the marker", () => {
    editYoursContent(agentDir, "New free-text notes about the household.", {
      actor: "operator",
    });
    const onDisk = readFileSync(claudeMdPath(), "utf-8");
    expect(onDisk).toContain("New free-text notes about the household.");
    expect(onDisk.split(MARKER).length).toBe(2); // exactly one marker occurrence
  });

  it("refuses (throws) when the new content contains a marker-block delimiter, file byte-identical", () => {
    const before = readFileSync(claudeMdPath(), "utf-8");
    expect(() =>
      editYoursContent(
        agentDir,
        "sneaky text <!-- switchroom:rules:begin -->\nfoo\n<!-- switchroom:rules:end -->",
        { actor: "operator" },
      ),
    ).toThrow(MarkerBlockOverlapError);
    const after = readFileSync(claudeMdPath(), "utf-8");
    expect(after).toBe(before);
  });

  it("editYoursContent preserves an existing rules block verbatim", () => {
    const { rule } = createRule(agentDir, {
      text: "Keep me.",
      source: "telegram",
      actor: "klanker",
    });
    editYoursContent(agentDir, "Updated free text.", { actor: "operator" });
    const rules = listRules(agentDir);
    expect(rules).toEqual([rule]);
  });
});

describe("MAJOR — whole-block deletion is detected as tamper (not dark)", () => {
  it("verifyIntegrity FAILs when the block markers are sed-deleted but the log head records a non-empty rule set", () => {
    createRule(agentDir, { text: "Do not delete me.", source: "telegram", actor: "klanker" });
    // Sanity: clean before tamper.
    expect(verifyIntegrity(agentDir).ok).toBe(true);

    // Tamper: delete the ENTIRE rules block (both markers + body), the exact
    // `sed -i` "delete the whole block" bypass. The mutation log is untouched,
    // so its head still records the non-empty rule set.
    const before = readFileSync(claudeMdPath(), "utf-8");
    const b = before.indexOf(RULES_BLOCK_BEGIN);
    const e = before.indexOf(RULES_BLOCK_END) + RULES_BLOCK_END.length;
    const stripped = before.slice(0, b) + before.slice(e);
    expect(stripped).not.toContain(RULES_BLOCK_BEGIN);
    writeFileSync(claudeMdPath(), stripped, "utf-8");

    const result = verifyIntegrity(agentDir);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("deleted");
  });

  it("stays dark (ok) when there is genuinely no block and no logged non-empty state", () => {
    // No rule ever created → no log, no block → nothing to verify.
    expect(verifyIntegrity(agentDir).ok).toBe(true);
  });
});

describe("MAJOR — text/source normalization prevents false tamper", () => {
  it("a rule added with an embedded newline verifies OK (stored == rendered == parsed)", () => {
    createRule(agentDir, {
      text: "First line.\n\nSecond   line with   double spaces.",
      source: "telegram",
      actor: "klanker",
    });
    const result = verifyIntegrity(agentDir);
    expect(result.ok).toBe(true);
    // The stored/rendered text is the flattened form.
    const rules = listRules(agentDir);
    expect(rules[0].text).toBe("First line. Second line with double spaces.");
  });

  it("a rule whose SOURCE contains a comma verifies OK (source is validated/rejected, not silently dropped)", () => {
    // A comma in source would truncate ruleLineRe and drop the rule at parse
    // → false tamper. It must be REFUSED at ingestion instead.
    expect(() =>
      createRule(agentDir, { text: "Rule text.", source: "telegram, urgent", actor: "klanker" }),
    ).toThrow(InvalidRuleError);
    // Nothing written.
    expect(existsSync(mutationLogPath())).toBe(false);
  });

  it("a legal source (no delimiter chars) round-trips and verifies OK", () => {
    createRule(agentDir, { text: "Rule text.", source: "telegram-urgent", actor: "klanker" });
    expect(verifyIntegrity(agentDir).ok).toBe(true);
    expect(listRules(agentDir)[0].source).toBe("telegram-urgent");
  });

  it("rejects rule text containing the literal end-marker substring, file byte-identical", () => {
    const before = readFileSync(claudeMdPath(), "utf-8");
    expect(() =>
      createRule(agentDir, {
        text: `sneaky ${RULES_BLOCK_END} truncation`,
        source: "telegram",
        actor: "klanker",
      }),
    ).toThrow(InvalidRuleError);
    expect(readFileSync(claudeMdPath(), "utf-8")).toBe(before);
    expect(existsSync(mutationLogPath())).toBe(false);
  });
});

describe("MEDIUM — over-budget --supersedes must not archive before the budget check", () => {
  it("createRule with supersedes over budget throws, writes NO archive entry, no log row, file byte-identical", () => {
    // Seed a small first rule to supersede.
    const first = createRule(agentDir, {
      text: "Original small rule.",
      source: "telegram",
      actor: "klanker",
    }).rule;

    const before = readFileSync(claudeMdPath(), "utf-8");
    const logBefore = readFileSync(mutationLogPath(), "utf-8");
    const archiveExistedBefore = existsSync(archivePath());

    const hugeText = "x".repeat(7000);
    expect(() =>
      createRule(agentDir, {
        text: hugeText,
        source: "telegram",
        actor: "klanker",
        supersedes: first.id,
      }),
    ).toThrow(BudgetExceededError);

    // File + log unchanged; NO archive entry created (the retire was not
    // committed because the budget check refused the whole mutation).
    expect(readFileSync(claudeMdPath(), "utf-8")).toBe(before);
    expect(readFileSync(mutationLogPath(), "utf-8")).toBe(logBefore);
    expect(existsSync(archivePath())).toBe(archiveExistedBefore);
    // The first rule is still ACTIVE (not phantom-retired).
    expect(listRules(agentDir).map((r) => r.id)).toEqual([first.id]);
  });
});
