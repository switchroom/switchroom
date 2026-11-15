"""Encrypted volume backup and restore check, end to end on a synthetic agent volume.

Needs GnuPG. Skipped locally when ``gpg`` is missing; in CI a missing ``gpg``
fails the suite instead of skipping it.
"""
from __future__ import annotations

import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts' / 'switchroom-volume-backup.py'
spec = importlib.util.spec_from_file_location('switchroom_volume_backup', SCRIPT)
svb = importlib.util.module_from_spec(spec)
sys.modules['switchroom_volume_backup'] = svb
spec.loader.exec_module(svb)

MARKER = 'SYNTHETIC-PLAINTEXT-MARKER-4f1c'
HAVE_GPG = shutil.which('gpg') is not None and shutil.which('gpgconf') is not None
if not HAVE_GPG and os.environ.get('CI'):
    raise RuntimeError('gpg is required for the volume backup tests in CI')


def fixed_clock(*stamps: str):
    values = iter(dt.datetime.strptime(s, '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc) for s in stamps)
    last = [None]

    def now():
        try:
            last[0] = next(values)
        except StopIteration:
            pass
        return last[0]
    return now


@unittest.skipUnless(HAVE_GPG, 'gpg not installed')
class VolumeBackupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = Path(tempfile.mkdtemp(prefix='svb-keys-'))
        cls.home = cls.keys / 'check-home'
        cls.home.mkdir(mode=0o700)
        gpg = ['gpg', '--batch', '--no-tty', '--homedir', str(cls.home)]
        subprocess.run(gpg + ['--passphrase', '', '--pinentry-mode', 'loopback', '--quick-gen-key',
                              'Synthetic backup check key', 'future-default', 'default', 'never'],
                       check=True, capture_output=True)
        out = subprocess.run(gpg + ['--with-colons', '--list-keys'], check=True, capture_output=True, text=True).stdout
        cls.fpr = next(line.split(':')[9] for line in out.splitlines() if line.startswith('fpr:'))
        cls.pub = cls.keys / 'recipient-public.asc'
        cls.pub.write_bytes(subprocess.run(gpg + ['--armor', '--export', cls.fpr], check=True,
                                           capture_output=True).stdout)
        cls.other_home = cls.keys / 'other-home'
        cls.other_home.mkdir(mode=0o700)
        subprocess.run(['gpg', '--batch', '--no-tty', '--homedir', str(cls.other_home), '--passphrase', '',
                        '--pinentry-mode', 'loopback', '--quick-gen-key', 'Unrelated synthetic key',
                        'future-default', 'default', 'never'], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        for home in (cls.home, cls.other_home):
            subprocess.run(['gpgconf', '--homedir', str(home), '--kill', 'all'], capture_output=True)
        shutil.rmtree(cls.keys, ignore_errors=True)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='svb-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.live = self.tmp / 'live' / 'state'
        (self.live / 'memories').mkdir(parents=True)
        (self.live / 'cache' / 'pip').mkdir(parents=True)
        (self.live / 'memories' / 'notes.md').write_text(f'{MARKER} synthetic agent memory\n')
        (self.live / 'cache' / 'pip' / 'wheel.bin').write_text('rebuildable')
        os.symlink('memories/notes.md', self.live / 'latest-notes')
        self.db = self.live / 'state.db'
        con = sqlite3.connect(self.db)
        con.execute('PRAGMA journal_mode=WAL')
        con.execute('CREATE TABLE sessions (id INTEGER PRIMARY KEY, body TEXT)')
        con.execute('CREATE TABLE messages (id INTEGER PRIMARY KEY, session INTEGER, body TEXT)')
        con.executemany('INSERT INTO sessions(body) VALUES (?)', [(f'{MARKER} s{i}',) for i in range(25)])
        con.executemany('INSERT INTO messages(session, body) VALUES (?, ?)',
                        [(i % 25, f'{MARKER} m{i}') for i in range(200)])
        con.commit()
        con.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        # Rows that exist only in the WAL while a writer holds the database open.
        con.execute('PRAGMA wal_autocheckpoint=0')
        con.executemany('INSERT INTO messages(session, body) VALUES (?, ?)', [(1, f'{MARKER} wal{i}') for i in range(7)])
        con.commit()
        self.writer = con
        self.addCleanup(con.close)
        self.dest = self.tmp / 'backup-target' / 'agents' / 'example-agent'
        (self.tmp / 'backup-target' / 'agents').mkdir(parents=True)
        self.state = self.tmp / 'state'
        self.config = self.tmp / 'example-agent.json'
        self.write_config()

    def write_config(self, **overrides):
        raw = {
            'enabled': True,
            'name': 'example-agent',
            'roots': {'state': str(self.live)},
            'exclude': {'state': ['cache/*']},
            'destination': str(self.dest),
            'recipient_files': [str(self.pub)],
            'recipient_fingerprints': [self.fpr],
            'check_gnupg_home': str(self.home),
            'retention': {'daily': 2, 'weekly': 1},
            'state_dir': str(self.state),
            'min_free_bytes': 0,
        }
        raw.update(overrides)
        self.config.write_text(json.dumps(raw))

    def run_cli(self, *argv, clock=None):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = svb.main([*argv, '--config', str(self.config)], **({'now': clock} if clock else {}))
        lines = out.getvalue().strip().splitlines()
        return code, (json.loads(lines[-1]) if lines else {})

    def backup(self, stamp='20261101T020000Z'):
        return self.run_cli('backup', clock=fixed_clock(stamp, stamp, stamp, stamp))

    def assert_no_plaintext(self, directory):
        for path in directory.rglob('*'):
            if path.is_file():
                data = path.read_bytes()
                self.assertNotIn(MARKER.encode(), data, path.name)
                self.assertNotIn(svb.SQLITE_MAGIC, data, path.name)
                self.assertFalse(data.startswith(b'\x1f\x8b'), f'{path.name} is unencrypted gzip')

    # -------------------------------------------------------------- happy path

    def test_backup_encrypts_and_restore_check_passes(self):
        code, status = self.backup()
        self.assertEqual(code, 0, status)
        self.assertEqual(status['result'], 'ok')
        self.assertEqual(status['recipients'], [self.fpr])
        self.assertGreater(status['verified_members'], 0)
        name = 'example-agent-volume-20261101T020000Z.tar.gz.gpg'
        self.assertEqual(sorted(p.name for p in self.dest.iterdir()), [name, name + '.sha256'])
        self.assert_no_plaintext(self.dest)
        self.assertEqual(status['counts']['databases'], 1)

        scratch = self.tmp / 'scratch'
        code, report = self.run_cli('restore-check', '--scratch', str(scratch))
        self.assertEqual(code, 0, report)
        self.assertEqual(report['result'], 'pass')
        self.assertEqual(report['archive'], name)
        self.assertEqual(report['databases'], [{'path': 'state/state.db', 'integrity': 'ok', 'tables': 2,
                                                'rows': 25 + 200 + 7}])
        self.assertTrue(report['scratch_removed'])
        self.assertFalse(scratch.exists())
        self.assertEqual(json.loads((self.state / 'restore-check.json').read_text())['result'], 'pass')
        # No throwaway GnuPG homes, temp files or plaintext linger in the state directory.
        self.assertEqual(sorted(p.name for p in self.state.iterdir()), ['.lock', 'restore-check.json', 'status.json'])
        self.assert_no_plaintext(self.state)

    def test_snapshot_includes_wal_rows_and_skips_excluded_and_sidecars(self):
        self.assertTrue((self.live / 'state.db-wal').stat().st_size > 0)
        self.assertEqual(self.backup()[0], 0)
        scratch = self.tmp / 'retained'
        code, report = self.run_cli('restore-check', '--scratch', str(scratch), '--keep')
        self.assertEqual((code, report['result']), (0, 'pass'))
        self.addCleanup(shutil.rmtree, scratch, True)
        restored = scratch / 'state'
        self.assertEqual((restored / 'memories' / 'notes.md').read_text(), f'{MARKER} synthetic agent memory\n')
        self.assertFalse((restored / 'cache' / 'pip').exists())
        self.assertFalse((restored / 'state.db-wal').exists())
        self.assertFalse((restored / 'latest-notes').exists(), 'archive links are verified, never materialised')
        con = sqlite3.connect(restored / 'state.db')
        self.assertEqual(con.execute("SELECT count(*) FROM messages WHERE body LIKE '%wal%'").fetchone()[0], 7)
        con.close()

    def test_backup_without_check_key_still_publishes_ciphertext_only(self):
        self.write_config(check_gnupg_home=None)
        code, status = self.backup()
        self.assertEqual(code, 0, status)
        self.assertIsNone(status['verified_members'])
        self.assert_no_plaintext(self.dest)
        code, report = self.run_cli('restore-check', '--scratch', str(self.tmp / 's'), '--gnupg-home', str(self.home))
        self.assertEqual((code, report['result']), (0, 'pass'))

    # -------------------------------------------------------------- tampering

    def test_tampered_archive_fails_restore_check(self):
        self.assertEqual(self.backup()[0], 0)
        archive = next(self.dest.glob('*.gpg'))
        data = bytearray(archive.read_bytes())
        data[len(data) // 2] ^= 0x01
        archive.write_bytes(bytes(data))
        scratch = self.tmp / 'scratch'
        code, report = self.run_cli('restore-check', '--scratch', str(scratch))
        self.assertEqual(code, 1)
        self.assertEqual(report['result'], 'fail')
        self.assertIn('checksum', report['reason'])
        self.assertFalse(scratch.exists())

    def test_tampered_archive_with_matching_checksum_fails_decryption(self):
        self.assertEqual(self.backup()[0], 0)
        archive = next(self.dest.glob('*.gpg'))
        data = bytearray(archive.read_bytes())
        data[len(data) // 2] ^= 0x01
        archive.write_bytes(bytes(data))
        import hashlib
        Path(str(archive) + '.sha256').write_text(f'{hashlib.sha256(data).hexdigest()}  {archive.name}\n')
        scratch = self.tmp / 'scratch'
        code, report = self.run_cli('restore-check', '--scratch', str(scratch))
        self.assertEqual((code, report['result']), (1, 'fail'), report)
        self.assertFalse(scratch.exists(), 'partially decrypted plaintext must be removed')

    def test_row_count_mismatch_fails_restore_check(self):
        real = svb.snapshot_sqlite

        def inflated(*args, **kwargs):
            counts, data = real(*args, **kwargs)
            return {k: v + 1 for k, v in counts.items()}, data
        with mock.patch.object(svb, 'snapshot_sqlite', inflated):
            self.assertEqual(self.backup()[0], 0)
        code, report = self.run_cli('restore-check', '--scratch', str(self.tmp / 'scratch'))
        self.assertEqual((code, report['result']), (1, 'fail'))
        self.assertIn('row counts differ', report['reason'])
        self.assertFalse((self.tmp / 'scratch').exists())

    def test_wrong_check_key_fails(self):
        self.assertEqual(self.backup()[0], 0)
        code, report = self.run_cli('restore-check', '--scratch', str(self.tmp / 's'),
                                    '--gnupg-home', str(self.other_home))
        self.assertEqual((code, report['result']), (1, 'fail'))
        self.assertIn('decryption failed', report['reason'])

    # -------------------------------------------------------------- failure paths

    def test_disabled_by_default(self):
        self.write_config(enabled=False)
        self.assertEqual(self.backup()[0], svb.EXIT_DISABLED)
        raw = json.loads(self.config.read_text())
        del raw['enabled']
        self.config.write_text(json.dumps(raw))
        self.assertEqual(self.backup()[0], svb.EXIT_DISABLED)
        self.assertFalse(self.dest.exists())

    def test_shipped_example_config_is_disabled(self):
        example = json.loads((ROOT / 'examples' / 'volume-backup' / 'example-agent.json').read_text())
        self.assertIs(example['enabled'], False)
        svb.Config(example)  # parses

    def test_failed_encryption_leaves_nothing_at_destination(self):
        garbage = self.tmp / 'not-a-key.asc'
        garbage.write_text('this is not an OpenPGP key\n')
        self.write_config(recipient_files=[str(garbage)], recipient_fingerprints=[])
        with mock.patch.object(svb, 'recipient_fingerprints', return_value=[]):
            code, out = self.backup()
        self.assertEqual(code, 1)
        self.assertEqual(out['reason'], 'encryption failed')
        self.assertEqual(list(self.dest.iterdir()), [])
        self.assertEqual(json.loads((self.state / 'status.json').read_text())['result'], 'failed')

    def test_fingerprint_mismatch_refuses(self):
        self.write_config(recipient_fingerprints=['0' * 40])
        code, out = self.backup()
        self.assertEqual(code, 1)
        self.assertIn('recipient_fingerprints', out['reason'])
        self.assertFalse(self.dest.exists())

    def test_secret_key_file_refused_as_recipient(self):
        secret = self.tmp / 'secret.asc'
        secret.write_bytes(subprocess.run(['gpg', '--batch', '--homedir', str(self.home), '--pinentry-mode',
                                           'loopback', '--passphrase', '', '--armor', '--export-secret-keys',
                                           self.fpr], check=True, capture_output=True).stdout)
        self.write_config(recipient_files=[str(secret)], recipient_fingerprints=[])
        code, out = self.backup()
        self.assertEqual(code, 1)
        self.assertIn('secret key', out['reason'])

    def test_unreadable_database_fails_the_run(self):
        (self.live / 'broken.db').write_bytes(svb.SQLITE_MAGIC + b'\0' * 2048)
        code, out = self.backup()
        self.assertEqual(code, 1)
        self.assertIn('database snapshot failed', out['reason'])
        self.assertEqual([p.name for p in self.dest.iterdir()], [])

    def test_config_errors_exit_2(self):
        self.write_config(destination=str(self.live / 'backups'))
        self.assertEqual(self.backup()[0], svb.EXIT_CONFIG)
        self.write_config(retention={'daily': 0})
        self.assertEqual(self.backup()[0], svb.EXIT_CONFIG)
        self.write_config(scratch_dir=str(self.dest / 'scratch'))
        self.assertEqual(self.backup()[0], svb.EXIT_CONFIG)
        self.config.write_text('{not json')
        self.assertEqual(self.backup()[0], svb.EXIT_CONFIG)

    def test_restore_check_refuses_non_empty_scratch(self):
        self.assertEqual(self.backup()[0], 0)
        scratch = self.tmp / 'scratch'
        scratch.mkdir()
        (scratch / 'keep-me').write_text('operator file')
        code, report = self.run_cli('restore-check', '--scratch', str(scratch))
        self.assertEqual((code, report['result']), (1, 'fail'))
        self.assertTrue((scratch / 'keep-me').exists())

    def test_lock_contention_exits_4(self):
        cfg = svb.load_config(self.config)
        with svb.Lock(cfg):
            self.assertEqual(self.backup()[0], svb.EXIT_LOCKED)

    def test_destination_mount_required_when_configured(self):
        self.write_config(destination_mount=str(self.tmp / 'backup-target'))
        code, out = self.backup()
        self.assertEqual(code, 1)
        self.assertIn('not mounted', out['reason'])

    # -------------------------------------------------------------- retention

    def test_retention_prunes_only_this_agents_archives(self):
        for stamp in ('20261028T020000Z', '20261030T020000Z', '20261031T020000Z'):
            self.assertEqual(self.backup(stamp)[0], 0)
        foreign = self.dest / 'other-agent-volume-20261001T020000Z.tar.gz.gpg'
        foreign.write_bytes(b'not ours')
        code, status = self.backup('20261101T020000Z')
        self.assertEqual(code, 0, status)
        # daily=2 keeps 11-01 and 10-31; weekly=1 keeps the newest of ISO week 44 (11-01).
        self.assertEqual(status['retained'], ['example-agent-volume-20261031T020000Z.tar.gz.gpg',
                                              'example-agent-volume-20261101T020000Z.tar.gz.gpg'])
        self.assertEqual(status['retention_removed'], ['example-agent-volume-20261030T020000Z.tar.gz.gpg'])
        self.assertEqual(sorted(p.name for p in self.dest.iterdir() if p.name.startswith('example-agent')),
                         ['example-agent-volume-20261031T020000Z.tar.gz.gpg',
                          'example-agent-volume-20261031T020000Z.tar.gz.gpg.sha256',
                          'example-agent-volume-20261101T020000Z.tar.gz.gpg',
                          'example-agent-volume-20261101T020000Z.tar.gz.gpg.sha256'])
        self.assertTrue(foreign.exists())
        self.assertFalse((self.dest / 'example-agent-volume-20261028T020000Z.tar.gz.gpg.sha256').exists())

    def test_large_database_staged_snapshot_is_removed_and_restore_passes(self):
        stage = self.tmp / 'stage'
        self.write_config(stage_dir=str(stage), stage_over_bytes=1)
        code, status = self.backup()
        self.assertEqual(code, 0, status)
        self.assertEqual(os.listdir(stage), [])
        self.assert_no_plaintext(self.dest)
        code, report = self.run_cli('restore-check', '--scratch', str(self.tmp / 'scratch'))
        self.assertEqual((code, report['result']), (0, 'pass'), report)
        self.assertEqual(report['databases'][0]['rows'], 25 + 200 + 7)

    def test_retention_keep_policy(self):
        utc = dt.timezone.utc
        stamps = [dt.datetime(2026, 10, d, 2, tzinfo=utc) for d in range(1, 32)]
        keep = svb.retention_keep(stamps, daily=7, weekly=4)
        # Daily: 25-31 Oct. Weekly (ISO): newest of weeks 44 and 43 are already daily; add 18 and 11 Oct.
        self.assertEqual(sorted(s.day for s in keep), [11, 18, 25, 26, 27, 28, 29, 30, 31])


if __name__ == '__main__':
    unittest.main()
