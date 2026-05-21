/**
 * `claude -p` driven inject for the skill-coverage harness.
 *
 * Why a sibling to inject.ts/inject_inbound: the IPC + sidecar paths
 * both depend on a long-running switchroom agent. For TRIGGER coverage
 * (does the description fire the right skill on this phrasing?) all
 * we need is the same model + the same skill bundle visible in a
 * workspace we own. `claude -p --output-format=stream-json` runs one
 * turn synchronously and emits every tool_use as a JSONL row.
 *
 * Workspace contract: caller passes `cwd` pointing at a dir whose
 * `.claude/skills/` symlinks (or houses) the skill bundles. The
 * cli.ts driver wires this to `/tmp/skill-coverage-workspace` by
 * default.
 *
 * Cost: each probe is one Claude API turn against the user's
 * subscription. Tunable via `--max-turns` (default 2 — enough for
 * "decide on skill, fire Skill tool, read skill content, stop").
 */

import { spawn } from "node:child_process";

export interface ClaudeCliInjectOptions {
  cwd: string;
  prompt: string;
  /** Default `claude-haiku-4-5-20251001` — cheaper + faster, still
   *  accurate on description-matching. Override to test against the
   *  same model the agents use. */
  model?: string;
  /** Default 2 — enough to observe the Skill tool_use without
   *  running the skill body to completion. */
  maxTurns?: number;
  /** Default 90_000 ms. Kills the child on overrun. */
  timeoutMs?: number;
  /** Test seam — substitute the binary for unit tests. */
  binaryPath?: string;
}

export interface ClaudeCliInjectOutcome {
  /** Skill slugs extracted from `tool_use` events where `name === "Skill"`. */
  skillsInvoked: string[];
  /** All assistant text content joined newline. Lightweight reply capture. */
  replyText: string;
  /** Total wall-clock ms for the claude -p invocation. */
  durationMs: number;
  /** True when the process exited 0 (or with `result` row marking
   *  is_error=false). */
  ok: boolean;
  /** Captured for forensic logs on failure. */
  rawErrLines?: string[];
}

interface AssistantContentBlock {
  type: string;
  name?: string;
  input?: { skill?: unknown };
  text?: string;
}

interface AssistantEvent {
  type: "assistant";
  message: { content?: AssistantContentBlock[] };
}

interface ResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
}

type StreamEvent = AssistantEvent | ResultEvent | { type: string };

export function extractFromStreamJson(stdout: string): {
  skills: string[];
  replyText: string;
  ok: boolean;
} {
  const skills = new Set<string>();
  const replyParts: string[] = [];
  let resultOk = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    if (ev.type === "assistant") {
      const blocks = (ev as AssistantEvent).message?.content ?? [];
      for (const b of blocks) {
        if (b.type === "tool_use" && b.name === "Skill") {
          const slug = typeof b.input?.skill === "string" ? b.input.skill : "";
          if (slug) skills.add(slug.toLowerCase());
        } else if (b.type === "text" && typeof b.text === "string") {
          replyParts.push(b.text);
        }
      }
    } else if (ev.type === "result") {
      // is_error=false → success; missing → assume success
      resultOk = (ev as ResultEvent).is_error !== true;
    }
  }
  return {
    skills: [...skills],
    replyText: replyParts.join("\n"),
    ok: resultOk,
  };
}

export function injectClaudeCli(
  opts: ClaudeCliInjectOptions,
): Promise<ClaudeCliInjectOutcome> {
  const {
    cwd,
    prompt,
    model = "claude-haiku-4-5-20251001",
    maxTurns = 2,
    timeoutMs = 90_000,
    binaryPath = "claude",
  } = opts;
  return new Promise((resolveFn) => {
    const startedAt = Date.now();
    const args = [
      "-p",
      "--output-format=stream-json",
      "--verbose",
      "--model",
      model,
      "--max-turns",
      String(maxTurns),
      prompt,
    ];
    const child = spawn(binaryPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const stdoutChunks: string[] = [];
    const stderrLines: string[] = [];
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (d: string) => stdoutChunks.push(d));
    child.stderr.on("data", (d: string) => {
      for (const l of d.split("\n")) if (l.trim()) stderrLines.push(l);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = stdoutChunks.join("");
      const extracted = extractFromStreamJson(stdout);
      resolveFn({
        skillsInvoked: extracted.skills,
        replyText: extracted.replyText,
        durationMs: Date.now() - startedAt,
        ok: !killed && code === 0 && extracted.ok,
        rawErrLines: stderrLines.length ? stderrLines.slice(-20) : undefined,
      });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolveFn({
        skillsInvoked: [],
        replyText: "",
        durationMs: Date.now() - startedAt,
        ok: false,
        rawErrLines: [`spawn failed for ${binaryPath}`],
      });
    });
  });
}
