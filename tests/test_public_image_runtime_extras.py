"""Dockerfile shape for the runtime extras every Fleet agent relies on (HF-856)."""
from __future__ import annotations

import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = (ROOT / "Dockerfile").read_text(encoding="utf-8")
PROFILE_D = ROOT / "docker" / "profile.d" / "hermes-cli-path.sh"
STALE_LOCK = ROOT / "scripts" / "bot-screen-stale-lock.py"
TOOLING = ROOT / "scripts" / "hermes-tooling"


class ImageRuntimeExtrasTests(unittest.TestCase):
    def test_pm_tools_are_prepared_into_the_immutable_store(self) -> None:
        self.assertIn('prepare_tools(["chromium", "cua-driver", "pnpm"]', DOCKERFILE)
        self.assertIn("chmod 0444 /opt/hermes/tools/facts.json", DOCKERFILE)

    def test_onepassword_autolaunch_is_disabled(self) -> None:
        self.assertRegex(DOCKERFILE, r"(?m)^ENV DBUS_SESSION_BUS_ADDRESS=disabled:$")

    def test_login_shell_path_script_is_installed_and_checked(self) -> None:
        self.assertIn("COPY docker/profile.d/hermes-cli-path.sh /etc/profile.d/hermes-cli-path.sh", DOCKERFILE)
        self.assertIn("bash -lc 'command -v hermes && command -v hermes-tooling'", DOCKERFILE)
        text = PROFILE_D.read_text(encoding="utf-8")
        for directory in ("/opt/data/bin", "/opt/hermes/.venv/bin", "/opt/hermes/bin"):
            self.assertIn(directory, text)

    def test_login_shell_path_script_prepends_existing_dirs_once(self) -> None:
        env = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent"}
        out = subprocess.run(
            ["sh", "-c", f". {PROFILE_D}; . {PROFILE_D}; printf %s \"$PATH\""],
            env=env, text=True, capture_output=True, check=True,
        ).stdout
        self.assertTrue(out.endswith("/usr/bin:/bin"))
        entries = out.split(":")
        self.assertEqual(len(entries), len(set(entries)))

    def test_stale_lock_runs_as_cont_init_before_services(self) -> None:
        self.assertIn(
            "COPY --chmod=0755 scripts/bot-screen-stale-lock.py /etc/cont-init.d/017-bot-screen-stale-lock",
            DOCKERFILE,
        )
        self.assertTrue(STALE_LOCK.read_text(encoding="utf-8").startswith("#!/command/with-contenv /opt/hermes/.venv/bin/python3\n"))

    def test_hermes_tooling_is_installed_beside_the_policy_hook_and_audited(self) -> None:
        self.assertIn("COPY --chmod=0755 scripts/hermes-tooling /opt/hermes/bin/hermes-tooling", DOCKERFILE)
        self.assertIn("/opt/hermes/bin/hermes-tooling audit", DOCKERFILE)
        self.assertTrue(os.access(TOOLING, os.X_OK))
        result = subprocess.run([sys.executable, str(TOOLING), "--help"], text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_workspace_symlink_points_at_the_profile_volume(self) -> None:
        self.assertIn("rm -rf /workspace && ln -s /opt/data/workspace /workspace", DOCKERFILE)

    def test_extras_carry_no_private_names(self) -> None:
        for path in (PROFILE_D, STALE_LOCK, TOOLING):
            text = path.read_text(encoding="utf-8").lower()
            for word in ("pixsoul", "klanker", "aggie", "marko", "lawgpt"):
                self.assertNotIn(word, text, f"{path.name}: {word}")


if __name__ == "__main__":
    unittest.main()
