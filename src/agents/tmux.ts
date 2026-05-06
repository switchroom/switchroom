// Crash-time tmux pane capture helper (#725 PR-2).
//
// Snapshots an agent's tmux pane scrollback to
// `<agentDir>/crash-reports/<ISO8601>-<reason>.txt` so RCA tooling
// can see the live screen state at the moment a watchdog kill or a
// crash-detection path triggered. The capture must NEVER throw —
// callers (watchdog, lifecycle crash detector) treat capture failure
// as best-effort and continue with the restart regardless.
//
// Naming/retention contract is shared with the bash mirror in
// `bin/bridge-watchdog.sh` (capture_pane_before_restart). Keep the
// two paths in sync: same socket convention (`switchroom-<agent>`),
// same target session (`<agent>`), same output dir, same header
// format. If you change one, change the other.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface CapturePaneOptions {
  agentName: string;
  agentDir: string;
  reason: string;
  scrollback?: boolean;
  retain?: number;
}

export type CaptureResult = { path: string } | { error: string };

const MAX_BYTES = 10 * 1024 * 1024; // 10MB cap on captured pane bytes (header excluded)

/**
 * Capture an agent's tmux pane to a crash-reports file.
 *
 * Returns `{ path }` on success or `{ error }` on any failure.
 * Never throws. Soft-failures are logged via `console.error` so the
 * watchdog/journal trail records them without disrupting the caller.
 */
export function captureAgentPane(opts: CapturePaneOptions): CaptureResult {
  const { agentName, agentDir, reason } = opts;
  const scrollback = opts.scrollback !== false; // default true
  const retain = typeof opts.retain === "number" && opts.retain > 0 ? opts.retain : 20;

  const socket = `switchroom-${agentName}`;
  const outDir = resolve(agentDir, "crash-reports");
  const ts = isoStamp(new Date());
  const reasonSlug = sanitizeReason(reason);
  const outPath = resolve(outDir, `${ts}-${reasonSlug}.txt`);

  try {
    mkdirSync(outDir, { recursive: true, mode: 0o755 });
  } catch (err) {
    const msg = `mkdir crash-reports failed: ${(err as Error).message}`;
    console.error(`[tmux-capture] ${agentName}: ${msg}`);
    return { error: msg };
  }

  const args = ["-L", socket, "capture-pane", "-p"];
  if (scrollback) {
    args.push("-S", "-");
  }
  args.push("-t", agentName);

  let pane: Buffer;
  try {
    pane = execFileSync("tmux", args, {
      timeout: 5000,
      maxBuffer: 64 * 1024 * 1024, // safe upper bound; we slice below
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = `tmux capture-pane failed: ${(err as Error).message}`;
    console.error(`[tmux-capture] ${agentName}: ${msg}`);
    return { error: msg };
  }

  // Cap captured bytes. tmux history-limit is 100k lines; ANSI-heavy
  // panes could spike to multi-MB. Slice from the END (newest content)
  // since tail of the scrollback is the interesting bit at crash time.
  let body: Buffer = pane;
  if (body.byteLength > MAX_BYTES) {
    body = body.subarray(body.byteLength - MAX_BYTES);
  }

  const header =
    `# agent: ${agentName}\n` +
    `# reason: ${reason}\n` +
    `# captured-at: ${ts}\n` +
    `# tmux-socket: ${socket}\n` +
    `\n`;

  try {
    writeFileSync(outPath, Buffer.concat([Buffer.from(header, "utf8"), body]), {
      mode: 0o644,
    });
  } catch (err) {
    const msg = `write crash-report failed: ${(err as Error).message}`;
    console.error(`[tmux-capture] ${agentName}: ${msg}`);
    return { error: msg };
  }

  // Retention sweep — keep the `retain` newest .txt files in the dir.
  try {
    pruneOldReports(outDir, retain);
  } catch (err) {
    // Soft-fail: a write succeeded, retention failure is cosmetic.
    console.error(
      `[tmux-capture] ${agentName}: retention prune failed: ${(err as Error).message}`,
    );
  }

  return { path: outPath };
}

function isoStamp(d: Date): string {
  // 2026-05-06T01-59-37Z — colons replaced with dashes for FS safety.
  return d.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

function sanitizeReason(reason: string): string {
  // Slug for filename use: keep alnum + dash + underscore; collapse rest.
  const slug = reason
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

export interface SendInterruptOptions {
  agentName: string;
  /** how many milliseconds to wait between two send-keys attempts (default 100). */
  retryDelayMs?: number;
  /** total attempts (default 1, no retry). */
  attempts?: number;
}

export type SendInterruptResult = { ok: true } | { error: string };

/**
 * Deliver a Ctrl-C to whatever is currently foregrounded in the agent's
 * tmux pane via `tmux send-keys C-c`.
 *
 * Why this exists separately from the cgroup-wide
 * `systemctl kill --signal=INT` path: under the tmux supervisor, claude
 * may have spawned a child process for a Bash tool call, and an operator
 * typing `!` in chat almost always means "interrupt whatever's currently
 * running" — which is the foreground thing in the pane, not necessarily
 * claude proper. send-keys hits the pane's foreground process; cgroup
 * SIGINT hits the whole tree (including the supervisor itself).
 *
 * Soft-fail contract: returns `{ error }` on any tmux failure (no session,
 * socket missing, timeout, exec error). Never throws. Callers can fall
 * back to the cgroup path on `{ error }`.
 */
export function sendAgentInterrupt(opts: SendInterruptOptions): SendInterruptResult {
  const { agentName } = opts;
  const attempts = typeof opts.attempts === "number" && opts.attempts > 0 ? opts.attempts : 1;
  const retryDelayMs =
    typeof opts.retryDelayMs === "number" && opts.retryDelayMs >= 0 ? opts.retryDelayMs : 100;

  const socket = `switchroom-${agentName}`;
  const args = ["-L", socket, "send-keys", "-t", agentName, "C-c"];

  let lastError: string | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      execFileSync("tmux", args, {
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true };
    } catch (err) {
      lastError = `tmux send-keys C-c failed: ${(err as Error).message}`;
      console.error(`[tmux-interrupt] ${agentName}: ${lastError}`);
    }
    if (i < attempts - 1 && retryDelayMs > 0) {
      sleepSync(retryDelayMs);
    }
  }

  return { error: lastError ?? "tmux send-keys C-c failed" };
}

function sleepSync(ms: number): void {
  // Atomics.wait on a fresh SharedArrayBuffer is a portable synchronous
  // sleep — keeps the helper self-contained and testable without forcing
  // callers/tests to manage fake timers.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

function pruneOldReports(dir: string, retain: number): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const files = entries
    .filter((n) => n.endsWith(".txt"))
    .map((n) => {
      const full = resolve(dir, n);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      return { full, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const stale of files.slice(retain)) {
    try {
      unlinkSync(stale.full);
    } catch {
      // best-effort; ignore
    }
  }
}
