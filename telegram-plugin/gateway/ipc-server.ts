import { renameSync, unlinkSync, chmodSync } from "fs";
import type {
  ClientToGateway,
  GatewayToClient,
  HeartbeatMessage,
  InjectInboundMessage,
  SendOutboundMessage,
  QuotaWallDetectedMessage,
  QueryPendingPermissionMessage,
  CheckPreApprovedMessage,
  PostSkillProposalMessage,
  PostEvalCaseProposalMessage,
  OperatorEventForward,
  PermissionRequestForward,
  PtyPartialForward,
  RegisterMessage,
  RequestConfigApprovalMessage,
  RequestConfigFinalizeMessage,
  RequestDriveApprovalMessage,
  RequestMs365ApprovalMessage,
  RolloutStatusPostMessage,
  RolloutStatusEditMessage,
  ScheduleRestartMessage,
  SessionEventForward,
  ToolCallMessage,
  ToolCallResult,
  HelloBuzzPeerMessage,
  OutboundToBuzzMessage,
  BuzzPublishResultMessage,
} from "./ipc-protocol.js";
import { RICH_MESSAGE_MAX_CHARS } from "../format.js";
import { OPERATOR_EVENT_KINDS } from "../operator-events.js";

export interface IpcServerOptions {
  socketPath: string;
  onClientRegistered: (client: IpcClient) => void;
  onClientDisconnected: (client: IpcClient) => void;
  onToolCall: (client: IpcClient, msg: ToolCallMessage) => Promise<ToolCallResult>;
  onSessionEvent: (client: IpcClient, msg: SessionEventForward) => void;
  onPermissionRequest: (client: IpcClient, msg: PermissionRequestForward) => void;
  onHeartbeat: (client: IpcClient, msg: HeartbeatMessage) => void;
  onScheduleRestart: (client: IpcClient, msg: ScheduleRestartMessage) => void;
  onOperatorEvent?: (client: IpcClient, msg: OperatorEventForward) => void;
  /**
   * Forwarded PTY-tail partial — the latest extracted reply text from
   * Claude Code's TUI rendering. Optional: gateways without streaming
   * configured (or in test fixtures) can omit this and pty_partial
   * messages will be silently dropped at dispatch.
   */
  onPtyPartial?: (client: IpcClient, msg: PtyPartialForward) => void;
  /**
   * Phase 2 cron-fold-in: invoked when a privileged in-container client
   * (the agent-scheduler sibling) asks the gateway to forward a
   * synthesized InboundMessage to a registered bridge. The handler is
   * expected to call `ipcServer.sendToAgent(msg.agentName, msg.inbound)`
   * (or its own equivalent). Optional: gateways that don't run the
   * inline scheduler simply ignore inject_inbound messages.
   */
  onInjectInbound?: (client: IpcClient, msg: InjectInboundMessage) => void;
  /**
   * #2307 Tier-0 action tier — a model-free outbound post. Invoked when the
   * agent-scheduler sibling fires a `kind: action` `telegram-message`. The
   * handler is expected to post `msg.text` to `msg.chatId` (fenced to the
   * agent's own chat) via the locked bot — with NO model, NO inject_inbound,
   * NO session wake. Optional: gateways that don't run the inline scheduler
   * ignore it.
   */
  onSendOutbound?: (client: IpcClient, msg: SendOutboundMessage) => void;
  /**
   * The autoaccept-poll wedge-watchdog detected claude's `/rate-limit-options`
   * weekly-quota menu (no 429 ever reached the gateway). Handler is expected to
   * trigger the existing fleet auto-fallback for `msg.agentName`, threading
   * `msg.resetAt` as the markExhausted `until`. Fire-and-forget; gateways that
   * don't run failover simply ignore it.
   */
  onQuotaWallDetected?: (client: IpcClient, msg: QuotaWallDetectedMessage) => void;
  /**
   * Issue #2971 — read-only wedge-watchdog query: is there a live pending
   * permission request (Telegram approval card) for this agent right now?
   * The handler MUST reply on the same connection with a
   * `pending_permission_status` event (matching `correlationId`) sourced
   * from the gateway's `pendingPermissions` map. Optional: when no handler
   * is wired (older gateway build, or a test fixture that doesn't need it),
   * the server replies `pending: false` immediately — the watchdog's
   * existing Esc fallback then behaves exactly as it did before this
   * feature (mixed-version safety).
   */
  onQueryPendingPermission?: (client: IpcClient, msg: QueryPendingPermissionMessage) => void;
  /**
   * #2975 Stage 2 — hostd's read-only pre-approval query. Handler answers from
   * the gateway's correlation maps by EXACT diff byte-match and replies with a
   * `pre_approved_result` event. MUST NOT mutate gateway state. Optional: when
   * no handler is wired (older gateway build, or a fixture that doesn't need
   * it), the server replies `preApproved: false` immediately so hostd fails
   * closed to today's rate-limited behaviour (mixed-version safety).
   */
  onCheckPreApproved?: (client: IpcClient, msg: CheckPreApprovedMessage) => void;
  /**
   * #2670 one-tap self-improvement — persist a skill-improvement proposal
   * and post its Approve/Dismiss card. Handler persists the draft bundle to
   * the self-improve proposal store and posts the card to the agent's own
   * chat. Optional; gateways that don't surface proposals ignore it.
   */
  onPostSkillProposal?: (client: IpcClient, msg: PostSkillProposalMessage) => void;
  /**
   * RFC amendment §"corrections as eval cases" — `add-eval-case` asks the
   * gateway to persist an eval-case proposal and post its one-tap card.
   * Optional; gateways that don't surface proposals ignore it.
   */
  onPostEvalCaseProposal?: (client: IpcClient, msg: PostEvalCaseProposalMessage) => void;
  /**
   * RFC E §4.2 Cut 2 — Drive-write PreToolUse hook asks the gateway
   * to register a kernel approval request + post a diff-preview
   * card to Telegram. Handler is expected to send a
   * `drive_approval_posted` event back over the same connection
   * (`client.send(...)`). Optional: gateways without the hook
   * configured ignore these messages.
   */
  onRequestDriveApproval?: (
    client: IpcClient,
    msg: RequestDriveApprovalMessage,
  ) => Promise<void>;
  /**
   * RFC #1873 §8 — Microsoft 365 write approval (PR 4). Same shape as
   * onRequestDriveApproval but for softeria write tools. Optional;
   * gateways without M365 integration ignore.
   */
  onRequestMs365Approval?: (
    client: IpcClient,
    msg: RequestMs365ApprovalMessage,
  ) => Promise<void>;
  /**
   * #1623 — hostd-initiated config-edit approval card. Handler posts
   * a Telegram card with [✅ Approve] [🚫 Deny] buttons, tracks the
   * pending request in-memory, and sends `config_approval_resolved`
   * back over the same connection when the operator taps or the
   * timeout fires. Optional: gateways without the hostd integration
   * configured ignore these messages.
   */
  onRequestConfigApproval?: (
    client: IpcClient,
    msg: RequestConfigApprovalMessage,
  ) => Promise<void>;
  /**
   * #1623 — hostd-initiated terminal card edit after apply completed
   * (success OR rolled-back). Best-effort; no reply expected.
   */
  onRequestConfigFinalize?: (
    client: IpcClient,
    msg: RequestConfigFinalizeMessage,
  ) => Promise<void>;
  /**
   * #2726 Part 1 — hostd asks the gateway to POST one ordinary operator-DM
   * message narrating a rollout's terminal outcome (Part 1) or its first phase
   * (Part 2). Handler posts to the agent's own operator chat and — for Part 2 —
   * replies with a `rollout_status_posted` event carrying the message_id.
   * Optional: gateways without the hostd integration ignore it.
   */
  onRolloutStatusPost?: (
    client: IpcClient,
    msg: RolloutStatusPostMessage,
  ) => Promise<void>;
  /**
   * #2726 Part 2 — hostd asks the gateway to EDIT a previously-posted rollout
   * status message as later phases arrive. Optional. #4065: the handler replies
   * with a `rollout_status_edited` outcome so hostd can tell an applied edit
   * from an edit into a deleted card; the roll never blocks on that reply.
   */
  onRolloutStatusEdit?: (
    client: IpcClient,
    msg: RolloutStatusEditMessage,
  ) => void | Promise<void>;
  /**
   * Buzz co-channel Phase 2b — the duplex Buzz peer's advisory publish outcome
   * (`buzz_publish_result`). Handler feeds the buzz-mirror hub's correlation
   * map: it frees the pending slot and, on success, records the published
   * eventId so a later `correction` can target it. Fire-and-forget — under
   * `both` mode the Telegram copy is the guaranteed delivery, so a failed
   * publish never fails or retries the answer. Optional; a gateway without Buzz
   * wired simply drops the message.
   */
  onBuzzPublishResult?: (client: IpcClient, msg: BuzzPublishResultMessage) => void;
  log?: (msg: string) => void;
  /**
   * How long (in ms) to wait without a heartbeat before force-closing the
   * client connection. The bridge sends heartbeats every 5s by default, so
   * a safe threshold is 3–5× that (15–30s). Set to 0 to disable the watchdog.
   * Defaults to 30 000 ms (30 s).
   *
   * Issue #71: without this, a bridge that crashes or hangs silently stays in
   * the agentIndex and new inbound Telegram messages are never delivered to the
   * new claude process that reconnects after a restart.
   */
  heartbeatTimeoutMs?: number;
}

