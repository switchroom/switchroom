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
  // Laravel Sanctum / Coolify personal-access tokens. Shape: `<id>|<token>`
  // where <id> is the integer PK and <token> is `Str::random(40)` — 40 base62
  // chars. The `|` separator is what distinguishes this from a Telegram
  // `id:token` (colon) or a JWT. Length floor 40 (the Sanctum default) keeps
  // this off short pipe-joined chat like `1|foo` or markdown table cells.
  // Incident 2026-06-01: a live `17|<40-char>` Coolify token pasted by a user
  // slipped every existing pattern and persisted in plaintext.
  { rule_id: 'laravel_sanctum_token', regex: /\b(\d+\|[A-Za-z0-9]{40,})\b/g, captureIndex: 1, slugHint: 'api_token' },
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
  // Authorization: Bearer token (form 1 — explicit Authorization header).
  //
  // CASE-INSENSITIVE since #3982's review: HTTP/2 and HTTP/3 lowercase
  // every header name on the wire, so `authorization: bearer <token>` is
  // what an agent actually pastes out of a curl trace or a proxy log —
  // and it sailed through both engines unmasked. RFC 9110 makes the
  // header name case-insensitive and the auth SCHEME token
  // case-insensitive too, so matching case-sensitively was simply wrong.
  {
    rule_id: 'bearer_auth_header',
    regex: /Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)/gi,
    captureIndex: 1,
    slugHint: 'bearer_token',
  },
  // Bare "Bearer XYZ" (length-gated to cut false positives on the word
  // "Bearer"). The 18-char floor is what keeps the now case-insensitive
  // match off prose like "the bearer token to use".
  {
    rule_id: 'bearer_loose',
    regex: /\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b/gi,
    captureIndex: 1,
    slugHint: 'bearer_token',
  },
  // Authorization: Basic <base64(user:password)>. Base64 is an encoding,
  // not a cipher — a Basic header is a plaintext credential with extra
  // steps, and it reached agent memory unmasked (#3982 review, MAJOR 6).
  // Anchored on the header + scheme, so a bare base64 blob elsewhere in
  // the text is untouched (that stays a documented gap).
  {
    rule_id: 'basic_auth_header',
    regex: /Authorization\s*[:=]\s*Basic\s+([A-Za-z0-9+/=]{8,})/gi,
    captureIndex: 1,
    slugHint: 'basic_auth',
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
 * High-precision PREFIXED provider patterns (gitleaks/secret-scanner style).
 *
 * Every rule here has a distinctive literal prefix + length, so false
 * positives on ordinary chat/code are near-zero — which is load-bearing,
 * because the inbound gate DELETES a message on a high-confidence hit.
 * We deliberately keep ONLY prefix-anchored rules here; a generic
 * "any high-entropy string" detector (the bare-token gap that let the
 * Sanctum `<id>|<token>` slip) is intentionally NOT here — that's a
 * separate, ambiguous-routed change so it can't auto-delete on a guess.
 *
 * Baked as TS (not loaded from the vendored gitleaks.toml at runtime):
 * the bundler inlines secret-detect into dist/server.js + gateway.js and
 * does NOT ship the .toml alongside, so a runtime `loadGitleaksPatterns()`
 * would silently resolve to nothing in the agent image. TS entries flow
 * through ALL_PATTERNS into the shared detectSecrets engine, so they
 * protect the inbound gate, the outbound mask, AND the issues pipeline.
 *
 * Provider prefixes already in ANCHORED_PATTERNS (sk-ant-, sk-, ghp_,
 * github_pat_, AKIA, AIza, xox*, gsk_, pplx-, npm_, telegram id:token, jwt)
 * are intentionally omitted to avoid duplicate hits.
 */
export const PROVIDER_PATTERNS: PatternDef[] = [
  { rule_id: 'slack_webhook', regex: /(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/]+)/g, captureIndex: 1, slugHint: 'slack_webhook' },
  { rule_id: 'stripe_live_secret', regex: /\b(sk_live_[A-Za-z0-9]{24,})\b/g, captureIndex: 1, slugHint: 'stripe_key' },
  { rule_id: 'stripe_restricted', regex: /\b(rk_live_[A-Za-z0-9]{24,})\b/g, captureIndex: 1, slugHint: 'stripe_key' },
  { rule_id: 'sendgrid_api_key', regex: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g, captureIndex: 1, slugHint: 'sendgrid_key' },
  { rule_id: 'gitlab_pat', regex: /\b(glpat-[A-Za-z0-9_-]{20})\b/g, captureIndex: 1, slugHint: 'gitlab_pat' },
  { rule_id: 'huggingface_token', regex: /\b(hf_[A-Za-z0-9]{34,})\b/g, captureIndex: 1, slugHint: 'huggingface_token' },
  // (openai sk-proj-/sk-svcacct- are already covered by the anchored
  //  `openai_api_key` sk- rule — no separate entry needed.)
  { rule_id: 'twilio_api_key', regex: /\b(SK[0-9a-f]{32})\b/g, captureIndex: 1, slugHint: 'twilio_api_key' },
  { rule_id: 'mailgun_key', regex: /\b(key-[0-9a-f]{32})\b/g, captureIndex: 1, slugHint: 'mailgun_key' },
  // (mailchimp keys are `<32-hex>-us<N>` with NO distinctive prefix — that
  //  collides with md5 hashes / ETags followed by `-usN` and would auto-delete
  //  benign messages. Deferred to the planned generic high-entropy detector,
  //  which asks instead of auto-deleting. Review #2054.)
  { rule_id: 'digitalocean_pat', regex: /\b(dop_v1_[a-f0-9]{64})\b/g, captureIndex: 1, slugHint: 'digitalocean_token' },
  { rule_id: 'digitalocean_oauth', regex: /\b(doo_v1_[a-f0-9]{64})\b/g, captureIndex: 1, slugHint: 'digitalocean_token' },
  { rule_id: 'digitalocean_refresh', regex: /\b(dor_v1_[a-f0-9]{64})\b/g, captureIndex: 1, slugHint: 'digitalocean_token' },
  { rule_id: 'doppler_token', regex: /\b(dp\.(?:pt|st|ct|sa|scim|audit)\.[A-Za-z0-9]{40,44})\b/g, captureIndex: 1, slugHint: 'doppler_token' },
  { rule_id: 'linear_api_key', regex: /\b(lin_api_[A-Za-z0-9]{40})\b/g, captureIndex: 1, slugHint: 'linear_api_key' },
  { rule_id: 'shopify_access_token', regex: /\b(shpat_[a-fA-F0-9]{32})\b/g, captureIndex: 1, slugHint: 'shopify_token' },
  { rule_id: 'shopify_shared_secret', regex: /\b(shpss_[a-fA-F0-9]{32})\b/g, captureIndex: 1, slugHint: 'shopify_token' },
  { rule_id: 'shopify_private_app', regex: /\b(shppa_[a-fA-F0-9]{32})\b/g, captureIndex: 1, slugHint: 'shopify_token' },
  { rule_id: 'square_access_token', regex: /\b(sq0atp-[A-Za-z0-9_-]{22})\b/g, captureIndex: 1, slugHint: 'square_token' },
  { rule_id: 'square_oauth_secret', regex: /\b(sq0csp-[A-Za-z0-9_-]{43})\b/g, captureIndex: 1, slugHint: 'square_token' },
  { rule_id: 'newrelic_key', regex: /\b(NRAK-[A-Z0-9]{27})\b/g, captureIndex: 1, slugHint: 'newrelic_key' },
  { rule_id: 'notion_token', regex: /\b(ntn_[A-Za-z0-9]{46})\b/g, captureIndex: 1, slugHint: 'notion_token' },
  { rule_id: 'planetscale_password', regex: /\b(pscale_pw_[A-Za-z0-9_.-]{43})\b/g, captureIndex: 1, slugHint: 'planetscale_token' },
  { rule_id: 'planetscale_token', regex: /\b(pscale_tkn_[A-Za-z0-9_.-]{43})\b/g, captureIndex: 1, slugHint: 'planetscale_token' },
  { rule_id: 'supabase_service_key', regex: /\b(sbp_[a-f0-9]{40})\b/g, captureIndex: 1, slugHint: 'supabase_key' },
  { rule_id: 'atlassian_token', regex: /\b(ATATT[A-Za-z0-9_\-=]{20,})\b/g, captureIndex: 1, slugHint: 'atlassian_token' },
  { rule_id: 'dropbox_token', regex: /\b(sl\.[A-Za-z0-9_-]{130,})/g, captureIndex: 1, slugHint: 'dropbox_token' },
  { rule_id: 'databricks_token', regex: /\b(dapi[a-f0-9]{32})\b/g, captureIndex: 1, slugHint: 'databricks_token' },
  { rule_id: 'grafana_service_account', regex: /\b(glsa_[A-Za-z0-9]{32}_[a-fA-F0-9]{8})\b/g, captureIndex: 1, slugHint: 'grafana_token' },
  { rule_id: 'pypi_token', regex: /\b(pypi-AgEIcHlwaS[A-Za-z0-9_-]{50,})/g, captureIndex: 1, slugHint: 'pypi_token' },
  { rule_id: 'aws_temp_access_key', regex: /\b(ASIA[0-9A-Z]{16})\b/g, captureIndex: 1, slugHint: 'aws_access_key' },
  { rule_id: 'gcp_oauth_token', regex: /\b(ya29\.[A-Za-z0-9_-]{30,})/g, captureIndex: 1, slugHint: 'gcp_oauth_token' },
]

/**
 * Concatenated registry — anchored + provider prefixes first (high
 * precision), then structured.
 */
export const ALL_PATTERNS: PatternDef[] = [...ANCHORED_PATTERNS, ...PROVIDER_PATTERNS, ...STRUCTURED_PATTERNS]
