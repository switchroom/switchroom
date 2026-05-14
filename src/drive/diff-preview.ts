/**
 * Suggesting-write diff-preview builder — RFC E §4.2.
 *
 * Pure assembler. Takes the wrapper-attested anchor (from
 * `anchors.ts:resolveAnchor`), the wrapper-computed line-count delta,
 * and the agent-supplied summary string, and produces the structured
 * `DiffPreview` the approval card renders.
 *
 * The load-bearing security invariant per RFC E §4.2:
 *
 *     Anchor name + line counts come from the wrapper.
 *     Summary string comes from the agent.
 *     Both are surfaced separately on the card so the user has
 *     wrapper-attested truth alongside the agent's framing.
 *
 * If the agent's summary says "Added Hiring section" but the wrapper-
 * attested anchor reads `📍 after heading 'Goals'`, the user can see
 * the discrepancy without needing to open the doc.
 *
 * Phase 1c ships the formatter + tests. Phase 1c-followup wires it
 * into the actual approval-card builder + the MCP tool's call site
 * (touches `src/vault/approvals/kernel.ts` and the gateway's
 * card-rendering code; both substantial enough to warrant their own
 * change).
 */

import { type ResolvedAnchor } from "./anchors.js";
import { openInDriveButton } from "./deep-links.js";

// ────────────────────────────────────────────────────────────────────────
// Inputs
// ────────────────────────────────────────────────────────────────────────

export interface DiffMetrics {
  /** Lines added by the proposed edit. NEVER agent-supplied — the wrapper computes it. */
  linesAdded: number;
  /** Lines removed by the proposed edit. NEVER agent-supplied. */
  linesRemoved: number;
}

export interface DiffPreviewInput {
  /** Agent slug — surfaced in the approval card title ("klanker wants to add to..."). */
  agentName: string;
  /** Drive doc title (from `files.get`). NOT agent-supplied. */
  docTitle: string;
  /** Drive file id — used to build the Open-in-Drive deep link. */
  fileId: string;
  /** mimeType from `files.get` — drives the deep-link kind. */
  mimeType?: string;
  /** Optional Drive discussion-thread id when the suggestion has been pre-allocated one. */
  discussionId?: string;
  /** The resolver's output (Phase 1b) — the anchor name surfaced on the card is from here. */
  resolvedAnchor: ResolvedAnchor;
  /** Wrapper-computed line counts. */
  metrics: DiffMetrics;
  /**
   * Agent-supplied "what changed" string. Optional — when absent the
   * card still renders without it (anchor + line counts are enough
   * for the safety guarantee). When present, surfaced under a
   * separate `💬` line so the user can see the agent's framing
   * alongside the wrapper truth.
   */
  agentSummary?: string;
  /**
   * Direct write vs suggestion. RFC E §4.2 default = suggest;
   * direct write is opt-in. Affects card title icon (✏️ vs ⚠).
   */
  mode: "suggest" | "write";
}

// ────────────────────────────────────────────────────────────────────────
// Output shape — what the approval card builder consumes
// ────────────────────────────────────────────────────────────────────────

export interface DiffPreviewLine {
  /** Order on the card top-to-bottom. */
  order: number;
  /**
   * Text content of the line. Already escaped for display — the
   * caller renders verbatim (no further markdown processing should
   * be applied).
   */
  text: string;
  /** Whether this line came from the wrapper (true) or the agent (false). */
  wrapperAttested: boolean;
}

export interface DiffPreviewButton {
  /** Display text of the inline-keyboard button. */
  text: string;
  /** What kind of action this triggers (used to wire callback_data in the kernel). */
  action: "apply_suggestion" | "apply_directly" | "open_in_drive" | "cancel";
  /** For open-in-drive: the URL. For action buttons: undefined (kernel synthesizes callback_data). */
  url?: string;
  /** Cosmetic tier — primary buttons are emphasized in the row layout. */
  emphasis: "primary" | "secondary" | "destructive";
}

export interface DiffPreview {
  /** Title line: "✏️ klanker wants to add to "Q3 Strategy Notes"" */
  title: string;
  /** Body lines, in render order. The 📍 + line-count rows are wrapperAttested. */
  lines: DiffPreviewLine[];
  /** Inline-keyboard button rows. Render order is array order. */
  buttons: DiffPreviewButton[];
  /**
   * Audit payload — what the kernel writes to `approval_audit` so a
   * post-hoc review can compare wrapper truth against agent framing.
   * RFC E §4.2 stores both for "post-hoc review of agent intent vs.
   * wrapper resolution."
   */
  audit: {
    wrapperAttested: {
      anchorDisplayName: string;
      linesAdded: number;
      linesRemoved: number;
      docTitle: string;
      fileId: string;
    };
    agentSupplied: {
      summary: string | null;
    };
  };
}

// ────────────────────────────────────────────────────────────────────────
// Builder
// ────────────────────────────────────────────────────────────────────────