export interface IpcClient {
  id: string;
  agentName: string | null;
  topicId: number | null;
  /**
   * Buzz co-channel Phase 2b (S7). True IFF this connection announced itself
   * as the duplex Buzz publish peer via `hello_buzz_peer`. A peer NEVER holds
   * an `agentName`/`agentIndex` slot; the flag makes the peer and agent-bridge
   * roles mutually exclusive (a `register` is refused on a peer connection and
   * vice-versa) and is what keeps the peer connection watchdog-exempt (it rides
   * the existing `agentName === null` exemption — the peer has no heartbeat).
   */
  isBuzzPeer: boolean;
  send(msg: GatewayToClient): void;
  close(): void;
  isAlive(): boolean;
  lastHeartbeat: number;
}

export interface IpcServer {
  sendToAgent(agentName: string, msg: GatewayToClient): boolean;
  sendToTopic(topicId: number, msg: GatewayToClient): boolean;
  broadcast(msg: GatewayToClient): void;
  getClient(agentName: string): IpcClient | undefined;
  clientCount(): number;
  /**
   * Buzz co-channel Phase 2b. Send an `outbound_to_buzz` request to the single
   * duplex Buzz peer, if one is currently connected. Returns false (no send)
   * when no peer has announced itself — the caller (buzz-mirror hub) treats a
   * false return as "Buzz unreachable" and simply drops the mirror; the
   * guaranteed Telegram copy already went out, so nothing fails or retries.
   */
  sendToBuzzPeer(msg: OutboundToBuzzMessage): boolean;
  close(): Promise<void>;
}

type SocketData = { clientId: string; buffer: string };

/** Max buffer size per client (1MB). Protects against a client flooding
 *  data without newline delimiters, which would cause unbounded memory growth. */
const MAX_BUFFER_SIZE = 1024 * 1024;

/** Allowlist of OperatorEventKind values that can arrive over IPC. DERIVED
 *  from the canonical `OPERATOR_EVENT_KINDS` array in
 *  `telegram-plugin/operator-events.ts` — the single source of truth for the
 *  taxonomy — so the validator can NEVER drift out of sync with it again.
 *
 *  History: this used to be a hand-maintained literal Set that missed the
 *  `provider-credit-exhausted` / `mcp-dependency-blocked` / `proxy-misconfig`
 *  kinds after they were added to the union. The bridge forwarded a
 *  `provider-credit-exhausted` operator_event; this validator rejected it as an
 *  "invalid IPC message shape" and dropped it, so an OpenRouter/LiteLLM 402
 *  credit wall produced NO loud Telegram card (the 2026-07-30 incident).
 *  Deriving from the canonical array closes that drift class structurally.
 *
 *  `operator-events.ts` is a pure module (its only imports are the pure
 *  `format` / `raw-error-scrub` / `model-unavailable` / `provider-credit`
 *  leaves), so importing it here introduces no cycle back into the gateway. */
const VALID_OPERATOR_KINDS = new Set<string>(OPERATOR_EVENT_KINDS);

/** Same regex as `assertSafeAgentName` and the op:* callback handler in
 *  gateway.ts — keeps every entry-point that touches an agent name on the
 *  same shape. */
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,50}$/;

/** Cap for the `detail` field on an operator_event message. Long enough to
 *  carry a typical Anthropic error body, short enough that a misbehaving
 *  bridge can't fill the gateway log. */
const OPERATOR_EVENT_DETAIL_MAX = 1000;

/** Validate that a parsed JSON object looks like a legitimate ClientToGateway
 *  message. Returns false for malformed or unexpected shapes. This prevents
 *  a rogue process on the same Unix socket from injecting arbitrary payloads.
 *
 *  Exported so tests can exercise every field-level rejection independently
 *  without spinning up a real Unix-socket server. */
