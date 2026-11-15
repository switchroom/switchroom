#!/usr/bin/env python3
"""Encrypted per-agent volume backup with a restore check. Off by default.

One config file per agent (JSON, see ``examples/volume-backup/``). Two commands:

``backup``
    Walks the agent's volume roots, snapshots every SQLite database with the
    online backup API (never a raw copy of a live file) and streams
    tar -> gzip -> ``gpg --encrypt`` straight into a hidden file at the
    destination, so only ciphertext ever reaches it. The ciphertext is read
    back and hashed, optionally decrypted and verified with a check key, then
    published under its final name with a ``.sha256`` sidecar. Retention runs
    only after a copy has been published.

``restore-check``
    Decrypts a published copy (the newest by default) into a scratch directory,
    re-hashes every file against the manifest, runs ``PRAGMA integrity_check``
    on every database and compares each table's row count with the count
    recorded when the snapshot was taken. Prints a JSON report with
    ``"result": "pass"`` or ``"fail"`` and removes the scratch copy.

Exit codes: 0 success/pass, 1 backup or restore check failed, 2 configuration
or usage error, 3 backups disabled in the config, 4 another run holds the lock.

Keys are always supplied by the operator: public recipient key files for
encryption, and an optional GnuPG home holding a check key for verification.
This tool never generates, stores or prints a key.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import fnmatch
import hashlib
import inspect
import io
import json
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import zlib
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterable

EXIT_OK, EXIT_FAILED, EXIT_CONFIG, EXIT_DISABLED, EXIT_LOCKED = 0, 1, 2, 3, 4

NAME_PATTERN = r'[a-z][a-z0-9-]{0,62}'
STAMP_FORMAT = '%Y%m%dT%H%M%SZ'
CHUNK = 1 << 20
GZIP_LEVEL = 3
SQLITE_MAGIC = b'SQLite format 3\x00'
SQLITE_SIDECARS = ('-wal', '-shm', '-journal')
DEFAULT_SKIP_NAMES = ('__pycache__',)
DEFAULT_STATE_ROOT = '/var/lib/switchroom-volume-backup'
DEFAULT_DAILY, DEFAULT_WEEKLY = 7, 4
DEFAULT_MIN_FREE = 1 << 30
GPG_TIMEOUT = 3600


class BackupError(RuntimeError):
    """A run failed; the message is safe to log (no file contents, no keys)."""


class ConfigError(RuntimeError):
    """The config is missing, malformed or unsafe."""


def require(ok: bool, why: str) -> None:
    if not ok:
        raise BackupError(why)


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


# --------------------------------------------------------------------------- config

class Config:
    def __init__(self, raw: dict[str, Any], *, now: Callable[[], dt.datetime] = utcnow) -> None:
        def need(ok: bool, why: str) -> None:
            if not ok:
                raise ConfigError(why)

        need(isinstance(raw, dict), 'config must be a JSON object')
        self.enabled = raw.get('enabled', False) is True
        name = raw.get('name')
        need(isinstance(name, str) and re.fullmatch(NAME_PATTERN, name) is not None,
             'name must match ' + NAME_PATTERN)
        self.name: str = name
        roots = raw.get('roots')
        need(isinstance(roots, dict) and roots, 'roots must be a non-empty object')
        self.roots: dict[str, Path] = {}
        for label, path in roots.items():
            need(re.fullmatch(NAME_PATTERN, label) is not None, 'root labels must match ' + NAME_PATTERN)
            need(isinstance(path, str) and os.path.isabs(path), 'root paths must be absolute')
            self.roots[label] = Path(os.path.normpath(path))
        exclude = raw.get('exclude', {})
        need(isinstance(exclude, dict) and set(exclude) <= set(self.roots), 'exclude keys must be root labels')
        self.exclude = {k: [str(p).strip('/') for p in v] for k, v in exclude.items()}
        self.skip_names = tuple(raw.get('skip_names', DEFAULT_SKIP_NAMES))
        dest = raw.get('destination')
        need(isinstance(dest, str) and os.path.isabs(dest), 'destination must be an absolute path')
        self.destination = Path(os.path.normpath(dest))
        for root in self.roots.values():
            need(not _within(self.destination, root) and not _within(root, self.destination),
                 'destination and volume roots must not overlap')
        recipients = raw.get('recipient_files')
        need(isinstance(recipients, list) and recipients and all(isinstance(p, str) and os.path.isabs(p)
                                                                for p in recipients),
             'recipient_files must list absolute paths to public key files')
        self.recipient_files = [Path(p) for p in recipients]
        fprs = raw.get('recipient_fingerprints', [])
        need(isinstance(fprs, list) and all(isinstance(f, str) and re.fullmatch(r'[0-9A-F]{40}|[0-9A-F]{64}', f)
                                            for f in fprs), 'recipient_fingerprints must be upper-case hex')
        self.recipient_fingerprints = list(fprs)
        home = raw.get('check_gnupg_home')
        need(home is None or (isinstance(home, str) and os.path.isabs(home)), 'check_gnupg_home must be absolute')
        self.check_gnupg_home = Path(home) if home else None
        retention = raw.get('retention', {})
        self.daily = retention.get('daily', DEFAULT_DAILY)
        self.weekly = retention.get('weekly', DEFAULT_WEEKLY)
        need(isinstance(self.daily, int) and self.daily >= 1 and isinstance(self.weekly, int) and self.weekly >= 0,
             'retention.daily must be >= 1 and retention.weekly >= 0')
        self.state_dir = Path(raw.get('state_dir', os.path.join(DEFAULT_STATE_ROOT, self.name)))
        need(self.state_dir.is_absolute(), 'state_dir must be absolute')
        need(not _within(self.state_dir, self.destination), 'state_dir must not be at the destination')
        scratch = raw.get('scratch_dir', str(self.state_dir / 'restore-check'))
        need(os.path.isabs(scratch), 'scratch_dir must be absolute')
        self.scratch_dir = Path(os.path.normpath(scratch))
        need(not _within(self.scratch_dir, self.destination), 'scratch_dir must not be at the destination')
        for root in self.roots.values():
            need(not _within(self.scratch_dir, root), 'scratch_dir must not be inside a volume root')
        stage = raw.get('stage_dir')
        self.stage_dir = Path(stage) if stage else None
        need(self.stage_dir is None or self.stage_dir.is_absolute(), 'stage_dir must be absolute')
        need(self.stage_dir is None or not _within(self.stage_dir, self.destination),
             'stage_dir must not be at the destination')
        for root in self.roots.values():
            need(self.stage_dir is None or not (_within(self.stage_dir, root) or _within(root, self.stage_dir)),
                 'stage_dir must not overlap a volume root')
        self.stage_over = raw.get('stage_over_bytes')
        need(self.stage_over is None or (isinstance(self.stage_over, int) and self.stage_dir is not None),
             'stage_over_bytes needs an integer and a stage_dir')
        mount = raw.get('destination_mount')
        need(mount is None or (isinstance(mount, str) and os.path.isabs(mount)
                               and _within(self.destination, Path(mount))),
             'destination_mount must be an absolute ancestor of destination')
        self.destination_mount = Path(mount) if mount else None
        self.min_free = raw.get('min_free_bytes', DEFAULT_MIN_FREE)
        need(isinstance(self.min_free, int) and self.min_free >= 0, 'min_free_bytes must be a non-negative integer')
        self.now = now


def _within(path: Path, parent: Path) -> bool:
    path, parent = Path(os.path.normpath(path)), Path(os.path.normpath(parent))
    return path == parent or parent in path.parents


def load_config(path: Path, **kwargs: Any) -> Config:
    try:
        raw = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise ConfigError(f'cannot read config ({type(exc).__name__})')
    return Config(raw, **kwargs)


# --------------------------------------------------------------------------- walking

def excluded(rel: str, patterns: Iterable[str], skip_names: Iterable[str]) -> bool:
    parts = rel.split('/')
    if any(p in skip_names for p in parts):
        return True
    return any(fnmatch.fnmatchcase(rel, pat) for pat in patterns)


def is_sqlite(path: Path) -> bool:
    try:
        with open(path, 'rb') as fh:
            return fh.read(16) == SQLITE_MAGIC
    except OSError:
        return False


def walk(root: Path, patterns: list[str], skip_names: Iterable[str]) -> Iterable[tuple[str, Path, os.stat_result]]:
    """Yield (relative path, path, lstat) for regular files and symlinks; never follow links or cross mounts."""
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        base = Path(dirpath)
        rel_dir = base.relative_to(root).as_posix()
        rel_dir = '' if rel_dir == '.' else rel_dir + '/'
        keep, links = [], []
        for d in sorted(dirnames):
            full = base / d
            if excluded(rel_dir + d, patterns, skip_names):
                continue
            if full.is_symlink():
                links.append(d)
            elif not os.path.ismount(full):
                keep.append(d)
        dirnames[:] = keep
        for fn in sorted(filenames + links):
            rel = rel_dir + fn
            if excluded(rel, patterns, skip_names):
                continue
            path = base / fn
            try:
                st = path.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode):
                yield rel, path, st


def sqlite_sidecar(path: Path) -> bool:
    for suffix in SQLITE_SIDECARS:
        if path.name.endswith(suffix) and is_sqlite(path.with_name(path.name[:-len(suffix)])):
            return True
    return False


# --------------------------------------------------------------------------- sqlite

# Runs in a child process as the database file's owner (when started as root),
# so any -wal/-shm SQLite creates stays owned by the agent, as if the agent had
# opened the database itself. Counts every table's rows in the snapshot itself,
# so the counts and the archived copy describe the same instant. Writes an
# 8-byte length, the counts as JSON, then the snapshot (or, with a file
# target, only the length and counts).
SNAPSHOT_CHILD = r'''
import json, os, sqlite3, struct, sys
path, wait, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
os.umask(0o077)
%TABLE_COUNTS%
def snap(uri):
    src = sqlite3.connect(uri, uri=True, timeout=wait, isolation_level=None)
    try:
        src.execute('PRAGMA busy_timeout=%d' % (wait * 1000))
        if out == '-':
            dst = sqlite3.connect(':memory:')
        else:
            if os.path.exists(out):
                os.unlink(out)
            dst = sqlite3.connect(out, isolation_level=None)
            dst.execute('PRAGMA journal_mode=OFF')
        src.backup(dst)
        return dst
    finally:
        src.close()
try:
    dst = snap('file:' + path + '?mode=ro')
except sqlite3.Error:
    # A read-only open of a WAL database needs an existing -shm; open normally.
    dst = snap('file:' + path)
row = dst.execute('PRAGMA quick_check').fetchone()
if not row or row[0] != 'ok':
    sys.stderr.write('quick_check failed\n')
    sys.exit(3)
counts = json.dumps(table_counts(dst), sort_keys=True).encode()
sys.stdout.buffer.write(struct.pack('>Q', len(counts)) + counts)
if out == '-':
    sys.stdout.buffer.write(dst.serialize())
dst.close()
'''


def _owner_kwargs(st: os.stat_result) -> dict[str, Any]:
    if os.geteuid() == 0 and st.st_uid != 0:
        return {'user': st.st_uid, 'group': st.st_gid, 'extra_groups': []}
    return {}


def snapshot_sqlite(path: Path, st: os.stat_result, out: Path | None = None, busy_wait: int = 60,
                    timeout: int = 3600) -> tuple[dict[str, int], bytes | None]:
    """Consistent online-backup snapshot of a live database (includes rows still only in the WAL).

    Returns the snapshot's per-table row counts and, without ``out``, the snapshot bytes.
    """
    proc = subprocess.run([sys.executable, '-I', '-B', '-c', SNAPSHOT_CHILD, str(path), str(busy_wait),
                           str(out) if out else '-'],
                          capture_output=True, timeout=timeout, check=False, cwd='/', **_owner_kwargs(st))
    require(proc.returncode == 0 and len(proc.stdout) >= 8, 'database snapshot failed')
    n = int.from_bytes(proc.stdout[:8], 'big')
    try:
        counts = json.loads(proc.stdout[8:8 + n])
    except ValueError:
        raise BackupError('database snapshot failed')
    require(isinstance(counts, dict), 'database snapshot failed')
    if out is None:
        data = proc.stdout[8 + n:]
        require(data.startswith(SQLITE_MAGIC), 'database snapshot failed')
        return counts, data
    require(len(proc.stdout) == 8 + n and out.is_file() and not out.is_symlink() and is_sqlite(out),
            'database snapshot failed')
    return counts, None


def table_counts(con: sqlite3.Connection) -> dict[str, int]:
    """Exact row count of every ordinary table (virtual tables are counted through their shadow tables)."""
    rows = con.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").fetchall()
    counts = {}
    for name, sql in rows:
        if sql and sql.lstrip().upper().startswith('CREATE VIRTUAL TABLE'):
            continue
        quoted = '"' + name.replace('"', '""') + '"'
        counts[name] = con.execute('SELECT count(*) FROM ' + quoted).fetchone()[0]
    return counts


# One definition, shared with the snapshot child.
SNAPSHOT_CHILD = SNAPSHOT_CHILD.replace('%TABLE_COUNTS%', inspect.getsource(table_counts))


# --------------------------------------------------------------------------- streams

class HashingGzipWriter(io.RawIOBase):
    """tar bytes in -> gzip -> sink; hashes the compressed stream."""

    def __init__(self, sink: BinaryIO) -> None:
        self.sink = sink
        self.comp = zlib.compressobj(GZIP_LEVEL, zlib.DEFLATED, 31)
        self.sha = hashlib.sha256()
        self.out_bytes = 0

    def writable(self) -> bool:
        return True

    def _emit(self, data: bytes) -> None:
        if data:
            self.sha.update(data)
            self.out_bytes += len(data)
            self.sink.write(data)

    def write(self, b) -> int:  # type: ignore[override]
        b = bytes(b)
        self._emit(self.comp.compress(b))
        return len(b)

    def finish(self) -> None:
        self._emit(self.comp.flush())
        self.sink.flush()


class HashingReader(io.RawIOBase):
    def __init__(self, src: BinaryIO) -> None:
        self.src, self.sha, self.n = src, hashlib.sha256(), 0

    def readable(self) -> bool:
        return True

    def readinto(self, buf) -> int:  # type: ignore[override]
        data = self.src.read(len(buf))
        if not data:
            return 0
        self.sha.update(data)
        self.n += len(data)
        buf[:len(data)] = data
        return len(data)


class LimitedFile(io.RawIOBase):
    """Read exactly ``size`` bytes of a file that may change while it is read."""

    def __init__(self, fh: BinaryIO, size: int) -> None:
        self.fh, self.left, self.sha, self.short = fh, size, hashlib.sha256(), False

    def readable(self) -> bool:
        return True

    def readinto(self, buf) -> int:  # type: ignore[override]
        if self.left <= 0:
            return 0
        want = min(len(buf), self.left)
        data = self.fh.read(want)
        if not data:
            data, self.short = b'\0' * want, True
        self.left -= len(data)
        self.sha.update(data)
        buf[:len(data)] = data
        return len(data)


def sha_fd(fd: int) -> tuple[str, int]:
    os.lseek(fd, 0, os.SEEK_SET)
    h, n = hashlib.sha256(), 0
    while True:
        b = os.read(fd, CHUNK)
        if not b:
            return h.hexdigest(), n
        h.update(b)
        n += len(b)


# --------------------------------------------------------------------------- gpg

def gpg_cmd(home: Path | str) -> list[str]:
    return ['gpg', '--no-options', '--batch', '--no-tty', '--quiet', '--homedir', str(home)]


class EmptyGnupgHome:
    """A throwaway, empty GnuPG home in the state directory.

    Encryption and key inspection need no secret key, so they never touch an
    operator keyring or agent: only the recipient files decide who can decrypt.
    """

    def __init__(self, cfg: Config) -> None:
        cfg.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = tempfile.mkdtemp(prefix='.gnupg-', dir=cfg.state_dir)

    def __enter__(self) -> str:
        return self.path

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        subprocess.run(['gpgconf', '--homedir', self.path, '--kill', 'all'],
                       capture_output=True, check=False, timeout=60)
        shutil.rmtree(self.path, ignore_errors=True)


def recipient_fingerprints(cfg: Config) -> list[str]:
    fprs: list[str] = []
    now = int(time.time())
    for f in cfg.recipient_files:
        try:
            with EmptyGnupgHome(cfg) as home:
                out = subprocess.run(gpg_cmd(home) + ['--with-colons', '--show-keys', str(f)],
                                     capture_output=True, check=True, timeout=60).stdout.decode()
        except (OSError, subprocess.SubprocessError):
            raise BackupError('a recipient public key file is unreadable')
        records = [line.split(':') for line in out.splitlines()]
        require(not any(r[0] in ('sec', 'ssb') for r in records), 'a recipient file holds a secret key')
        require(any(r[0] == 'pub' for r in records), 'a recipient file holds no public key')
        for r in records:
            if r[0] in ('pub', 'sub'):
                require(r[1] not in ('r', 'e', 'd') and (not r[6] or int(r[6]) > now),
                        'a recipient key is revoked or expired')
        primary = False
        for r in records:
            if r[0] == 'pub':
                primary = True
            elif r[0] == 'sub':
                primary = False
            elif r[0] == 'fpr' and primary:
                fprs.append(r[9])
                primary = False
    return fprs


class GpgEncrypt:
    """``gpg --encrypt`` to every recipient file, writing ciphertext to ``fd``."""

    def __init__(self, cfg: Config, fd: int) -> None:
        self.home = EmptyGnupgHome(cfg)
        cmd = gpg_cmd(self.home.path) + ['--trust-model', 'always', '--compress-algo', 'none']
        for f in cfg.recipient_files:
            cmd += ['--recipient-file', str(f)]
        try:
            self.proc = subprocess.Popen(cmd + ['--encrypt'], stdin=subprocess.PIPE, stdout=fd,
                                         stderr=subprocess.DEVNULL)
        except BaseException:
            self.home.close()
            raise

    def close(self) -> int:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except BrokenPipeError:
            pass
        try:
            return self.proc.wait(timeout=GPG_TIMEOUT)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
            return -1
        finally:
            self.home.close()


def gpg_decrypt(home: Path, fd: int) -> subprocess.Popen:
    return subprocess.Popen(gpg_cmd(home) + ['--pinentry-mode', 'error', '--decrypt'],
                            stdin=fd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


# --------------------------------------------------------------------------- archive

def write_archive(cfg: Config, sink: BinaryIO, stage: Path | None) -> dict[str, Any]:
    """Stream the agent volume as tar.gz into ``sink``; return the manifest."""
    entries: list[dict[str, Any]] = []
    counts = {'files': 0, 'links': 0, 'databases': 0, 'changed_during_read': 0, 'bytes': 0}
    gz = HashingGzipWriter(sink)
    staged = 0
    with tarfile.open(fileobj=gz, mode='w|', format=tarfile.PAX_FORMAT) as tar:
        for label, root in cfg.roots.items():
            require(root.is_dir() and not root.is_symlink(), f'volume root {label} is missing')
            for rel, path, st in walk(root, cfg.exclude.get(label, []), cfg.skip_names):
                if sqlite_sidecar(path):
                    continue  # the snapshot already holds the WAL's rows
                arc = f'{label}/{rel}'
                info = tarfile.TarInfo(arc)
                info.mtime, info.mode = int(st.st_mtime), stat.S_IMODE(st.st_mode)
                info.uid, info.gid = st.st_uid, st.st_gid
                if stat.S_ISLNK(st.st_mode):
                    try:
                        target = os.readlink(path)
                    except FileNotFoundError:
                        continue
                    info.type, info.linkname = tarfile.SYMTYPE, target
                    tar.addfile(info)
                    entries.append({'path': arc, 'kind': 'link', 'target': target})
                    counts['links'] += 1
                    continue
                if st.st_size >= 512 and is_sqlite(path):
                    try:
                        if stage is not None and cfg.stage_over is not None and st.st_size >= cfg.stage_over:
                            staged += 1
                            entry = _add_staged_db(cfg, tar, info, path, st, stage, staged)
                        else:
                            tables, data = snapshot_sqlite(path, st)
                            assert data is not None
                            info.size = len(data)
                            tar.addfile(info, io.BytesIO(data))
                            entry = {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                                     'tables': tables}
                            del data
                    except (subprocess.TimeoutExpired, OSError, sqlite3.Error):
                        raise BackupError(f'database snapshot failed ({arc})')
                    except BackupError as exc:
                        raise BackupError(f'{exc} ({arc})')
                    entries.append({'path': arc, 'kind': 'db', **entry})
                    counts['databases'] += 1
                    counts['bytes'] += entry['size']
                    continue
                try:
                    fh = open(path, 'rb')
                except FileNotFoundError:
                    continue
                with fh:
                    size = os.fstat(fh.fileno()).st_size
                    info.size = size
                    lf = LimitedFile(fh, size)
                    tar.addfile(info, io.BufferedReader(lf, CHUNK))
                    changed = lf.short or fh.read(1) != b''
                entries.append({'path': arc, 'kind': 'file', 'size': size, 'sha256': lf.sha.hexdigest()})
                counts['files'] += 1
                counts['bytes'] += size
                counts['changed_during_read'] += int(changed)
        manifest = {'schema': 1, 'name': cfg.name, 'created': cfg.now().strftime(STAMP_FORMAT),
                    'roots': sorted(cfg.roots), 'counts': counts, 'entries': entries}
        blob = json.dumps(manifest, sort_keys=True).encode()
        mi = tarfile.TarInfo('MANIFEST.json')
        mi.size, mi.mtime, mi.mode = len(blob), int(time.time()), 0o600
        tar.addfile(mi, io.BytesIO(blob))
    gz.finish()
    manifest['stream_sha256'] = gz.sha.hexdigest()
    return manifest


def _add_staged_db(cfg: Config, tar: tarfile.TarFile, info: tarfile.TarInfo, path: Path,
                   st: os.stat_result, stage: Path, n: int) -> dict[str, Any]:
    """Snapshot a large database to a file on the live database's own filesystem, archive it, delete it."""
    require(os.stat(stage).st_dev == st.st_dev, 'stage_dir is not on the live database filesystem')
    vfs = os.statvfs(stage)
    require(vfs.f_bavail * vfs.f_frsize >= st.st_size * 12 // 10, 'not enough space to stage a snapshot')
    run = stage / f'run-{os.getpid()}-{n}'
    os.mkdir(run, 0o700)
    try:
        if _owner_kwargs(st):
            os.chown(run, st.st_uid, st.st_gid)
        out = run / 'snapshot.db'
        tables, _ = snapshot_sqlite(path, st, out=out)
        with open(out, 'rb') as fh:
            size = os.fstat(fh.fileno()).st_size
            info.size = size
            lf = LimitedFile(fh, size)
            tar.addfile(info, io.BufferedReader(lf, CHUNK))
            require(not lf.short and fh.read(1) == b'', 'staged snapshot changed while archiving')
        return {'size': size, 'sha256': lf.sha.hexdigest(), 'tables': tables, 'staged': True}
    finally:
        shutil.rmtree(run, ignore_errors=True)


def clear_stage(stage: Path) -> None:
    """Remove leftovers of a killed run. Called under the agent's lock."""
    stage.mkdir(mode=0o700, parents=True, exist_ok=True)
    st = os.lstat(stage)
    require(stat.S_ISDIR(st.st_mode), 'stage_dir is not a directory')
    for child in os.listdir(stage):
        p = stage / child
        if p.is_dir() and not p.is_symlink():
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)
    require(not os.listdir(stage), 'stage_dir leftovers could not be removed')


