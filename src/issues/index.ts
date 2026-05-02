/**
 * Public API for the issue sink.
 *
 * Hooks, the boot self-test, and any other in-agent code wanting
 * visibility on Telegram should import from here. The library is
 * intentionally narrow — record / list / resolve / prune — to keep
 * callers honest about what they're storing.
 *
 * See `src/issues/store.ts` for the storage contract.
 */

export {
  list,
  prune,
  readAll,
  record,
  resolve,
  resolveAllBySource,
  ISSUES_FILE,
  ISSUES_LOCK,
  type ListOptions,
  type PruneOptions,
} from "./store.js";
export { computeFingerprint } from "./fingerprint.js";
export {
  DETAIL_MAX_BYTES,
  SEVERITY_RANK,
  SUMMARY_MAX_CHARS,
  type IssueEvent,
  type IssueInput,
  type IssueSeverity,
} from "./types.js";