export function validateClientMessage(msg: unknown): msg is ClientToGateway {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case "register":
      // Reject the literal "default" — that's the legacy fallback used
      // by anonymous bridges (see #430). A correctly-configured bridge
      // sets SWITCHROOM_AGENT_NAME to the real agent name; a bridge
      // sending "default" is either an older binary or a stray
      // claude-code session and would crosstalk into another agent's
      // chat. Server-side rejection is defence in depth — the bridge
      // refuses to register without a name first.
      return typeof m.agentName === "string"
        && m.agentName.length > 0
        && m.agentName !== "default"
        && m.agentName.length <= 128
        && (m.topicId === undefined
          || (typeof m.topicId === "number"
            && Number.isInteger(m.topicId)
            && Number.isFinite(m.topicId)));
    case "tool_call":
      return typeof m.id === "string" && m.id.length > 0
        && typeof m.tool === "string" && m.tool.length > 0
        && typeof m.args === "object" && m.args !== null;
    case "session_event":
      return typeof m.event === "object" && m.event !== null
        && typeof m.chatId === "string";
    case "permission_request":
      return typeof m.requestId === "string" && m.requestId.length > 0
        && typeof m.toolName === "string"
        && typeof m.description === "string"
        && typeof m.inputPreview === "string";
    case "heartbeat":
      return typeof m.agentName === "string" && m.agentName.length > 0;
    case "schedule_restart":
      return typeof m.agentName === "string" && m.agentName.length > 0;
    case "operator_event":
      return typeof m.kind === "string"
        && VALID_OPERATOR_KINDS.has(m.kind as string)
        && typeof m.agent === "string"
        && AGENT_NAME_RE.test(m.agent as string)
        && typeof m.detail === "string"
        && (m.detail as string).length <= OPERATOR_EVENT_DETAIL_MAX
        && typeof m.chatId === "string";
    case "pty_partial":
      // Extracted reply text from PTY-tail. May be empty (the extractor
      // returns empty strings for "no text yet" snapshots — gateway
      // handler dedups on lastPtyPreviewByChat). Capped at 8192 — this is a
      // preview-buffer bound on the PTY tail, not the outbound wire cap (which
      // is now RICH_MESSAGE_MAX_CHARS / 32768 on the rich path post-#2669) —
      // sized to bound buffer growth from a runaway extractor while still
      // carrying a useful preview.
      return typeof m.text === "string"
        && (m.text as string).length <= 8192;
    case "update_placeholder":
      // Legacy recall.py IPC. Accepted as a valid wire shape so the
      // validator doesn't log "invalid IPC message shape" on every
      // recall hook fire; dispatched to a no-op handler in
      // `handleMessage` below. See `UpdatePlaceholderMessage` doc in
      // ipc-protocol.ts for context.
      return typeof m.chatId === "string" && (m.chatId as string).length > 0
        && typeof m.text === "string" && (m.text as string).length <= 8192;
    case "inject_inbound": {
      // Phase 2 cron-fold-in. The wrapped `inbound` is forwarded
      // verbatim to the bridge as a `type: "inbound"` envelope, so
      // we validate the same fields the bridge's
      // validateGatewayMessage cares about (`chatId`, `text`) plus
      // the basic structural shape every InboundMessage carries.
      if (typeof m.agentName !== "string"
        || !AGENT_NAME_RE.test(m.agentName as string)) return false;
      if (typeof m.inbound !== "object" || m.inbound === null) return false;
      const inb = m.inbound as Record<string, unknown>;
      return inb.type === "inbound"
        && typeof inb.chatId === "string"
        && (inb.chatId as string).length > 0
        && typeof inb.text === "string"
        && typeof inb.messageId === "number"
        && typeof inb.user === "string"
        && typeof inb.userId === "number"
        && typeof inb.ts === "number"
        && typeof inb.meta === "object"
        && inb.meta !== null;
    }
    case "send_outbound": {
      // #2307 Tier-0 action tier — a model-free outbound post. Validate the
      // wire shape; the gateway handler fences chatId to the agent's own chat.
      if (typeof m.agentName !== "string"
        || !AGENT_NAME_RE.test(m.agentName as string)) return false;
      if (typeof m.chatId !== "string" || (m.chatId as string).length === 0) return false;
      // text non-empty and bounded — the send_outbound handler posts via
      // sendRichMessage (rich path), whose wire cap is RICH_MESSAGE_MAX_CHARS
      // (32768) post-#2669, not the legacy 4096 plain-text limit. Reject
      // over-long here (defense in depth against a malformed payload).
      if (typeof m.text !== "string" || (m.text as string).length === 0
        || (m.text as string).length > RICH_MESSAGE_MAX_CHARS) return false;
      if (m.threadId !== undefined
        && (typeof m.threadId !== "number" || !Number.isInteger(m.threadId as number))) return false;
      if (m.parseMode !== undefined && m.parseMode !== "html" && m.parseMode !== "text") return false;
      return true;
    }
    case "post_skill_proposal": {
      // #2670 one-tap self-improvement — validate the wire shape; the
      // gateway handler fences chatId to the agent's own chat.
      if (typeof m.agentName !== "string"
        || !AGENT_NAME_RE.test(m.agentName as string)) return false;
      if (typeof m.chatId !== "string" || (m.chatId as string).length === 0) return false;
      if (typeof m.skillSlug !== "string" || (m.skillSlug as string).length === 0) return false;
      if (typeof m.isNew !== "boolean") return false;
      if (typeof m.lesson !== "string" || (m.lesson as string).length === 0) return false;
      if (typeof m.evidence !== "string") return false;
      if (typeof m.draft !== "object" || m.draft === null || Array.isArray(m.draft)) return false;
      if (typeof (m.draft as Record<string, unknown>)["SKILL.md"] !== "string") return false;
      if (m.threadId !== undefined
        && (typeof m.threadId !== "number" || !Number.isInteger(m.threadId as number))) return false;
      return true;
    }
    case "post_eval_case_proposal": {
      // RFC amendment §"corrections as eval cases" — validate the wire shape;
      // the gateway handler fences chatId to the agent's own chat.
      if (typeof m.agentName !== "string"
        || !AGENT_NAME_RE.test(m.agentName as string)) return false;
      if (typeof m.chatId !== "string" || (m.chatId as string).length === 0) return false;
      if (typeof m.skillSlug !== "string" || (m.skillSlug as string).length === 0) return false;
      if (typeof m.skillDir !== "string" || (m.skillDir as string).length === 0) return false;
      if (typeof m.fingerprint !== "string" || (m.fingerprint as string).length === 0) return false;
      if (typeof m.heldOut !== "boolean") return false;
      if (typeof m.case !== "object" || m.case === null || Array.isArray(m.case)) return false;
      if (typeof (m.case as Record<string, unknown>).prompt !== "string"
        || ((m.case as Record<string, unknown>).prompt as string).length === 0) return false;
      if (m.threadId !== undefined
        && (typeof m.threadId !== "number" || !Number.isInteger(m.threadId as number))) return false;
      return true;
    }
    case "quota_wall_detected": {
      // wedge-watchdog detected the /rate-limit-options weekly-quota menu.
      if (typeof m.agentName !== "string"
        || !AGENT_NAME_RE.test(m.agentName as string)) return false;
      // resetAt optional; when present it must be a finite epoch-ms.
      if (m.resetAt !== undefined
        && (typeof m.resetAt !== "number" || !Number.isFinite(m.resetAt as number))) return false;
      return true;
    }
    case "query_pending_permission": {
      // Issue #2971 — read-only wedge-watchdog probe. Wire shape only.
      if (typeof m.agentName !== "string"
        || !AGENT_NAME_RE.test(m.agentName as string)) return false;
      if (typeof m.correlationId !== "string"
        || (m.correlationId as string).length === 0
        || (m.correlationId as string).length > 64) return false;
      return true;
    }
    case "check_pre_approved": {
      // #2975 Stage 2 — hostd read-only pre-approval query. Wire shape only;
      // the handler byte-matches the diff against the correlation maps and
      // never mutates state.
      if (typeof m.agentName !== "string"
        || !AGENT_NAME_RE.test(m.agentName as string)) return false;
      if (typeof m.correlationId !== "string"
        || (m.correlationId as string).length === 0
        || (m.correlationId as string).length > 64) return false;
      if (typeof m.unifiedDiff !== "string"
        || (m.unifiedDiff as string).length === 0) return false;
      return true;
    }
    case "request_config_approval": {
      // #1623 — hostd-initiated config-edit approval card. Wire shape
      // only; the handler module validates the diff content.
      if (typeof m.requestId !== "string"
        || (m.requestId as string).length === 0
        || (m.requestId as string).length > 64) return false;
      if (typeof m.agentName !== "string"
        || !AGENT_NAME_RE.test(m.agentName as string)) return false;
      if (typeof m.reason !== "string"
        || (m.reason as string).length === 0
        || (m.reason as string).length > 500) return false;
      if (typeof m.unifiedDiff !== "string"
        || (m.unifiedDiff as string).length === 0) return false;
      if (typeof m.timeoutMs !== "number"
        || !Number.isFinite(m.timeoutMs)
        || (m.timeoutMs as number) <= 0) return false;
      // Optional header override (KEN-129) — absent falls back to the
      // default config-edit header. SINGLE LINE ONLY: the header renders
      // VERBATIM as the card's first line (it carries intentional markdown,
      // so it can't be escaped), which means a newline would let a caller
      // forge the `Agent:` / `Reason:` lines beneath it — or unbalance the
      // diff's ``` fence — on a card the operator is about to approve.
      // Control characters are rejected for the same reason.
      if (m.title !== undefined
        && (typeof m.title !== "string"
          || (m.title as string).length === 0
          || (m.title as string).length > 200
          // eslint-disable-next-line no-control-regex
          || /[\u0000-\u001f\u007f]/.test(m.title as string))) return false;
      return true;
    }
    case "request_config_finalize": {
      if (typeof m.requestId !== "string"
        || (m.requestId as string).length === 0
        || (m.requestId as string).length > 64) return false;
      if (m.outcome !== "applied"
        && m.outcome !== "aborted_config_changed"
        && m.outcome !== "reconcile_failed_rolled_back") return false;
      if (m.detail !== undefined
        && (typeof m.detail !== "string"
          || (m.detail as string).length > 500)) return false;
      // affectedAgents (optional): a bounded list of kebab-case agent names —
      // they drive a restart button, so validate shape + charclass even though
      // the sender (hostd) is trusted (defense in depth).
      if (m.affectedAgents !== undefined) {
        if (!Array.isArray(m.affectedAgents) || (m.affectedAgents as unknown[]).length > 64) return false;
        for (const a of m.affectedAgents as unknown[]) {
          if (typeof a !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(a)) return false;
        }
      }
      if (m.fleetWide !== undefined && typeof m.fleetWide !== "boolean") return false;
      return true;
    }
    case "request_drive_approval": {
      // RFC E §4.2 Cut 2. Validate the wire-shaped fields the
      // gateway will route on; the inner `preview` is treated as
      // an opaque object and gets defensively re-validated by
      // `buildDiffPreview()` downstream.
      if (typeof m.correlationId !== "string"
        || (m.correlationId as string).length === 0
        || (m.correlationId as string).length > 64) return false;
      if (typeof m.agentName !== "string"
        || !AGENT_NAME_RE.test(m.agentName as string)) return false;
      if (typeof m.preview !== "object" || m.preview === null) return false;
      if (m.ttlMs !== undefined
        && (typeof m.ttlMs !== "number"
          || !Number.isFinite(m.ttlMs)
          || (m.ttlMs as number) < 0)) return false;
      return true;
    }
    case "request_ms365_approval": {
      // RFC #1873 §8 PR 4. Same wire-shape gate as Drive — gateway
      // routes on the outer fields; the inner `preview` is opaque
      // and re-validated by `validateMs365Preview()` downstream.
      if (typeof m.correlationId !== "string"
        || (m.correlationId as string).length === 0
        || (m.correlationId as string).length > 64) return false;
      if (typeof m.agentName !== "string"
        || !AGENT_NAME_RE.test(m.agentName as string)) return false;
      if (typeof m.preview !== "object" || m.preview === null) return false;
      if (m.ttlMs !== undefined
        && (typeof m.ttlMs !== "number"
          || !Number.isFinite(m.ttlMs)
          || (m.ttlMs as number) < 0)) return false;
      return true;
    }
    case "rollout_status_post": {
      // #2726 Part 1 — hostd-initiated terminal ping / status post. Wire shape
      // only; the gateway handler fences the chat to the agent's own operator.
      if (typeof m.requestId !== "string"
        || (m.requestId as string).length === 0
        || (m.requestId as string).length > 64) return false;
      if (typeof m.agentName !== "string"
        || !AGENT_NAME_RE.test(m.agentName as string)) return false;
      if (typeof m.text !== "string"
        || (m.text as string).length === 0
        || (m.text as string).length > RICH_MESSAGE_MAX_CHARS) return false;
      return true;
    }
    case "rollout_status_edit": {
      // #2726 Part 2 — hostd-initiated status-message edit.
      if (typeof m.requestId !== "string"
        || (m.requestId as string).length === 0
        || (m.requestId as string).length > 64) return false;
      if (typeof m.agentName !== "string"
        || !AGENT_NAME_RE.test(m.agentName as string)) return false;
      if (typeof m.messageId !== "number"
        || !Number.isInteger(m.messageId as number)) return false;
      if (typeof m.text !== "string"
        || (m.text as string).length === 0
        || (m.text as string).length > RICH_MESSAGE_MAX_CHARS) return false;
      return true;
    }
    case "hello_buzz_peer": {
      // Buzz co-channel Phase 2b — the sidecar's one-time duplex-peer
      // announcement. Wire shape only; the handler parks it in the dedicated
      // buzzPeerClient slot and enforces role-disjointness with `register`.
      return typeof m.agentName === "string"
        && AGENT_NAME_RE.test(m.agentName as string);
    }
    case "buzz_publish_result": {
      // Buzz co-channel Phase 2b — the sidecar's advisory publish outcome.
      if (typeof m.correlationId !== "string"
        || (m.correlationId as string).length === 0
        || (m.correlationId as string).length > 64) return false;
      if (typeof m.ok !== "boolean") return false;
      if (m.eventId !== undefined
        && (typeof m.eventId !== "string" || (m.eventId as string).length > 128)) return false;
      if (m.error !== undefined
        && (typeof m.error !== "string" || (m.error as string).length > 500)) return false;
      return true;
    }
    default:
      return false;
  }
}

