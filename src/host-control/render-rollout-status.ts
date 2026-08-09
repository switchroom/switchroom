/**
 * Pure renderers for the rollout status message (#2726).
 *
 * The rollout narration is an ORDINARY operator-DM message the operator can
 * scroll to — NOT a pinned card, NOT a bespoke widget. It reads like the
 * framework speaking a plain progress line in the chat, which is exactly the
 * remedy the `chat-is-the-single-source-of-truth` invariant prescribes (in-chat
 * narration, never a parallel pinned mirror).
 *
 * These functions are pure (input → string) so both the terminal push (Part 1)
 * and the log-tailed narration surface (Part 2) render identically and can be
 * unit-tested without a gateway.
 *
 * The render is a MULTI-LINE progress-card-style checklist (GFM: `-` lists,
 * bold, code spans — matching the telegram-plugin progress-card vocabulary):
 * a header (version → version, short request id, phase), one checklist line
 * per known agent (✓ done / ⏳ in progress / · pending / ✗ failed, with
 * durations), a rough ETA once at least one agent finished, and a terminal
 * summary incl. elapsed total and the deferred host-side components.
 */

// Imported, not re-declared: the renderer branches on this exact step
// label, and a local copy would be one more place for "what does rollout
// call this" to drift — the class of bug this whole change exists to kill
// (#3928). cli/rollout.js does not import host-control, so no cycle; both
// runtime consumers of this renderer already load it.
import { VERIFY_COMPONENTS_STEP as VERIFY_COMPONENTS_FAILED_STEP } from "../cli/rollout.js";
// #4269 — the definite "hostd template regen required / not needed" verdict.
// The constant is kept honest by scripts/check-hostd-template-guard.ts.
import {
  HOSTD_TEMPLATE_LAST_CHANGED,
  hostdTemplateRegenVerdict,
} from "../config/hostd-template-version.js";
// #4571 — the host CLI's install record + the DERIVED upgrade command. Pure
// functions only (no fs from the renderer): the stamp arrives on the state.
import {
  hostCliInstallCommand,
  hostCliInstallShellCommand,
  shouldRefuseStaleHostCli,
  type HostCliStamp,
} from "../cli/host-cli-stamp.js";

/** Per-agent progress an accumulator (the narrator) feeds the renderer. */
export type AgentRollStatus = "pending" | "running" | "done" | "failed";

export interface AgentRollProgress {
  name: string;
  status: AgentRollStatus;
  /** True for the canary agent (rolled first, gates the rest). */
  canary?: boolean;
  /** Restart wall-time once the agent finished (done/failed). */
  durationMs?: number;
  /** ms-since-epoch the agent's restart began (accumulator bookkeeping). */
  startedAtMs?: number;
}

/**
 * Truthful per-singleton state on the narration card. Every value maps to a
 * REAL observation (or a real deferral) — the narrator never invents a ✓:
 *   - "pending"   — this roll owns it but hasn't reached it yet;
 *   - "updating"  — its refresh phase started and no outcome phase yet;
 *   - "updated"   — an observed success (a `…-done` phase, or the terminal
 *                   `verify-components` gate proving convergence);
 *   - "deferred"  — deliberately left to a host-side run (hostd on the
 *                   agent-invoked path);
 *   - "skipped"   — not refreshed in this roll (no container / --skip-web /
 *                   the roll never reached it);
 *   - "failed"    — its refresh step failed (roll stopped there, or the
 *                   terminal drift gate named it still behind).
 */
export type SingletonRollStatus =
  | "pending"
  | "updating"
  | "updated"
  | "deferred"
  | "skipped"
  | "failed";

export interface SingletonRollProgress {
  /** Display name (container-ish: `switchroom-web`, `hindsight`, `hostd`,
   *  or the shared-services group row). */
  name: string;
  status: SingletonRollStatus;
  /** Short truthful qualifier rendered after the name (e.g. "host-side"). */
  detail?: string;
}

