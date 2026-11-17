"""The retired Switchroom installer URL now prints a migration notice only."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STUB = ROOT / "scripts" / "install-deps.sh"


class InstallDepsStubTests(unittest.TestCase):
    def test_stub_is_executable_posix_sh(self) -> None:
        self.assertTrue(os.access(STUB, os.X_OK))
        self.assertEqual(STUB.read_text(encoding="utf-8").splitlines()[0], "#!/bin/sh")

    def test_piped_run_prints_migration_and_fails_without_installing(self) -> None:
        # Old docs piped the script into `sudo bash`; run it the same way, with an
        # empty PATH so any attempt to call apt, curl, npm or sudo would fail loudly.
        with tempfile.TemporaryDirectory() as empty:
            result = subprocess.run(
                ["/bin/sh"],
                input=STUB.read_text(encoding="utf-8"),
                text=True,
                capture_output=True,
                env={"PATH": empty, "HOME": empty},
                check=False,
            )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("switchroom/switchroom-classic", result.stderr)
        self.assertIn("Nothing was installed.", result.stderr)
        self.assertIn("https://github.com/switchroom/switchroom#quick-start", result.stderr)
        self.assertNotIn("not found", result.stderr)

    def test_stub_invokes_no_package_manager(self) -> None:
        code = "\n".join(
            line
            for line in STUB.read_text(encoding="utf-8").splitlines()
            if not line.lstrip().startswith(("#", "'"))
        )
        self.assertEqual(code.split(), ["printf", "'%s\\n'", "\\", "exit", "1"])

if __name__ == "__main__":
    unittest.main()
