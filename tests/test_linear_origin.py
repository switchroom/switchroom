"""The mounted evidence edge accepts no model-supplied identity or authority grant."""
import argparse
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from linear_fake_api import load_plugin
plugin = load_plugin()
from hermes_fleet_linear_plugin import origin, ops, transport


class OriginEdgeTests(unittest.TestCase):
    def test_reference_shape_cannot_select_a_home_database_or_identity(self):
        ref = dict(version=1, profile="default", admission_id="admission",
                   instance_id="owner", authority_epoch=1, execution_generation=1, scope_digest="digest")
        self.assertEqual(origin.reference(ref), ref)
        for changed in ({**ref, "home": "/foreign"}, {**ref, "principal": "human"},
                        {**ref, "authority_epoch": True}, {**ref, "session_id": ""},
                        {**ref, "input_id": "private"}, {}):
            with self.subTest(changed=changed), self.assertRaises(transport.Unavailable):
                origin.reference(changed)

    def test_scope_projection_excludes_credentials_and_unrelated_settings(self):
        settings = {"identity": {"organization_id": "workspace", "teams": ["team"],
                                 "credentials": "SECRET_SENTINEL", "viewer_id": "app"},
                    "credentials": "SECRET_SENTINEL"}
        projected = origin.scope(settings)
        self.assertEqual(projected, {"linear": {"organization_id": "workspace", "teams": ["team"]},
                                     "specialist_scope": None})
        self.assertNotIn("SECRET_SENTINEL", json.dumps(projected))

    def test_tool_and_owner_cli_offer_only_the_work_reference(self):
        actions = plugin.chat.SCHEMA["parameters"]["properties"]["action"]["enum"]
        self.assertIn("work_reference", actions)
        self.assertNotIn("origin_reference", actions)
        parser = argparse.ArgumentParser()
        ops.setup(parser)
        commands = next(action for action in parser._actions if isinstance(action, argparse._SubParsersAction)).choices
        self.assertIn("inspect-work", commands)
        for retired in ("inspect-origin", "inspect-cleanup", "hand-off"):
            self.assertNotIn(retired, commands)

    def test_owner_cli_inspects_only_one_complete_work_reference(self):
        parser = argparse.ArgumentParser()
        ops.setup(parser)
        args = parser.parse_args(["inspect-work", "--reference-json", '{"admission_id":"one"}'])
        from hermes_fleet_linear_plugin import work
        with (patch.object(work, "inspect", return_value={"requester": {"kind": "native_dispatcher"},
                                                           "permission_granted": False}) as inspect_work,
              patch("builtins.print")):
            self.assertEqual(ops.run(args, Path("unused"), Path("unused"), "default"), 0)
        inspect_work.assert_called_once_with({"admission_id": "one"}, {})
