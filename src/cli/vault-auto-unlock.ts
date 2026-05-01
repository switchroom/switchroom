/**
 * Vault auto-unlock setup — shared logic between `vault broker enable-auto-unlock`
 * and the `switchroom setup` wizard.
 *
 * The job here is encrypting the vault passphrase via systemd-creds and writing
 * it to a credential file the broker unit can `LoadCredentialEncrypted=` at boot.
 *
 * The hard part is that systemd-creds offers three encryption scopes — user,
 * host, and root-via-sudo — and which one works depends on the systemd version,
 * whether the user-scope varlink socket is up, whether the host keystore
 * exists, and whether polkit is willing to authenticate the call. On a fresh
 * Ubuntu 24.04+ box (systemd ≥256, no user-scope socket shipped, polkit gates
 * the system socket for non-root callers) every unprivileged path fails; sudo
 * is the only option. We detect that case from systemd-creds' own error
 * classes (io.systemd.System / io.systemd.InteractiveAuthenticationRequired)
 * and offer to escalate once, with a single confirmation prompt.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import YAML from "yaml";

import { findConfigFile, loadConfig, resolvePath } from "../config/loader.js";
import { installAllUnits } from "../agents/systemd.js";
import { statusViaBroker } from "../vault/broker/client.js";
import { askYesNo } from "../setup/prompt.js";

export const HOST_SECRET = "/var/lib/systemd/credential.secret";

export type EncryptScope = "host" | "host-sudo";

export type EncryptErrorClass =
  | "polkit-required"
  | "varlink-unreachable"
  | "no-host-keystore"
  | "other";

export type EncryptOutcome =
  | { ok: true; scope: EncryptScope }
  | { ok: false; class: EncryptErrorClass; stderr: string };

/**
 * Map systemd-creds stderr output to an actionable error class. We branch on
 * intent (is this polkit gating us? is the varlink socket missing?) rather
 * than on environmental flags (does the host keystore file exist?) — the
 * filesystem axis was a bad proxy that masked the real failure mode on
 * Ubuntu 24.04+.
 */
export function classifyEncryptStderr(stderr: string): EncryptErrorClass {
  if (/InteractiveAuthenticationRequired/i.test(stderr)) return "polkit-required";
  if (/io\.systemd\.System(?!\w)/i.test(stderr)) return "varlink-unreachable";
  if (/credential\.secret.*No such file|host key.*not.*found/i.test(stderr)) return "no-host-keystore";
  return "other";
}

/**
 * Detect whether `systemd-creds` is available on PATH. We don't care about
 * version-specific feature flags — every flag we use (`--with-key=host`,
 * `--name=`, `--quiet`) is supported in every systemd-creds release we
 * target. Returns null when the binary is missing.
 */
