import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildReviewPrompt } from "../src/self-improve/review-prompt.js";
import {
  writeReviewContext,
  reviewIsPending,
} from "../src/self-improve/review-context.js";
import { SELF_IMPROVE_CORRECTION_PENDING_FILE } from "../src/memory/hindsight-retain-provenance.js";

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

/**
 * Write a transcript whose entries may be either plain text OR a list of
 * `tool_use` parts (the real assistant-message shape), so the gate's
 * Edit/Bash fix-fingerprinting can be exercised faithfully.
 */
type Entry =
  | { role: "user" | "assistant"; text: string }
  | {
      role: "assistant";
      tools: Array<{ name: string; input: Record<string, unknown> }>;
    };
function writeToolTranscript(name: string, entries: Entry[]): string {
  const p = join(tmp, name);
  const lines = entries.map((e) => {
    const content =
      "tools" in e
        ? e.tools.map((t) => ({ type: "tool_use", name: t.name, input: t.input }))
        : e.text;
    return JSON.stringify({ type: e.role, message: { role: e.role, content } });
  });
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

  // Regression for the infinite re-fire loop (issue #2462). The REAL runtime
  // shape of an injected review turn is NOT the bare banner — the gateway
  // wraps it in a `<channel …>` envelope first, so the banner is not at
  // offset 0. With a live server listening we assert the hook injects
  // NOTHING: it must recognise the wrapped review turn and short-circuit.
  it("does NOT re-inject on a CHANNEL-WRAPPED review turn (the loop bug)", async () => {
    if (!bunOk) return;
    const socketPath = join(tmp, "gw-wrapped.sock");
    const received: string[] = [];
    const server: Server = await new Promise((resolve) => {
      const s = createServer((conn) => {
        conn.on("data", (d) => received.push(d.toString("utf-8")));
      });
      s.listen(socketPath, () => resolve(s));
    });
    try {
      const prompt = buildReviewPrompt([
        {
          kind: "directive-not-bound",
          reason: "A standing rule was restated 2× — it isn't binding",
          occurrences: 2,
          evidence: "Lisa and JDLF emails are always relevant",
        },
      ]);
      // Exactly how the gateway stores it: channel envelope + newline + prompt.
      const wrapped =
        `<channel source="switchroom-telegram" source="self_improve_review" ` +
        `triggering_session="loop">\n${prompt}`;
      // The window ALSO carries two genuine operator corrections (which the
      // scan filter does NOT remove). This pins the short-circuit: if the
      // `isReviewTurn(lastUser)` guard regressed, the gate would run on those
      // corrections, trip, and inject — so the "no inject" assertion would
      // fail. (Without these, a single sub-threshold directive made the test
      // pass even against the buggy `startsWith` guard — a hollow regression.)
      const tp = writeTranscript("wrapped-review.jsonl", [
        { role: "user", text: "No, that's wrong — you included drafts again." },
        { role: "assistant", text: "Fixed." },
        { role: "user", text: "That's not what I asked, I told you to exclude drafts." },
        { role: "assistant", text: "Understood." },
        { role: "user", text: wrapped },
        { role: "assistant", text: "Bound the directive. Ending the turn." },
      ]);
      const r = run(JSON.stringify({ session_id: "loop", transcript_path: tp }), {
        SWITCHROOM_AGENT_NAME: "test-agent",
        SWITCHROOM_GATEWAY_SOCKET: socketPath,
      });
      expect(r.status).toBe(0);
      await new Promise((res) => setTimeout(res, 200));
      expect(received.join("")).toBe(""); // no inject — loop broken
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  // Defense in depth (issue #2462): even when the review turn is NOT last —
  // e.g. a wrapped review prompt earlier in the window plus a benign normal
  // message last — the gate must not COUNT the review prompt's embedded
  // evidence as a fresh restated rule and re-fire. The scan filter drops our
  // own injected prompts before the gate runs.
  it("does NOT re-fire from a review prompt sitting in the scan window", async () => {
    if (!bunOk) return;
    const socketPath = join(tmp, "gw-window.sock");
    const received: string[] = [];
    const server: Server = await new Promise((resolve) => {
      const s = createServer((conn) => {
        conn.on("data", (d) => received.push(d.toString("utf-8")));
      });
      s.listen(socketPath, () => resolve(s));
    });
    try {
      // Two wrapped review prompts carrying the SAME directive evidence — left
      // in the scan, the directive detector would cluster them (count ≥ 2) and
      // re-fire. They must be filtered out.
      const mk = (n: number) =>
        `<channel source="switchroom-telegram" source="self_improve_review" ` +
        `triggering_session="w${n}">\n` +
        buildReviewPrompt([
          {
            kind: "directive-not-bound",
            reason: "A standing rule was restated — always dedupe the recipients",
            occurrences: 2,
            evidence: "always dedupe the recipients",
          },
        ]);
      const tp = writeTranscript("window-review.jsonl", [
        { role: "user", text: mk(1) },
        { role: "assistant", text: "Bound it." },
        { role: "user", text: mk(2) },
        { role: "assistant", text: "Already bound." },
        { role: "user", text: "ok thanks" }, // benign normal turn is last
      ]);
      const r = run(JSON.stringify({ session_id: "window", transcript_path: tp }), {
        SWITCHROOM_AGENT_NAME: "test-agent",
        SWITCHROOM_GATEWAY_SOCKET: socketPath,
      });
      expect(r.status).toBe(0);
      await new Promise((res) => setTimeout(res, 200));
      expect(received.join("")).toBe(""); // filtered — no self-amplification
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it("clears the review-context marker at the end of a REAL review turn (regression: no leak)", () => {
    if (!bunOk) return;
    const stateDir = mkdtempSync(join(tmpdir(), "self-improve-stop-marker-"));
    try {
      // Arm the marker exactly as the Stop hook would at injection time.
      writeReviewContext(stateDir, {
        created_at: new Date(Date.now() - 60_000).toISOString(),
        triggering_session: "prev",
        chat_id: "c",
        signals: [],
      });
      expect(reviewIsPending(stateDir)).toBe(true);

      // A real review turn: the last user message is the ACTUAL review
      // prompt (built from a benign signal). It trips NO gate signal — the
      // precise case the leak bug missed — yet the marker must still clear,
      // because review-turn detection now runs BEFORE the gate check.
      const prompt = buildReviewPrompt([
        {
          kind: "directive-not-bound",
          reason: "standing rule not honoured",
          occurrences: 2,
          evidence: "always exclude drafts",
        },
      ]);
      const tp = writeTranscript("real-review.jsonl", [
        { role: "user", text: prompt },
        { role: "assistant", text: "Edited the skill and recorded the change." },
      ]);
      const r = run(JSON.stringify({ session_id: "rev", transcript_path: tp }), {
        SWITCHROOM_AGENT_NAME: "test-agent",
        TELEGRAM_STATE_DIR: stateDir,
        SWITCHROOM_GATEWAY_SOCKET: join(tmp, "no-server.sock"),
      });
      expect(r.status).toBe(0);
      expect(reviewIsPending(stateDir)).toBe(false); // marker cleared — no leak
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

// PR4 slice 4a: on an operator-correction trip the Stop hook drops a per-turn
// sentinel into the state dir so the (separate-process) auto-retain hook can
// tag that turn's retain `self-improve:correction`. The marker is written ONLY
// for the operator-correction signal — never on other trips, never on a clean
// turn — so a mutation that wrote it unconditionally would fail these.
describe("self-improve-stop hook — operator-correction retain sentinel (slice 4a)", () => {
  function sentinelPresent(stateDir: string): boolean {
    return existsSync(join(stateDir, SELF_IMPROVE_CORRECTION_PENDING_FILE));
  }

  it("writes the correction sentinel when the gate trips on operator-correction", () => {
    if (!bunOk) return;
    const stateDir = mkdtempSync(join(tmpdir(), "self-improve-correction-"));
    try {
      const tp = writeTranscript("correction-trip.jsonl", [
        { role: "user", text: "Send the digest." },
        { role: "assistant", text: "Sent." },
        { role: "user", text: "No, that's wrong — you included drafts again." },
        { role: "assistant", text: "Fixed." },
        { role: "user", text: "That's not what I asked, I told you to exclude drafts." },
      ]);
      const r = run(JSON.stringify({ session_id: "corr", transcript_path: tp }), {
        SWITCHROOM_AGENT_NAME: "test-agent",
        TELEGRAM_STATE_DIR: stateDir,
        SWITCHROOM_GATEWAY_SOCKET: join(stateDir, "no-server.sock"),
      });
      expect(r.status).toBe(0);
      expect(sentinelPresent(stateDir)).toBe(true);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does NOT write the sentinel on a non-correction trip (repeated-manual-fix only)", () => {
    if (!bunOk) return;
    const stateDir = mkdtempSync(join(tmpdir(), "self-improve-nocorr-"));
    try {
      // The same Bash remediation twice trips repeated-manual-fix WITHOUT any
      // operator-correction pattern — so the correction sentinel must stay absent.
      const cmd = "rm -f /tmp/stale.lock && systemctl restart worker";
      const tp = writeToolTranscript("fix-only.jsonl", [
        { role: "user", text: "It's stuck." },
        { role: "assistant", tools: [{ name: "Bash", input: { command: cmd } }] },
        { role: "user", text: "still stuck, retry." },
        { role: "assistant", tools: [{ name: "Bash", input: { command: cmd } }] },
      ]);
      const r = run(JSON.stringify({ session_id: "fixonly", transcript_path: tp }), {
        SWITCHROOM_AGENT_NAME: "test-agent",
        TELEGRAM_STATE_DIR: stateDir,
        SWITCHROOM_GATEWAY_SOCKET: join(stateDir, "no-server.sock"),
      });
      expect(r.status).toBe(0);
      expect(sentinelPresent(stateDir)).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does NOT write the sentinel on a clean turn (no signal)", () => {
    if (!bunOk) return;
    const stateDir = mkdtempSync(join(tmpdir(), "self-improve-clean-"));
    try {
      const tp = writeTranscript("clean-nocorr.jsonl", [
        { role: "user", text: "Summarise the logs." },
        { role: "assistant", text: "Done — all green." },
        { role: "user", text: "Thanks!" },
      ]);
      const r = run(JSON.stringify({ session_id: "clean", transcript_path: tp }), {
        SWITCHROOM_AGENT_NAME: "test-agent",
        TELEGRAM_STATE_DIR: stateDir,
        SWITCHROOM_GATEWAY_SOCKET: join(stateDir, "no-server.sock"),
      });
      expect(r.status).toBe(0);
      expect(sentinelPresent(stateDir)).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

// #2462 follow-up: the repeated-manual-fix detector fingerprinted an Edit by
// FILE PATH only, so several DISTINCT edits to one file in a normal turn
// mis-read as "the same fix applied N×" and tripped a review. The fingerprint
// is now content-aware: only a genuinely identical re-applied edit recurs.
describe("self-improve-stop hook — repeated-manual-fix is content-aware (#2462 follow-up)", () => {
  function injectedNothing(received: string[]): boolean {
    return received.join("") === "";
  }

  it("does NOT fire on several DISTINCT edits to the same file (normal iteration)", async () => {
    if (!bunOk) return;
    const socketPath = join(tmp, "gw-distinct.sock");
    const received: string[] = [];
    const server: Server = await new Promise((resolve) => {
      const s = createServer((conn) => {
        conn.on("data", (d) => received.push(d.toString("utf-8")));
      });
      s.listen(socketPath, () => resolve(s));
    });
    try {
      // Three real, DIFFERENT edits to the same path — exactly what iterating
      // on a fix looks like. Path-only fingerprinting tripped here; content-
      // aware fingerprinting must not.
      const file = "/repo/src/self-improve/review-prompt.ts";
      const tp = writeToolTranscript("distinct-edits.jsonl", [
        { role: "user", text: "Make the change." },
        {
          role: "assistant",
          tools: [
            { name: "Edit", input: { file_path: file, old_string: "const A = 1;", new_string: "const A = 2;" } },
            { name: "Edit", input: { file_path: file, old_string: "foo(bar)", new_string: "foo(baz)" } },
            { name: "Edit", input: { file_path: file, old_string: "// todo", new_string: "// done" } },
          ],
        },
        { role: "user", text: "thanks" },
      ]);
      const r = run(JSON.stringify({ session_id: "distinct", transcript_path: tp }), {
        SWITCHROOM_AGENT_NAME: "test-agent",
        SWITCHROOM_GATEWAY_SOCKET: socketPath,
      });
      expect(r.status).toBe(0);
      await new Promise((res) => setTimeout(res, 200));
      expect(injectedNothing(received)).toBe(true); // no false repeated-manual-fix
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it("STILL fires on a genuinely identical remediation re-applied (signal preserved)", async () => {
    if (!bunOk) return;
    const socketPath = join(tmp, "gw-identical.sock");
    const received: string[] = [];
    const server: Server = await new Promise((resolve) => {
      const s = createServer((conn) => {
        conn.on("data", (d) => received.push(d.toString("utf-8")));
      });
      s.listen(socketPath, () => resolve(s));
    });
    try {
      // The SAME Bash remediation run twice — the real "I had to redo the same
      // fix" signal the detector exists to catch. Must still trip.
      const cmd = "rm -f /tmp/stale.lock && systemctl restart worker";
      const tp = writeToolTranscript("identical-fix.jsonl", [
        { role: "user", text: "It's stuck." },
        { role: "assistant", tools: [{ name: "Bash", input: { command: cmd } }] },
        { role: "user", text: "stuck again." },
        { role: "assistant", tools: [{ name: "Bash", input: { command: cmd } }] },
      ]);
      const r = run(JSON.stringify({ session_id: "identical", transcript_path: tp }), {
        SWITCHROOM_AGENT_NAME: "test-agent",
        SWITCHROOM_GATEWAY_SOCKET: socketPath,
        SWITCHROOM_SELF_IMPROVE_CHAT_ID: "9",
      });
      expect(r.status).toBe(0);
      await new Promise((res) => setTimeout(res, 200));
      const envelope = JSON.parse(received.join("").trim());
      expect(envelope.inbound.text).toContain("repeated-manual-fix");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});
