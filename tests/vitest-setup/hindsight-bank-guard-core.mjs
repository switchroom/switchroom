/**
 * hindsight-bank-guard-core — the origin predicate and trip counter behind the
 * Hindsight bank hermeticity guard.
 *
 * ── The defect class this closes ────────────────────────────────────────
 *
 * On 2026-07-30T23:51-23:55Z a harness/parity sweep minted ELEVEN throwaway
 * banks in the FLEET's live Hindsight in a four-minute window — verified in
 * `GET /v1/default/banks` on the production instance, `created_at` between
 * 2026-07-30T23:51:08Z and 2026-07-30T23:55:37Z:
 *
 *   probe, general, gamma, test-agent, memory-agent, clerk,
 *   parity-default-no-tools-, parity-dangerous-mode-true,
 *   parity-webkite-opted-out, parity-explicit-tools-allow,
 *   parity-tools-allow-all-
 *
 * Every one of those is a switchroom TEST FIXTURE agent name (`probe` is the
 * fixture name in tests/scaffold.*.test.ts; the `parity-*` set is a parity
 * matrix). They reached the fleet instance because switchroom's own default
 * Hindsight endpoint is a fixed localhost port (`HINDSIGHT_DEFAULT_API_PORT`,
 * 18888) that is ALSO what every agent container exports as
 * `HINDSIGHT_API_URL` — so a test process that reads the env, or that falls
 * through to the baked-in default, talks to production without saying so.
 *
 * One of the eleven was named `clerk`, which collided with a LIVE agent.
 * Agent `clerk` writes to the bank whose `bank_id` is `assistant` (86,240
 * facts), and a warning annotation lived in the decoy `clerk` bank's `mission`
 * field precisely so nobody would mistake the empty `clerk` bank for lost
 * memory. The sweep replaced that bank and erased the annotation; a week later
 * an agent walked into the trap and reported clerk's memory as lost.
 *
 * ── Why the guard lives here and not in the engine ──────────────────────
 *
 * Hindsight's engine auto-creates a bank on miss and returns zeros — there is
 * no error on a missing bank, it springs into existence
 * (`engine/retain/bank_utils.py` `get_or_create_bank_profile`,
 * `engine/retain/fact_storage.py` `ensure_bank_exists`, both at hindsight
 * v0.8.6). Deleting a stray therefore does not fix anything: the next lookup
 * of that name recreates it.
 *
 * But an engine-side guard cannot be COMPLETE for this defect, because the
 * server cannot tell a test-context caller from a production one. The stray
 * banks were minted by ordinary, correctly-formed bank-scoped requests — the
 * same shape a real agent sends. Any server-side rule would have to guess from
 * the bank NAME, and name-guessing fails in both directions: it cannot let a
 * genuinely new agent create its bank while refusing a test fixture that
 * happens to share a live agent's name.
 *
 * The test RUNNER is the one place where "this is a test context" is a
 * structural fact rather than a guess — a preload that both runners load with
 * no per-file opt-in. Production code paths (`switchroom apply`, an agent
 * container's start.sh, the MCP shim) never load this file, so legitimate
 * agent bank creation is untouched and no boot path can be affected: this
 * module is never shipped in an image and never executes outside `vitest` /
 * `bun test`. That is the strongest available answer to "must not crash-loop a
 * boot" — it is impossible by construction, not by care.
 *
 * ── The rule ────────────────────────────────────────────────────────────
 *
 * A test process may not send ANY request to a fleet Hindsight origin. Two
 * ways an origin qualifies, both structural — never a bank-name match:
 *
 *   1. It is the port switchroom pins the fleet instance to
 *      (`FLEET_HINDSIGHT_PORTS`). Ephemeral test servers use `listen(0)`,
 *      which on Linux allocates from 32768-60999 and can never collide with
 *      18888/19999, so `tests/hindsight-mcp-shim.test.ts` and
 *      `tests/hindsight-write-redaction.test.ts` (both real local HTTP
 *      servers driving real bank paths) are unaffected.
 *   2. It is the origin named by an ambient Hindsight env var at preload time
 *      — captured BEFORE the guard scrubs those vars, because inside an agent
 *      container `npm test` inherits `HINDSIGHT_API_URL` pointed at
 *      production. This covers a fleet instance moved off the default port.
 *
 * Escape hatch: `SWITCHROOM_TEST_HINDSIGHT_ALLOW_ORIGINS`, a comma-separated
 * allowlist, for a test that genuinely owns an instance on a fleet port. It is
 * explicit and greppable, which a silent default is not.
 *
 * ── Consumers ───────────────────────────────────────────────────────────
 *
 *   - tests/vitest-setup/hindsight-bank-guard.mjs      (the runner entry)
 *   - scripts/check-hindsight-bank-hermeticity.mjs     (the lint gate — plain
 *     node, which is why this is .mjs and not .ts)
 *   - tests/hindsight-bank-guard.test.ts               (the runtime proof)
 *
 * Deliberately free of any vitest import and of any global patching:
 * importing this module must NOT install the guard. That separation is what
 * lets the runtime proof be an honest alarm — it reads the counter without
 * installing the thing it verifies, so unwiring `setupFiles` in
 * vitest.config.ts makes it FAIL rather than silently self-heal. Same shape as
 * the sibling `auth-net-guard-core.mjs`.
 */