/** The rollout progress state a renderer needs — a projection of the latest
 *  durable rollout row / status payload. */
export interface RolloutRenderState {
  target: string;
  /** Version that was running before this roll (prior pin), when known. */
  fromVersion?: string;
  /** hostd request_id — rendered shortened so the operator can `get_status` it. */
  requestId?: string;
  /** Current phase name from the latest phase row, or "terminal". */
  phase?: string;
  /** Agents confirmed on the target, in order. */
  rolled?: string[];
  /** Roll-order position (1-based) of the agent in the current phase. */
  n?: number;
  /** Total agents this roll restarts. */
  m?: number;
  /** Agent named in the current phase. */
  agent?: string;
  /** Per-agent checklist state, in roll order (accumulated by the narrator). */
  agents?: AgentRollProgress[];
  /**
   * Singleton / shared-service checklist (accumulated by the narrator from
   * the singleton phases + the terminal row). Rendered as its own section so
   * the card answers "what about web / hindsight / hostd / the shared
   * services", not just the agents.
   */
  singletons?: SingletonRollProgress[];
  /** ms since epoch the roll started (for the elapsed line). */
  startedAtMs?: number;
  /** ms since epoch "now" at render time (clock seam — keeps the fn pure). */
  nowMs?: number;
  /** Total elapsed ms (terminal rows, where finished_at is known). */
  elapsedMs?: number;
  /** True once the hostd/web refresh was deferred to a host-side run. */
  deferred?: boolean;
  /**
   * The HOST operator CLI's own install record (#4571), when hostd could read
   * `~/.switchroom/host-cli.json`. Two things depend on it, and both used to be
   * guesses: whether the "still host-side — upgrade the CLI" line belongs on
   * the card at all (a converged host CLI must not be listed as outstanding),
   * and what the upgrade command actually is (`sudo npm i -g` is wrong on the
   * user-owned nvm prefix this fleet actually runs).
   */
  hostCli?: HostCliStamp;
  /** Terminal outcome — set only once the roll finished. */
  terminal?: "completed" | "error";
  /** Step that stopped a failed roll. */
  failedStep?: string;
  /** Agent that failed the version assert. */
  failedAgent?: string;
  /** Version detected on the failed agent (null = unreachable). */
  got?: string | null;
  /**
   * Components still BEHIND the target after the roll (#3928), set with
   * `failedStep === "verify-components"`. Rendered as its own terminal
   * shape: the agents DID roll, so "STOPPED — rolled before stop" would
   * misdescribe it and send the operator to re-run a roll that cannot fix
   * the stale component. This is the Telegram-side answer to "what is
   * still behind?", which is the only place the operator is supposed to
   * need to look.
   */
  drifted?: string[];
  /**
   * Non-fatal warnings the roll accumulated (#3944) — web/hostd refresh
   * misses, skipped components, degraded steps. Rendered as a terminal
   * section so the operator sees, in the chat, exactly what the roll flagged
   * without opening a host shell. The wire always carried these; hostd used
   * to drop them before the render ever saw them.
   */
  warnings?: string[];
}

