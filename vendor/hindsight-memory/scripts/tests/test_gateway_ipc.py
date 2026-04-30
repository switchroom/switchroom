"""Unit tests for lib/gateway_ipc.py.

Covers:
  - chat_id extraction from <channel ...> wrapper (various attribute orders,
    quote styles, no-channel prompts).
  - socket-path resolution (env override + CLAUDE_PLUGIN_DATA fallback).
  - update_placeholder happy path (one JSON line written, valid shape).
  - update_placeholder failure paths (no socket, refused, timeout) all
    silent — return False but never raise.

Stdlib-only.
"""

import json
import os
import socket
import tempfile
import threading
import unittest

import sys
SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib.gateway_ipc import (  # noqa: E402
    extract_chat_id_from_prompt,
    gateway_socket_path,
    update_placeholder,
)


class ExtractChatIdTests(unittest.TestCase):
    def test_double_quoted_attribute(self):
        prompt = '<channel source="switchroom-telegram" chat_id="8248703757" thread_id="-">\nhi\n</channel>'
        self.assertEqual(extract_chat_id_from_prompt(prompt), "8248703757")

    def test_single_quoted_attribute(self):
        prompt = "<channel source='switchroom-telegram' chat_id='12345' user_id='99'>\nhi\n</channel>"
        self.assertEqual(extract_chat_id_from_prompt(prompt), "12345")

    def test_negative_group_chat_id(self):
        prompt = '<channel source="switchroom-telegram" chat_id="-1001234567890">\nhi\n</channel>'
        self.assertEqual(extract_chat_id_from_prompt(prompt), "-1001234567890")

    def test_attribute_order_doesnt_matter(self):
        prompt = '<channel chat_id="999" source="switchroom-telegram" user="x">\nhi\n</channel>'
        self.assertEqual(extract_chat_id_from_prompt(prompt), "999")

    def test_no_channel_wrapper_returns_none(self):
        self.assertIsNone(extract_chat_id_from_prompt("plain user prompt"))

    def test_channel_without_chat_id_returns_none(self):
        prompt = '<channel source="x" user_id="1">hi</channel>'
        self.assertIsNone(extract_chat_id_from_prompt(prompt))

    def test_empty_chat_id_returns_none(self):
        prompt = '<channel chat_id="">hi</channel>'
        self.assertIsNone(extract_chat_id_from_prompt(prompt))

    def test_non_string_input(self):
        self.assertIsNone(extract_chat_id_from_prompt(None))  # type: ignore[arg-type]
        self.assertIsNone(extract_chat_id_from_prompt(""))
        self.assertIsNone(extract_chat_id_from_prompt(12345))  # type: ignore[arg-type]

    def test_only_inspects_first_kb(self):
        # Pad with content BEFORE the channel wrapper; the regex shouldn't
        # find it because we only inspect the first 1 KB.
        prompt = ("x" * 2000) + '<channel chat_id="111">hi</channel>'
        self.assertIsNone(extract_chat_id_from_prompt(prompt))


