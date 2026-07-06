"""Exit-code contract for recall.py's top-level exception handler.

Switchroom #1070 (redo per #1085 review feedback).

The original fix changed non-debug uncaught exceptions to exit 2,
assuming `bin/run-hook.sh`'s `record_failure` path would fire. But
recall.py is registered as a DIRECT Claude Code plugin hook
(`vendor/hindsight-memory/hooks/hooks.json`), not wrapped. Per Claude
Code's `UserPromptSubmit` hook contract, exit 2 blocks the user's
prompt and surfaces stderr to them — so a hindsight outage would
block every turn.

The corrected contract pinned by these tests:

* Non-debug uncaught exception → exit code 0 (agent stays responsive),
  empty stdout (matches the no-memories success-path shape), stderr
  carrying the class + message but NOT a traceback, AND a synchronous
  shell-out to `switchroom issues record --severity warn --source
  hindsight.recall --code recall_failed ...` so the #424 issue-sink
  still captures the outage.
* The shell-out is fault-tolerant: if the `switchroom` binary is
  missing, hangs, or exits non-zero, recall.py still exits 0 with the
  safe stdout shape.
* Stderr / issue-sink detail are passed through an inline secret
  redactor (bearer tokens, ?token=…/&api_key=… query-string creds,
  x-api-key headers) so credentials leaking out of `lib/client.py:73`'s
  `RuntimeError(f"HTTP {e.code} from {url}: ...")` don't land in
  journald or the issues store.
* Debug uncaught exception (HINDSIGHT_DEBUG=1) → exit code 2 with
  full traceback. Unchanged — live-debugging operators opt in.

The fault is injected by monkey-patching a helper called during
``main()`` so the top-level except handler fires. We run the script
as a subprocess so the real ``if __name__ == '__main__':`` block
executes.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap


SCRIPTS_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "scripts")
)
RECALL_PY = os.path.join(SCRIPTS_DIR, "recall.py")


def _dir_is_exec_capable(path):
    """Return True iff a file created under ``path`` can be executed.

    pytest's ``tmp_path`` defaults to the system temp dir, which on
    hardened hosts / CI containers is frequently mounted ``noexec``
    (verify with ``findmnt -T /tmp``). recall.py invokes the
    ``switchroom`` CLI *by name* via ``subprocess.run`` — that resolves
    to our on-PATH shim, which must therefore live on an
    exec-capable filesystem or the call dies with PermissionError and
    the shim never runs. Probe the real invariant rather than assuming.
    """
    try:
        probe = os.path.join(path, ".exec_probe.sh")
        with open(probe, "w") as fh:
            fh.write("#!/usr/bin/env bash\nexit 0\n")
        os.chmod(probe, 0o755)
        rc = subprocess.run([probe], capture_output=True).returncode
        os.unlink(probe)
        return rc == 0
    except (OSError, PermissionError):
        return False


def _make_exec_bindir(tmp_path):
    """Create the shim ``bin`` directory on an exec-capable filesystem.

    Prefer ``tmp_path`` itself (keeps everything colocated); fall back
    to a self-cleaning temp dir next to this test file — which lives in
    the repo checkout, an exec-capable ext4/overlay mount — when the
    default temp root is ``noexec``.
    """
    if _dir_is_exec_capable(str(tmp_path)):
        bindir = tmp_path / "bin"
        bindir.mkdir(exist_ok=True)
        return bindir
    fallback_root = tempfile.mkdtemp(
        prefix="sw-recall-bin-", dir=os.path.dirname(__file__)
    )
    import atexit

    atexit.register(shutil.rmtree, fallback_root, ignore_errors=True)
    import pathlib

    return pathlib.Path(fallback_root)


def _run_recall_with_injected_fault(
    tmp_path,
    debug=False,
    fault_message="boom: simulated fault",
    switchroom_shim=None,
):
    """Run recall.py as a subprocess after injecting a fault into a
    lib helper called *during* main() so the top-level except handler
    fires. We target ``lib.gateway_ipc.extract_chat_id_from_prompt``
    because it's called unconditionally in the recall flow and
    crucially does NOT touch lib.config — so the handler's own
    ``load_config()`` call (used to decide on traceback verbosity)
    still works.

    ``switchroom_shim`` (optional) is shell script content; if
    provided, a `switchroom` executable with that content is prepended
    to PATH so the handler's subprocess call resolves to it instead
    of (or instead of failing to find) the real CLI.

    Returns the CompletedProcess.
    """
    shim = tmp_path / "fault_shim.py"
    shim.write_text(
        textwrap.dedent(
            f"""\
            import sys, os, runpy
            sys.path.insert(0, {SCRIPTS_DIR!r})
            from lib import gateway_ipc as _gw

            def _boom(*a, **kw):
                raise RuntimeError({fault_message!r})

            _gw.extract_chat_id_from_prompt = _boom

            # Run recall.py as __main__ so the top-level try/except
            # block executes exactly as it does in production.
            runpy.run_path({RECALL_PY!r}, run_name="__main__")
            """
        )
    )

    env = os.environ.copy()
    # Strip any real HINDSIGHT_* / CLAUDE_PLUGIN_* env that might bleed in
    for key in list(env):
        if key.startswith(("HINDSIGHT_", "CLAUDE_PLUGIN_")):
            env.pop(key, None)
    env["HOME"] = str(tmp_path)
    env["CLAUDE_PLUGIN_ROOT"] = str(tmp_path / "plugin_root")
    env["CLAUDE_PLUGIN_DATA"] = str(tmp_path / "plugin_data")
    (tmp_path / "plugin_root").mkdir(exist_ok=True)
    (tmp_path / "plugin_data").mkdir(exist_ok=True)
    if debug:
        env["HINDSIGHT_DEBUG"] = "1"

    # Path manipulation for the switchroom shim. We always isolate
    # PATH so the test doesn't accidentally invoke a real `switchroom`
    # on the host — that would write to a real state dir.
    bindir = _make_exec_bindir(tmp_path)
    if switchroom_shim is not None:
        sw = bindir / "switchroom"
        sw.write_text(switchroom_shim)
        sw.chmod(0o755)
    # Keep system path elements for /usr/bin/env etc., but put our
    # bindir FIRST so any shim wins.
    env["PATH"] = f"{bindir}:{env.get('PATH', '/usr/bin:/bin')}"

    proc = subprocess.run(
        [sys.executable, str(shim)],
        input=json.dumps({"prompt": "anything", "session_id": "s"}),
        capture_output=True,
        text=True,
        env=env,
        timeout=15,
    )
    return proc


# Default recording shim: writes argv (NUL-separated) + stdin into a
# file under $SHIM_RECORD so the test can assert call shape. Exit 0.
_RECORDING_SHIM = textwrap.dedent(
    """\
    #!/usr/bin/env bash
    set -u
    out="${SHIM_RECORD:-/tmp/sw-shim-record}"
    {
      for a in "$@"; do printf '%s\\0' "$a"; done
      printf -- '---STDIN---\\n'
      cat
    } > "$out"
    exit 0
    """
)


class TestRecallExitCodes:
    def test_nondebug_uncaught_exits_zero(self, tmp_path):
        """Headline contract: a hindsight outage must NOT block the
        user's prompt. exit 0 → Claude Code accepts the empty
        additionalContext and proceeds with normal turn handling."""
        proc = _run_recall_with_injected_fault(tmp_path, debug=False)
        assert proc.returncode == 0, (
            f"expected exit 0, got {proc.returncode}; "
            f"stderr={proc.stderr!r}"
        )

    def test_nondebug_stdout_is_empty_memory_shape(self, tmp_path):
        """Stdout must match the no-memories success-path shape. In
        recall.py that path is a bare `return` with nothing dumped
        to stdout (see line ~660 — the `if not directives_block and
        not memories_block: return` branch). So stdout must be the
        empty string."""
        proc = _run_recall_with_injected_fault(tmp_path, debug=False)
        assert proc.stdout == "", (
            f"expected empty stdout, got {proc.stdout!r}"
        )

    def test_nondebug_stderr_includes_class_and_message(self, tmp_path):
        """Operators reading journald need the class + message to
        understand what broke. The full traceback stays gated behind
        HINDSIGHT_DEBUG=1."""
        proc = _run_recall_with_injected_fault(
            tmp_path, debug=False, fault_message="kaboom-1070"
        )
        assert "RuntimeError" in proc.stderr
        assert "kaboom-1070" in proc.stderr
        assert "Unexpected error in recall" in proc.stderr

    def test_nondebug_stderr_omits_traceback(self, tmp_path):
        """#1069 threat model: don't dump tracebacks (which may
        include local-variable repr in some frames or framework
        internals) to unredacted stderr unless debug mode is on."""
        proc = _run_recall_with_injected_fault(tmp_path, debug=False)
        # The Python traceback module emits "Traceback (most recent
        # call last):" as the first line. Its absence is the cheap,
        # unambiguous check.
        assert "Traceback (most recent call last)" not in proc.stderr, (
            f"non-debug stderr leaked traceback: {proc.stderr!r}"
        )

    def test_nondebug_invokes_issues_record_subprocess(self, tmp_path):
        """The substitute for the wrapper's record_failure path:
        recall.py must shell out to `switchroom issues record` itself.
        Assert the call argv shape via a recording shim on PATH."""
        record_path = tmp_path / "shim_record.txt"
        env_override_shim = _RECORDING_SHIM.replace(
            '${SHIM_RECORD:-/tmp/sw-shim-record}', str(record_path)
        )
        proc = _run_recall_with_injected_fault(
            tmp_path,
            debug=False,
            fault_message="kaboom-call-shape",
            switchroom_shim=env_override_shim,
        )
        assert proc.returncode == 0
        assert record_path.exists(), (
            f"switchroom shim was not invoked; stderr={proc.stderr!r}"
        )
        raw = record_path.read_bytes()
        head, _, tail = raw.partition(b"---STDIN---\n")
        argv = [a.decode() for a in head.split(b"\x00") if a]
        # Expected verb chain
        assert argv[0:3] == ["issues", "record", "--severity"], argv
        assert "warn" in argv
        assert "--source" in argv
        assert "hindsight.recall" in argv
        assert "--code" in argv
        assert "recall_failed" in argv
        assert "--summary" in argv
        # Summary contains the class
        assert any(
            "Hindsight recall failed: RuntimeError" in a for a in argv
        ), argv
        assert "--detail-stdin" in argv
        assert "--quiet" in argv
        # Stdin carries class + message
        stdin_payload = tail.decode()
        assert "RuntimeError" in stdin_payload
        assert "kaboom-call-shape" in stdin_payload

    def test_nondebug_issues_record_failure_does_not_propagate(self, tmp_path):
        """If the shim exits non-zero (or the binary is missing or
        hangs), recall.py must still exit 0 with the safe stdout
        shape. The agent's responsiveness on a hindsight outage MUST
        NOT depend on the issue sink also working."""
        failing_shim = "#!/usr/bin/env bash\nexit 17\n"
        proc = _run_recall_with_injected_fault(
            tmp_path, debug=False, switchroom_shim=failing_shim
        )
        assert proc.returncode == 0, (
            f"shim failure leaked through; rc={proc.returncode} "
            f"stderr={proc.stderr!r}"
        )
        assert proc.stdout == ""

    def test_nondebug_missing_switchroom_binary_does_not_propagate(self, tmp_path):
        """The other failure mode: the binary isn't on PATH at all.
        FileNotFoundError must be swallowed; agent still exits 0."""
        # Empty bindir, no shim. PATH will only contain our empty
        # bindir + system paths; system paths shouldn't have a
        # `switchroom` on a test runner (and even if they do, the
        # important thing is exit 0).
        proc = _run_recall_with_injected_fault(
            tmp_path, debug=False, switchroom_shim=None
        )
        # We can't assert the shim wasn't called (we didn't install
        # one) but we CAN assert recall.py still exits 0.
        assert proc.returncode == 0, (
            f"missing-binary path leaked; rc={proc.returncode} "
            f"stderr={proc.stderr!r}"
        )

    def test_nondebug_redacts_token_in_message(self, tmp_path):
        """Exception messages from `lib/client.py:73` interpolate the
        request URL into a RuntimeError; that URL may carry
        `?api_key=...` or `Authorization: Bearer ...` in the body
        echo. The redactor must scrub these from BOTH stderr and the
        issues-record stdin payload.

        Per repo convention (CLAUDE.md "Secrets in tests"), the
        token-shaped fixture is built by string concatenation so the
        source file never contains a contiguous secret-looking blob.
        """
        # Construct a fake token at runtime
        fake_token = "sk" + "-" + "ant" + "-" + "a" * 40
        fault_msg = (
            "HTTP 401 from https://api.example.com/recall"
            f"?api_key={fake_token}: unauthorized"
        )
        record_path = tmp_path / "shim_record.txt"
        env_override_shim = _RECORDING_SHIM.replace(
            '${SHIM_RECORD:-/tmp/sw-shim-record}', str(record_path)
        )
        proc = _run_recall_with_injected_fault(
            tmp_path,
            debug=False,
            fault_message=fault_msg,
            switchroom_shim=env_override_shim,
        )
        assert proc.returncode == 0
        assert fake_token not in proc.stderr, (
            f"token leaked to stderr: {proc.stderr!r}"
        )
        assert record_path.exists()
        payload = record_path.read_bytes().decode("utf-8", errors="replace")
        assert fake_token not in payload, (
            f"token leaked to issues-record payload: {payload!r}"
        )

    def test_nondebug_redacts_bearer_in_message(self, tmp_path):
        """Bearer-token shape is the other common leak vector."""
        fake_bearer = "abcdef" + "0123456789" * 4
        fault_msg = f"HTTP 401: Authorization: Bearer {fake_bearer} rejected"
        proc = _run_recall_with_injected_fault(
            tmp_path,
            debug=False,
            fault_message=fault_msg,
            switchroom_shim=_RECORDING_SHIM,
        )
        assert proc.returncode == 0
        assert fake_bearer not in proc.stderr, (
            f"bearer leaked to stderr: {proc.stderr!r}"
        )

    def test_debug_exits_two_with_traceback(self, tmp_path):
        """In debug mode, the traceback is allowed AND we exit 2.
        Unchanged from the existing debug-branch behaviour."""
        proc = _run_recall_with_injected_fault(tmp_path, debug=True)
        assert proc.returncode == 2, (
            f"expected exit 2 in debug, got {proc.returncode}; "
            f"stderr={proc.stderr!r}"
        )
        assert "Traceback (most recent call last)" in proc.stderr, (
            f"debug stderr missing traceback: {proc.stderr!r}"
        )
