/**
 * Tests for src/cli/preflight-mounts.ts — the pre-flight bind-source
 * validator that prevents the 2026-06-23 outage class (missing bind sources
 * silently auto-created as root-owned dirs by Docker).
 */

import { describe, it, expect } from "vitest";
import {
  parseHostBindSources,
  validateBindSources,
  formatPreflightError,
  type BindSourceIssue,
  type PreflightResult,
} from "../src/cli/preflight-mounts.js";

// ---------------------------------------------------------------------------
// parseHostBindSources
// ---------------------------------------------------------------------------

describe("parseHostBindSources — filtering", () => {
  it("skips named volumes (no leading /)", () => {
    const yaml = `
    volumes:
      - broker-klanker-sock:/run/switchroom/broker
      - agent-home:/home/agent
`;
    expect(parseHostBindSources(yaml)).toHaveLength(0);
  });

  it("skips \${HOME}-prefixed lines (docker resolves at up-time)", () => {
    const yaml = `
    volumes:
      - \${HOME}/.switchroom/agents/klanker:/state/agent:ro
`;
    expect(parseHostBindSources(yaml)).toHaveLength(0);
  });

  it("skips tmpfs entries where size= appears in source or target", () => {
    // The parser's filter checks if source OR target contains "size=" —
    // tmpfs short-syntax puts the size option in the third colon-delimited
    // part, so a line like `/tmp:/tmp:size=100m` is NOT skipped by the
    // source/target check (source=/tmp, target=/tmp). The guard is for
    // specs like `tmpfs:/some/path:size=100m` where source contains "size=".
    // Confirm the filter works for the case it was designed for:
    const yaml = `
    volumes:
      - tmpfs:/app/tmp:size=100m
`;
    // "tmpfs" does not start with "/" so it's already filtered by the
    // absolute-path check — returns empty
    expect(parseHostBindSources(yaml)).toHaveLength(0);
  });

  it("returns absolute host sources with correct expectFile inference", () => {
    const yaml = `
    volumes:
      - /home/op/.switchroom/switchroom.yaml:/state/config/switchroom.yaml:ro
      - /home/op/.switchroom/vault-grants.db:/run/switchroom/vault-grants.db:ro
      - /var/log/switchroom/gateway.log:/var/log/switchroom/gateway.log:ro
      - /home/op/.switchroom/agents/klanker/.vault-token:/state/agent/.vault-token:ro
      - /etc/machine-id:/etc/machine-id:ro
      - /home/op/.switchroom/agents/klanker:/state/agent:rw
`;
    const result = parseHostBindSources(yaml);
    // All 6 lines are absolute host paths
    expect(result).toHaveLength(6);

    const switchroomYaml = result.find((r) => r.source.endsWith("switchroom.yaml"));
    expect(switchroomYaml).toBeDefined();
    expect(switchroomYaml!.expectFile).toBe(true);

    const grantsDb = result.find((r) => r.source.endsWith("vault-grants.db"));
    expect(grantsDb).toBeDefined();
    expect(grantsDb!.expectFile).toBe(true);

    const logFile = result.find((r) => r.source.endsWith("gateway.log"));
    expect(logFile).toBeDefined();
    expect(logFile!.expectFile).toBe(true);

    const vaultToken = result.find((r) => r.source.endsWith(".vault-token"));
    expect(vaultToken).toBeDefined();
    expect(vaultToken!.expectFile).toBe(true);

    const machineId = result.find((r) => r.source === "/etc/machine-id");
    expect(machineId).toBeDefined();
    expect(machineId!.expectFile).toBe(true);

    const agentDir = result.find((r) => r.source.endsWith("/klanker"));
    expect(agentDir).toBeDefined();
    expect(agentDir!.expectFile).toBe(false); // directory, no file extension
  });
});

// ---------------------------------------------------------------------------
// validateBindSources — injected stat
// ---------------------------------------------------------------------------

describe("validateBindSources — clean compose", () => {
  it("reports ok=true with no issues when all sources exist and have the right type", () => {
    const yaml = `
    volumes:
      - /home/op/.switchroom/switchroom.yaml:/state/config/switchroom.yaml:ro
      - /home/op/.switchroom/agents/klanker:/state/agent:rw
`;
    const stat = (p: string) => {
      if (p.endsWith("switchroom.yaml")) return { isDirectory: () => false, isFile: () => true };
      if (p.endsWith("klanker")) return { isDirectory: () => true, isFile: () => false };
      throw new Error(`unexpected stat: ${p}`);
    };
    const result = validateBindSources(yaml, { stat });
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.checked).toBe(2);
  });
});

