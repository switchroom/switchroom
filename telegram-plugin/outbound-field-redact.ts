/**
 * Structured-payload outbound redaction (#2044 coverage extension).
 *
 * The original #2044 outbound scrub masks agent-authored FREE TEXT on the
 * reply / edit_message / progress_update paths (see gateway.ts
 * `redactOutboundText`). But several other outbound surfaces carry
 * agent-authored text to Telegram inside STRUCTURED payloads and had no
 * redaction at all:
 *
 *   - ask_user      → the question text + every option/button label
 *   - send_checklist / update_checklist → the title + every task's text
 *
 * An agent that echoes a token or a DATABASE_URL it just read into an
 * ask_user question, a button label, or a checklist task would transmit it
 * unmasked — defeating the same scrub invariant the reply `text` path
 * honors.
 *
 * These helpers apply the SAME redactor to each such field. The redactor is
 * INJECTED (the gateway passes its `redactOutboundText`; tests pass the real
 * `redact`) so the masking is deterministic and unit-testable at the OUTCOME
 * level: the object returned here is exactly what the downstream send call
 * receives, so a test can assert the secret is gone from the sent payload —
 * not merely that a redactor was invoked.
 */

/** A pure text redactor: maps input text to a masked copy. */
export type FieldRedactor = (text: string) => string

/**
 * Redact the two agent-authored outbound fields of an ask_user prompt: the
 * question and each option label. Returns fresh values (the input arrays are
 * not mutated) so the caller can assign them onto the validated args.
 */
export function redactAskUserFields(
  question: string,
  options: readonly string[],
  redact: FieldRedactor,
): { question: string; options: string[] } {
  return {
    question: redact(question),
    options: options.map((opt) => redact(opt)),
  }
}

/** Minimal shape of a checklist task — only `text` is redacted; every other
 *  field (id, done, …) is carried through untouched. */
export interface ChecklistTaskLike {
  text?: string
  [key: string]: unknown
}

/**
 * Redact the agent-authored outbound fields of a checklist: the title and
 * each task's `text`. `title`/`tasks` may be undefined (update_checklist
 * allows partial patches); undefined passes through untouched. A task whose
 * `text` is undefined (an id-only patch) is left as-is.
 */
export function redactChecklistFields<T extends ChecklistTaskLike>(
  title: string | undefined,
  tasks: readonly T[] | undefined,
  redact: FieldRedactor,
): { title: string | undefined; tasks: T[] | undefined } {
  return {
    title: title != null ? redact(title) : title,
    tasks: tasks?.map((task) =>
      task.text != null ? { ...task, text: redact(task.text) } : task,
    ),
  }
}