/** Human-readable one-liner for the current phase. */
function phaseLine(s: RolloutRenderState): string {
  switch (s.phase) {
    case "apply":
      return "applying — regenerating compose";
    case "canary-start":
      return `canary — restarting ${s.agent ? `\`${s.agent}\`` : "canary agent"}`;
    case "canary-pass":
      return `canary passed (${s.agent ? `\`${s.agent}\`` : "canary"}) — rolling the rest`;
    case "canary-fail":
      return `canary failed (${s.agent ? `\`${s.agent}\`` : "canary"})`;
    case "agent-start":
      return `agent ${s.n ?? "?"}/${s.m ?? "?"} — restarting ${s.agent ? `\`${s.agent}\`` : ""}`.trim();
    case "agent-done":
      return `agent ${s.n ?? "?"}/${s.m ?? "?"} — ${s.agent ? `\`${s.agent}\`` : ""} done`.trim();
    case "persist-pin":
      return "persisting pin";
    case "web-refresh":
      return "refreshing web dashboard (webd install)";
    case "web-refresh-done":
      return "web dashboard refreshed";
    case "hindsight-refresh":
      return "refreshing hindsight (memory backend recreate)";
    case "hindsight-refresh-done":
      return "hindsight refreshed";
    case "hindsight-skipped":
      return "hindsight — no container on this host; skipped";
    case "hostd-web-deferred":
      // Legacy phase name: since the in-plan refresh-web step landed, only
      // the hostd self-refresh is actually deferred on the agent path.
      return "hostd refresh deferred (run host-side)";
    case "self-bump":
      return "hostd refreshing itself to the target (brief control blip)…";
    case "self-bump-done":
      return "hostd refreshed — resuming the roll";
    default:
      return "starting";
  }
}

/** Compact human duration: 42s / 3m 10s / 1h 5m. */
export function formatDurationMs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec > 0 ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? `${hr}h ${min}m` : `${hr}h`;
}

/** Shorten a hostd request_id for the header (still get_status-able by prefix
 *  recall — the full id lives in the durable audit row). */
function shortRequestId(id: string): string {
  return id.length > 16 ? id.slice(0, 16) + "…" : id;
}

/** Header line: icon + version → version + short request id. */
function headerLine(s: RolloutRenderState, icon: string): string {
  const arrow = s.fromVersion
    ? `\`${s.fromVersion}\` → \`${s.target}\``
    : `→ \`${s.target}\``;
  const req = s.requestId ? ` · req \`${shortRequestId(s.requestId)}\`` : "";
  return `${icon} **Rollout** ${arrow}${req}`;
}

/**
 * One `- <glyph> agent` checklist line per known agent, in roll order.
 *
 * `compact` is the message-size fallback (see MAX_RENDER_CHARS): completed
 * and pending agents fold into single count lines so a large fleet can never
 * push the render past Telegram's edit limit (an oversized edit would be
 * swallowed by the gateway and silently freeze the narration).
 */
function checklistLines(s: RolloutRenderState, compact: boolean): string[] {
  const agents = s.agents ?? [];
  const lines: string[] = [];
  let doneCount = 0;
  let pendingNamed = 0;
  for (const a of agents) {
    const canary = a.canary ? " (canary)" : "";
    const dur = a.durationMs !== undefined ? ` — ${formatDurationMs(a.durationMs)}` : "";
    switch (a.status) {
      case "done":
        if (compact) doneCount += 1;
        else lines.push(`- ✓ \`${a.name}\`${canary}${dur}`);
        break;
      case "running":
        lines.push(`- ⏳ \`${a.name}\`${canary} — restarting…`);
        break;
      case "failed":
        lines.push(`- ✗ \`${a.name}\`${canary} — failed${dur}`);
        break;
      default:
        if (compact) pendingNamed += 1;
        else lines.push(`- · \`${a.name}\`${canary}`);
    }
  }
  if (doneCount > 0) lines.unshift(`- ✓ ${doneCount} done`);
  // Agents we haven't seen a phase for yet (names unknown until their
  // agent-start row): collapse into one pending line.
  const unseen = s.m !== undefined ? Math.max(0, s.m - agents.length) : 0;
  const pendingTotal = unseen + pendingNamed;
  if (pendingTotal > 0 && agents.length > 0) {
    lines.push(`- · ${pendingTotal} more pending`);
  }
  return lines;
}

/** Glyph per singleton state — consistent with the agent checklist glyphs
 *  (✓ / ⏳ / ✗), plus ⧗ for a deliberate host-side deferral and ○ for a
 *  skip. */
function singletonGlyph(status: SingletonRollStatus): string {
  switch (status) {
    case "updated":
      return "✓";
    case "updating":
      return "⏳";
    case "deferred":
      return "⧗";
    case "skipped":
      return "○";
    case "failed":
      return "✗";
    default:
      return "·";
  }
}

