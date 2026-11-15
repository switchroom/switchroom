"""Public shared skill pack: membership, frontmatter and identity hygiene."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "skills"

EXPECTED_SKILLS = {
    "coding-independent-review-merge",
    "fleet-coding-clis",
    "linear-work-tracking",
    "persistent-agent-tools",
}

IDENTITY_PATTERNS = {
    "email address": re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}"),
    "IPv4 address": re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
    "long digit run": re.compile(r"\d{7,}"),
    "vault reference": re.compile("o" + "p://", re.IGNORECASE),
    "tailnet hostname": re.compile(r"\.ts\.net\b", re.IGNORECASE),
    # Linear's own docs and API reference are allowed; any other path is a workspace.
    "Linear workspace URL": re.compile(r"linear\.app/(?!docs\b|developers\b)[A-Za-z0-9_-]+"),
}

NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def frontmatter(text: str) -> dict[str, str]:
    if not text.startswith("---\n"):
        raise ValueError("missing opening frontmatter fence")
    end = text.find("\n---\n", 4)
    if end < 0:
        raise ValueError("missing closing frontmatter fence")
    fields: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if not line.strip() or line.startswith((" ", "\t", "#")):
            continue
        key, sep, value = line.partition(":")
        if not sep:
            raise ValueError(f"malformed frontmatter line: {line!r}")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        fields[key.strip()] = value
    return fields


def identity_hits(text: str) -> list[str]:
    return [label for label, pattern in IDENTITY_PATTERNS.items() if pattern.search(text)]


class SharedSkillPackTests(unittest.TestCase):
    def test_pack_contains_exactly_the_listed_skills(self) -> None:
        found = {p.name for p in PACK.iterdir() if p.is_dir()}
        self.assertEqual(found, EXPECTED_SKILLS)
        for name in EXPECTED_SKILLS:
            self.assertTrue((PACK / name / "SKILL.md").is_file(), name)

    def test_readme_explains_mounting_and_is_not_default_on(self) -> None:
        text = (PACK / "README.md").read_text(encoding="utf-8")
        self.assertIn("read-only", text)
        self.assertIn("external_dirs", text)
        self.assertIn("not on by default", text)

    def test_every_skill_has_valid_frontmatter(self) -> None:
        for name in sorted(EXPECTED_SKILLS):
            with self.subTest(skill=name):
                fields = frontmatter((PACK / name / "SKILL.md").read_text(encoding="utf-8"))
                self.assertEqual(fields.get("name"), name)
                self.assertRegex(fields["name"], NAME)
                description = fields.get("description", "")
                self.assertTrue(description.startswith("Use when "), description)
                self.assertLessEqual(len(description), 100, description)

    def test_no_file_matches_identity_patterns(self) -> None:
        files = [p for p in PACK.rglob("*") if p.is_file()]
        self.assertTrue(files)
        for path in files:
            with self.subTest(path=path.relative_to(ROOT).as_posix()):
                self.assertEqual(identity_hits(path.read_text(encoding="utf-8")), [])

    def test_identity_patterns_catch_planted_values(self) -> None:
        planted = {
            "email address": "contact someone@example.org",
            "IPv4 address": "host at 203.0.113.7",
            "long digit run": "chat 12345678",
            "vault reference": "o" + "p://vault/item/field",
            "tailnet hostname": "box.example-tail.ts.net",
            "Linear workspace URL": "https://linear.app/some-team/issue/ABC-1",
        }
        for label, sample in planted.items():
            with self.subTest(label=label):
                self.assertIn(label, identity_hits(sample))
        self.assertEqual(identity_hits("see https://linear.app/docs/editor"), [])


if __name__ == "__main__":
    unittest.main()
