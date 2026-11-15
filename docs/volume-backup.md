# Encrypted volume backups

`scripts/switchroom-volume-backup.py` backs up one agent's volume (its Hermes
state directory and, if you want, its workspace) to a destination you choose,
encrypted on the host before anything is written there, and checks that a copy
really restores. It is **off by default**: nothing in the image or the starter
overlay runs it. You install it on the host, write a config, supply your own
keys and enable a timer or a cron line.

It needs only the host's `python3` (3.11 or newer, standard library) and
`gpg` (GnuPG 2.2 or newer). It runs on the host, as root, because it reads
agent volumes owned by the container user.

## What a run does

`backup`:

1. Takes a lock for the agent (a second run exits with code 4).
2. Reads the recipient public key files and refuses a run if a file holds no
   public key, holds a secret key, or a key is revoked or expired. With
   `recipient_fingerprints` set, the keys must be exactly those.
3. Walks each configured root. Symlinks are recorded, never followed. Other
   mounts are never crossed. `exclude` patterns and `skip_names` drop
   rebuildable trees.
4. Snapshots every SQLite database with SQLite's **online backup API**, as the
   database file's owner, never a raw copy of a live file. The snapshot
   includes rows still only in the `-wal`, and `-wal`/`-shm`/`-journal` files
   are not copied. A snapshot must pass `PRAGMA quick_check`, and the run
   records an exact row count for every table **from the snapshot itself**.
   A database that cannot be snapshotted fails the run.
5. Streams tar, then gzip, then `gpg --encrypt` to every recipient, straight
   into a hidden `.<name>.incomplete` file at the destination. Database
   snapshots are held in memory (or staged, see below), so **no plaintext is
   written to the destination or to any temporary file**. GnuPG runs with a
   throwaway, empty home, so only your recipient files decide who can decrypt.
6. Reads the ciphertext back from the destination and hashes it. If
   `check_gnupg_home` is set, it also decrypts that copy and re-hashes every
   member against the manifest.
7. Publishes the copy as `<name>-volume-YYYYMMDDTHHMMSSZ.tar.gz.gpg` with a
   `<file>.sha256` sidecar, then applies retention.

On any failure the hidden file is deleted, nothing is published, retention
does not run and the exit code is non-zero.

`restore-check`:

1. Picks the newest published copy (or `--archive <file name>`) and checks it
   against its `.sha256` sidecar.
2. Decrypts it with the check key into an empty scratch directory (`0700`),
   refusing any member that would land outside it. Archived symlinks are
   compared with the manifest but never created.
3. Re-hashes every restored file against the manifest, runs
   `PRAGMA integrity_check` on every database and compares every table's row
   count with the count recorded at backup time.
4. Prints a JSON report with `"result": "pass"` or `"fail"` (and a `reason`),
   writes it to `<state_dir>/restore-check.json`, and deletes the scratch copy,
   on a pass or a fail. `--keep` keeps it after a pass only.

A copy whose ciphertext was changed fails: the checksum no longer matches, and
if the sidecar was rewritten too, GnuPG's integrity protection rejects the
decrypt. Any plaintext a failed decrypt had already written is removed.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Backup published, or restore check passed |
| 1 | Backup failed, or restore check failed |
| 2 | Config or usage error |
| 3 | Backups are disabled in the config (`"enabled": true` is missing) |
| 4 | Another run for this agent holds the lock |

The last line of stdout is always one JSON object with a `result`. Run status
(counts, hashes, archive names; never file contents or keys) is written to
`<state_dir>/status.json`. A run that is killed stays `running` there, never a
stale success.

## Keys

You supply every key. The tool never generates, stores or prints one.

- **Recipient public keys** (`recipient_files`): armored or binary OpenPGP
  public keys. Use at least one **recovery key** whose secret half is kept off
  the host (for example, offline or in your password manager). Pin them with
  `recipient_fingerprints`.
- **Check key** (`check_gnupg_home`, optional): a GnuPG home on the host
  holding a secret key that is also a recipient, without a passphrase, used
  only to verify copies. It decrypts every backup, so keep it root-only
  (`0700`), on the host's own disk, and out of every backed-up root. Without
  it, `backup` still publishes ciphertext (verified by hash only), and
  `restore-check` needs `--gnupg-home` pointing at a key that can decrypt.

Public-key encryption protects confidentiality and detects modification. It
does not prove who made a copy: anyone with the public key could write a new
valid archive. Keep the destination writable only by the backup host.

## Config

One JSON file per agent, for example `/etc/switchroom/volume-backup/<agent>.json`.
Start from [`examples/volume-backup/example-agent.json`](../examples/volume-backup/example-agent.json),
which ships with `"enabled": false`.

