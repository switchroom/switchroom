import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { constants as fsConstants } from "node:fs";
import type { SwitchroomConfig } from "../config/schema.js";
import { openVault, type VaultEntry } from "./vault.js";
import { resolvePath } from "../config/loader.js";
import {
  getViaBrokerStructured,
  resolveBrokerSocketPath,
  type BrokerClientOpts,
} from "./broker/client.js";

export function isVaultReference(value: string): boolean {
  return value.startsWith("vault:");
}

export function parseVaultReference(value: string): string {
  if (!isVaultReference(value)) {
    throw new Error(`Not a vault reference: ${value}`);
  }
  return value.slice("vault:".length);
}

export interface ParsedVaultRef {
  key: string;
  filename?: string;
}

export function parseVaultReferenceDetailed(value: string): ParsedVaultRef {
  const body = parseVaultReference(value);
  const hashIdx = body.indexOf("#");
  if (hashIdx === -1) return { key: body };
  return { key: body.slice(0, hashIdx), filename: body.slice(hashIdx + 1) };
}

const materializedDirs = new Set<string>();
let cleanupRegistered = false;

function registerCleanupHook(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const cleanup = (): void => {
    for (const dir of materializedDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    materializedDirs.clear();
    // Also remove the mkdtemp root so /tmp doesn't accumulate empty dirs.
    if (cachedRoot) {
      try { rmSync(cachedRoot, { recursive: true, force: true }); } catch {}
      cachedRoot = null;
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}

/**
 * Lazily-initialised per-process materialization root. Using `mkdtempSync`
 * gives us an unguessable 6-char suffix so a local attacker on a shared
 * host can't pre-create the path with weaker permissions (which the old
 * `<uid>-<pid>` scheme permitted). Each invocation of `switchroom` gets
 * its own root; entries inside are further namespaced per-key.
 */
let cachedRoot: string | null = null;
function materializationRoot(): string {
  if (cachedRoot) return cachedRoot;
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) {
    // XDG_RUNTIME_DIR is per-user and 0o700; mkdtemp inside the switchroom
    // subdir is both unguessable and unreachable by other UIDs.
    const base = join(xdg, "switchroom", "vault");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    cachedRoot = mkdtempSync(join(base, "run-"));
  } else {
    cachedRoot = mkdtempSync(join(tmpdir(), "switchroom-vault-"));
  }
  chmodSync(cachedRoot, 0o700);
  return cachedRoot;
}

function writeFileExclusive(
  filePath: string,
  content: Buffer | string,
): void {
  // O_CREAT | O_EXCL refuses to follow symlinks or reuse existing files,
  // closing the TOCTOU gap where an attacker pre-creates `filePath` as a
  // symlink into their own directory before the vault materialization.
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const fd = openSync(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    writeSync(fd, buf);
  } finally {
    closeSync(fd);
  }
}

export function materializeFilesEntry(
  key: string,
  files: Record<string, { encoding: "utf8" | "base64"; value: string }>
): string {
  const dir = join(materializationRoot(), key);
  // Wipe any pre-existing dir from a prior resolve in the same process.
  if (materializedDirs.has(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // Defense in depth: verify the directory is owned by us and not a symlink
  // pointing somewhere else. `mkdtemp` above guarantees this for the root,
  // but the leaf `${root}/${key}` is created with `recursive: true` which
  // silently succeeds on a pre-existing path.
  const st = statSync(dir);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`Refusing to materialize vault entry: ${dir} not owned by caller`);
  }

  for (const [filename, { encoding, value }] of Object.entries(files)) {
    if (
      filename.includes("/") ||
      filename.includes("\\") ||
      filename === ".." ||
      filename === "." ||
      filename.includes("\0")
    ) {
      throw new Error(
        `Refusing to materialize vault file with unsafe name: ${filename}`,
      );
    }
    const filePath = join(dir, filename);
    const content =
      encoding === "base64" ? Buffer.from(value, "base64") : value;
    writeFileExclusive(filePath, content);
  }

  materializedDirs.add(dir);
  registerCleanupHook();
  return dir;
}

export function cleanupMaterializedSecrets(): void {
  for (const dir of materializedDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  materializedDirs.clear();
  if (cachedRoot) {
    try { rmSync(cachedRoot, { recursive: true, force: true }); } catch {}
    cachedRoot = null;
  }
}

function resolveSingleReference(
  ref: ParsedVaultRef,
  secrets: Record<string, VaultEntry>
): string {
  const entry = secrets[ref.key];
  if (entry === undefined) {
    throw new Error(`Vault secret not found: ${ref.key}`);
  }

  // `vault:<key>#<filename>` — inline a specific file's contents as a string.
  if (ref.filename !== undefined) {
    if (entry.kind !== "files") {
      throw new Error(
        `Vault reference "vault:${ref.key}#${ref.filename}" expected kind="files", got kind="${entry.kind}".`
      );
    }
    const file = entry.files[ref.filename];
    if (!file) {
      throw new Error(
        `Vault secret "${ref.key}" has no file named "${ref.filename}". Available: ${Object.keys(entry.files).join(", ")}`
      );
    }
    return file.encoding === "base64"
      ? Buffer.from(file.value, "base64").toString("utf8")
      : file.value;
  }

  // `vault:<key>` — substitute based on entry kind.
  if (entry.kind === "string" || entry.kind === "binary") {
    return entry.value;
  }
  // kind === "files" — materialize to a temp dir and substitute the dir path.
  return materializeFilesEntry(ref.key, entry.files);
}

function resolveValue(
  value: unknown,
  secrets: Record<string, VaultEntry>
): unknown {
  if (typeof value === "string" && isVaultReference(value)) {
    const ref = parseVaultReferenceDetailed(value);
    return resolveSingleReference(ref, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, secrets));
  }
  if (value !== null && typeof value === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveValue(v, secrets);
    }
    return resolved;
  }
  return value;
}

export function resolveVaultReferences(
  config: SwitchroomConfig,
  passphrase: string
): SwitchroomConfig {
  const vaultPath = resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
  const secrets = openVault(passphrase, vaultPath);
  return resolveValue(config, secrets) as SwitchroomConfig;
}

/**
 * Structured result from `resolveVaultReferencesViaBroker`.
 *
 * Callers can now distinguish WHY resolution failed and act accordingly:
 *
 *   - `ok`          — all vault refs resolved; `config` has real values.
 *   - `denied`      — broker refused at least one key (ACL, locked vault).
 *                     The caller is not authorised; falling back to a
 *                     passphrase prompt is correct for interactive contexts
 *                     but wrong for headless cron — surface an actionable
 *                     error instead of a confusing "no TTY" failure.
 *   - `unreachable` — broker socket not found / timed out. Broker is likely
 *                     not running; passphrase-based decrypt is appropriate.
 *   - `locked`      — broker is running and the caller is authorised, but
 *                     the vault has not been unlocked yet.
 *
 * Issue #207 item 2: replaces the previous silent-return-unchanged-config
 * behaviour (which collapsed denied + unreachable + locked into the same
 * opaque result), letting callers surface the right error or choose the
 * right fallback.
 */
export type ResolveViaBrokerResult =
  | { ok: true; config: SwitchroomConfig }
  | { ok: false; reason: "denied" | "unreachable" | "locked" | "unknown" };

/**
 * Resolve vault references in a config using the broker daemon.
 *
 * For each `vault:<key>` reference found in the config, fetches the value
 * from the running broker rather than decrypting the vault file directly.
 *
 * Returns a structured `ResolveViaBrokerResult` so the caller can
 * distinguish success from each failure mode (denied, unreachable, locked)
 * and decide whether to fall back, log differently, or surface the right error.
 *
 * @param config     The parsed SwitchroomConfig.
 * @param brokerOpts Optional broker client options (socket path, timeout).
 */
export async function resolveVaultReferencesViaBroker(
  config: SwitchroomConfig,
  brokerOpts?: BrokerClientOpts,
): Promise<ResolveViaBrokerResult> {
  const socketPath = resolveBrokerSocketPath({
    ...brokerOpts,
    vaultBrokerSocket: config.vault?.broker?.socket
      ? resolvePath(config.vault.broker.socket)
      : undefined,
  });
  const opts: BrokerClientOpts = { ...brokerOpts, socket: socketPath };

  // Collect all vault keys referenced in the config
  const refs = collectVaultRefs(config as unknown as Record<string, unknown>);

  if (refs.size === 0) {
    // No vault references — nothing to do
    return { ok: true, config };
  }

  // Try broker for each key. Accumulate results to determine the aggregate
  // outcome. We continue past the first failure so we can classify the
  // reason accurately (a mix of denied + unreachable yields 'unknown').
  //
  // Issue #129 review: previously used the legacy null-shape getViaBroker,
  // which collapsed unreachable / denied / not_found into a single null.
  // Issue #207: we now surface the specific reason to the caller.
  const brokerSecrets: Record<string, VaultEntry> = {};
  let sawDenied = false;
  let sawUnreachable = false;
  let sawLocked = false;

  for (const key of refs) {
    const result = await getViaBrokerStructured(key, opts);
    if (result.kind === "ok") {
      brokerSecrets[key] = result.entry;
    } else if (result.kind === "unreachable") {
      sawUnreachable = true;
      // Pure unreachable: bail early, every subsequent call will time out.
      break;
    } else if (result.kind === "denied") {
      // Distinguish LOCKED (vault not yet unlocked) from generic DENIED
      // (ACL / peercred rejection) so callers can suggest the right action.
      if (result.code === "LOCKED") {
        sawLocked = true;
      } else {
        sawDenied = true;
      }
    }
    // not_found: key is absent from the vault; other keys may still resolve.
    // We don't treat not_found as a failure — partial resolution is fine;
    // the caller will encounter the unresolved `vault:` reference later and
    // can surface a proper "key not found" message then.
  }

  // Compute the aggregate reason for the structured failure result.
  // If all refs resolved (even partially with not_found gaps), return ok.
  const resolvedCount = Object.keys(brokerSecrets).length;
  const allResolved = resolvedCount === refs.size;

  if (allResolved) {
    return { ok: true, config: resolveValue(config, brokerSecrets) as SwitchroomConfig };
  }

  // Partial or full failure. Determine why.
  if (sawUnreachable && !sawDenied && !sawLocked) {
    return { ok: false, reason: "unreachable" };
  }
  if (sawLocked && !sawDenied && !sawUnreachable) {
    return { ok: false, reason: "locked" };
  }
  if (sawDenied && !sawUnreachable && !sawLocked) {
    return { ok: false, reason: "denied" };
  }
  // Mixed: cannot definitively classify — surface 'unknown' rather than guess.
  if (sawDenied || sawUnreachable || sawLocked) {
    return { ok: false, reason: "unknown" };
  }

  // Only not_found failures (no connectivity/auth issue): some keys are
  // genuinely missing. Return what we could resolve; caller sees unresolved refs.
  if (resolvedCount > 0) {
    return { ok: true, config: resolveValue(config, brokerSecrets) as SwitchroomConfig };
  }
  return { ok: false, reason: "unknown" };
}

/**
 * Collect all vault key names referenced in an arbitrary value tree.
 * Returns a Set of key names (without the "vault:" prefix or "#filename" suffix).
 */
function collectVaultRefs(value: unknown): Set<string> {
  const keys = new Set<string>();

  function walk(v: unknown): void {
    if (typeof v === "string" && isVaultReference(v)) {
      const ref = parseVaultReferenceDetailed(v);
      keys.add(ref.key);
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (v !== null && typeof v === "object") {
      for (const val of Object.values(v as Record<string, unknown>)) walk(val);
    }
  }

  walk(value);
  return keys;
}