export function detectSystemdCreds(): { available: true } | null {
  try {
    execFileSync("systemd-creds", ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return { available: true };
  } catch {
    return null;
  }
}

/**
 * Why `--with-key=host` and not the systemd-creds default ("auto")?
 *
 * `auto` picks `tpm2+host` when a TPM is present. The resulting credential
 * needs `/dev/tpmrm0` access at *decrypt* time — i.e., when the broker user
 * unit starts at boot. Ubuntu's default permissions on `/dev/tpmrm0` require
 * group `tss`, which kenthompson-style user accounts aren't members of by
 * default. Result: encrypt succeeds, decrypt at unit start fails with
 * "Permission denied" on /dev/tpmrm0 → systemd refuses to start the unit
 * with `status=243/CREDENTIALS`. By forcing `host`, the credential needs
 * only the host secret — which user-systemd brokers via the system manager
 * for any user unit, no group membership required. Trade-off: no TPM
 * sealing. Acceptable, since the encrypted file lives at mode 0600 in the
 * user's home and the real defence is filesystem perms, not TPM binding.
 *
 * Run a single systemd-creds encrypt invocation in host scope. Returns an
 * outcome object instead of throwing — caller orchestrates the fall-through
 * cascade.
 *
 * Passphrase is piped via stdin so it never appears in argv, environ, or
 * any process listing. stderr is captured (not inherited) so we can
 * classify the failure; stdout is empty on success because of --quiet.
 */
export function tryEncrypt(passphrase: string, credPath: string): EncryptOutcome {
  const result = spawnSync(
    "systemd-creds",
    ["encrypt", "--with-key=host", "--name=vault-passphrase", "--quiet", "-", credPath],
    {
      input: passphrase,
      stdio: ["pipe", "ignore", "pipe"],
      encoding: "utf8",
    },
  );

  if (result.status === 0) {
    return { ok: true, scope: "host" };
  }
  const stderr = (result.stderr ?? "") + (result.error ? `\n${result.error.message}` : "");
  return { ok: false, class: classifyEncryptStderr(stderr), stderr };
}

/**
 * Run sudo systemd-creds encrypt, then sudo chown the file back to the user.
 * Passphrase via stdin (never argv). The chown converts a root-owned cred
 * file (which broker user-units can't open) into a user-owned one with
 * mode 0600 — same end-state as a successful unprivileged encrypt.
 */
export function runSudoEncrypt(
  passphrase: string,
  credPath: string,
): { ok: true } | { ok: false; reason: string } {
  // -p customizes the prompt so the user sees what they're authenticating for.
  const encrypt = spawnSync(
    "sudo",
    [
      "-p",
      "[sudo] password to encrypt vault auto-unlock credential: ",
      "systemd-creds",
      "encrypt",
      "--with-key=host",
      "--name=vault-passphrase",
      "--quiet",
      "-",
      credPath,
    ],
    {
      input: passphrase,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );

  if (encrypt.status !== 0) {
    return { ok: false, reason: `sudo systemd-creds encrypt exited ${encrypt.status}` };
  }

  const uid = process.getuid?.() ?? -1;
  const gid = process.getgid?.() ?? -1;
  if (uid < 0 || gid < 0) {
    return { ok: false, reason: "could not determine current uid/gid for chown" };
  }

  // The first sudo above primed the cache; -n keeps this from re-prompting in
  // the common case. Fall back to interactive sudo if the cache expired.
  const owner = `${uid}:${gid}`;
  let chown = spawnSync("sudo", ["-n", "chown", owner, credPath], { stdio: "pipe" });
  if (chown.status !== 0) {
    chown = spawnSync("sudo", ["chown", owner, credPath], { stdio: "inherit" });
  }
  if (chown.status !== 0) {
    return { ok: false, reason: "sudo chown failed (credential is root-owned and unreadable by the broker)" };
  }

  try {
    chmodSync(credPath, 0o600);
  } catch {
    // systemd-creds already restricts mode; chmod is belt-and-braces.
  }

  return { ok: true };
}

export interface EncryptOptions {
  /** Skip the interactive sudo confirmation (used in tests and --yes flows). */
  assumeYesSudo?: boolean;
  /** Override TTY detection (used in tests). */
  isTTY?: boolean;
  /** Logger — defaults to console; tests inject a buffer. */
  log?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * Encrypt the vault passphrase, walking the user → host → sudo cascade as
 * needed. Returns the scope that succeeded so callers can describe what just
 * happened. Throws `EncryptCancelledError` if the user declined sudo.
 */
export class EncryptCancelledError extends Error {
  constructor(public credPath: string) {
    super("auto-unlock encrypt cancelled by user");
    this.name = "EncryptCancelledError";
  }
}

export class EncryptFailedError extends Error {
  constructor(public credPath: string, public detail: string) {
    super(detail);
    this.name = "EncryptFailedError";
  }
}

export async function encryptCredential(
  passphrase: string,
  credPath: string,
  opts: EncryptOptions = {},
): Promise<EncryptScope> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const err = opts.err ?? ((s: string) => console.error(s));
  const isTTY = opts.isTTY ?? process.stdin.isTTY === true;

  mkdirSync(dirname(credPath), { recursive: true, mode: 0o700 });

  // Host-scope encrypt-as-user only works when the host keystore is present
  // AND readable to the user (default Ubuntu has it root-only at mode 0400,
  // so this is mostly a fast-path for systems where it's been intentionally
  // shared). When that fails we escalate to sudo, which can always read it.
  let lastFail: EncryptOutcome | null = null;

  if (existsSync(HOST_SECRET)) {
    const r = tryEncrypt(passphrase, credPath);
    if (r.ok) return r.scope;
    lastFail = r;
  }

  // Unprivileged path exhausted. Decide whether to escalate.
  const sudoEncryptCmd = `sudo systemd-creds encrypt --with-key=host --name=vault-passphrase - ${credPath}`;
  if (!isTTY) {
    err("systemd-creds encrypt failed and stdin is not a TTY; refusing to auto-escalate via sudo.");
    if (lastFail) err(`  Last error: ${lastFail.stderr.trim().split("\n")[0]}`);
    err("");
    err("  Run interactively, or run this manually with sudo:");
    err(`    ${sudoEncryptCmd}`);
    err(`    sudo chown $USER:$USER ${credPath} && chmod 600 ${credPath}`);
    throw new EncryptFailedError(credPath, "non-tty: cannot auto-escalate");
  }

  log("");
  log("Unprivileged systemd-creds encrypt was refused on this host:");
  if (lastFail) {
    const firstLine = lastFail.stderr.trim().split("\n")[0] || "(no detail)";
    log(`  ${firstLine}`);
  }
  log("");
  log("This is the default state of Ubuntu 24.04+: the host secret at");
  log(`  ${HOST_SECRET} is mode 0400 root-only, so unprivileged callers`);
  log("  can't read it. sudo bypasses that.");
  log("");

  const proceed = opts.assumeYesSudo ?? (await askYesNo("Encrypt with sudo (one-time prompt)?", true));
  if (!proceed) {
    err("Aborted. To finish manually:");
    err(`  ${sudoEncryptCmd}`);
    err(`  sudo chown $USER:$USER ${credPath} && chmod 600 ${credPath}`);
    throw new EncryptCancelledError(credPath);
  }

  const sudoResult = runSudoEncrypt(passphrase, credPath);
  if (!sudoResult.ok) {
    err(`sudo encrypt failed: ${sudoResult.reason}`);
    throw new EncryptFailedError(credPath, sudoResult.reason);
  }

  return "host-sudo";
}

/**
 * Set `vault.broker.autoUnlock: <value>` in the user's switchroom.yaml,
 * preserving comments, key ordering, and surrounding formatting. Mirrors
 * the YAML.parseDocument pattern used by `updateAgentExtendsInConfig` in
 * src/cli/agent.ts.
 *
 * If the user's config has neither `vault:` nor `vault.broker:` blocks,
 * we add them as plain maps. The cascade resolver in `src/config/merge.ts`
 * fills in any other broker defaults at load time, so we don't need to
 * write them here.
 */
export function setVaultBrokerAutoUnlock(configPath: string, value: boolean): void {
  const raw = readFileSync(configPath, "utf-8");
  const doc = YAML.parseDocument(raw);
  doc.setIn(["vault", "broker", "autoUnlock"], value);
  writeFileSync(configPath, doc.toString(), "utf-8");
}

export interface ApplyOptions {
  configPath?: string;
  log?: (line: string) => void;
  err?: (line: string) => void;
  /** Override systemctl invocation in tests. */
  runSystemctl?: (args: string[]) => { status: number | null };
  /** Override status polling in tests. */
  pollStatus?: () => Promise<{ unlocked: boolean } | null>;
  /** How long to wait for the broker to come up unlocked. */
  verifyTimeoutMs?: number;
}

/**
 * Flip vault.broker.autoUnlock=true in switchroom.yaml, regenerate units,
 * restart the broker, and poll status to confirm the vault came up unlocked.
 *
 * The whole thing is one call so callers don't have to re-implement the
 * 3-step "Next steps" list. If anything fails we throw with a clear message
 * — the credential file is already on disk by this point so re-running is
 * cheap.
 */
export async function applyAutoUnlock(opts: ApplyOptions = {}): Promise<void> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const err = opts.err ?? ((s: string) => console.error(s));
  const runSystemctl =
    opts.runSystemctl ?? ((args: string[]) => spawnSync("systemctl", args, { stdio: "inherit" }));
  // 10s default — generous enough for cold-cache decrypt on slow boxes, short
  // enough that a real cred-decrypt failure surfaces before the user gives up.
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? 10000;

  const configPath = opts.configPath ?? findConfigFile();
  setVaultBrokerAutoUnlock(configPath, true);
  log(`✓ Set vault.broker.autoUnlock=true in ${configPath}`);

  // Reload the config from disk so we pass the freshly-flipped value into
  // installAllUnits — otherwise the broker unit gets re-rendered without the
  // LoadCredentialEncrypted= line.
  const config = loadConfig(configPath);
  installAllUnits(config);
  log("✓ Reconciled broker unit");

  runSystemctl(["--user", "daemon-reload"]);
  const restart = runSystemctl(["--user", "restart", "switchroom-vault-broker.service"]);
  if (restart.status !== 0) {
    err(
      "Broker restart failed. Check:\n" +
        "  systemctl --user status switchroom-vault-broker.service\n" +
        "  journalctl --user -u switchroom-vault-broker.service -e",
    );
    throw new Error(`broker restart exited ${restart.status}`);
  }
  log("✓ Restarted switchroom-vault-broker.service");

  const socket = resolvePath(config.vault?.broker?.socket ?? "~/.switchroom/vault-broker.sock");
  const poll = opts.pollStatus ?? (() => statusViaBroker({ socket }));

  const deadline = Date.now() + verifyTimeoutMs;
  while (Date.now() < deadline) {
    const status = await poll();
    if (status?.unlocked) {
      log("✓ Vault unlocked via auto-unlock credential");
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  err(
    "Broker restarted but vault did not unlock within " +
      `${verifyTimeoutMs}ms. Check:\n` +
      "  systemctl --user status switchroom-vault-broker.service\n" +
      "  journalctl --user -u switchroom-vault-broker.service -e",
  );
  throw new Error("verification timeout: broker did not unlock");
}
