"""Distribution must offer only the native Kanban integration for Linear work."""
import json
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

class LinearRetirementTests(unittest.TestCase):
    def test_retired_executor_and_cli_cannot_ship(self):
        for name in ('plugins/linear-agent', 'scripts/verify-linear-policy-trust.py',
                     'examples/linear-agent-policy.json', 'docs/linear-agent.md'):
            with self.subTest(path=name):
                self.assertFalse((ROOT / name).exists())
        dockerfile = (ROOT / 'Dockerfile').read_text()
        workflow = (ROOT / '.github/workflows/fleet-image.yml').read_text()
        self.assertNotIn('COPY plugins/linear-agent/', dockerfile)
        self.assertNotIn('verify-linear-policy-trust.py', dockerfile + workflow)
        self.assertNotIn('plugins/linear-agent,dst=', workflow)

    def test_native_linear_is_a_planned_default_and_documented(self):
        contract = json.loads((ROOT / 'contracts/plugins.json').read_text())
        ids = [item['id'] for item in contract['components']]
        self.assertNotIn('linear-agent', ids)
        native = [item for item in contract['components'] if item['id'] == 'linear']
        self.assertEqual(len(native), 1)
        self.assertIs(native[0]['default_enabled'], False)
        self.assertEqual(native[0]['default_role'], 'default')
        default = [d for d in contract['public_base']['default_set'] if 'linear' in d['covers']]
        self.assertEqual([d['id'] for d in default], ['linear'])
        self.assertEqual(default[0]['status'], 'planned')
        self.assertIn('kanban_owns_execution', native[0]['conditions'])
        self.assertTrue((ROOT / 'plugins/linear/plugin.yaml').is_file())
        self.assertIn('plugins/linear/README.md', (ROOT / 'README.md').read_text())
        self.assertNotIn('### Linear Agent', (ROOT / 'README.md').read_text())

if __name__ == '__main__':
    unittest.main()