/**
 * The singleton / shared-service section: a header plus one checklist line
 * per tracked singleton. Kept in BOTH full and compact renders — it is a
 * fixed handful of rows, unlike the per-agent list, so it can't blow the
 * size ceiling; folding it would drop exactly the information the section
 * exists to add.
 */
function singletonLines(s: RolloutRenderState): string[] {
  const singletons = s.singletons ?? [];
  if (singletons.length === 0) return [];
  const lines = ["**Singletons / shared:**"];
  for (const g of singletons) {
    const detail = g.detail ? ` — ${g.detail}` : "";
    lines.push(`- ${singletonGlyph(g.status)} \`${g.name}\`${detail}`);
  }
  return lines;
}

/** Rough ETA from the mean per-agent duration so far. */
function etaLine(s: RolloutRenderState): string | null {
  if (s.m === undefined) return null;
  const done = (s.agents ?? []).filter(
    (a) => a.status === "done" && a.durationMs !== undefined,
  );
  if (done.length === 0) return null;
  const remaining = s.m - done.length;
  if (remaining <= 0) return null;
  const meanMs = done.reduce((t, a) => t + (a.durationMs ?? 0), 0) / done.length;
  return `~${formatDurationMs(meanMs * remaining)} left (rough est.)`;
}

/**
 * What genuinely stays behind after a COMPLETED roll, and the host-side
 * command for each.
 *
 * #3928 — this used to list `switchroom-web` as "still on the prior
 * version — run host-side". That claim is now provably false on a
 * completed roll: `refresh-web` is in the plan on BOTH paths, and the
 * terminal `verify-components` gate FAILS the roll if web is still
 * behind — so a ✅ card means web converged. Leaving the line in would
 * send an operator who has no host shell (the entire premise of the
 * managed path) to run a command that is already done.
 *
 * What remains is only what no roll can converge: the operator's own
 * host CLI (`npm i -g`, nothing in the plan touches it), and a hostd
 * TEMPLATE regen, which matters only when a release changes hostd's
 * mounts/env — the image tag itself is advanced by the self-bump.
 *
 * #4269 — the template-regen line is DEFINITE, not hedged. The repo
 * records the release in which the hostd template last changed shape
 * (HOSTD_TEMPLATE_LAST_CHANGED, kept honest by the
 * check-hostd-template-guard lint), so when both endpoints of the roll
 * are clean tags the card says "REQUIRED" or "not needed" outright —
 * the operator never guesses. Only when an endpoint is unknown or not
 * a clean vX.Y.Z (channel/sha) does the old hedged wording remain.
 * When the regen IS required, both residual commands collapse into one
 * copy-paste line.
 */
