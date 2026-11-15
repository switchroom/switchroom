"""1Password secret-reference audit: each agent reads only its own references.

Synthetic maps and configs only. The audit must never resolve a reference:
a stand-in ``op`` binary on PATH records any call, and the module may not
import anything that could reach a process or the network.
"""
from __future__ import annotations

import ast
import contextlib
import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "switchroom-secret-reference-audit.py"
EXAMPLE = ROOT / "examples" / "overlay-repo" / "ops-kit" / "secret-reference-map.json"
SCHEMA = ROOT / "examples" / "overlay-repo" / "ops-kit" / "secret-reference-map.schema.json"
CROSS = ROOT / "tests" / "fixtures" / "secret-references" / "cross-agent-map.json"
SCHEME = "o" + "p" + "://"  # never written out whole in the public tree
VALUE_MARKER = "SYNTHETIC-SECRET-VALUE-9c1e"

spec = importlib.util.spec_from_file_location("switchroom_secret_reference_audit", SCRIPT)
audit = importlib.util.module_from_spec(spec)
sys.modules["switchroom_secret_reference_audit"] = audit
spec.loader.exec_module(audit)

try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover
    yaml = None


def ref(vault: str, item: str, field: str) -> str:
    return f"{SCHEME}{vault}/{item}/{field}"


def run_cli(*args: str) -> tuple[int, dict]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = audit.main(list(args))
    text = out.getvalue() + err.getvalue()
    return rc, {"json": json.loads(out.getvalue()), "text": text}


class SecretReferenceAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        # A stand-in `op` that leaves a marker if anything ever calls it.
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.marker = self.base / "op-was-called"
        op = self.bin / "op"
        op.write_text(f"#!/bin/sh\ntouch {self.marker}\necho {VALUE_MARKER}\n")
        op.chmod(op.stat().st_mode | stat.S_IXUSR)
        self.env = mock.patch.dict(os.environ, {"PATH": f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}"})
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        self.assertFalse(self.marker.exists(), "the audit resolved a reference through op")
        self.tmp.cleanup()

    def test_example_map_is_clean(self) -> None:
        rc, out = run_cli("--map", str(EXAMPLE))
        self.assertEqual(rc, 0, out["text"])
        self.assertEqual(out["json"]["status"], "ok")
        self.assertEqual(out["json"]["resolved_values"], 0)

    def test_one_deliberate_cross_agent_reference_is_flagged(self) -> None:
        rc, out = run_cli("--map", str(CROSS))
        self.assertEqual(rc, 1)
        self.assertEqual(out["json"]["findings"], [{
            "agent": "worker", "env": "LINEAR_TOKEN", "kind": "cross-agent", "owner": "ops",
            "source": "map", "vault": "example-ops"}])
        # The shared item and the owner's own read are not findings.
        self.assertNotIn("HONCHO_API_KEY", out["text"])

    def test_without_the_audit_rule_the_violation_would_pass(self) -> None:
        # Guard against a vacuous fixture: treating every vault as owned by the reader
        # makes the deliberate violation disappear.
        secret_map = audit.load_map(CROSS)
        for detail in secret_map["agents"].values():
            detail["vaults"] = sorted({r["vault"] for r in detail["references"].values()} | set(detail["vaults"]))
        kinds = {f["kind"] for f in audit.audit_map(secret_map)}
        self.assertNotIn("cross-agent", kinds)

    def test_unowned_and_doubly_owned_vaults(self) -> None:
        doc = json.loads(EXAMPLE.read_text())
        doc["agents"]["worker"]["vaults"].append("example-ops")
        doc["agents"]["worker"]["references"]["EXTRA"] = {"vault": "nobody", "item": "x", "field": "y"}
        path = self.base / "map.json"
        path.write_text(json.dumps(doc))
        rc, out = run_cli("--map", str(path))
        kinds = sorted(f["kind"] for f in out["json"]["findings"])
        self.assertEqual(rc, 1)
        self.assertEqual(kinds, ["unowned-vault", "vault-owned-twice"])

    def config(self, agent: str, env: dict) -> Path:
        path = self.base / f"{agent}.json"
        path.write_text(json.dumps({"secrets": {"onepassword": {"enabled": True, "env": env}}}))
        return path

    def test_config_comparison_never_prints_a_literal_value(self) -> None:
        ops = self.config("ops", {
            "PERPLEXITY_API_KEY": ref("example-ops", "perplexity", "credential"),
            "HERMES_KOKORO_SIDECAR_TOKEN": VALUE_MARKER,              # a pasted secret
        })
        worker = self.config("worker", {
            "PERPLEXITY_API_KEY": ref("example-ops", "perplexity", "credential"),  # reads ops' item
            "HERMES_KOKORO_SIDECAR_TOKEN": ref("example-shared", "voice-sidecar", "token"),
            "SURPRISE": ref("example-worker", "other", "field") + "?attribute=otp",
        })
        rc, out = run_cli("--map", str(EXAMPLE), "--agent-config", f"ops={ops}", "--agent-config", f"worker={worker}")
        self.assertEqual(rc, 1)
        self.assertNotIn(VALUE_MARKER, out["text"])
        self.assertNotIn(SCHEME, out["text"])
        found = {(f["agent"], f["env"], f["kind"]) for f in out["json"]["findings"]}
        self.assertEqual(found, {
            ("ops", "HERMES_KOKORO_SIDECAR_TOKEN", "literal-value"),
            ("worker", "PERPLEXITY_API_KEY", "mismatch"),
            ("worker", "PERPLEXITY_API_KEY", "cross-agent"),
            ("worker", "SURPRISE", "unmapped"),
        })
        self.assertEqual(out["json"]["configs_checked"], ["ops", "worker"])

    def test_missing_mapping_is_reported(self) -> None:
        ops = self.config("ops", {"PERPLEXITY_API_KEY": ref("example-ops", "perplexity", "credential")})
        rc, out = run_cli("--map", str(EXAMPLE), "--agent-config", f"ops={ops}")
        self.assertEqual(rc, 1)
        self.assertEqual([(f["env"], f["kind"]) for f in out["json"]["findings"]],
                         [("HERMES_KOKORO_SIDECAR_TOKEN", "missing")])

    @unittest.skipIf(yaml is None, "PyYAML not installed")
    def test_reads_a_hermes_config_yaml(self) -> None:
        path = self.base / "config.yaml"
        path.write_text(yaml.safe_dump({"model": {"provider": "x"}, "secrets": {"onepassword": {"env": {
            "PERPLEXITY_API_KEY": ref("example-ops", "perplexity", "credential"),
            "HERMES_KOKORO_SIDECAR_TOKEN": ref("example-shared", "voice-sidecar", "token")}}}}))
        rc, out = run_cli("--map", str(EXAMPLE), "--agent-config", f"ops={path}")
        self.assertEqual(rc, 0, out["text"])

    def test_rejects_bad_maps_without_echoing_them(self) -> None:
        path = self.base / "bad.json"
        for doc in (
            {"schema": "other"},
            {"schema": audit.SCHEMA, "agents": {"Ops": {}}},
            {"schema": audit.SCHEMA, "agents": {"ops": {"references": {"X": {"vault": "a/b", "item": "i", "field": "f"}}}}},
            {"schema": audit.SCHEMA, "agents": {"ops": {"references": {"X": {"vault": "a", "item": "i", "field": "f", "value": VALUE_MARKER}}}}},
            {"schema": audit.SCHEMA, "agents": {"ops": {}}, "shared": [{"vault": "v", "item": "i", "readers": ["ops"]}]},
        ):
            path.write_text(json.dumps(doc))
            with self.subTest(doc=doc):
                rc, out = run_cli("--map", str(path))
                self.assertEqual(rc, 2)
                self.assertNotIn(VALUE_MARKER, out["text"])

    def test_cannot_resolve_by_construction(self) -> None:
        tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        self.assertLessEqual(imported, {"__future__", "argparse", "json", "re", "sys", "pathlib", "typing",
                                        "yaml", "ruamel"})
        self.assertNotIn(SCHEME, SCRIPT.read_text(encoding="utf-8"))

    def test_schema_and_example_agree(self) -> None:
        schema = json.loads(SCHEMA.read_text())
        example = json.loads(EXAMPLE.read_text())
        self.assertEqual(schema["properties"]["schema"]["const"], audit.SCHEMA)
        self.assertEqual(example["schema"], audit.SCHEMA)
        self.assertEqual(set(example) - set(schema["properties"]), set())
        try:
            import jsonschema  # type: ignore
        except ImportError:
            return
        jsonschema.validate(example, schema)
        jsonschema.validate(json.loads(CROSS.read_text()), schema)


if __name__ == "__main__":
    unittest.main()
