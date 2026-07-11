# Vault auto-unlock at boot

Run-once command, vault unlocks itself on every reboot.

```
switchroom vault broker enable-auto-unlock
```

You enter your vault passphrase once. Switchroom encrypts it with a key
derived from `/etc/machine-id`, writes the result to
`~/.switchroom/vault-auto-unlock` at mode 0600, flips
`vault.broker.autoUnlock: true` in your `switchroom.yaml`, and restarts the
broker. Done — every subsequent boot, the broker reads the file, decrypts,
unlocks the vault, and your fleet comes back working without you typing
anything.

**Scope / see also:** this is the **auto-unlock** doc (boot-time machine-bound unlock, setup, and recovery). For day-to-day operator use, see [vault.md](vault.md); for the security/threat model, see [vault-security.md](vault-security.md); for broker ACL internals, see [vault-broker.md](vault-broker.md).

To turn it off:

```
switchroom vault broker disable-auto-unlock
```

That removes the encrypted blob and flips the YAML back. Next reboot, the
broker starts locked and you unlock interactively (`switchroom vault broker
unlock`).

## What you need

- A Linux box with `/etc/machine-id` populated (every distro since 2014).
  On a freshly-imaged install where the file is empty, run
  `sudo systemd-machine-id-setup` once and reboot.
- That's it. No sudo for the auto-unlock setup itself, no group
  membership, no TPM2, no systemd-creds, no polkit.

## Threat model

**What the encrypted blob protects against:**

- **Theft of the home directory alone (without `/etc/machine-id`).** The
  encryption key is derived from your machine's `/etc/machine-id`, which
  lives under `/etc` and doesn't sit inside your home directory. If
  someone copies only your home directory and mounts it on another
  machine, the auto-unlock blob is unrecoverable garbage on the other
  box. Brute-forcing it requires guessing a 128-bit key — not a threat
  anyone has the budget for. This protection holds only when the copy
  leaves `machine-id` behind — see "Combined-backup exfiltration" below.
- **Other users on the same machine.** The blob lives at mode 0600 in
  your home directory. Other UNIX users on the same box can't read it.

**What it does NOT protect against:**

- **Root on the same machine.** Root can read `/etc/machine-id` and
  your home dir, so root can decrypt the blob. This matches every
  comparable system (gpg-agent, ssh-agent, gnome-keyring, systemd-creds
  host scope) — once root is on the box, secrets at rest are
  recoverable. If your threat model includes hostile root, don't enable
  auto-unlock.
- **Your user account being compromised.** Same model as the vault
  itself — if an attacker reads your home directory, they can read both
  the auto-unlock blob and the vault file.
- **Combined-backup exfiltration.** Machine-binding defends only against
  theft of the home directory *alone*. Any single artifact that captures
  BOTH `/etc/machine-id` and the blob — a full-disk image, a full-system
  backup, or `rsync -a /` — carries the key material off-box, so the blob
  is decryptable on another machine and reduces to passphrase-only
  protection. Backup hygiene: exclude `~/.switchroom/vault-auto-unlock`
  or `/etc/machine-id` from off-box backups, or treat any backup that
  captures both as passphrase-protected only.

## When it breaks

The blob is bound to the machine that created it. It will stop
decrypting if any of the following happens:

- You re-image the OS (new install → new machine-id).
- You manually run `systemd-machine-id-setup --force` or delete
  `/etc/machine-id`.
- You move the home directory to a different physical machine.
- You restore from a backup taken from a different machine.

The broker recognises this and logs a clear message:

```
[vault-broker] auto-unlock decrypt failed (tag-mismatch): Auto-unlock
blob failed to decrypt — likely bound to a different machine-id. Re-run
`switchroom vault broker enable-auto-unlock` to refresh.
[vault-broker] staying locked; use `switchroom vault broker unlock`
interactively
```

The broker stays running and lets you unlock interactively. Re-running
`enable-auto-unlock` writes a fresh blob bound to the new machine-id.

## How it works (file format)

```
~/.switchroom/vault-auto-unlock   mode 0600

  0       1     version (always 0x01)
  1       16    salt (random per-encryption)
  17      12    AES-GCM nonce (random per-encryption)
  29      N+16  ciphertext + 16-byte GCM auth tag
```

Key derivation:

```
HKDF-SHA256(
  ikm   = readFileSync('/etc/machine-id'),
  salt  = blob[1..17],
  info  = "switchroom-vault-auto-unlock-v1",
)  →  32-byte AES-256 key
```

Encryption: AES-256-GCM. Authenticated, so any tamper or wrong machine
fails closed with a recognisable error class — no ambiguous "decrypted
to garbage" mode.

The implementation is ~80 lines in `src/vault/auto-unlock.ts`. Read it.

## Why not TPM, systemd-creds, or polkit?

We tried. Here's the short version:

- **TPM2 sealing** requires `/dev/tpmrm0` access at decrypt time, which
  needs the user to be in the `tss` group. They aren't, by default, on
  Ubuntu 24.04+. systemd-creds picks `tpm2+host` automatically when a
  TPM is available, so the encryption succeeds and the decrypt at unit
  start fails with `status=243/CREDENTIALS`. Brittle.
- **systemd-creds host scope** would work, but on Ubuntu 24.04+ the
  varlink credential service is polkit-gated for non-root callers.
  Users can't decrypt their own credentials without an interactive
  authentication prompt, which doesn't happen at boot.
- **polkit rules** to grant decrypt access could fix that, but require
  root to install and reset on every distro upgrade. Not "simple by
  default."

Machine-bound encryption with a key we control is universal: works on
Ubuntu, Debian, Fedora, Arch, NixOS, Alpine — anywhere `/etc/machine-id`
exists. No distro-specific polkit rules. No group membership. No sudo
on the user's first run.

For the rare power user who genuinely wants TPM-bound or system-unit
auto-unlock, the broker still understands `$CREDENTIALS_DIRECTORY/vault-passphrase`
when running as a system unit with `LoadCredentialEncrypted=`. That path
is documented in [vault-broker.md](vault-broker.md) and tracked in
[issue #540](https://github.com/switchroom/switchroom/issues/540).

## Recovering from a broken auto-unlock

If the blob fails to decrypt at boot (broker logs show
`auto-unlock decrypt failed`), the broker stays running but locked.
Three ways to recover:

1. **Refresh the blob.** Re-run `switchroom vault broker
   enable-auto-unlock` and enter your vault passphrase. The blob is
   rewritten bound to the current machine-id.
2. **Disable auto-unlock and unlock manually.** Run `switchroom vault
   broker disable-auto-unlock`, then `switchroom vault broker unlock`
   on every boot.
3. **Inspect.** `docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml logs switchroom-broker --tail 100`
   will show the exact error class
   (`tag-mismatch` / `format` / `io`).