function deferredLines(
  target: string,
  fromVersion?: string,
  hostCli?: HostCliStamp,
): string[] {
  const head = [
    `**Verified on ${target}** — every component this roll owned passed \`verify-components\`, so this is host convergence, not just the agents. Anything the roll was told to skip is named in its warnings.`,
  ];
  // #4571 — the host CLI line is CONDITIONAL now. A roll refuses to start
  // against a stale host CLI, so on a completed roll the stamp normally says
  // the host CLI is already on target — printing "still host-side: upgrade the
  // CLI" there is the same false residual #3928 removed for switchroom-web.
  const hostCliOutstanding = hostCli === undefined || shouldRefuseStaleHostCli(hostCli, target);
  if (hostCli && !hostCliOutstanding) {
    head.push(
      `Host operator CLI: **on ${hostCli.version}** (read from \`~/.switchroom/host-cli.json\`) — nothing to do.`,
    );
  }
  const cliCommand = hostCliInstallCommand(hostCli, target);
  const cliLine = hostCli
    ? `- host operator CLI — observed **${hostCli.version}**, run: \`${cliCommand}\``
    : `- host operator CLI (version not observable from here — no \`~/.switchroom/host-cli.json\`) — ${cliCommand}`;
  const verdict = hostdTemplateRegenVerdict(target, fromVersion);
  // #4269's one-copy-paste block, preserved only where it is still CORRECT:
  // both residuals collapse into one line when the host CLI's upgrade is a
  // pasteable command (see hostCliInstallShellCommand for when it is not).
  const collapsible =
    verdict === "required" && hostCliOutstanding
      ? hostCliInstallShellCommand(hostCli, target)
      : undefined;
  if (collapsible) {
    return [
      ...head,
      `**Still host-side (nothing in a roll can do these):**`,
      `- host operator CLI + hostd template regen — regen is **REQUIRED** for this roll (hostd mounts/env changed in ${HOSTD_TEMPLATE_LAST_CHANGED}). One copy-paste:`,
      `  \`${collapsible} && switchroom hostd install --tag ${target}\``,
    ];
  }
  const regenLine =
    verdict === "required"
      ? `- hostd template regen — **REQUIRED** for this roll (hostd mounts/env changed in ${HOSTD_TEMPLATE_LAST_CHANGED}): \`switchroom hostd install --tag ${target}\``
      : verdict === "not-needed"
        ? `- hostd template regen: **not needed** for this release — hostd mounts/env unchanged since ${HOSTD_TEMPLATE_LAST_CHANGED}.`
        : `- hostd template regen (only if the release changed hostd mounts/env) — \`switchroom hostd install --tag ${target}\``;
  const outstanding = [...(hostCliOutstanding ? [cliLine] : []), regenLine];
  return [...head, `**Still host-side (nothing in a roll can do these):**`, ...outstanding];
}

/**
 * The roll's non-fatal warnings (#3944), rendered as their own terminal
 * section. Empty ⇒ no section. Bounded so a pathological warning flood can't
 * blow the message-size ceiling — the full set still lives on the durable
 * audit row and in `get_status`.
 */
function warningLines(warnings: string[] | undefined): string[] {
  if (!warnings || warnings.length === 0) return [];
  const MAX_SHOWN = 8;
  const shown = warnings.slice(0, MAX_SHOWN);
  const lines = ["**Warnings:**", ...shown.map((w) => `- ⚠️ ${w}`)];
  if (warnings.length > MAX_SHOWN) {
    lines.push(`- …and ${warnings.length - MAX_SHOWN} more (see \`get_status\`).`);
  }
  return lines;
}

/**
 * Defensive size ceiling for the rendered message. Telegram caps message text
 * at 4096 chars, and the gateway's edit path deliberately swallows failures
 * (incl. MESSAGE_TOO_LONG) — an oversized render would therefore freeze the
 * narration silently. Past this threshold the render retries in compact mode
 * (completed/pending agents fold into count lines, name lists become counts).
 */
const MAX_RENDER_CHARS = 3800;

/** Code-span a rolled-agent name list, or a bare count in compact mode
 *  (names may contain `_`, which italicizes in GFM outside a code span). */
function rolledList(rolled: string[], compact: boolean): string {
  if (rolled.length === 0) return "none";
  if (compact) return `${rolled.length} agent(s)`;
  return rolled.map((r) => `\`${r}\``).join(", ");
}