export function buildDiffPreview(input: DiffPreviewInput): DiffPreview {
  validateInput(input);

  const titleIcon = input.mode === "write" ? "⚠" : "✏️";
  const titleVerb = input.mode === "write" ? "wants to write to" : "wants to add to";
  const title = `${titleIcon} ${input.agentName} ${titleVerb} "${input.docTitle}"`;

  const lines: DiffPreviewLine[] = [];

  // 📍 line — wrapper-attested anchor name. Always first body line.
  // The 📍 prefix is the load-bearing visual cue per RFC E §4.2 mockup.
  lines.push({
    order: 0,
    text: `📍 ${input.resolvedAnchor.displayName}`,
    wrapperAttested: true,
  });

  // Line-count metrics — wrapper-computed. Format mirrors the RFC §4.2
  // mockup ("+47 lines / -0 lines"). Agent CANNOT influence these.
  lines.push({
    order: 1,
    text: formatMetrics(input.metrics),
    wrapperAttested: true,
  });

  // Optional agent-supplied summary, prefixed `💬` so the user can
  // visually distinguish "agent's framing" from "wrapper's truth"
  // above. Only rendered when the agent supplied one — the card is
  // already safety-complete without it.
  if (input.agentSummary !== undefined && input.agentSummary.trim() !== "") {
    lines.push({
      order: 2,
      text: `💬 "${sanitizeSummary(input.agentSummary)}"`,
      wrapperAttested: false,
    });
  }

  const buttons: DiffPreviewButton[] = [];

  // Open-in-Drive — always present, always first button per RFC §4.2.
  buttons.push({
    text: "📖 Open in Drive",
    action: "open_in_drive",
    url: openInDriveButton({
      fileId: input.fileId,
      mimeType: input.mimeType,
      discussionId: input.discussionId,
    }).url,
    emphasis: "secondary",
  });

  // Primary action: Apply as suggestion (default per RFC) or Apply
  // directly (when mode=write, which is opt-in via expand only —
  // the kernel routes the user there before this builder is called).
  if (input.mode === "suggest") {
    buttons.push({
      text: "✅ Apply as suggestion",
      action: "apply_suggestion",
      emphasis: "primary",
    });
    buttons.push({
      text: "⚠ Apply directly",
      action: "apply_directly",
      emphasis: "secondary",
    });
  } else {
    buttons.push({
      text: "⚠ Apply directly",
      action: "apply_directly",
      emphasis: "destructive",
    });
  }

  buttons.push({
    text: "🚫 Cancel",
    action: "cancel",
    emphasis: "secondary",
  });

  const audit: DiffPreview["audit"] = {
    wrapperAttested: {
      anchorDisplayName: input.resolvedAnchor.displayName,
      linesAdded: input.metrics.linesAdded,
      linesRemoved: input.metrics.linesRemoved,
      docTitle: input.docTitle,
      fileId: input.fileId,
    },
    agentSupplied: {
      summary: input.agentSummary?.trim() || null,
    },
  };

  return { title, lines, buttons, audit };
}

// ────────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────────

/**
 * Format the wrapper's diff metrics as the RFC §4.2 mockup line:
 * "+47 lines / -0 lines". Always shows both halves so the absence
 * of either is visually unambiguous.
 */
function formatMetrics(m: DiffMetrics): string {
  return `+${m.linesAdded} lines / -${m.linesRemoved} lines`;
}

/**
 * Strip control characters from agent-supplied summary text. The
 * summary lands in a quoted string on the approval card; an embedded
 * `"` or newline could break out of the quoting visually. We
 * normalize to a single line, replace embedded quotes, and cap
 * length to keep the card scannable.
 *
 * NOT a security boundary (the agent already controls the summary
 * content; our defense is the wrapper-attested anchor surfaced
 * separately). This is a "card stays well-formed" hygiene step.
 */
function sanitizeSummary(summary: string): string {
  const oneLine = summary.replace(/[\r\n\t]+/g, " ").trim();
  const noQuotes = oneLine.replace(/"/g, "'");
  const max = 200;
  if (noQuotes.length <= max) return noQuotes;
  return noQuotes.slice(0, max - 1) + "…";
}

function validateInput(input: DiffPreviewInput): void {
  if (input.agentName.length === 0) {
    throw new Error("buildDiffPreview: agentName must not be empty");
  }
  if (input.docTitle.length === 0) {
    throw new Error("buildDiffPreview: docTitle must not be empty");
  }
  if (input.metrics.linesAdded < 0 || input.metrics.linesRemoved < 0) {
    throw new Error(
      "buildDiffPreview: line counts must be non-negative (wrapper bug if you hit this)",
    );
  }
  if (
    !Number.isInteger(input.metrics.linesAdded) ||
    !Number.isInteger(input.metrics.linesRemoved)
  ) {
    throw new Error(
      "buildDiffPreview: line counts must be integers",
    );
  }
}