def read_archive(src: BinaryIO, on_member: Callable[[tarfile.TarInfo, BinaryIO | None], None]) -> str:
    """Decompress and walk a tar.gz stream; returns the compressed stream's sha256."""
    hr = HashingReader(src)
    import gzip
    with gzip.GzipFile(fileobj=io.BufferedReader(hr, CHUNK), mode='rb') as gz:
        with tarfile.open(fileobj=gz, mode='r|') as tar:
            for m in tar:
                on_member(m, tar.extractfile(m) if m.isreg() else None)
        while gz.read(CHUNK):
            pass
    while hr.read(CHUNK):
        pass
    return hr.sha.hexdigest()


def verify_stream(src: BinaryIO, manifest: dict[str, Any]) -> int:
    """Check a decrypted stream against the manifest written during the same run."""
    expected = {e['path']: e for e in manifest['entries']}
    seen: set[str] = set()
    found = False

    def check(m: tarfile.TarInfo, fh: BinaryIO | None) -> None:
        nonlocal found
        if m.name == 'MANIFEST.json':
            require(fh is not None, 'unexpected manifest member')
            inner = json.loads(fh.read())  # type: ignore[union-attr]
            require(inner['entries'] == manifest['entries'], 'manifest mismatch after decrypt')
            found = True
            return
        e = expected.get(m.name)
        require(e is not None and m.name not in seen, 'unexpected member after decrypt')
        seen.add(m.name)
        if m.issym():
            require(e['kind'] == 'link' and e['target'] == m.linkname, 'link mismatch after decrypt')
            return
        require(fh is not None, 'unexpected non-file member')
        h = hashlib.sha256()
        for chunk in iter(lambda: fh.read(CHUNK), b''):  # type: ignore[union-attr]
            h.update(chunk)
        require(h.hexdigest() == e['sha256'] and m.size == e['size'], 'member hash mismatch after decrypt')

    sha = read_archive(src, check)
    require(found and seen == set(expected), 'member set mismatch after decrypt')
    require(sha == manifest['stream_sha256'], 'decrypted stream hash mismatch')
    return len(seen)


