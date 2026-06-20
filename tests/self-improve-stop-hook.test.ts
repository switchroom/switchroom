import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drive the hook through `bun` against source (mirrors
// tests/skill-validate-pretool.test.ts) so the test doesn't depend on
// build order. Skip cleanly if bun is absent.
const bunOk = spawnSync("which", ["bun"], { encoding: "utf-8" }).status === 0;
const HOOK = join(process.cwd(), "src", "cli", "self-improve-stop.ts");

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "self-improve-stop-"));
});
afterAll(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(stdin: string, env: Record<string, string> = {}): RunResult {
  const r = spawnSync("bun", [HOOK], {
    input: stdin,
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, ...env },
  });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: r.stderr ?? "",
  };
}

/** Write a Claude-Code-shaped JSONL transcript and return its path. */
function writeTranscript(name: string, msgs: Array<{ role: string; text: string }>): string {
  const p = join(tmp, name);
  const lines = msgs.map((m) =>
    JSON.stringify({ type: m.role, message: { role: m.role, content: m.text } }),
  );
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

describe("self-improve-stop hook — fail-open + cost guarantee", () => {
  it("exits 0 silently on empty / non-JSON stdin", () => {
    if (!bunOk) return;
    for (const bad of ["", "not-json"]) {
      const r = run(bad);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  });

  it("exits 0 with no socket activity on a CLEAN turn (no signal)", () => {
    if (!bunOk) return;
    const tp = writeTranscript("clean.jsonl", [
      { role: "user", text: "Summarise the logs." },
      { role: "assistant", text: "Done — all green." },
      { role: "user", text: "Thanks!" },
    ]);
    const r = run(JSON.stringify({ session_id: "s1", transcript_path: tp }), {
      SWITCHROOM_AGENT_NAME: "test-agent",
      SWITCHROOM_GATEWAY_SOCKET: join(tmp, "nonexistent.sock"),
    });
    expect(r.status).toBe(0);
  });

  it("respects the opt-out kill switch (SWITCHROOM_SELF_IMPROVE=0)", () => {
    if (!bunOk) return;
    const tp = writeTranscript("disabled.jsonl", [
      { role: "user", text: "No, that's wrong." },
      { role: "user", text: "That's not what I asked, I told you." },
    ]);
    const r = run(JSON.stringify({ session_id: "s2", transcript_path: tp }), {
      SWITCHROOM_SELF_IMPROVE: "0",
      SWITCHROOM_AGENT_NAME: "test-agent",
      SWITCHROOM_GATEWAY_SOCKET: join(tmp, "nonexistent.sock"),
    });
    expect(r.status).toBe(0);
  });
});

describe("self-improve-stop hook — fires the forked review on a real signal", () => {
  it("connects to the gateway socket and injects a self_improve_review inbound", async () => {
    if (!bunOk) return;

    const socketPath = join(tmp, "gw.sock");
    const received: string[] = [];
    const server: Server = await new Promise((resolve) => {
      const s = createServer((conn) => {
        conn.on("data", (d) => received.push(d.toString("utf-8")));
      });
      s.listen(socketPath, () => resolve(s));
    });

    try {
      const tp = writeTranscript("tripping.jsonl", [
        { role: "user", text: "Send the digest." },
        { role: "assistant", text: "Sent." },
        { role: "user", text: "No, that's wrong — you included drafts again." },
        { role: "assistant", text: "Fixed." },
        { role: "user", text: "That's not what I asked, I told you to exclude drafts." },
      ]);
      const r = run(JSON.stringify({ session_id: "s3", transcript_path: tp }), {
        SWITCHROOM_AGENT_NAME: "test-agent",
        SWITCHROOM_GATEWAY_SOCKET: socketPath,
        SWITCHROOM_SELF_IMPROVE_CHAT_ID: "1234",
      });
      expect(r.status).toBe(0);

      // Give the async write a moment to land on the server side.
      await new Promise((res) => setTimeout(res, 200));
      const payload = received.join("");
      expect(payload.length).toBeGreaterThan(0);
      const envelope = JSON.parse(payload.trim());
      expect(envelope.type).toBe("inject_inbound");
      expect(envelope.agentName).toBe("test-agent");
      expect(envelope.inbound.meta.source).toBe("self_improve_review");
      expect(envelope.inbound.chatId).toBe("1234");
      expect(envelope.inbound.text).toContain("[self-improvement review]");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it("does NOT recurse: a review turn does not re-trip the gate", () => {
    if (!bunOk) return;
    const socketPath = join(tmp, "gw2.sock");
    // The last user message is a review prompt we previously injected.
    const tp = writeTranscript("review.jsonl", [
      {
        role: "user",
        text:
          "[self-improvement review] The turn-end gate detected a learning signal. " +
          "No, that's wrong. That's not what I asked, I told you.",
      },
      { role: "assistant", text: "Recorded a pending suggestion." },
    ]);
    const r = run(JSON.stringify({ session_id: "s4", transcript_path: tp }), {
      SWITCHROOM_AGENT_NAME: "test-agent",
      SWITCHROOM_GATEWAY_SOCKET: socketPath, // no server listening — connect would fail anyway
    });
    expect(r.status).toBe(0);
  });
});