export function createIpcServer(options: IpcServerOptions): IpcServer {
  const {
    socketPath,
    onClientRegistered,
    onClientDisconnected,
    onToolCall,
    onSessionEvent,
    onPermissionRequest,
    onHeartbeat,
    onScheduleRestart,
    onOperatorEvent,
    onPtyPartial,
    onInjectInbound,
    onSendOutbound,
    onQuotaWallDetected,
    onQueryPendingPermission,
    onCheckPreApproved,
    onPostSkillProposal,
    onPostEvalCaseProposal,
    onRequestDriveApproval,
    onRequestMs365Approval,
    onRequestConfigApproval,
    onRequestConfigFinalize,
    onRolloutStatusPost,
    onRolloutStatusEdit,
    onBuzzPublishResult,
    log = () => {},
    heartbeatTimeoutMs = 30_000,
  } = options;

  // Buzz co-channel Phase 2b (S7) — the single duplex Buzz publish peer's
  // connection, or null when none is connected. Parked here (never in
  // agentIndex) so `outbound_to_buzz` addresses exactly one peer and the peer
  // never shadows an agent-bridge slot. Nulled in removeClient on disconnect.
  let buzzPeerClient: IpcClientImpl | null = null;

  // Hub-side dedup ring for Buzz injects (fable MAJOR-2). The Buzz sidecar's
  // durable journal covers the normal case, but a crash AFTER the gateway
  // injects but BEFORE the sidecar records dedup would re-fire the turn on
  // restart. This bounded in-memory ring drops a re-injected duplicate at the
  // hub, keyed on the stable Buzz event id.
  //
  // SCOPE — buzz ONLY. This is the shared inject hot path (cron, reactions,
  // resume, etc.). The check below fires exclusively for injects whose
  // `inbound.meta.source === "buzz"` AND that carry a `buzz_event_id`; every
  // other inject source flows through untouched, byte-identical to before. A
  // buzz inject without a stable id (should not happen — inbound-map always
  // stamps one) also flows through untouched rather than being dropped blind.
  const BUZZ_INJECT_RING_MAX = 1024;
  const buzzInjectSeen = new Set<string>();
  const buzzInjectOrder: string[] = [];
  /** Return true if this buzz event id was already injected (drop it); else
   *  record it and return false. Bounded FIFO eviction at RING_MAX entries. */
  const buzzInjectIsDuplicate = (eventId: string): boolean => {
    if (buzzInjectSeen.has(eventId)) return true;
    buzzInjectSeen.add(eventId);
    buzzInjectOrder.push(eventId);
    if (buzzInjectOrder.length > BUZZ_INJECT_RING_MAX) {
      const evicted = buzzInjectOrder.shift();
      if (evicted !== undefined) buzzInjectSeen.delete(evicted);
    }
    return false;
  };

  // Race-safe cleanup: rename the live socket to a .bak sidecar rather than
  // unlinking it. If the old gateway's delayed shutdown-cleanup later tries to
  // rename again, it targets .bak (already-moved) not the freshly-bound file.
  // Previous unlinkSync-based cleanup had a race where an in-flight old-gateway
  // cleanup could delete the new gateway's just-bound socket inode, leaving the
  // server listening but the filesystem entry gone (orphaned socket).
  try { renameSync(socketPath, socketPath + ".bak"); } catch {}
  // Now that we're about to bind fresh, stale .bak from a prior generation
  // is safe to remove — no one is using it (we haven't bound yet).
  try { unlinkSync(socketPath + ".bak"); } catch {}

  const clients = new Set<IpcClient>();
  const agentIndex = new Map<string, IpcClient>();
  const topicIndex = new Map<number, IpcClient>();

  /** Per-client dedup set for the legacy `update_placeholder` log line —
   *  one log entry per connection, not per message. Cleared on disconnect. */
  const loggedLegacyUpdatePlaceholder = new Set<string>();

  function removeClient(client: IpcClient & { _socket: ReturnType<typeof Bun.listen> extends infer S ? any : never }) {
    clients.delete(client);
    // CRITICAL race fix (2026-05-20): only delete from agentIndex /
    // topicIndex if the index still points to THIS client. A bridge
    // that reconnects fast can have its NEW client overwrite
    // agentIndex[name] (via handleRegister's replace-not-reject)
    // BEFORE the OLD client's close+removeClient runs. Blindly
    // deleting agentIndex[name] would remove the LIVE replacement
    // client by accident → sendToAgent returns false → all subsequent
    // inbound buffered until the bridge happens to reconnect in an
    // ordering that works out. User-visible symptom was the chronic
    // bridge-flap pattern (clerk + gymbro unresponsive 2026-05-20)
    // where the gateway log showed "bridge registered" but messages
    // were still getting buffered as if no bridge existed.
    if (client.agentName && agentIndex.get(client.agentName) === client) {
      agentIndex.delete(client.agentName);
    }
    if (client.topicId != null && topicIndex.get(client.topicId) === client) {
      topicIndex.delete(client.topicId);
    }
    // Buzz co-channel Phase 2b — release the duplex peer slot if this was it,
    // identity-checked (a fast peer reconnect may have already installed a new
    // peer before this old connection's close runs).
    if (buzzPeerClient === client) buzzPeerClient = null;
    loggedLegacyUpdatePlaceholder.delete(client.id);
    onClientDisconnected(client);
    log(`client disconnected: ${client.id} (agent=${client.agentName})`);
  }

  // Local alias of the exported validator — kept as a named reference so
  // the call site below reads the same as before.
  const validateMessage = validateClientMessage;

  function processBuffer(
    socket: import("bun").Socket<SocketData>,
  ) {
    const lines = socket.data.buffer.split("\n");
    socket.data.buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!validateMessage(parsed)) {
          log(`invalid IPC message shape from client: ${line.slice(0, 200)}`);
          continue;
        }
        const client = clientBySocketId.get(socket.data.clientId);
        if (client) handleMessage(client, parsed);
      } catch {
        log(`bad JSON from client: ${line.slice(0, 200)}`);
      }
    }
  }

  function handleMessage(client: IpcClientImpl, msg: ClientToGateway) {
    switch (msg.type) {
      case "register":
        handleRegister(client, msg);
        break;
      case "tool_call":
        handleToolCall(client, msg);
        break;
      case "session_event":
        onSessionEvent(client, msg);
        break;
      case "permission_request":
        onPermissionRequest(client, msg);
        break;
      case "heartbeat":
        client.lastHeartbeat = Date.now();
        onHeartbeat(client, msg);
        break;
      case "schedule_restart":
        onScheduleRestart(client, msg);
        break;
      case "operator_event":
        if (onOperatorEvent) onOperatorEvent(client, msg as OperatorEventForward);
        break;
      case "pty_partial":
        if (onPtyPartial) onPtyPartial(client, msg as PtyPartialForward);
        break;
      case "inject_inbound": {
        const injectMsg = msg as InjectInboundMessage;
        // Hub-side Buzz dedup ring (fable MAJOR-2) — scoped strictly to
        // meta.source==="buzz". A duplicate buzz event id (a re-inject after a
        // crash between inject and the sidecar's dedup record) is dropped here;
        // every non-buzz inject is unaffected.
        const injMeta = (injectMsg.inbound as { meta?: Record<string, unknown> } | undefined)?.meta;
        if (injMeta && injMeta.source === "buzz" && typeof injMeta.buzz_event_id === "string") {
          if (buzzInjectIsDuplicate(injMeta.buzz_event_id)) {
            log(`inject_inbound: dropped duplicate buzz event ${injMeta.buzz_event_id.slice(0, 12)} (hub dedup ring)`);
            break;
          }
        }
        if (onInjectInbound) onInjectInbound(client, injectMsg);
        break;
      }
      case "send_outbound":
        if (onSendOutbound) onSendOutbound(client, msg as SendOutboundMessage);
        break;
      case "post_skill_proposal":
        if (onPostSkillProposal) onPostSkillProposal(client, msg as PostSkillProposalMessage);
        break;
      case "post_eval_case_proposal":
        if (onPostEvalCaseProposal) onPostEvalCaseProposal(client, msg as PostEvalCaseProposalMessage);
        break;
      case "quota_wall_detected":
        if (onQuotaWallDetected) onQuotaWallDetected(client, msg as QuotaWallDetectedMessage);
        break;
      case "query_pending_permission":
        if (onQueryPendingPermission) {
          onQueryPendingPermission(client, msg as QueryPendingPermissionMessage);
        } else {
          // No handler wired — fail closed to "not pending" so the caller's
          // Esc fallback fires (byte-identical to pre-#2971 behaviour).
          try {
            client.send({
              type: "pending_permission_status",
              correlationId: (msg as QueryPendingPermissionMessage).correlationId,
              pending: false,
            });
          } catch {
            /* best effort */
          }
        }
        break;
      case "check_pre_approved":
        if (onCheckPreApproved) {
          onCheckPreApproved(client, msg as CheckPreApprovedMessage);
        } else {
          // No handler wired — fail closed to "not pre-approved" so hostd
          // applies the ordinary rate limit (byte-identical to pre-#2975-S2
          // behaviour; the Stage 1 retry then covers an approved persist).
          try {
            client.send({
              type: "pre_approved_result",
              correlationId: (msg as CheckPreApprovedMessage).correlationId,
              preApproved: false,
            });
          } catch {
            /* best effort */
          }
        }
        break;
      case "request_drive_approval":
        if (onRequestDriveApproval) {
          // Handler is async — fire-and-forget here; the handler
          // is responsible for sending its `drive_approval_posted`
          // response (success or failure) back to the client.
          onRequestDriveApproval(client, msg as RequestDriveApprovalMessage).catch(
            (err) => {
              log(
                `request_drive_approval handler threw (client=${client.id}): ${(err as Error).message}`,
              );
              try {
                client.send({
                  type: "drive_approval_posted",
                  correlationId: (msg as RequestDriveApprovalMessage).correlationId,
                  ok: false,
                  reason: `gateway handler error: ${(err as Error).message}`,
                });
              } catch {
                /* best effort */
              }
            },
          );
        } else {
          // No handler wired — fail closed and tell the hook so it
          // can fall back to blocking the tool. Better than leaving
          // the hook timing out.
          try {
            client.send({
              type: "drive_approval_posted",
              correlationId: (msg as RequestDriveApprovalMessage).correlationId,
              ok: false,
              reason: "gateway not configured for Drive-write approval",
            });
          } catch {
            /* best effort */
          }
        }
        break;
      case "request_ms365_approval":
        if (onRequestMs365Approval) {
          onRequestMs365Approval(client, msg as RequestMs365ApprovalMessage).catch(
            (err) => {
              log(
                `request_ms365_approval handler threw (client=${client.id}): ${(err as Error).message}`,
              );
              try {
                client.send({
                  type: "ms365_approval_posted",
                  correlationId: (msg as RequestMs365ApprovalMessage).correlationId,
                  ok: false,
                  reason: `gateway handler error: ${(err as Error).message}`,
                });
              } catch {
                /* best effort */
              }
            },
          );
        } else {
          try {
            client.send({
              type: "ms365_approval_posted",
              correlationId: (msg as RequestMs365ApprovalMessage).correlationId,
              ok: false,
              reason: "gateway not configured for MS-365 write approval",
            });
          } catch {
            /* best effort */
          }
        }
        break;
      case "request_config_approval":
        if (onRequestConfigApproval) {
          onRequestConfigApproval(
            client,
            msg as RequestConfigApprovalMessage,
          ).catch((err) => {
            log(
              `request_config_approval handler threw (client=${client.id}): ${(err as Error).message}`,
            );
            try {
              client.send({
                type: "config_approval_resolved",
                requestId: (msg as RequestConfigApprovalMessage).requestId,
                verdict: "deny",
                reason: `gateway handler error: ${(err as Error).message}`,
              });
            } catch {
              /* best effort */
            }
          });
        } else {
          // Fail closed — hostd treats this as deny so the apply path
          // never runs without an operator-attested approval card.
          try {
            client.send({
              type: "config_approval_resolved",
              requestId: (msg as RequestConfigApprovalMessage).requestId,
              verdict: "deny",
              reason: "gateway not configured for config-edit approval",
            });
          } catch {
            /* best effort */
          }
        }
        break;
      case "request_config_finalize":
        if (onRequestConfigFinalize) {
          onRequestConfigFinalize(
            client,
            msg as RequestConfigFinalizeMessage,
          ).catch((err) => {
            log(
              `request_config_finalize handler threw (client=${client.id}): ${(err as Error).message}`,
            );
          });
        }
        // No reply expected.
        break;
      case "rollout_status_post":
        if (onRolloutStatusPost) {
          onRolloutStatusPost(client, msg as RolloutStatusPostMessage).catch(
            (err) => {
              log(
                `rollout_status_post handler threw (client=${client.id}): ${(err as Error).message}`,
              );
              // Best-effort failure reply so hostd's Part 2 renderer knows the
              // post failed (it just won't edit). Part 1 ignores the reply.
              try {
                client.send({
                  type: "rollout_status_posted",
                  requestId: (msg as RolloutStatusPostMessage).requestId,
                  ok: false,
                  reason: `gateway handler error: ${(err as Error).message}`,
                });
              } catch {
                /* best effort */
              }
            },
          );
        }
        // No reply required when unwired — hostd falls back to the durable log.
        break;
      case "rollout_status_edit":
        if (onRolloutStatusEdit) {
          try {
            void Promise.resolve(
              onRolloutStatusEdit(client, msg as RolloutStatusEditMessage),
            ).catch((err) => {
              log(
                `rollout_status_edit handler rejected (client=${client.id}): ${(err as Error).message}`,
              );
            });
          } catch (err) {
            log(
              `rollout_status_edit handler threw (client=${client.id}): ${(err as Error).message}`,
            );
          }
        }
        // The handler replies `rollout_status_edited` (#4065) when it can; an
        // unwired gateway sends nothing and hostd's bounded wait expires.
        break;
      case "hello_buzz_peer":
        handleHelloBuzzPeer(client, msg as HelloBuzzPeerMessage);
        break;
      case "buzz_publish_result":
        // Confused-deputy close (MAJOR-1a): ONLY the registered duplex Buzz peer
        // may report a publish outcome. Without this gate any client (an agent
        // MCP bridge, or a fresh anonymous connection) could forge a
        // `buzz_publish_result` carrying a valid-looking correlationId and a
        // foreign eventId, poisoning the hub's correlation map so a later
        // correction signs against an arbitrary Nostr event. The peer→agent
        // direction is already fenced (register-after-hello refused above); this
        // mirrors that rigor on the agent→peer surface.
        if (!client.isBuzzPeer) {
          log(
            `SECURITY: rejecting buzz_publish_result from non-peer connection ` +
            `(agent=${client.agentName ?? "anonymous"} id=${client.id}) — only the ` +
            `registered Buzz publish peer may report publish outcomes; dropped`,
          );
          break;
        }
        if (onBuzzPublishResult) onBuzzPublishResult(client, msg as BuzzPublishResultMessage);
        break;
      case "update_placeholder":
        // Legacy recall.py IPC — placeholder UX was removed in #553 PR 5.
        // Soft-accepted so recall.py keeps working without modifying
        // vendored code; logged once per client connection so the gateway
        // log doesn't fill with one line per hook fire.
        if (!loggedLegacyUpdatePlaceholder.has(client.id)) {
          loggedLegacyUpdatePlaceholder.add(client.id);
          log(`legacy update_placeholder ignored (client=${client.id}, agent=${client.agentName ?? "anonymous"})`);
        }
        break;
      default:
        log(`unknown IPC message type from client ${client.id}: ${(msg as any).type}`);
    }
  }

  /**
   * Buzz co-channel Phase 2b (S7). Accept a `hello_buzz_peer` announcement,
   * parking the connection as the single duplex Buzz publish peer. Enforces
   * role-disjointness as a CODE mechanism, not sidecar self-discipline:
   *   - a connection that already `register`ed (agentName set) or already
   *     announced as a peer is refused (close+drop);
   *   - the reciprocal refusal — a `register` on a peer connection — lives in
   *     handleRegister below.
   * The peer NEVER touches agentIndex/topicIndex and carries no heartbeat, so
   * it rides the watchdog's existing `agentName === null` exemption untouched.
   */
  function handleHelloBuzzPeer(client: IpcClientImpl, msg: HelloBuzzPeerMessage) {
    if (client.agentName !== null || client.isBuzzPeer) {
      log(
        `rejecting hello_buzz_peer: connection already has a role ` +
        `(agent=${client.agentName ?? "none"} isBuzzPeer=${client.isBuzzPeer}) — close+drop client=${client.id}`,
      );
      try { client.close(); } catch { /* nothing to do */ }
      return;
    }
    // Impersonation guard (MAJOR-1b): a fresh connection must NOT be able to
    // DISPLACE a LIVE Buzz peer. Without this an anonymous client could send
    // `hello_buzz_peer`, replace the real sidecar in the buzzPeerClient slot,
    // then receive every `outbound_to_buzz` and answer with forged
    // `{ok:true, eventId:<foreign>}` results — poisoning `msgToBuzz` so a later
    // edit_message signs a correction targeting an arbitrary foreign event.
    //
    // A legitimate sidecar reconnect is still honored: it only ever happens
    // AFTER the prior socket dropped, at which point the socket `close` handler
    // has run removeClient (nulling buzzPeerClient), OR — in the brief window
    // before that fires — the prior client is already `close()`d so isAlive()
    // is false. So we refuse displacement ONLY while the existing peer
    // connection is still alive; a dead/closed prior peer is freely replaceable.
    if (buzzPeerClient && buzzPeerClient !== client && buzzPeerClient.isAlive()) {
      log(
        `SECURITY: rejecting hello_buzz_peer — a LIVE Buzz peer is already ` +
        `connected (live_id=${buzzPeerClient.id} rejected_id=${client.id}); ` +
        `refusing displacement, close+drop`,
      );
      try { client.close(); } catch { /* nothing to do */ }
      return;
    }
    // Replace a dead/closed prior peer connection (e.g. a sidecar reconnect
    // whose predecessor's socket already dropped) cleanly.
    if (buzzPeerClient && buzzPeerClient !== client) {
      log(`hello_buzz_peer: replacing prior (dead) buzz peer (prior_id=${buzzPeerClient.id} new_id=${client.id})`);
      try { buzzPeerClient.close(); } catch { /* nothing to do */ }
    }
    client.isBuzzPeer = true;
    buzzPeerClient = client;
    log(`registered buzz publish peer for agent=${msg.agentName} id=${client.id}`);
  }

  function handleRegister(client: IpcClientImpl, msg: RegisterMessage) {
    // Buzz co-channel Phase 2b (S7) — reciprocal role-disjointness: a
    // connection that announced itself as the duplex Buzz peer must never be
    // allowed to claim an agentIndex slot. Refuse server-side (a code check,
    // not sidecar self-discipline).
    if (client.isBuzzPeer) {
      log(
        `rejecting register: connection is the Buzz publish peer, not an agent bridge ` +
        `(close+drop client=${client.id})`,
      );
      try { client.close(); } catch { /* nothing to do */ }
      return;
    }
    // Defence in depth for #430. The bridge refuses to register
    // without SWITCHROOM_AGENT_NAME (set in start.sh per agent), but
    // an older bridge or a third-party caller could still send the
    // string "default" — which crosstalks into whichever agent's
    // gateway happens to accept the connection. Reject server-side
    // so the gateway never confuses an anonymous client for the
    // agent it was launched to serve. The expected switchroom
    // contract is exactly one agent name per gateway socket; any
    // mismatch is an outright bug, not a transient.
    if (msg.agentName === "default") {
      log(
        `rejecting register: agentName="default" — anonymous bridges are not allowed (close+drop client=${client.id})`,
      );
      try {
        client.close();
      } catch {
        /* nothing to do */
      }
      return;
    }

    if (client.agentName) agentIndex.delete(client.agentName);
    if (client.topicId != null) topicIndex.delete(client.topicId);

    // 2026-05-20 race fix: if a PRIOR client is registered as this
    // agent name (a stale/zombie connection that hasn't been evicted
    // yet), explicitly close it before installing this new client.
    // Without this, the prior client remains in `clients` set, its
    // heartbeat watchdog still ticks, and its eventual close+removeClient
    // can confuse routing. The removeClient identity-check fix above
    // means the index won't be wrongly deleted, but two concurrent
    // clients claiming the same agent name is still a routing hazard
    // — close the zombie cleanly here.
    const existingClient = agentIndex.get(msg.agentName);
    if (existingClient && existingClient !== client) {
      log(
        `register: closing prior client for agent=${msg.agentName} ` +
        `(prior_id=${existingClient.id} new_id=${client.id}) — bridge reconnect race`,
      );
      try {
        (existingClient as IpcClientImpl).close();
      } catch {
        /* nothing to do */
      }
    }

    client.agentName = msg.agentName;
    client.topicId = msg.topicId ?? null;

    agentIndex.set(msg.agentName, client);
    if (msg.topicId != null) topicIndex.set(msg.topicId, client);

    log(`registered agent=${msg.agentName} topicId=${msg.topicId ?? "none"}`);
    onClientRegistered(client);
  }

  function handleToolCall(client: IpcClientImpl, msg: ToolCallMessage) {
    onToolCall(client, msg).then(
      (result) => client.send(result),
      (err) => client.send({
        type: "tool_call_result",
        id: msg.id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  class IpcClientImpl implements IpcClient {
    id: string;
    agentName: string | null = null;
    topicId: number | null = null;
    isBuzzPeer = false;
    lastHeartbeat: number = Date.now();
    _socket: import("bun").Socket<SocketData>;
    private _closed = false;

    constructor(socket: import("bun").Socket<SocketData>) {
      this.id = socket.data.clientId;
      this._socket = socket;
    }

    send(msg: GatewayToClient): void {
      if (this._closed) return;
      this._socket.write(JSON.stringify(msg) + "\n");
    }

    close(): void {
      if (this._closed) return;
      this._closed = true;
      this._socket.end();
    }

    isAlive(): boolean {
      return !this._closed;
    }
  }

  const clientBySocketId = new Map<string, IpcClientImpl>();

  const server = Bun.listen<SocketData>({
    unix: socketPath,
    socket: {
      open(socket) {
        const clientId = crypto.randomUUID();
        socket.data = { clientId, buffer: "" };
        const client = new IpcClientImpl(socket);
        clients.add(client);
        clientBySocketId.set(clientId, client);
        log(`client connected: ${clientId}`);
      },
      data(socket, data) {
        socket.data.buffer += data.toString();
        if (socket.data.buffer.length > MAX_BUFFER_SIZE) {
          log(`client ${socket.data.clientId} exceeded max buffer size (${MAX_BUFFER_SIZE} bytes), dropping connection`);
          socket.end();
          return;
        }
        processBuffer(socket);
      },
      close(socket) {
        const client = clientBySocketId.get(socket.data.clientId);
        if (client) {
          clientBySocketId.delete(socket.data.clientId);
          removeClient(client);
        }
      },
      drain() {},
      error(socket, err) {
        log(`socket error: ${err.message}`);
      },
    },
  });

  // Allow the web container (uid=1000, operator) to inject prompts via
  // injectInbound without needing root — the socket is inside the per-agent
  // state directory which is already operator-accessible.
  try { chmodSync(socketPath, 0o666); } catch { /* best-effort */ }
  log(`listening on ${socketPath}`);

  // ─── Heartbeat watchdog (issue #71) ─────────────────────────────────────
  // The IPC client sends a heartbeat every `heartbeatIntervalMs` (default 5s).
  // If a client's `lastHeartbeat` is older than `heartbeatTimeoutMs` (default
  // 30s), the TCP socket is likely wedged (process crashed but the socket fd
  // was never cleanly closed, or the OS hasn't yet delivered the FIN). Force-
  // close those connections so:
  //   1. The gateway clears the stale agentIndex entry immediately.
  //   2. Inbound Telegram messages are not silently dropped into a black hole.
  //   3. The real bridge process (which may already be reconnecting) gets its
  //      fresh register() handled rather than silently shadowed by the stale
  //      entry (handleRegister does replace-not-reject, so this is belt-and-
  //      suspenders — but eviction is cleaner).
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  if (heartbeatTimeoutMs > 0) {
    // Poll at half the timeout so we catch a wedged client within one interval.
    const watchdogInterval = Math.max(1000, Math.floor(heartbeatTimeoutMs / 2));
    watchdogTimer = setInterval(() => {
      const now = Date.now();
      for (const client of clients) {
        if (!client.isAlive()) continue;
        // Only evict clients that have registered (agentName set). Unregistered
        // connections that just opened are excluded — they haven't had a chance
        // to send their first heartbeat yet.
        if (client.agentName === null) continue;
        const age = now - client.lastHeartbeat;
        if (age > heartbeatTimeoutMs) {
          log(
            `heartbeat watchdog: evicting stale client agent=${client.agentName} id=${client.id} ` +
            `lastHeartbeat=${age}ms ago (threshold=${heartbeatTimeoutMs}ms)`,
          );
          client.close();
        }
      }
    }, watchdogInterval);
    // Unref so the watchdog doesn't prevent clean process exit.
    if (typeof (watchdogTimer as any)?.unref === "function") {
      (watchdogTimer as any).unref();
    }
  }

  const ipcServer: IpcServer = {
    sendToAgent(agentName: string, msg: GatewayToClient): boolean {
      const client = agentIndex.get(agentName);
      if (!client || !client.isAlive()) return false;
      client.send(msg);
      return true;
    },

    sendToTopic(topicId: number, msg: GatewayToClient): boolean {
      const client = topicIndex.get(topicId);
      if (!client || !client.isAlive()) return false;
      client.send(msg);
      return true;
    },

    broadcast(msg: GatewayToClient): void {
      for (const client of clients) {
        if (client.isAlive()) client.send(msg);
      }
    },

    getClient(agentName: string): IpcClient | undefined {
      return agentIndex.get(agentName);
    },

    clientCount(): number {
      return clients.size;
    },

    sendToBuzzPeer(msg: OutboundToBuzzMessage): boolean {
      if (!buzzPeerClient || !buzzPeerClient.isAlive()) return false;
      buzzPeerClient.send(msg);
      return true;
    },

    async close(): Promise<void> {
      // Stop the heartbeat watchdog before closing clients so it doesn't
      // log spurious evictions during planned shutdown.
      if (watchdogTimer !== null) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      for (const client of clients) {
        client.close();
      }
      clients.clear();
      agentIndex.clear();
      topicIndex.clear();
      clientBySocketId.clear();
      server.stop(true);
      // Rename (not unlink) so a subsequent new-gateway bind that has already
      // landed at socketPath is not accidentally clobbered by this late cleanup.
      // If this rename arrives after a new server is listening, it moves the
      // NEW server's live file to .bak — which is wrong but recoverable. See
      // the note on test 4 in ipc-server-race.test.ts: when both generations
      // target the same pathname, the rename-to-.bak discipline is not enough
      // by itself to prevent the new generation's file from being moved away
      // by the old generation's delayed cleanup. Startup-side cleanup unlinks
      // the stale .bak, so the self-healing property is the best we can do
      // without an inode-matching check.
      try { renameSync(socketPath, socketPath + ".bak"); } catch {}
    },
  };

  return ipcServer;
}