# --------------------------------------------------------------------------- destination

def archive_name(cfg: Config, when: dt.datetime) -> str:
    return f'{cfg.name}-volume-{when.strftime(STAMP_FORMAT)}.tar.gz.gpg'


def parse_stamp(name: str, agent: str) -> dt.datetime | None:
    m = re.fullmatch(re.escape(agent) + r'-volume-(\d{8}T\d{6}Z)\.tar\.gz\.gpg', name)
    if not m:
        return None
    return dt.datetime.strptime(m.group(1), STAMP_FORMAT).replace(tzinfo=dt.timezone.utc)


def open_dest(cfg: Config, create: bool) -> int:
    dest = cfg.destination
    if cfg.destination_mount is not None:
        require(os.path.ismount(cfg.destination_mount), 'destination_mount is not mounted')
    require(dest.parent.is_dir(), 'destination parent is not available (is it mounted?)')
    require(not any(p.is_symlink() for p in [dest, *dest.parents] if p.exists()),
            'destination path contains a symlink')
    if create:
        try:
            os.mkdir(dest, 0o700)
        except FileExistsError:
            pass
    require(dest.is_dir(), 'destination is not available')
    return os.open(dest, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


def published(cfg: Config, dfd: int) -> list[str]:
    return sorted(n for n in os.listdir(dfd) if parse_stamp(n, cfg.name))


def retention_keep(stamps: Iterable[dt.datetime], daily: int, weekly: int) -> set[dt.datetime]:
    """Newest copy per day for the newest ``daily`` days, plus newest per ISO week for ``weekly`` weeks."""
    keep: set[dt.datetime] = set()
    days: list[dt.date] = []
    weeks: list[tuple[int, int]] = []
    for s in sorted(set(stamps), reverse=True):
        if s.date() not in days and len(days) < daily:
            days.append(s.date())
            keep.add(s)
        w = tuple(s.isocalendar())[:2]
        if w not in weeks and len(weeks) < weekly:
            weeks.append(w)  # type: ignore[arg-type]
            keep.add(s)
    return keep


def apply_retention(cfg: Config, dfd: int, newest: str) -> list[str]:
    names = os.listdir(dfd)
    stamps = {n: s for n in names if (s := parse_stamp(n, cfg.name))}
    keep = retention_keep(stamps.values(), cfg.daily, cfg.weekly)
    removed = []
    for n, s in stamps.items():
        if n == newest or s in keep:
            continue
        for victim in (n, n + '.sha256'):
            try:
                os.unlink(victim, dir_fd=dfd)
            except FileNotFoundError:
                pass
        removed.append(n)
    cutoff = time.time() - 86400
    for n in names:
        if n.startswith('.') and n.endswith('.incomplete') and parse_stamp(n[1:-len('.incomplete')], cfg.name):
            try:
                if os.stat(n, dir_fd=dfd, follow_symlinks=False).st_mtime < cutoff:
                    os.unlink(n, dir_fd=dfd)
            except FileNotFoundError:
                pass
    return sorted(removed)


def check_space(cfg: Config, dfd: int) -> None:
    vfs = os.fstatvfs(dfd)
    free = vfs.f_bavail * vfs.f_frsize
    last = max((os.stat(n, dir_fd=dfd, follow_symlinks=False).st_size for n in published(cfg, dfd)), default=0)
    require(free >= max(cfg.min_free, 2 * last), 'not enough free space at the destination')


# --------------------------------------------------------------------------- state

class Lock:
    def __init__(self, cfg: Config) -> None:
        cfg.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.fh = open(cfg.state_dir / '.lock', 'w')

    def __enter__(self) -> 'Lock':
        try:
            fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.fh.close()
            raise
        return self

    def __exit__(self, *exc: Any) -> None:
        self.fh.close()


def write_status(cfg: Config, status: dict[str, Any], name: str = 'status.json') -> None:
    cfg.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = cfg.state_dir / f'.{name}.tmp'
    fd = os.open(tmp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as fh:
        json.dump(status, fh, indent=2, sort_keys=True)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, cfg.state_dir / name)


def stamp(cfg: Config) -> str:
    return cfg.now().strftime('%Y-%m-%dT%H:%M:%SZ')


# --------------------------------------------------------------------------- backup

def backup(cfg: Config) -> dict[str, Any]:
    started = cfg.now()
    status: dict[str, Any] = {'name': cfg.name, 'command': 'backup', 'result': 'running', 'started': stamp(cfg)}
    with Lock(cfg):
        write_status(cfg, status)  # a run killed mid-way stays 'running', never a stale success
        dfd = cipher = -1
        hidden: str | None = None
        try:
            fprs = recipient_fingerprints(cfg)
            if cfg.recipient_fingerprints:
                require(sorted(fprs) == sorted(cfg.recipient_fingerprints),
                        'recipient keys do not match recipient_fingerprints')
            if cfg.stage_dir is not None:
                clear_stage(cfg.stage_dir)
            dfd = open_dest(cfg, create=True)
            check_space(cfg, dfd)
            name = archive_name(cfg, started)
            require(name not in os.listdir(dfd), 'archive name already exists')
            hidden = '.' + name + '.incomplete'
            cipher = os.open(hidden, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
            enc = GpgEncrypt(cfg, cipher)
            broken = False
            try:
                assert enc.proc.stdin is not None
                manifest = write_archive(cfg, enc.proc.stdin, cfg.stage_dir)  # type: ignore[arg-type]
            except BrokenPipeError:
                broken = True  # gpg exited early; its exit status says why
            finally:
                rc = enc.close()
            require(rc == 0 and not broken, 'encryption failed')
            os.fsync(cipher)
            c_sha, c_len = sha_fd(cipher)
            rd = os.open(hidden, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
            try:
                require(sha_fd(rd) == (c_sha, c_len), 'destination readback mismatch')
                verified = None
                if cfg.check_gnupg_home is not None:
                    os.lseek(rd, 0, os.SEEK_SET)
                    dec = gpg_decrypt(cfg.check_gnupg_home, rd)
                    try:
                        verified = verify_stream(dec.stdout, manifest)  # type: ignore[arg-type]
                    finally:
                        dec.stdout.close()  # type: ignore[union-attr]
                        drc = dec.wait(timeout=GPG_TIMEOUT)
                    require(drc == 0, 'decryption check failed')
            finally:
                os.close(rd)
            os.link(hidden, name, src_dir_fd=dfd, dst_dir_fd=dfd, follow_symlinks=False)
            os.unlink(hidden, dir_fd=dfd)
            hidden = None
            side = os.open(name + '.sha256', os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
            os.write(side, f'{c_sha}  {name}\n'.encode())
            os.fsync(side)
            os.close(side)
            os.fsync(dfd)
            removed = apply_retention(cfg, dfd, name)
            status.update({'result': 'ok', 'archive': name, 'ciphertext_sha256': c_sha, 'ciphertext_bytes': c_len,
                           'counts': manifest['counts'], 'recipients': sorted(fprs),
                           'verified_members': verified, 'retention_removed': removed,
                           'retained': published(cfg, dfd), 'finished': stamp(cfg)})
            return status
        except BaseException as exc:
            reason = str(exc) if isinstance(exc, BackupError) else type(exc).__name__
            status.update({'result': 'failed', 'reason': reason[:300], 'finished': stamp(cfg)})
            raise
        finally:
            if cfg.stage_dir is not None:
                try:
                    clear_stage(cfg.stage_dir)
                except (OSError, BackupError):
                    pass
            if hidden is not None and dfd >= 0:
                try:
                    os.unlink(hidden, dir_fd=dfd)
                except FileNotFoundError:
                    pass
            for fd in (cipher, dfd):
                if fd >= 0:
                    os.close(fd)
            write_status(cfg, status)


# --------------------------------------------------------------------------- restore check

def restore_check(cfg: Config, archive: str | None = None, scratch: Path | None = None,
                  keep: bool = False, gnupg_home: Path | None = None) -> dict[str, Any]:
    home = gnupg_home or cfg.check_gnupg_home
    if home is None:
        raise ConfigError('restore-check needs check_gnupg_home or --gnupg-home')
    target = Path(os.path.normpath(scratch or cfg.scratch_dir))
    if _within(target, cfg.destination) or any(_within(target, r) or _within(r, target) for r in cfg.roots.values()):
        raise ConfigError('scratch directory must be outside the destination and the volume roots')
    report: dict[str, Any] = {'name': cfg.name, 'command': 'restore-check', 'result': 'fail', 'started': stamp(cfg)}
    with Lock(cfg):
        created = False
        rd = -1
        try:
            dfd = open_dest(cfg, create=False)
            try:
                names = published(cfg, dfd)
                require(names, 'no published backup to check')
                name = archive or names[-1]
                require(name in names, 'archive not found')
                report['archive'] = name
                with open(os.open(name + '.sha256', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd), 'rb') as fh:
                    expect = fh.read(4096).decode().split()[0]
                rd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
            finally:
                os.close(dfd)
            require(sha_fd(rd)[0] == expect, 'ciphertext checksum mismatch')
            os.lseek(rd, 0, os.SEEK_SET)
            require(not target.exists() or (target.is_dir() and not target.is_symlink() and not any(target.iterdir())),
                    'scratch directory is not empty')
            target.mkdir(mode=0o700, parents=True, exist_ok=True)
            created = True
            os.chmod(target, 0o700)
            real = target.resolve()
            manifest: dict[str, Any] = {}
            hashes: dict[str, str] = {}
            links: dict[str, str] = {}

            def extract(m: tarfile.TarInfo, fh: BinaryIO | None) -> None:
                if m.name == 'MANIFEST.json':
                    require(fh is not None and not manifest, 'unexpected manifest member')
                    manifest.update(json.loads(fh.read()))  # type: ignore[union-attr]
                    return
                parts = m.name.split('/')
                require(not m.name.startswith('/') and '..' not in parts and '' not in parts,
                        'member escapes the scratch directory')
                require(m.name not in hashes and m.name not in links, 'duplicate member')
                out = real / m.name
                out.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                require(_within(out.parent.resolve(), real), 'member escapes the scratch directory')
                if m.issym():
                    links[m.name] = m.linkname  # recorded and compared, never materialised or followed
                    return
                require(fh is not None and m.isreg(), 'unexpected non-file member')
                h = hashlib.sha256()
                fd = os.open(out, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as w:
                    for chunk in iter(lambda: fh.read(CHUNK), b''):  # type: ignore[union-attr]
                        h.update(chunk)
                        w.write(chunk)
                hashes[m.name] = h.hexdigest()

            dec = gpg_decrypt(home, rd)
            unpacked = False
            try:
                read_archive(dec.stdout, extract)  # type: ignore[arg-type]
                unpacked = True
            except (tarfile.TarError, OSError, EOFError, zlib.error, ValueError):
                pass
            finally:
                dec.stdout.close()  # type: ignore[union-attr]
                drc = dec.wait(timeout=GPG_TIMEOUT)
            require(drc == 0, 'decryption failed (wrong key or tampered archive)')
            require(unpacked, 'archive could not be unpacked')
            entries = manifest.get('entries')
            require(isinstance(entries, list) and manifest.get('name') == cfg.name, 'manifest missing or foreign')
            bad = [e['path'] for e in entries if e['kind'] != 'link' and hashes.get(e['path']) != e['sha256']]
            bad += [e['path'] for e in entries if e['kind'] == 'link' and links.get(e['path']) != e['target']]
            require(not bad and len(hashes) + len(links) == len(entries), 'restored file hash mismatch')
            dbs, tables = [], 0
            for e in entries:
                if e['kind'] != 'db':
                    continue
                # immutable: the scratch copy has no -wal/-shm and nothing else writes it.
                con = sqlite3.connect(f'file:{real / e["path"]}?mode=ro&immutable=1', uri=True)
                try:
                    row = con.execute('PRAGMA integrity_check').fetchone()
                    require(row is not None and row[0] == 'ok', f'integrity_check failed ({e["path"]})')
                    got = table_counts(con)
                finally:
                    con.close()
                require(got == e['tables'], f'row counts differ from the backup ({e["path"]})')
                dbs.append({'path': e['path'], 'integrity': 'ok', 'tables': len(got), 'rows': sum(got.values())})
                tables += len(got)
            report.update({'result': 'pass', 'files': len(hashes), 'links': len(links), 'databases': dbs,
                           'tables_compared': tables, 'backup_created': manifest.get('created')})
            return report
        except BackupError as exc:
            report['reason'] = str(exc)[:300]
            return report
        finally:
            if rd >= 0:
                os.close(rd)
            if created and not (keep and report['result'] == 'pass'):
                shutil.rmtree(target, ignore_errors=True)
            report['finished'] = stamp(cfg)
            report['scratch_removed'] = not target.exists()
            try:
                write_status(cfg, report, 'restore-check.json')
            except OSError:
                pass


# --------------------------------------------------------------------------- cli

def main(argv: list[str] | None = None, *, now: Callable[[], dt.datetime] = utcnow) -> int:
    parser = argparse.ArgumentParser(description='Encrypted per-agent volume backup with a restore check.')
    sub = parser.add_subparsers(dest='command', required=True)
    b = sub.add_parser('backup', help='take, encrypt, verify and publish one backup, then apply retention')
    b.add_argument('--config', required=True, type=Path)
    r = sub.add_parser('restore-check', help='decrypt a published backup into scratch and verify it')
    r.add_argument('--config', required=True, type=Path)
    r.add_argument('--archive', help='archive file name (default: newest)')
    r.add_argument('--scratch', type=Path, help='empty scratch directory (default: scratch_dir from the config)')
    r.add_argument('--gnupg-home', type=Path, help='GnuPG home with the check key (default: check_gnupg_home)')
    r.add_argument('--keep', action='store_true', help='keep the decrypted copy after a pass')
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return EXIT_CONFIG if exc.code else EXIT_OK
    os.umask(0o077)
    try:
        cfg = load_config(args.config, now=now)
        if not cfg.enabled:
            print(json.dumps({'name': cfg.name, 'result': 'disabled',
                              'reason': 'set "enabled": true in the config to run backups'}))
            return EXIT_DISABLED
        if args.command == 'backup':
            out = backup(cfg)
        else:
            out = restore_check(cfg, args.archive, args.scratch, args.keep, args.gnupg_home)
    except ConfigError as exc:
        print(json.dumps({'result': 'config-error', 'reason': str(exc)}))
        return EXIT_CONFIG
    except BlockingIOError:
        print(json.dumps({'result': 'locked', 'reason': 'another run for this agent holds the lock'}))
        return EXIT_LOCKED
    except BackupError as exc:
        print(json.dumps({'result': 'failed', 'reason': str(exc)}))
        return EXIT_FAILED
    except (OSError, subprocess.SubprocessError) as exc:
        print(json.dumps({'result': 'failed', 'reason': type(exc).__name__}))
        return EXIT_FAILED
    print(json.dumps(out, sort_keys=True))
    if args.command == 'restore-check':
        return EXIT_OK if out['result'] == 'pass' else EXIT_FAILED
    return EXIT_OK


if __name__ == '__main__':
    raise SystemExit(main())
