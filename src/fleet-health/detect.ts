/**
 * Fleet Health — Layer-0 model-free detector (the nightly sensor).
 *
 * Design: `reference/rfcs/fleet-health.md` (serves `fleet-stays-healthy`,
 * outcome `always-available`). This is the TypeScript port of the validated
 * reference detector (`spec_audit_l0.py`) — same tuned constants, same precise
 * gateway signatures, same `synthetic-` exclusion, same `turn_id` join key.
 *
 * STRICTLY MODEL-FREE: no LLM call, no `claude -p`, zero tokens. It reads only
 * hard artifacts — the structured `turns.jsonl` oracle and precise gateway log
 * signatures — and emits a structured signal digest. Everything here is a pure
 * function over already-read text so it is trivially unit-testable and never
 * touches the network.
 */

/** Tuned hang threshold: >6 min (live data p99 = 303 s). Load-bearing —
 *  do not casually change (see RFC "Tuned constants"). */
export const HANG_MS = 360_000;
/** A long turn with few tool calls is a stall (hang); a long turn with many
 *  tool calls is deep work. Load-bearing. */
export const HANG_MAXTOOLS = 2;

/** One row of `turns.jsonl` — the structured per-turn oracle. */
export interface TurnRecord {
  ts?: number;
  agent?: string;
  duration_ms?: number;
  tools?: number;
  status?: string;
  turn_id?: string;
}

/** The L0 failure-mode signals emitted from `turns.jsonl`. Kept as stable
 *  string keys so the signal→spec mapping table can join on them. */
export type TurnSignal =
  | "killed-incomplete-turn"
  | "hang-long-stalled"
  | "silent-no-op-candidate"
  // A turn-flush/backstop send that failed or only partially delivered
  // (turns.jsonl status `send_failed`, new in gateway PR B). Distinct from
  // `killed-incomplete-turn` (process killed mid-run): here the run finished
  // but the answer never fully reached the user (e.g. flood-dropped).
  | "send-failed-delivery";

/** The L0 failure-mode signals emitted from precise gateway log signatures. */
export type GatewaySignal =
  | "duplicate-delivery-represent"
  | "represent-escalation"
  | "reply-delivery-failure";

export type L0Signal = TurnSignal | GatewaySignal;

/** A single flagged occurrence with its hard-artifact evidence. */
export interface Finding {
  signal: L0Signal;
  agent: string;
  /** origin_turn_id join key (turns.jsonl / gateway log / transcript). For a
   *  gateway-count signal with no single turn, this is a synthesized pointer. */
  turn_id: string;
  /** A grep-able pointer the operator can jump to. */
  log_pointer: string;
  /** ISO timestamp of the occurrence (from the turn `ts`, if known). */
  ts: string | null;
}

/** The per-agent digest — mirrors the reference detector's JSON output plus
 *  the structured findings the ledger writer consumes. */
export interface AgentScanResult {
  agent: string;
  turns: number;
  status_mix: Record<string, number>;
  findings: Finding[];
  /** Raw gateway signature hit counts (for the digest / escalate decision). */
  gw_hits: Record<GatewaySignal, number>;
  escalate: boolean;
}

/**
 * Precise gateway log signatures. Precision-filtered so a `getUpdates` network
 * blip never counts as a delivery failure — the reply-delivery pattern matches
 * ONLY a `sendRichMessage` non-ok status. Regex sources match the reference
 * detector's `grep -E` patterns exactly.
 */
export const GATEWAY_SIGNATURES: Record<GatewaySignal, RegExp> = {
  "duplicate-delivery-represent": /represent duplicate-send/,
  "represent-escalation": /obligation escalation/,
  "reply-delivery-failure": /tg-post method=sendRichMessage[^\n]*status=err/,
};

/** Parse `turns.jsonl` text into records, silently skipping malformed lines
 *  (a corrupt line must never crash the scan — RFC: defensive). */
export function parseTurns(text: string): TurnRecord[] {
  const out: TurnRecord[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as TurnRecord);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function isoFromTs(ts: number | undefined): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  // turns.jsonl `ts` is unix seconds.
  return new Date(ts * 1000).toISOString();
}

/**
 * Run the turns.jsonl detectors over one agent's parsed turns. Pure — returns
 * the flagged findings. Mirrors the reference detector's three turn checks.
 */