describe("validateBindSources — the 2026-06-23 incident: vault-grants.db source is a directory", () => {
  it("reports expected-file-got-dir when a db/file source is a directory", () => {
    // Exactly the incident: docker auto-created /home/op/.switchroom/vault-grants.db
    // as an empty root-owned directory. Subsequent access via SQLite → EISDIR crash.
    const yaml = `
    volumes:
      - /home/op/.switchroom/vault-grants.db:/run/switchroom/vault-grants.db:ro
`;
    const stat = (_p: string) => ({
      isDirectory: () => true,   // the source is a directory — the bug
      isFile: () => false,
    });
    const result = validateBindSources(yaml, { stat });
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.problem).toBe("expected-file-got-dir");
    expect(issue.source).toContain("vault-grants.db");
  });
});

describe("validateBindSources — missing source", () => {
  it("reports missing when stat throws (source does not exist)", () => {
    const yaml = `
    volumes:
      - /home/op/.switchroom/agents/nonexistent:/state/agent:rw
`;
    const stat = (_p: string) => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    const result = validateBindSources(yaml, { stat });
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].problem).toBe("missing");
    expect(result.issues[0].source).toContain("nonexistent");
  });
});

describe("validateBindSources — no false positive on an extensionless file source", () => {
  // The "expected-dir-got-file" direction was REMOVED: many legit host sources
  // are extensionless FILES (vault-auto-unlock, bin/webkite) mounted at targets
  // that look dir-ish. Flagging them as "should be a dir" false-positived and
  // would block real deploys (caught by e2e against the live fleet compose).
  // A present file source that ISN'T a known-file-hint must NOT be flagged.
  it("does NOT flag a present, extensionless file source (e.g. vault-auto-unlock)", () => {
    const yaml = `
    volumes:
      - /home/op/.switchroom/vault-auto-unlock:/state/vault-auto-unlock:ro
      - /home/op/.switchroom/bin/webkite:/usr/local/bin/webkite:ro
      - /home/op/.switchroom/agents/klanker:/state/agent:rw
`;
    // Every source present; the extensionless ones are FILES, the agent dir is a dir.
    const stat = (p: string) => ({
      isDirectory: () => p.endsWith("/klanker"),
      isFile: () => !p.endsWith("/klanker"),
    });
    const result = validateBindSources(yaml, { stat });
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("STILL flags a known-file source (vault-auto-unlock) that became a directory", () => {
    const yaml = `
    volumes:
      - /home/op/.switchroom/vault-auto-unlock:/state/vault-auto-unlock:ro
`;
    const stat = (_p: string) => ({ isDirectory: () => true, isFile: () => false });
    const result = validateBindSources(yaml, { stat });
    expect(result.ok).toBe(false);
    expect(result.issues[0].problem).toBe("expected-file-got-dir");
  });
});

describe("validateBindSources — deduplication", () => {
  it("counts deduplicated sources in checked", () => {
    // Same source mounted twice (different targets) — should only stat once
    const yaml = `
    volumes:
      - /home/op/.switchroom/switchroom.yaml:/state/config/switchroom.yaml:ro
      - /home/op/.switchroom/switchroom.yaml:/state/config/switchroom.yaml.bak:ro
`;
    const statCalls: string[] = [];
    const stat = (p: string) => {
      statCalls.push(p);
      return { isDirectory: () => false, isFile: () => true };
    };
    const result = validateBindSources(yaml, { stat });
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
    expect(statCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// formatPreflightError
// ---------------------------------------------------------------------------

describe("formatPreflightError", () => {
  it("mentions the offending path", () => {
    const result: PreflightResult = {
      ok: false,
      checked: 3,
      issues: [
        {
          source: "/home/op/.switchroom/vault-grants.db",
          target: "/run/switchroom/vault-grants.db",
          problem: "expected-file-got-dir",
        },
      ],
    };
    const msg = formatPreflightError(result);
    expect(msg).toContain("/home/op/.switchroom/vault-grants.db");
    expect(msg).toContain("expected-file-got-dir");
  });

  it("includes recovery guidance referencing switchroom apply", () => {
    const result: PreflightResult = {
      ok: false,
      checked: 2,
      issues: [
        {
          source: "/home/op/.missing-file",
          target: "/state/missing",
          problem: "missing",
        },
      ],
    };
    const msg = formatPreflightError(result);
    // Should mention the recovery path
    expect(msg).toMatch(/switchroom apply|repair-mounts/);
  });

  it("truncates at 20 issues in the rendered list", () => {
    const issues: BindSourceIssue[] = Array.from({ length: 25 }, (_, i) => ({
      source: `/home/op/.switchroom/file-${i}`,
      target: `/state/file-${i}`,
      problem: "missing" as const,
    }));
    const result: PreflightResult = { ok: false, checked: 25, issues };
    const msg = formatPreflightError(result);
    // The function slices at 20; the total count is still reported
    expect(msg).toContain("25 bind-mount source(s)");
    // Only 20 lines in the rendered list
    const lineCount = (msg.match(/^ {2}- /gm) ?? []).length;
    expect(lineCount).toBe(20);
  });
});
