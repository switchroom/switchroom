import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handlePostSkillProposal } from "../telegram-plugin/gateway/self-improve-proposal-wiring.js";
import type { PostSkillProposalMessage } from "../telegram-plugin/gateway/ipc-protocol.js";
import type { ProposalWiringDeps } from "../telegram-plugin/gateway/self-improve-proposal-wiring.js";
import { readProposals } from "../src/self-improve/skill-proposals.js";

const bunOk = spawnSync("which", ["bun"], { encoding: "utf-8" }).status === 0;
const CLI = join(process.cwd(), "bin", "switchroom.ts");

let home: string;
let stateDir: string;
let draftPath: string;

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

/** Spawn propose-skill against a stub gateway socket; return the parsed IPC. */
async function captureIpc(args: string[]): Promise<Record<string, unknown>> {
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
      ["self-improve", "propose-skill", "--draft", draftPath, ...args],
      { SWITCHROOM_GATEWAY_SOCKET: sockPath },
    );
    expect(r.status).toBe(0);
    await new Promise((res) => setTimeout(res, 50));
    expect(received.length).toBe(1);
    return JSON.parse(received[0]!.trim()) as Record<string, unknown>;
  } finally {
    await new Promise((res) => server.close(() => res(null)));
  }
}

/** Feed a captured IPC message through the gateway handler (the enqueue leg). */
function runHandler(msg: PostSkillProposalMessage): void {
  // The handler resolves its store + identity from the environment, exactly as
  // it does inside the gateway process.
  process.env.TELEGRAM_STATE_DIR = stateDir;
  process.env.SWITCHROOM_AGENT_NAME = "tester";
  const deps: ProposalWiringDeps = {
    // Minimal stub — we only exercise the persist path, not the card render.
    bot: { api: { sendMessage: async () => ({}) } } as unknown as ProposalWiringDeps["bot"],
    assertAllowedChat: () => {},
    swallowingApiCall: async (fn) => fn(),
  };
  handlePostSkillProposal(msg, deps);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "propose-cli-home-"));
  stateDir = mkdtempSync(join(tmpdir(), "propose-cli-state-"));
  draftPath = join(home, "draft.json");
  writeFileSync(
    draftPath,
    JSON.stringify({ "SKILL.md": "---\nname: t\ndescription: d\n---\nbody\n" }),
  );
});
afterEach(() => {
  for (const d of [home, stateDir]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe("propose-skill --origin (R1: origin threaded CLI → IPC → store)", () => {
  it("threads --origin failure-synthesis into the IPC and persists it (not the default)", async () => {
    if (!bunOk) return;
    const msg = await captureIpc([
      "--slug", "myskill",
      "--lesson", "always X",
      "--chat", "12345",
      "--origin", "failure-synthesis",
    ]);
    expect(msg.type).toBe("post_skill_proposal");
    expect(msg.origin).toBe("failure-synthesis");

    // Full round-trip: run the captured IPC through the gateway enqueue, then
    // read the persisted store — the origin must survive as failure-synthesis.
    runHandler(msg as unknown as PostSkillProposalMessage);
    const stored = readProposals(stateDir);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.origin).toBe("failure-synthesis");
  });

  it("absent --origin ⇒ no origin on the IPC and store default (skill-synthesis, back-compat)", async () => {
    if (!bunOk) return;
    const msg = await captureIpc([
      "--slug", "myskill",
      "--lesson", "always X",
      "--chat", "12345",
    ]);
    expect(msg.origin).toBeUndefined();

    runHandler(msg as unknown as PostSkillProposalMessage);
    const stored = readProposals(stateDir);
    expect(stored).toHaveLength(1);
    // Absence ⇒ skill-synthesis (the documented back-compat default) — the
    // record carries no explicit origin field.
    expect(stored[0]!.origin).toBeUndefined();
  });

  it("rejects an invalid --origin before any IPC (commander-level validation)", () => {
    if (!bunOk) return;
    const r = cli([
      "self-improve", "propose-skill",
      "--draft", draftPath,
      "--slug", "myskill",
      "--lesson", "always X",
      "--chat", "12345",
      "--origin", "bogus",
    ]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/--origin must be one of/);
  });
});
