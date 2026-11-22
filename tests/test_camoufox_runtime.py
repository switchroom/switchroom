"""The image's Camoufox stack (HF-773): pins, the downstream patch, the service, the bake smoke.

These are source checks. The headed proof is scripts/verify-camoufox-runtime.py, which the Fleet
Image workflow runs in the candidate image (UID 1000, fleet seccomp, no-new-privileges).
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "release" / "camoufox.lock.json").read_text(encoding="utf-8"))
DOCKERFILE = (ROOT / "Dockerfile").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github" / "workflows" / "fleet-image.yml").read_text(encoding="utf-8")
SERVICE = (ROOT / "docker" / "camofox-browser" / "service-run").read_text(encoding="utf-8")
PATCH = (ROOT / "release" / "camofox-browser" / "official-camoufox.patch").read_text(encoding="utf-8")
# service-run checks a derived locale and time zone with `node -e` (Intl) before it exports them.
REAL_NODE = shutil.which("node")


class LockTests(unittest.TestCase):
    def test_camoufox_is_the_attested_latest_stable_build(self):
        c = LOCK["camoufox"]
        self.assertEqual((c["version"], c["build"]), ("158.0.1", "beta.41"))
        self.assertEqual(c["tag"], f"v{c['version']}-{c['build']}")
        self.assertEqual(c["asset"], f"camoufox-{c['version']}-{c['build']}-lin.x86_64.zip")
        self.assertRegex(c["sha256"], r"^[0-9a-f]{64}$")
        self.assertGreater(c["size"], 10**9)
        self.assertIs(c["attestation"]["required"], True)
        self.assertEqual(c["attestation"]["signer_workflow"], "daijro/camoufox/.github/workflows/release.yml")
        self.assertEqual(c["install_dir"], "/opt/camoufox")
        self.assertEqual(c["executable"], "/opt/camoufox/camoufox-bin")

    def test_camofox_browser_is_the_integrity_pinned_npm_tarball(self):
        s = LOCK["camofox_browser"]
        self.assertEqual((s["package"], s["version"]), ("@askjo/camofox-browser", "1.19.0"))
        self.assertTrue(s["tarball"].startswith("https://registry.npmjs.org/@askjo/camofox-browser/-/"))
        self.assertRegex(s["integrity"], r"^sha512-[A-Za-z0-9+/]{86}==$")
        (patch,) = s["patches"]
        self.assertEqual(patch["id"], "official-camoufox")
        self.assertTrue((ROOT / patch["file"]).is_file())
        # The same change, offered upstream (docs/camoufox.md): drop the patch once a release has it.
        self.assertEqual(patch["upstream"], "https://github.com/jo-inc/camofox-browser/pull/15715")
        self.assertEqual(patch["upstream_issue"], "https://github.com/jo-inc/camofox-browser/issues/15333")

    def test_fingerprint_model_is_baked_from_the_fpgen_pin(self):
        m = LOCK["camofox_browser"]["fingerprint_model"]
        lock = json.loads((ROOT / LOCK["camofox_browser"]["npm_lock"]).read_text(encoding="utf-8"))
        self.assertEqual(lock["packages"]["node_modules/fpgen-js"]["version"], m["package_version"])
        self.assertRegex(m["sha256"], r"^[0-9a-f]{64}$")
        self.assertTrue(m["url"].startswith("https://github.com/scrapfly/fingerprint-generator/releases/download/"))
        self.assertEqual(m["install_dir"], "/opt/camofox-browser/fpgen")
        for token in ("m.MODEL_PIN.sha256 !== sha", "await m.ensureModel({ dir: process.env.CAMOUFOX_FPGEN_DATA })",
                      "CAMOUFOX_FPGEN_DATA=/opt/camofox-browser/fpgen"):
            with self.subTest(token=token):
                self.assertIn(token, DOCKERFILE)
        self.assertIn("export CAMOUFOX_FPGEN_DATA=${CAMOUFOX_FPGEN_DATA:-/opt/camofox-browser/fpgen}", SERVICE)

    def test_npm_lock_resolves_the_official_package_only(self):
        lock = json.loads((ROOT / LOCK["camofox_browser"]["npm_lock"]).read_text(encoding="utf-8"))
        packages = lock["packages"]
        self.assertEqual(packages[""]["version"], "1.19.0")
        self.assertEqual(packages[""]["dependencies"]["camoufox"], "0.5.9")
        self.assertNotIn("camoufox-js", packages[""]["dependencies"])
        self.assertNotIn("node_modules/camoufox-js", packages)
        self.assertEqual(packages["node_modules/camoufox"]["version"], "0.5.9")
        major, minor, _ = (int(p) for p in packages["node_modules/playwright-core"]["version"].split("."))
        self.assertLess((major, minor), (1, 63))
        for name, meta in packages.items():
            if name and not meta.get("link"):
                with self.subTest(package=name):
                    self.assertTrue(meta.get("integrity", "").startswith("sha512-"), name)
                    self.assertTrue(meta.get("resolved", "").startswith("https://registry.npmjs.org/"), name)


class PatchTests(unittest.TestCase):
    def test_patch_swaps_camoufox_js_for_the_official_package_and_bumps_the_pin(self):
        files = re.findall(r"^diff -ruN a/(\S+) b/", PATCH, re.M)
        self.assertEqual(sorted(files), ["lib/camoufox-download.js", "lib/camoufox-executable.js",
                                         "package.json", "server.js"])
        added = "\n".join(line for line in PATCH.splitlines() if line.startswith("+") and not line.startswith("+++"))
        self.assertNotIn("camoufox-js", added.replace("camoufox-js@", ""))
        self.assertIn("import { Camoufox, launchOptions, VirtualDisplay } from 'camoufox';", added)
        self.assertIn("BUNDLED_CAMOUFOX_RELEASE = '158.0.1-beta.41'", added)
        self.assertIn('"camoufox": "0.5.9"', added)
        self.assertNotRegex(PATCH, r"^(---|\+\+\+) \S+\t", "patch headers must not carry timestamps")


class ImageTests(unittest.TestCase):
    def test_dockerfile_installs_desktop_browsers_and_camoufox(self):
        for token in (
            "tigervnc-standalone-server", "xfce4-panel", "chromium", "adwaita-icon-theme-legacy",
            "libdbus-glib-1-2", "libegl1", "fonts-noto-core", "fonts-noto-color-emoji", "locales",
            "en_AU.UTF-8 UTF-8", "LANG=en_AU.UTF-8", "BH_TAB_MARKER=0",
            # en-AU resolves to Chromium's en-GB UI locale; without that pak pages run en-US.
            "chromium chromium-l10n", "path-exclude=/usr/lib/chromium/locales/*",
            "path-include=/usr/lib/chromium/locales/en-GB.pak",
            "path-include=/usr/lib/chromium/locales/en-US.pak",
            "= 'en-GB.pak en-US.pak '",
            "COPY release/camoufox.lock.json /opt/hermes-fleet/release/camoufox.lock.json",
            "gh attestation verify", "--signer-workflow", "unzip -q \"$archive\" -d /opt/camoufox",
            "/opt/camoufox/.hermes-fleet-provenance.json", "/usr/share/icons/hicolor/${size}x${size}/apps/camoufox.png",
            "git apply --whitespace=nowarn /tmp/camofox-browser-release/official-camoufox.patch",
            "npm ci --omit=dev --ignore-scripts", "test ! -e node_modules/camoufox-js",
            "COPY docker/s6-rc.d/camofox-browser/ /etc/s6-overlay/s6-rc.d/camofox-browser/",
            "COPY docker/s6-rc.d/user/contents.d/camofox-browser",
            "CAMOFOX_URL=http://127.0.0.1:9377", "S6_SERVICES_GRACETIME=50000",
            "COPY --chmod=0755 scripts/verify-camoufox-runtime.py /opt/hermes-fleet/bin/verify-camoufox-runtime.py",
        ):
            with self.subTest(token=token):
                self.assertIn(token, DOCKERFILE)
        # Camoufox is never registered with the per-profile tool store.
        self.assertNotIn("/opt/hermes/tools/camoufox", DOCKERFILE)
        # The plugins are mounted by deployment, never baked.
        self.assertNotIn("COPY plugins/camofox", DOCKERFILE)
        self.assertNotIn("COPY plugins/camoufox-desktop", DOCKERFILE)

    def test_s6_service_is_a_supervised_longrun_without_root(self):
        svc = ROOT / "docker" / "s6-rc.d" / "camofox-browser"
        self.assertEqual((svc / "type").read_text().strip(), "longrun")
        self.assertTrue((svc / "dependencies.d" / "base").is_file())
        self.assertTrue((ROOT / "docker" / "s6-rc.d" / "user" / "contents.d" / "camofox-browser").is_file())
        run = (svc / "run").read_text()
        self.assertIn('[ "$(id -u)" = 0 ] || exec /usr/local/lib/camofox-browser/service-run', run)

    def test_service_is_loopback_keyed_headed_quiet_and_persistent(self):
        for token in (
            "export CAMOFOX_BIND_HOST=127.0.0.1",
            'export CAMOFOX_ACCESS_KEY="$access_key" CAMOFOX_API_KEY="$access_key"',
            "export CAMOFOX_INTERACTIVE=desktop",
            "export CAMOFOX_CRASH_REPORT_ENABLED=false SENTRY_DSN= PROMETHEUS_ENABLED=false",
            "CAMOFOX_DISABLE_DEFAULT_ADDONS=${CAMOFOX_DISABLE_DEFAULT_ADDONS:-1}",
            'state=${CAMOFOX_STATE_DIR:-$home_dir/camofox-browser}',
            'export CAMOFOX_PROFILE_DIR="$state/profiles"',
            "SESSION_TIMEOUT_MS=${SESSION_TIMEOUT_MS:-0}",
            "TAB_INACTIVITY_MS=${TAB_INACTIVITY_MS:-28800000}",
            "trap stop TERM INT",
            'kill -TERM "$child"',
            "unset ENABLE_VNC",
            'backoff_exit "cannot create $state"',
        ):
            with self.subTest(token=token):
                self.assertIn(token, SERVICE)
        self.assertIn("umask 077", SERVICE)
        self.assertNotIn("0.0.0.0", SERVICE)

    def test_both_bake_jobs_run_the_headed_smoke_under_the_runtime_sandbox(self):
        self.assertEqual(WORKFLOW.count("/opt/hermes-fleet/bin/verify-camoufox-runtime.py --out /smoke"), 2)
        for token in ("--user 1000:1000", "--security-opt no-new-privileges",
                      "--security-opt seccomp=security/chromium-seccomp.json", "--network none"):
            with self.subTest(token=token):
                self.assertGreaterEqual(WORKFLOW.count(token), 2)
        self.assertEqual(WORKFLOW.count("name: camoufox-smoke-${{ github.sha }}-${{ github.job }}"), 2)


class ServiceRunKeyTests(unittest.TestCase):
    """Run the real service-run up to its exec, with a stand-in server that reports its env."""

    # Report the environment, then stop the run the way s6 does (SIGTERM), after the trap is set.
    REPORT_AND_STOP = '#!/bin/sh\nenv\nsleep 0.5\nkill -TERM "$PPID"\n'

    def x_table(self, *displays: int) -> None:
        """A /proc/net/unix stand-in with the given X displays bound (as Xvnc binds them)."""
        rows = ["Num       RefCount Protocol Flags    Type St Inode Path"]
        for n in displays:
            rows.append(f"0000000000000000: 00000002 00000000 00010000 0001 01 1142{n} /tmp/.X11-unix/X{n}")
            rows.append(f"0000000000000000: 00000003 00000000 00000000 0001 03 1141{n} @/tmp/.X11-unix/X{n}")
        rows.append("0000000000000000: 00000002 00000000 00010000 0001 01 99 /run/dbus/system_bus_socket")
        self.table.write_text("\n".join(rows) + "\n")

    def start_service(self, home: Path, node: str = REPORT_AND_STOP, **extra: str):
        import os
        import subprocess
        import tempfile
        server = Path(tempfile.mkdtemp(dir=home.parent))
        (server / "server.js").write_text("")
        bindir = Path(tempfile.mkdtemp(dir=home.parent))
        fake = bindir / "node"
        # The stand-in server hands service-run's `node -e` Intl check to the real node.
        shebang, body = node.split("\n", 1)
        delegate = f'exec "{REAL_NODE}" "$@"' if REAL_NODE else "exit 1"
        fake.write_text(f'{shebang}\nif [ "$1" = "-e" ]; then {delegate}; fi\n{body}')
        fake.chmod(0o755)
        env = {"PATH": f"{bindir}:/usr/bin:/bin", "HERMES_HOME": str(home), "CAMOFOX_SERVER_DIR": str(server),
               "CAMOFOX_X_SOCKET_TABLE": str(self.table), **extra}
        self.stdout, self.stderr = home.parent / "service.out", home.parent / "service.err"
        # Files, not pipes: the watch loop's background sleep outlives the run and would hold a pipe open.
        with self.stdout.open("w") as out, self.stderr.open("w") as err:
            return subprocess.Popen(["bash", str(ROOT / "docker" / "camofox-browser" / "service-run")], env=env,
                                    stdout=out, stderr=err)

    def run_service(self, home: Path, expect: int = 0, **extra: str) -> dict:
        code = self.start_service(home, **extra).wait(timeout=20)
        self.assertEqual(code, expect, self.stderr.read_text())
        return dict(line.split("=", 1) for line in self.stdout.read_text().splitlines() if "=" in line)

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        self.table = Path(self.tmp.name) / "net-unix"
        self.x_table(20)

    def tearDown(self):
        self.tmp.cleanup()

    def test_first_start_creates_a_private_key_and_reuses_it(self):
        env = self.run_service(self.home)
        key = self.home / "camofox-browser" / "access-key"
        self.assertEqual(key.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.home / "camofox-browser").stat().st_mode & 0o777, 0o700)
        self.assertRegex(env["CAMOFOX_ACCESS_KEY"], r"^[0-9a-f]{64}$")
        self.assertEqual(env["CAMOFOX_API_KEY"], env["CAMOFOX_ACCESS_KEY"])
        self.assertEqual(env["CAMOFOX_BIND_HOST"], "127.0.0.1")
        self.assertEqual(env["CAMOFOX_INTERACTIVE"], "desktop")
        self.assertEqual(self.run_service(self.home)["CAMOFOX_ACCESS_KEY"], env["CAMOFOX_ACCESS_KEY"])
        self.assertEqual(sorted(p.name for p in (self.home / "camofox-browser").glob(".access-key.*")), [])

    def identity(self, **extra: str) -> tuple:
        """Run the service and return the (CAMOFOX_LOCALE, CAMOFOX_TIMEZONE) it exported (None if unset)."""
        if not REAL_NODE:
            self.skipTest("the locale and time-zone check needs node")
        extra.setdefault("CAMOFOX_TIMEZONE_FILE", str(Path(self.tmp.name) / "no-timezone-file"))
        env = self.run_service(self.home, **extra)
        return env.get("CAMOFOX_LOCALE"), env.get("CAMOFOX_TIMEZONE")

    def test_locale_and_time_zone_follow_the_container(self):
        # camofox-browser (lib/config.js directBrowserIdentity) takes both or neither; with both,
        # navigator.language matches Intl instead of staying en-US.
        self.assertEqual(self.identity(LANG="en_AU.UTF-8", TZ="Australia/Sydney"), ("en-AU", "Australia/Sydney"))
        self.assertEqual(self.identity(LANG="en_AU.UTF-8", TZ="UTC"), ("en-AU", "UTC"))
        self.assertEqual(self.identity(LANG="de_DE.UTF-8@euro", TZ=":Europe/Berlin"), ("de-DE", "Europe/Berlin"))

    def test_lc_all_beats_lang(self):
        self.assertEqual(self.identity(LC_ALL="fr_CA.UTF-8", LANG="en_AU.UTF-8", TZ="UTC"), ("fr-CA", "UTC"))

    def test_time_zone_falls_back_to_the_timezone_file(self):
        tzfile = Path(self.tmp.name) / "timezone"
        tzfile.write_text("Europe/Lisbon\n")
        self.assertEqual(self.identity(LANG="en_GB.UTF-8", CAMOFOX_TIMEZONE_FILE=str(tzfile)),
                         ("en-GB", "Europe/Lisbon"))
        self.assertEqual(self.identity(LANG="en_GB.UTF-8", TZ="UTC", CAMOFOX_TIMEZONE_FILE=str(tzfile)),
                         ("en-GB", "UTC"))

    def test_explicit_values_win_and_pass_through_unpaired(self):
        self.assertEqual(self.identity(LANG="en_AU.UTF-8", TZ="UTC", CAMOFOX_LOCALE="en-GB",
                                       CAMOFOX_TIMEZONE="Europe/London"), ("en-GB", "Europe/London"))
        # Half a pair is the operator's own: passed through as given, so camofox-browser refuses it.
        self.assertEqual(self.identity(LANG="en_AU.UTF-8", TZ="UTC", CAMOFOX_LOCALE="en-GB"), ("en-GB", None))
        self.assertEqual(self.identity(LANG="en_AU.UTF-8", TZ="UTC", CAMOFOX_TIMEZONE="Europe/London"),
                         (None, "Europe/London"))

    def test_a_pair_intl_rejects_exports_neither(self):
        # camofox-browser refuses these at start (Intl.getCanonicalLocales / DateTimeFormat timeZone),
        # and s6 would restart it in a loop.
        cases = [("UTF-8", "UTC")] + [("en_AU.UTF-8", tz) for tz in (
            "Factory", "posixrules", "localtime", "zone.tab", "AEST-10", "Mars/Olympus",
            "../Etc/UTC", "Europe/../Etc/UTC", "/usr/share/zoneinfo/UTC")]
        for lang, tz in cases:
            with self.subTest(lang=lang, tz=tz):
                self.assertEqual(self.identity(LANG=lang, TZ=tz), (None, None))
                self.assertIn("is not valid for the browser; leaving both to camofox-browser",
                              self.stderr.read_text())
        tzfile = Path(self.tmp.name) / "timezone"
        tzfile.write_text("AEST-10\n")
        self.assertEqual(self.identity(LANG="en_AU.UTF-8", CAMOFOX_TIMEZONE_FILE=str(tzfile)), (None, None))
        # A timezone path that is not a file is skipped, not fatal under set -e.
        self.assertEqual(self.identity(LANG="en_AU.UTF-8", CAMOFOX_TIMEZONE_FILE=self.tmp.name), (None, None))
        # A valid pair exports; explicit values are the operator's and are not checked.
        self.assertEqual(self.identity(LANG="en_AU.UTF-8", TZ="Europe/Lisbon"), ("en-AU", "Europe/Lisbon"))
        self.assertEqual(self.identity(CAMOFOX_LOCALE="en-AU", CAMOFOX_TIMEZONE="AEST-10"), ("en-AU", "AEST-10"))

    def test_half_a_derived_pair_exports_neither(self):
        for extra in ({"LANG": "C", "TZ": "UTC"}, {"LANG": "POSIX", "TZ": "UTC"}, {"LANG": "C.UTF-8", "TZ": "UTC"},
                      {"TZ": "UTC"}, {"LANG": "en_AU.UTF-8"}, {"LANG": "en_AU.UTF-8", "TZ": ""},
                      {"LANG": "en_AU.UTF-8", "TZ": ":"}, {"LC_ALL": "C", "LANG": "en_AU.UTF-8", "TZ": "UTC"}):
            with self.subTest(extra=extra):
                self.assertEqual(self.identity(**extra), (None, None))

    def test_an_empty_key_left_by_a_crash_is_replaced(self):
        state = self.home / "camofox-browser"
        state.mkdir(mode=0o700)
        (state / "access-key").write_text("")
        env = self.run_service(self.home)
        self.assertRegex(env["CAMOFOX_ACCESS_KEY"], r"^[0-9a-f]{64}$")
        self.assertEqual((state / "access-key").read_text().strip(), env["CAMOFOX_ACCESS_KEY"])

    def test_a_short_key_nothing_can_use_is_replaced(self):
        state = self.home / "camofox-browser"
        state.mkdir(mode=0o700)
        (state / "access-key").write_text("abc\n")
        env = self.run_service(self.home)
        self.assertRegex(env["CAMOFOX_ACCESS_KEY"], r"^[0-9a-f]{64}$")
        self.assertEqual((state / "access-key").read_text().strip(), env["CAMOFOX_ACCESS_KEY"])
        self.assertIn("replacing an unusable access key", self.stderr.read_text())
        self.assertEqual(sorted(p.name for p in state.glob(".access-key.*")), [])

    def test_an_unusable_state_directory_backs_off_then_fails(self):
        (self.home / "blocked").write_text("a file, not a directory")
        env = self.run_service(self.home, expect=1, CAMOFOX_STATE_DIR=str(self.home / "blocked" / "state"),
                               CAMOFOX_BACKOFF_SECONDS="0")
        self.assertEqual(env, {})  # the server never started
        self.assertIn("cannot create", self.stderr.read_text())
        self.assertIn("retrying in 0 s", self.stderr.read_text())

    def test_the_published_display_is_used(self):
        desktop = self.home / "bot-desktop"
        desktop.mkdir()
        (desktop / "env").write_text("DISPLAY=:23\nXAUTHORITY=/x/auth\n")
        self.x_table(23)
        env = self.run_service(self.home)
        self.assertEqual((env["DISPLAY"], env["XAUTHORITY"]), (":23", "/x/auth"))

    def test_the_server_waits_for_the_screen_instead_of_retrying_a_dead_display(self):
        import time
        desktop = self.home / "bot-desktop"
        desktop.mkdir()
        # A stale env file (it survives a container recreate) is not a live screen.
        (desktop / "env").write_text("DISPLAY=:20\n")
        self.x_table()
        service = self.start_service(self.home)
        time.sleep(2.5)
        self.assertIsNone(service.poll())
        self.assertNotIn("CAMOFOX_ACCESS_KEY=", self.stdout.read_text())  # node not started
        self.assertIn("waiting for the Bot Desktop (:20)", self.stderr.read_text())
        # The screen comes up on another display: the server starts there.
        (desktop / "env").write_text("DISPLAY=:21\nXAUTHORITY=/x/a21\n")
        self.x_table(21)
        self.assertEqual(service.wait(timeout=10), 0, self.stderr.read_text())
        env = dict(line.split("=", 1) for line in self.stdout.read_text().splitlines() if "=" in line)
        self.assertEqual((env["DISPLAY"], env["XAUTHORITY"]), (":21", "/x/a21"))

    def test_a_waiting_service_stops_cleanly_on_sigterm(self):
        import signal
        import time
        self.x_table()
        service = self.start_service(self.home)
        time.sleep(1.5)
        service.send_signal(signal.SIGTERM)
        self.assertEqual(service.wait(timeout=10), 0)

    def test_the_server_is_stopped_when_the_screen_goes_away(self):
        import time
        marker = self.home.parent / "node-got-term"
        node = f'#!/bin/sh\ntrap \'touch {marker}; exit 0\' TERM\nwhile :; do sleep 0.1; done\n'
        service = self.start_service(self.home, node=node, CAMOFOX_WATCH_SECONDS="0.2")
        time.sleep(1.0)
        self.assertIsNone(service.poll())
        self.x_table()  # Bot Desktop stopped (idle-stop): its X server is gone
        self.assertEqual(service.wait(timeout=10), 0, self.stderr.read_text())
        self.assertTrue(marker.exists(), "the server was not sent SIGTERM")
        self.assertIn("Bot Desktop (:20) stopped", self.stderr.read_text())


class SmokeHelperTests(unittest.TestCase):
    def test_listening_addresses_reads_ipv4_and_ipv6_listeners_only(self):
        import importlib.util
        import tempfile
        spec = importlib.util.spec_from_file_location("verify_camoufox_runtime",
                                                      ROOT / "scripts" / "verify-camoufox-runtime.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
        with tempfile.TemporaryDirectory() as tmp:
            tcp, tcp6 = Path(tmp) / "tcp", Path(tmp) / "tcp6"
            tcp.write_text(header
                           + "   0: 0100007F:4BB1 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 1\n"
                           + "   1: 00000000:4BB1 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000 0 2\n"
                           + "   2: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 3\n")
            tcp6.write_text(header + "   0: 00000000000000000000000001000000:4BB1 "
                            "00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000"
                            "  1000 0 4\n")
            tables = ((str(tcp), 8), (str(tcp6), 32))
            self.assertEqual(mod.listening_addresses(19377, tables), {"127.0.0.1", "::1"})
            self.assertEqual(mod.listening_addresses(80, tables), {"0.0.0.0"})
            self.assertEqual(mod.listening_addresses(19377, ((str(Path(tmp) / "missing"), 8),)), set())


class VendoredPluginTests(unittest.TestCase):
    PLUGIN = ROOT / "plugins" / "camofox"

    def test_official_camofox_plugin_is_vendored_unmodified(self):
        upstream = json.loads((self.PLUGIN / "UPSTREAM.json").read_text(encoding="utf-8"))
        self.assertEqual(upstream["repository"], "https://github.com/NousResearch/hermes-official-plugins.git")
        self.assertRegex(upstream["commit"], r"^[0-9a-f]{40}$")
        self.assertEqual(upstream["version"], "1.2.0")
        self.assertEqual(upstream["patches"], [])
        on_disk = sorted(p.name for p in self.PLUGIN.iterdir() if p.is_file())
        self.assertEqual(on_disk, sorted([*upstream["files_sha256"], "UPSTREAM.json"]))
        for name, digest in upstream["files_sha256"].items():
            with self.subTest(file=name):
                self.assertEqual(hashlib.sha256((self.PLUGIN / name).read_bytes()).hexdigest(), digest)
        self.assertIn("version: 1.2.0", (self.PLUGIN / "plugin.yaml").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