/** Message prefix thrown by the guard when it blocks an outbound call. */
export const HINDSIGHT_BANK_GUARD_MARKER = "SWITCHROOM_HINDSIGHT_BANK_GUARD";

/**
 * Ports switchroom pins a FLEET Hindsight API to. Mirrors
 * `HINDSIGHT_DEFAULT_API_PORT` in `src/setup/hindsight.ts`; duplicated as a
 * literal because this file is loaded by plain node (the lint gate) with no TS
 * pipeline, and pinned against the source constant by
 * `scripts/check-hindsight-bank-hermeticity.mjs` so a repoint cannot silently
 * un-protect the new port.
 *
 * The control-plane UI port (`HINDSIGHT_DEFAULT_UI_PORT`, 9999) is
 * deliberately NOT here. It exposes no bank-write surface, and 9999 is a
 * common ad-hoc dev port — blocking it would trade the leak this guard closes
 * for false positives in unrelated suites.
 */
export const FLEET_HINDSIGHT_PORTS = ["18888"];

/**
 * Env vars that can name a fleet Hindsight endpoint. Read at preload time to
 * seed the blocked-origin set, then scrubbed to a sentinel so code that reads
 * the env cannot reach production either.
 */
export const HINDSIGHT_URL_ENV_VARS = [
  "HINDSIGHT_API_URL",
  "HINDSIGHT_MCP_URL",
  "SWITCHROOM_HINDSIGHT_API_URL",
];

/**
 * Where the guard repoints the scrubbed env vars. TEST-NET-1 (RFC 5737) on a
 * fleet port: unroutable, so an un-mocked read cannot reach anything, and
 * still blocked by rule 1 so the failure names the guard rather than timing
 * out.
 */
export const HINDSIGHT_SENTINEL_URL = "http://192.0.2.1:18888";

/** Env var holding a comma-separated opt-in allowlist of origins. */
export const ALLOW_ORIGINS_ENV_VAR = "SWITCHROOM_TEST_HINDSIGHT_ALLOW_ORIGINS";

/** `origin` (scheme://host:port) for a URL-ish input, or null if unparseable. */
export function originOf(input) {
  try {
    const u = new URL(typeof input === "string" ? input : (input?.url ?? String(input)));
    return u.origin;
  } catch {
    return null;
  }
}

/** Port for a URL-ish input as a string, or null. Explicit port only — a fleet
 *  Hindsight is always addressed with one. */
function portOf(input) {
  try {
    const u = new URL(typeof input === "string" ? input : (input?.url ?? String(input)));
    return u.port || null;
  } catch {
    return null;
  }
}

/**
 * Build the guard's decision policy from an environment.
 *
 * Returns `{ blockedOrigins, allowedOrigins }` — both arrays of origin
 * strings. Pure: takes the env, touches no globals, so the lint gate and the
 * unit tests can evaluate it against synthetic environments.
 */
export function buildHindsightGuardPolicy(env = process.env) {
  const blockedOrigins = [];
  for (const k of HINDSIGHT_URL_ENV_VARS) {
    const o = originOf(env[k]);
    if (o && !blockedOrigins.includes(o)) blockedOrigins.push(o);
  }
  const allowedOrigins = String(env[ALLOW_ORIGINS_ENV_VAR] ?? "")
    .split(",")
    .map((s) => originOf(s.trim()))
    .filter((o) => o !== null);
  return { blockedOrigins, allowedOrigins };
}

/**
 * True when a test process must NOT issue this request.
 *
 * `policy` comes from `buildHindsightGuardPolicy`. The allowlist wins over
 * both block rules — an opt-in is a deliberate statement that the test owns
 * that instance.
 */
export function shouldBlockHindsightRequest(input, policy) {
  const origin = originOf(input);
  if (origin === null) return false;
  if (policy.allowedOrigins.includes(origin)) return false;
  if (policy.blockedOrigins.includes(origin)) return true;
  const port = portOf(input);
  return port !== null && FLEET_HINDSIGHT_PORTS.includes(port);
}

let trips = 0;

/** Reset the per-test trip counter. Called by the setup file's beforeEach. */
export function resetHindsightBankGuardTrips() {
  trips = 0;
}

/** Record one blocked outbound call. Called by the guard stub. */
export function recordHindsightBankGuardTrip() {
  trips += 1;
}

/**
 * Outbound requests the guard blocked during the current test.
 *
 * The runtime alarm asserts this is > 0 after attempting a fleet-origin
 * request. A zero means the guard is not installed — i.e. someone unwired a
 * runner — and the whole defect class is open again.
 */
export function hindsightBankGuardTrips() {
  return trips;
}

/**
 * Explain a blocked call. Kept here so the runner entry, the lint gate and the
 * tests all quote the same text.
 */
export function blockedMessage(input) {
  return (
    `${HINDSIGHT_BANK_GUARD_MARKER}: refusing a test-process request to ` +
    `${originOf(input) ?? String(input)} — that is a FLEET Hindsight origin. ` +
    "On 2026-07-30 a harness sweep reached this endpoint and minted 11 banks " +
    "in the live instance, one of them named `clerk`, colliding with a live " +
    "agent and destroying a warning annotation. Hindsight auto-creates a bank " +
    "on miss, so a single stray request is enough. Point the test at its own " +
    `instance, or opt in explicitly via ${ALLOW_ORIGINS_ENV_VAR}.`
  );
}