function renderWith(s: RolloutRenderState, compact: boolean): string {
  const rolled = s.rolled ?? [];
  const rolledCount = rolled.length;
  const checklist = checklistLines(s, compact);
  const singletons = singletonLines(s);
  const warnings = warningLines(s.warnings);
  const elapsedMs =
    s.elapsedMs ??
    (s.startedAtMs !== undefined && s.nowMs !== undefined
      ? s.nowMs - s.startedAtMs
      : undefined);

  if (s.terminal === "completed") {
    const parts = [headerLine(s, "✅")];
    let summary = `**Done** — rolled ${rolledCount}${s.m !== undefined ? `/${s.m}` : ""} agent(s)`;
    if (elapsedMs !== undefined) summary += ` in ${formatDurationMs(elapsedMs)}`;
    summary += compact ? "." : `: ${rolledList(rolled, compact)}.`;
    parts.push(summary);
    if (checklist.length > 0) parts.push("", ...checklist);
    if (singletons.length > 0) parts.push("", ...singletons);
    if (warnings.length > 0) parts.push("", ...warnings);
    if (s.deferred !== false)
      parts.push("", ...deferredLines(s.target, s.fromVersion, s.hostCli));
    return parts.join("\n");
  }

  // #3928 — residual component drift. Distinct from "STOPPED": every agent
  // reached the target and the pin is committed; a component the roll owned
  // did not converge. Name it, and name the fact that re-rolling is not the
  // remedy — the operator reads this in Telegram and has no host shell.
  if (s.terminal === "error" && s.failedStep === VERIFY_COMPONENTS_FAILED_STEP) {
    const drifted = s.drifted ?? [];
    const parts = [headerLine(s, "⚠️")];
    let summary =
      `**INCOMPLETE** — ${rolledCount}${s.m !== undefined ? `/${s.m}` : ""} ` +
      `agent(s) reached ${s.target}`;
    if (elapsedMs !== undefined) summary += ` in ${formatDurationMs(elapsedMs)}`;
    summary += `, but the host did NOT fully converge.`;
    parts.push(summary);
    parts.push(
      "",
      `**Still behind ${s.target}:** ` +
        (drifted.length > 0
          ? drifted.map((d) => `\`${d}\``).join(", ")
          : "one or more components (see the roll's warnings)"),
    );
    parts.push(
      "",
      `Re-running the roll will NOT fix this — the agents are already on ` +
        `target. Finish the stale component(s), then \`switchroom update --check\`.`,
    );
    if (checklist.length > 0) parts.push("", ...checklist);
    if (singletons.length > 0) parts.push("", ...singletons);
    if (warnings.length > 0) parts.push("", ...warnings);
    return parts.join("\n");
  }

  if (s.terminal === "error") {
    const where = s.failedStep
      ? ` at \`${s.failedStep}\`${s.failedAgent ? ` (\`${s.failedAgent}\` → ${s.got ?? "unreachable"})` : ""}`
      : "";
    const parts = [headerLine(s, "❌")];
    let summary = `**STOPPED**${where}`;
    if (elapsedMs !== undefined) summary += ` after ${formatDurationMs(elapsedMs)}`;
    summary += `. Rolled before stop: ${rolledList(rolled, compact)}.`;
    parts.push(summary);
    if (checklist.length > 0) parts.push("", ...checklist);
    if (singletons.length > 0) parts.push("", ...singletons);
    if (warnings.length > 0) parts.push("", ...warnings);
    return parts.join("\n");
  }

  // In-flight.
  const parts = [headerLine(s, "⏳"), `**Phase:** ${phaseLine(s)}`];
  if (checklist.length > 0) parts.push("", ...checklist);
  if (singletons.length > 0) parts.push("", ...singletons);
  const footer: string[] = [];
  if (s.m !== undefined) footer.push(`${rolledCount}/${s.m} rolled`);
  else if (rolledCount > 0) footer.push(`${rolledCount} rolled`);
  if (elapsedMs !== undefined) footer.push(`elapsed ${formatDurationMs(elapsedMs)}`);
  const eta = etaLine(s);
  if (eta) footer.push(eta);
  if (footer.length > 0) parts.push("", footer.join(" · "));
  return parts.join("\n");
}

/**
 * Render the full status message body. When `terminal` is set, renders the
 * final ✅/❌ summary; otherwise the in-flight progress checklist. Always leads
 * with the target so the message is self-describing when scrolled back to.
 * Falls back to a compact render (folded checklist, counts instead of name
 * lists) when the full render would exceed the message-size ceiling.
 */
export function renderRolloutStatus(s: RolloutRenderState): string {
  const full = renderWith(s, /* compact */ false);
  if (full.length <= MAX_RENDER_CHARS) return full;
  return renderWith(s, /* compact */ true);
}
