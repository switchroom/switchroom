"""Container-start cleanup of a Bot Screen Chromium lock left by a recreated container."""
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/bot-screen-stale-lock.py'


def _load():
    spec = importlib.util.spec_from_file_location('bot_screen_stale_lock', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StaleLockTests(unittest.TestCase):
    def setUp(self):
        self.m = _load()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / 'data'
        self.profile = self.home / 'bot-desktop' / 'browser-profile'
        self.profile.mkdir(parents=True)
        self.locks = Path(self.tmp.name) / 'locks'
        root = self.locks / 'browser-shared-profiles'
        root.mkdir(parents=True, mode=0o700)
        root.chmod(0o700)
        self.state = root / self.m.profile_digest(self.profile)[:32]
        self.state.mkdir(mode=0o700)
        self.state.chmod(0o700)
        self.host = socket.gethostname()

    def _lock(self, pid, host=None):
        (self.profile / 'SingletonLock').symlink_to(f'{host or self.host}-{pid}')
        (self.profile / 'SingletonCookie').symlink_to('1234567890')
        (self.profile / 'SingletonSocket').symlink_to('/nonexistent/scratch/SingletonSocket')

    def _record(self, pid, ns='111:old-boot', udd=None):
        stem = f'{self.m.profile_digest(self.profile)[:16]}-{pid}-n0123456789ab'
        record = self.state / f'{stem}.json'
        record.write_text(json.dumps({'pid': pid, 'user_data_dir': str(udd or self.profile), 'ns': ns,
                                      'devtools': '/devtools/browser/old'}))
        lease = self.state / f'{stem}@42-n0123456789ab.lease'
        lease.write_text('{}')
        return record, lease

    def _dead_pid(self):
        proc = subprocess.Popen([sys.executable, '-c', 'pass'])
        proc.wait()
        return proc.pid

    def _run(self):
        return self.m.clear_profile(self.profile, self.locks)

    def _singletons(self):
        return sorted(p.name for p in self.profile.iterdir() if p.name.startswith('Singleton'))

    def test_stale_lock_and_old_namespace_record_are_removed(self):
        pid = self._dead_pid()
        self._lock(pid)
        record, lease = self._record(pid)
        self.assertTrue(self._run())
        self.assertEqual(self._singletons(), [])
        self.assertFalse(record.exists())
        self.assertFalse(lease.exists())

    def test_lock_pid_reused_by_unrelated_live_process_is_stale(self):
        # The new namespace reuses low pids: a live process whose argv does not name the profile is not its browser.
        self._lock(os.getpid())
        self.assertTrue(self._run())
        self.assertEqual(self._singletons(), [])

    def test_live_browser_on_profile_keeps_lock_and_records(self):
        proc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)',
                                 f'--user-data-dir={self.profile}'])
        self.addCleanup(proc.wait)
        self.addCleanup(proc.kill)
        time.sleep(0.2)
        self._lock(proc.pid)
        record, lease = self._record(proc.pid)
        self.assertFalse(self._run())
        self.assertEqual(self._singletons(), ['SingletonCookie', 'SingletonLock', 'SingletonSocket'])
        self.assertTrue(record.exists())
        self.assertTrue(lease.exists())

    def test_any_live_process_naming_profile_keeps_lock(self):
        proc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)',
                                 f'--user-data-dir={self.profile}'])
        self.addCleanup(proc.wait)
        self.addCleanup(proc.kill)
        time.sleep(0.2)
        self._lock(self._dead_pid())
        self.assertFalse(self._run())
        self.assertIn('SingletonLock', self._singletons())

    def test_lock_from_another_hostname_is_left_alone(self):
        self._lock(self._dead_pid(), host='some-other-container')
        self.assertFalse(self._run())
        self.assertIn('SingletonLock', self._singletons())

    def test_listening_devtools_endpoint_keeps_lock(self):
        listener = socket.socket()
        self.addCleanup(listener.close)
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        (self.profile / 'DevToolsActivePort').write_text(f'{listener.getsockname()[1]}\n/devtools/browser/x\n')
        self._lock(self._dead_pid())
        self.assertFalse(self._run())
        self.assertIn('SingletonLock', self._singletons())

    def test_this_namespace_records_are_kept(self):
        pid = self._dead_pid()
        self._lock(pid)
        record, _ = self._record(pid, ns=self.m.ns_identity())
        other_profile, _ = self._record(pid + 1, udd=self.home / 'elsewhere')
        self.assertTrue(self._run())
        self.assertTrue(record.exists())
        self.assertTrue(other_profile.exists())

    def test_leftover_old_namespace_record_without_lock_is_cleared(self):
        # A pid reused by a later crash in this namespace would otherwise match the old record and wedge again.
        record, lease = self._record(self._dead_pid())
        self.assertTrue(self._run())
        self.assertFalse(record.exists())
        self.assertFalse(lease.exists())

    def test_held_records_lock_keeps_records(self):
        import fcntl
        pid = self._dead_pid()
        self._lock(pid)
        record, _ = self._record(pid)
        with open(self.state / '.holders.lock', 'a+') as fd:
            fcntl.flock(fd, fcntl.LOCK_EX)
            self.assertFalse(self._run())
        self.assertTrue(record.exists())
        self.assertIn('SingletonLock', self._singletons())

    def test_non_symlink_singleton_is_not_deleted(self):
        pid = self._dead_pid()
        (self.profile / 'SingletonLock').symlink_to(f'{self.host}-{pid}')
        (self.profile / 'SingletonCookie').mkdir()
        self._run()
        self.assertEqual(self._singletons(), ['SingletonCookie'])

    def test_no_profile_is_a_noop(self):
        self.assertFalse(self.m.clear_profile(self.home / 'missing', self.locks))

    def test_main_never_fails_boot(self):
        self.assertEqual(self.m.main(env={'HERMES_HOME': str(self.home), 'HERMES_GATEWAY_LOCK_DIR': '/nonexistent'}), 0)

    def test_profiles_cover_root_and_named_profiles(self):
        (self.home / 'profiles' / 'work' / 'bot-desktop' / 'browser-profile').mkdir(parents=True)
        self.assertEqual(self.m.bot_screen_profiles(self.home), [
            self.profile, self.home / 'profiles' / 'work' / 'bot-desktop' / 'browser-profile'])

    def test_lock_dir_follows_core_resolution(self):
        self.assertEqual(self.m.lock_dir({'HERMES_GATEWAY_LOCK_DIR': '/x'}), Path('/x'))
        self.assertEqual(self.m.lock_dir({'XDG_STATE_HOME': '/s', 'HOME': '/h'}), Path('/s/hermes/gateway-locks'))
        self.assertEqual(self.m.lock_dir({'XDG_STATE_HOME': 'rel', 'HOME': '/h'}),
                         Path('/h/.local/state/hermes/gateway-locks'))


if __name__ == '__main__':
    unittest.main()
