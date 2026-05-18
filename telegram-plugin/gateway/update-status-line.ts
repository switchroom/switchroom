/**
 * Deterministic, model-free status line for an in-flight hostd
 * `update_apply`. Pure function over hostd's `get_status` response —
 * no model, no I/O. Used by the gateway's framework silence-fallback
 * so the recurring "is it still going?" message carries hostd's
 * actual phase + elapsed instead of the content-free
 * "still working… no update from agent in N min" (the klanker
 * incident: a multi-minute fleet update with zero visible status).
 *
 * The hostd CLI prints step banners as `▸ <step>` lines (pull-images,
 * apply-config, recreate-containers, doctor, …) into stdout; hostd
 * surfaces the last 4 KiB as `stdout_tail`. The phase is the LAST such
 * banner — a deterministic string parse, no interpretation.
 */

export interface UpdateStatusResponse {
  result: string;
  stdout_tail?: string;
  stderr_tail?: string;
}

/** Latest `▸ <step>` banner in the tail, or null if none yet. */
export function latestHostdPhase(tail: string | undefined): string | null {
  if (!tail) return null;
  let phase: string | null = null;
  for (const raw of tail.split("\n")) {
    const m = /^\s*▸\s*(.+?)\s*$/.exec(raw);
    if (m && m[1]) phase = m[1];
  }
  return phase;
}

function elapsedMin(startedAt: number, now: number): number {
  return Math.max(1, Math.round((now - startedAt) / 60_000));
}

/**
 * Compose the deterministic status line. `resp` is hostd's get_status
 * for the in-flight update_apply; `startedAt` is when the gateway
 * dispatched it; `now` is the current time.
 */
export function formatUpdateStatusLine(
  resp: UpdateStatusResponse,
  startedAt: number,
  now: number,
): string {
  const mins = elapsedMin(startedAt, now);
  const tail = `Recreating the fleet (including me) — I'll report the result here when it's done.`;

  // Terminal-but-gateway-still-alive: recreate hasn't killed us yet, or
  // it failed before recreate. The dedicated terminal/boot path owns the
  // final verdict; here we just stop claiming "in progress".
  if (resp.result !== "started") {
    return `⏳ Fleet update finishing — hostd reported \`${resp.result}\` (~${mins}m). ${tail}`;
  }

  const phase = latestHostdPhase(resp.stdout_tail);
  return phase
    ? `⏳ Fleet update in progress — phase: ${phase} (~${mins}m). ${tail}`
    : `⏳ Fleet update in progress — starting (~${mins}m). ${tail}`;
}