export function detectTurnFindings(agent: string, turns: TurnRecord[]): Finding[] {
  const findings: Finding[] = [];
  for (const t of turns) {
    const tid = t.turn_id ?? "?";
    const st = t.status;
    const tl = typeof t.tools === "number" ? t.tools : 0;
    const dur = typeof t.duration_ms === "number" ? t.duration_ms : 0;
    const synthetic = tid.includes("synthetic-"); // gateway-injected, not a real job
    const ts = isoFromTs(t.ts);

    // send_failed (gateway PR B): the run finished but the answer did not fully
    // reach the user. Its own signal — NOT the process-killed catch-all below
    // (which would corrupt `killed-incomplete-turn`'s "killed mid-run" meaning).
    if (st === "send_failed") {
      findings.push({
        signal: "send-failed-delivery",
        agent,
        turn_id: tid,
        log_pointer: `turns.jsonl:${tid} status=send_failed`,
        ts,
      });
    } else if (st !== "complete" && st !== "no_reply") {
      findings.push({
        signal: "killed-incomplete-turn",
        agent,
        turn_id: tid,
        log_pointer: `turns.jsonl:${tid} status=${st}`,
        ts,
      });
    }
    // tuned hang: long AND stalled — long+productive is deep work.
    if (dur > HANG_MS && tl <= HANG_MAXTOOLS) {
      findings.push({
        signal: "hang-long-stalled",
        agent,
        turn_id: tid,
        log_pointer: `turns.jsonl:${tid} ${Math.floor(dur / 1000)}s tools=${tl}`,
        ts,
      });
    }
    // silent no-op: completed, zero tools, real (non-synthetic).
    if (st === "complete" && tl === 0 && !synthetic) {
      findings.push({
        signal: "silent-no-op-candidate",
        agent,
        turn_id: tid,
        log_pointer: `turns.jsonl:${tid} tools=0`,
        ts,
      });
    }
  }
  return findings;
}

/**
 * Run the precise gateway signatures over one agent's gateway log text. Returns
 * both the per-signature hit counts and one Finding per matched line (so the
 * ledger gets real log pointers). `logName` is only used to build the pointer.
 */
export function detectGatewayFindings(
  agent: string,
  logText: string,
  logName = `logs/${agent}/gateway-supervisor.log`,
): { findings: Finding[]; gw_hits: Record<GatewaySignal, number> } {
  const findings: Finding[] = [];
  const gw_hits: Record<GatewaySignal, number> = {
    "duplicate-delivery-represent": 0,
    "represent-escalation": 0,
    "reply-delivery-failure": 0,
  };
  const lines = logText.split("\n");
  for (const [name, re] of Object.entries(GATEWAY_SIGNATURES) as [
    GatewaySignal,
    RegExp,
  ][]) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (re.test(line)) {
        gw_hits[name] += 1;
        findings.push({
          signal: name,
          agent,
          turn_id: extractTurnId(line) ?? `${agent}:gw#${i + 1}`,
          log_pointer: `${logName}:${i + 1}`,
          ts: extractTs(line),
        });
      }
    }
  }
  return { findings, gw_hits };
}

/** Best-effort turn_id extraction from a gateway log line (origin_turn_id
 *  form `<digits>:_#<digits>`). Returns null if the line carries none. */
export function extractTurnId(line: string): string | null {
  const m = line.match(/\d+:_#\d+/);
  return m ? m[0] : null;
}

/** Best-effort ISO-timestamp extraction from a gateway log line. Gateway lines
 *  are prefixed with an ISO-8601 timestamp; return it if present. */
export function extractTs(line: string): string | null {
  const m = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/);
  return m ? m[0] : null;
}

/**
 * Full L0 scan for one agent over the two artifact texts. The gateway signals
 * that gate escalation match the reference detector exactly: killed/hang/silent
 * no-op, plus duplicate-delivery and reply-delivery-failure (represent-escalation
 * is informational and does NOT by itself escalate).
 */
export function scanAgent(
  agent: string,
  turnsText: string,
  gatewayText: string,
): AgentScanResult {
  const turns = parseTurns(turnsText);
  const status_mix: Record<string, number> = {};
  for (const t of turns) {
    const st = t.status ?? "unknown";
    status_mix[st] = (status_mix[st] ?? 0) + 1;
  }
  const turnFindings = detectTurnFindings(agent, turns);
  const { findings: gwFindings, gw_hits } = detectGatewayFindings(
    agent,
    gatewayText,
  );
  const findings = [...turnFindings, ...gwFindings];

  const escalate =
    turnFindings.some(
      (f) =>
        f.signal === "killed-incomplete-turn" ||
        f.signal === "hang-long-stalled" ||
        f.signal === "silent-no-op-candidate" ||
        f.signal === "send-failed-delivery",
    ) ||
    gw_hits["duplicate-delivery-represent"] > 0 ||
    gw_hits["reply-delivery-failure"] > 0;

  return { agent, turns: turns.length, status_mix, findings, gw_hits, escalate };
}