| Key | Required | Meaning |
| --- | --- | --- |
| `enabled` | yes | Must be `true` to run. Anything else exits 3. |
| `name` | yes | Agent label used in archive names, lower-case (`[a-z][a-z0-9-]*`). |
| `roots` | yes | `{label: absolute path}`. Archive members are `<label>/<relative path>`. |
| `exclude` | no | `{label: [pattern, ...]}`, shell-style patterns on the path relative to the root (`cache/*`, `*/node_modules`). |
| `skip_names` | no | File or directory names skipped at any depth. Default `["__pycache__"]`. |
| `destination` | yes | Absolute directory for the encrypted copies. Its parent must exist, and no part of the path may be a symlink. Must not overlap a root. |
| `destination_mount` | no | An ancestor of `destination` that must be a mount point, so an unmounted share fails instead of filling the local disk. |
| `recipient_files` | yes | Absolute paths of the recipient public keys. |
| `recipient_fingerprints` | no | Expected primary key fingerprints (upper-case hex). |
| `check_gnupg_home` | no | GnuPG home with the check key. |
| `retention` | no | `{"daily": 7, "weekly": 4}` (the default). `daily` is at least 1. |
| `state_dir` | no | Default `/var/lib/switchroom-volume-backup/<name>`. |
| `scratch_dir` | no | Restore-check target. Default `<state_dir>/restore-check`. Must be outside the destination and the roots. |
| `stage_dir`, `stage_over_bytes` | no | Disk staging for large databases, below. |
| `min_free_bytes` | no | Free space required at the destination, default 1 GiB. A run also needs twice the size of the last copy. |

### Large databases

Snapshots are held in memory, so a run needs roughly twice the size of the
largest database. For databases at least `stage_over_bytes` in size, set
`stage_dir` to a directory on **the same filesystem as the live database** and
outside every root. The snapshot is written there by the same backup API,
streamed into the encrypted archive and deleted at once. The run refuses if the
staging directory is on another filesystem, so no new disk, tmpfs or share ever
holds a plaintext copy. Leftovers from a killed run are removed at the start of
the next one.

## Retention

After a new copy is published: keep the newest copy per day for the newest
`daily` days, plus the newest copy per ISO week for the newest `weekly` weeks.
The copy just published is always kept. Only files matching this agent's exact
archive name are pruned, with their `.sha256` sidecars. Hidden `.incomplete`
files older than a day are removed.

## Install (host, root)

```bash
sudo install -d -m 0755 /opt/switchroom/scripts
sudo install -m 0755 scripts/switchroom-volume-backup.py /opt/switchroom/scripts/
sudo install -d -m 0700 /etc/switchroom/volume-backup /etc/switchroom/volume-backup/keys
sudo install -m 0600 examples/volume-backup/example-agent.json /etc/switchroom/volume-backup/example-agent.json
# Copy in your recovery public key, set up the optional check key, then edit
# the config: roots, destination, keys, and finally "enabled": true.
sudo python3 -I /opt/switchroom/scripts/switchroom-volume-backup.py backup --config /etc/switchroom/volume-backup/example-agent.json
sudo python3 -I /opt/switchroom/scripts/switchroom-volume-backup.py restore-check --config /etc/switchroom/volume-backup/example-agent.json
```

Run the first backup and a restore check by hand before scheduling anything.

### systemd

Example units are in [`examples/volume-backup/`](../examples/volume-backup/).
The instance name is the agent name and selects `/etc/switchroom/volume-backup/<agent>.json`.

```bash
sudo install -m 0644 examples/volume-backup/switchroom-volume-*@.service \
  examples/volume-backup/switchroom-volume-*@.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now switchroom-volume-backup@example-agent.timer          # nightly backup
sudo systemctl enable --now switchroom-volume-restore-check@example-agent.timer   # weekly restore check
```

Set `RequiresMountsFor=` to your destination mount, and point `OnFailure=` at
whatever alerting you use. The units set `UMask=0077`, `MemorySwapMax=0` and
`LimitCORE=0` so snapshot plaintext held in memory stays out of swap and core
dumps.

### cron

Without systemd, use [`examples/volume-backup/crontab.example`](../examples/volume-backup/crontab.example):
the same two commands on a nightly and a weekly schedule. Any non-zero exit is
a failure and is reported by cron.

## Restoring for real

Stop the agent first. Decrypt with any recipient key, ideally on another machine:

```bash
gpg --decrypt example-agent-volume-YYYYMMDDTHHMMSSZ.tar.gz.gpg | tar -xz -C <empty-dir>
```

Each `<label>/` directory maps back to the root with that label in the config.
`MANIFEST.json` lists every file with its SHA-256 and every table's row count.
Copy the files back as the container user (UID/GID 1000 in the Fleet image),
then start the agent.