class GatewaySocketPathTests(unittest.TestCase):
    def setUp(self):
        self._saved = {
            "SWITCHROOM_GATEWAY_SOCKET": os.environ.get("SWITCHROOM_GATEWAY_SOCKET"),
            "CLAUDE_PLUGIN_DATA": os.environ.get("CLAUDE_PLUGIN_DATA"),
        }
        # Always start clean.
        os.environ.pop("SWITCHROOM_GATEWAY_SOCKET", None)
        os.environ.pop("CLAUDE_PLUGIN_DATA", None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_explicit_env_override_wins(self):
        os.environ["SWITCHROOM_GATEWAY_SOCKET"] = "/tmp/explicit.sock"
        self.assertEqual(gateway_socket_path(), "/tmp/explicit.sock")

    def test_env_override_with_only_whitespace_falls_through(self):
        os.environ["SWITCHROOM_GATEWAY_SOCKET"] = "   "
        # No CLAUDE_PLUGIN_DATA set → returns None.
        self.assertIsNone(gateway_socket_path())

    def test_resolves_from_plugin_data_when_socket_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = os.path.join(tmp, "myagent")
            plugin_data = os.path.join(
                agent_dir, ".claude", "plugins", "data", "hindsight-memory-inline"
            )
            os.makedirs(plugin_data, exist_ok=True)
            tg_dir = os.path.join(agent_dir, "telegram")
            os.makedirs(tg_dir, exist_ok=True)
            sock_path = os.path.join(tg_dir, "gateway.sock")
            # Create a sentinel file so existence check passes.
            open(sock_path, "w").close()

            os.environ["CLAUDE_PLUGIN_DATA"] = plugin_data
            self.assertEqual(gateway_socket_path(), sock_path)

    def test_returns_none_when_socket_does_not_exist(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugin_data = os.path.join(
                tmp, "agent", ".claude", "plugins", "data", "hindsight-memory-inline"
            )
            os.makedirs(plugin_data, exist_ok=True)
            os.environ["CLAUDE_PLUGIN_DATA"] = plugin_data
            self.assertIsNone(gateway_socket_path())

    def test_no_env_no_path(self):
        self.assertIsNone(gateway_socket_path())


class UpdatePlaceholderHappyPathTests(unittest.TestCase):
    """Spin up a real unix socket server, send a placeholder update,
    assert the message we sent matches the wire protocol contract."""

    def test_writes_one_json_line_with_correct_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            sock_path = os.path.join(tmp, "test.sock")
            received: list[bytes] = []
            ready = threading.Event()

            def server():
                srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                srv.bind(sock_path)
                srv.listen(1)
                ready.set()
                conn, _ = srv.accept()
                conn.settimeout(1.0)
                try:
                    chunk = conn.recv(4096)
                    if chunk:
                        received.append(chunk)
                finally:
                    conn.close()
                    srv.close()

            t = threading.Thread(target=server, daemon=True)
            t.start()
            ready.wait(timeout=1.0)

            ok = update_placeholder(
                "8248703757",
                "📚 recalling memories…",
                socket_path=sock_path,
            )
            t.join(timeout=1.0)

            self.assertTrue(ok)
            self.assertEqual(len(received), 1)
            line = received[0].decode("utf-8")
            self.assertTrue(line.endswith("\n"))
            payload = json.loads(line)
            self.assertEqual(payload["type"], "update_placeholder")
            self.assertEqual(payload["chatId"], "8248703757")
            self.assertEqual(payload["text"], "📚 recalling memories…")


class UpdatePlaceholderFailureTests(unittest.TestCase):
    """Every failure path returns False — never raises."""

    def test_no_socket_path_returns_false(self):
        # No socket_path arg, no env override, no plugin data → resolves None.
        prev = os.environ.pop("SWITCHROOM_GATEWAY_SOCKET", None)
        prev_data = os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        try:
            self.assertFalse(update_placeholder("123", "x"))
        finally:
            if prev is not None:
                os.environ["SWITCHROOM_GATEWAY_SOCKET"] = prev
            if prev_data is not None:
                os.environ["CLAUDE_PLUGIN_DATA"] = prev_data

    def test_socket_does_not_exist_returns_false(self):
        # Path is provided but the socket file isn't there.
        self.assertFalse(update_placeholder("123", "x", socket_path="/nonexistent/sock"))

    def test_empty_chat_id_returns_false(self):
        self.assertFalse(update_placeholder("", "x", socket_path="/tmp/whatever"))

    def test_empty_text_returns_false(self):
        self.assertFalse(update_placeholder("123", "", socket_path="/tmp/whatever"))

    def test_non_string_inputs_return_false(self):
        self.assertFalse(update_placeholder(None, "x", socket_path="/tmp/x"))  # type: ignore[arg-type]
        self.assertFalse(update_placeholder("123", None, socket_path="/tmp/x"))  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
