import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  enqueueEvalCaseProposal,
  setEvalCaseProposalStatus,
} from "../src/self-improve/eval-case-proposals.js";
import { evalsJsonPath } from "../src/self-improve/eval-gate.js";
import { verifyEvalIntegrity } from "../src/self-improve/eval-cases.js";

const bunOk = spawnSync("which", ["bun"], { encoding: "utf-8" }).status === 0;
const CLI = join(process.cwd(), "bin", "switchroom.ts");

let home: string;
let stateDir: string;
let skillDir: string;

function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bun", [CLI, ...args], {
    encoding: "utf-8",
    timeout: 30000,
    env: {
      ...process.env,
      HOME: home,
      TELEGRAM_STATE_DIR: stateDir,
      SWITCHROOM_AGENT_NAME: "tester",
      SWITCHROOM_SELF_IMPROVE: "1",
      ...env,
    },
  });
  return { status: r.status ?? -1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "evcase-cli-home-"));
  stateDir = mkdtempSync(join(tmpdir(), "evcase-cli-state-"));
  skillDir = join(home, ".claude", "skills", "myskill");
  mkdirSync(skillDir, { recursive: true });
});
afterEach(() => {
  for (const d of [home, stateDir]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe("add-eval-case (propose-only)", () => {
  it("rejects an unowned skill", () => {
    if (!bunOk) return;
    const r = cli(["self-improve", "add-eval-case", "--skill", "ghost", "--prompt", "be terse", "--chat", "1"]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/not an owned skill/i);
  });

  it("FAIL-CLOSED: rejects a prompt carrying PII before any IPC (invariant I4)", () => {
    if (!bunOk) return;
    const r = cli(["self-improve", "add-eval-case", "--skill", "myskill", "--prompt", "email me at bob@example.com", "--chat", "1"]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/PII\/secret scan found/);
    expect(r.err).toMatch(/email/);
  });

  it("on a clean prompt, sends a post_eval_case_proposal IPC to the gateway socket", async () => {
    if (!bunOk) return;
    const sockPath = join(stateDir, "gateway.sock");
    const received: string[] = [];
    const server: Server = await new Promise((resolve) => {
      const s = createServer((conn) => {
        let buf = "";
        conn.on("data", (d) => (buf += d.toString()));
        conn.on("end", () => received.push(buf));
      });
      s.listen(sockPath, () => resolve(s));
    });
    try {
      const r = cli(
        ["self-improve", "add-eval-case", "--skill", "myskill", "--prompt", "keep replies terse", "--chat", "12345"],
        { SWITCHROOM_GATEWAY_SOCKET: sockPath },
      );
      expect(r.status).toBe(0);
      expect(JSON.parse(r.out).ok).toBe(true);
      // Give the server a tick to flush the connection 'end'.
      await new Promise((res) => setTimeout(res, 50));
      expect(received.length).toBe(1);
      const msg = JSON.parse(received[0]!.trim());
      expect(msg.type).toBe("post_eval_case_proposal");
      expect(msg.agentName).toBe("tester");
      expect(msg.chatId).toBe("12345");
      expect(msg.skillSlug).toBe("myskill");
      expect(msg.case.prompt).toBe("keep replies terse");
      expect(typeof msg.fingerprint).toBe("string");
    } finally {
      await new Promise((res) => server.close(() => res(null)));
    }
  });
});

describe("apply-eval-case (deterministic applier)", () => {
  function seed(caseObj: { prompt: string }, status: "pending" | "approved") {
    const p = enqueueEvalCaseProposal(stateDir, {
      skill_slug: "myskill",
      skill_dir: skillDir,
      case: caseObj,
      fingerprint: "fp-" + caseObj.prompt.length,
      held_out: false,
      chat_id: 1,
    });
    if (status === "approved") setEvalCaseProposalStatus(stateDir, p.id, "approved");
    return p.id;
  }

  it("refuses a proposal that is not approved (defense-in-depth, MJ2)", () => {
    if (!bunOk) return;
    const id = seed({ prompt: "be terse" }, "pending");
    const r = cli(["self-improve", "apply-eval-case", "--id", id]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/not "approved"|refusing to apply/i);
  });

  it("applies an approved case byte-exact and records the integrity baseline", () => {
    if (!bunOk) return;
    const id = seed({ prompt: "be terse" }, "approved");
    const r = cli(["self-improve", "apply-eval-case", "--id", id]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.applied).toBe(true);
    expect(out.total).toBe(1);
    const doc = JSON.parse(readFileSync(evalsJsonPath(skillDir), "utf8"));
    expect(doc.evals[0].prompt).toBe("be terse");
    // Applier recorded its own write as the baseline → no spurious drift.
    expect(verifyEvalIntegrity(stateDir, "myskill", skillDir)).toBe("ok");
  });

  it("FAIL-CLOSED: re-scans at apply and refuses a stored case carrying PII (I4 both ends)", () => {
    if (!bunOk) return;
    const id = seed({ prompt: "call 415-555-2671" }, "approved");
    const r = cli(["self-improve", "apply-eval-case", "--id", id]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/PII\/secret scan found/);
    // Nothing was written to the skill.
    expect(existsSync(evalsJsonPath(skillDir))).toBe(false);
  });
});
