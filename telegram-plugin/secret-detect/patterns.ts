/**
 * Pattern registry for secret detection — the openclaw-derived list plus
 * a few anchored, high-confidence provider prefixes.
 *
 * Ordering matters: patterns near the top are preferred on ties (first match
 * wins). Anchored provider prefixes are listed first so `sk-ant-...` wins
 * over the generic "sk-..." match.
 *
 * Each entry has a rule_id, a regex, and a `captureIndex` pointing at the
 * capture group that holds the raw secret bytes (so the detector can slice
 * just the sensitive portion, not the whole match which may include
 * "KEY=" or quote prefixes).
 */
export interface PatternDef {
  rule_id: string
  regex: RegExp
  /**
   * Which capture group is the secret value. 0 means "the whole match".
   * For KEY=VALUE style, we point at the value group so the detection
   * range covers only the secret bytes, letting the rewriter preserve
   * the `KEY=` prefix.
   */
  captureIndex: number
  /** If set, a hint used when deriving the vault slug. */
  slugHint?: string
}

/**
 * High-confidence anchored provider prefixes. Listed first so they win
 * over the generic broad patterns.
 */
export const ANCHORED_PATTERNS: PatternDef[] = [
  { rule_id: 'anthropic_api_key', regex: /\b(sk-ant-[A-Za-z0-9_-]{8,})\b/g, captureIndex: 1, slugHint: 'anthropic_api_key' },
  // anthropic_api_key precedes; the patterns don't overlap (the `#` separator
  // isn't in api-key shape) so ordering is moot for correctness.
  // Anthropic OAuth browser code — emitted by the claude.com/cai authorize
  // flow as two URL-safe base64 segments joined by `#`.
  // Shape: <20+ url-safe-b64>#<20+ url-safe-b64>
  // Anchored to whitespace boundaries (^/\s before, \s/$ after) to avoid
  // false-positives on real URLs whose path segment + fragment anchor both
  // exceed 20 chars (e.g. GitHub headings, npm readme anchors). The bare-code
  // paste case ("code#state" alone on a line or after prose) is the only
  // intended match target.
  { rule_id: 'anthropic_oauth_code', regex: /(?:^|\s)([A-Za-z0-9_-]{20,}#[A-Za-z0-9_-]{20,})(?=\s|$)/gm, captureIndex: 1, slugHint: 'anthropic_oauth_code' },
  { rule_id: 'openai_api_key', regex: /\b(sk-[A-Za-z0-9_-]{20,})\b/g, captureIndex: 1, slugHint: 'openai_api_key' },
  { rule_id: 'github_pat_classic', regex: /\b(ghp_[A-Za-z0-9]{20,})\b/g, captureIndex: 1, slugHint: 'github_pat' },
  { rule_id: 'github_pat_fine_grained', regex: /\b(github_pat_[A-Za-z0-9_]{20,})\b/g, captureIndex: 1, slugHint: 'github_pat' },
  { rule_id: 'slack_token', regex: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, captureIndex: 1, slugHint: 'slack_token' },
  { rule_id: 'slack_app_token', regex: /\b(xapp-[A-Za-z0-9-]{10,})\b/g, captureIndex: 1, slugHint: 'slack_app_token' },
  { rule_id: 'groq_api_key', regex: /\b(gsk_[A-Za-z0-9_-]{10,})\b/g, captureIndex: 1, slugHint: 'groq_api_key' },
  { rule_id: 'google_api_key', regex: /\b(AIza[0-9A-Za-z\-_]{20,})\b/g, captureIndex: 1, slugHint: 'google_api_key' },
  { rule_id: 'perplexity_api_key', regex: /\b(pplx-[A-Za-z0-9_-]{10,})\b/g, captureIndex: 1, slugHint: 'perplexity_api_key' },
  { rule_id: 'npm_token', regex: /\b(npm_[A-Za-z0-9]{10,})\b/g, captureIndex: 1, slugHint: 'npm_token' },
  // Telegram bot tokens: with "bot" prefix or bare ID:token.
  { rule_id: 'telegram_bot_token_prefixed', regex: /\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b/g, captureIndex: 1, slugHint: 'telegram_bot_token' },
  { rule_id: 'telegram_bot_token', regex: /\b(\d{6,}:[A-Za-z0-9_-]{20,})\b/g, captureIndex: 1, slugHint: 'telegram_bot_token' },
  { rule_id: 'aws_access_key', regex: /\b(AKIA[0-9A-Z]{16})\b/g, captureIndex: 1, slugHint: 'aws_access_key' },
  { rule_id: 'jwt', regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, captureIndex: 1, slugHint: 'jwt' },
]

/**
 * Openclaw default pattern list. Matches structured contexts where a value
 * is "labelled" as a secret (KEY=value, JSON field, CLI flag, Bearer token,
 * PEM block). Only the value group is captured.
 */
export const STRUCTURED_PATTERNS: PatternDef[] = [
  // KEY=value (ALL-CAPS identifier ending in KEY/TOKEN/SECRET/PASSWORD/PASSWD).
  // Value group index is 2 — group 1 is the optional quote char.
  {
    rule_id: 'env_key_value',
    regex: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD))\b\s*[=:]\s*(["']?)([^\s"'\\]+)\2/g,
    captureIndex: 3,
    slugHint: 'env',
  },
  // JSON field: "apiKey": "value"
  {
    rule_id: 'json_secret_field',
    regex: /"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)"\s*:\s*"([^"]+)"/g,
    captureIndex: 1,
    slugHint: 'json_secret',
  },
  // CLI flag: --api-key VALUE or --token='VALUE'
  {
    rule_id: 'cli_flag',
    regex: /--(?:api[-_]?key|hook[-_]?token|token|secret|password|passwd)\s+(["']?)([^\s"']+)\1/g,
    captureIndex: 2,
    slugHint: 'cli_flag',
  },
  // Authorization: Bearer token (form 1 — explicit Authorization header)
  {
    rule_id: 'bearer_auth_header',
    regex: /Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)/g,
    captureIndex: 1,
    slugHint: 'bearer_token',
  },
  // Bare "Bearer XYZ" (length-gated to cut false positives on the word "Bearer")
  {
    rule_id: 'bearer_loose',
    regex: /\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b/g,
    captureIndex: 1,
    slugHint: 'bearer_token',
  },
  // PEM private key block — single greedy capture, non-overlapping.
  {
    rule_id: 'pem_private_key',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
    captureIndex: 0,
    slugHint: 'pem_private_key',
  },
]

/**
 * Concatenated registry — anchored first, then structured.
 */
export const ALL_PATTERNS: PatternDef[] = [...ANCHORED_PATTERNS, ...STRUCTURED_PATTERNS]
