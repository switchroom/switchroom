#!/usr/bin/env python3
"""Raise the baked Honcho plugin's ``honcho-ai`` floor to the SDK this image ships (HF-757).

Each profile's dependency environment is a PM generation seeded from the previous
generation's resolved lock. uv keeps every seeded pin that still satisfies the
member requirements, and core's lock does not pin ``honcho-ai``, so the plugin's
``honcho-ai>=2.2.0,<3`` let every profile keep the 2.5.1 it first resolved while
the image's own interpreter carried the reviewed SDK.

This script reads the exact ``honcho-ai==X`` pin from Fleet's hashed SDK lock and
rewrites the plugin requirement to ``honcho-ai>=X,<3``. The member stamp changes
with the file, so container boot rebuilds the generation and uv must move the
seeded pin up to the reviewed version. It fails closed when either the lock or
the plugin no longer has the expected shape.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

_PIN_RE = re.compile(r"^honcho-ai==(\d+\.\d+\.\d+)\b", re.MULTILINE)
_REQUIREMENT_RE = re.compile(r'"honcho-ai>=(\d+\.\d+\.\d+),<3"')


def reviewed_version(requirements: str) -> str:
    pins = _PIN_RE.findall(requirements)
    if len(pins) != 1:
        raise SystemExit("honcho SDK lock: expected exactly one honcho-ai==X.Y.Z pin")
    return pins[0]


def _version(text: str) -> tuple[int, ...]:
    return tuple(int(part) for part in text.split("."))


def patch_pyproject(source: str, version: str) -> str:
    matches = _REQUIREMENT_RE.findall(source)
    if len(matches) != 1:
        raise SystemExit('honcho plugin: expected one "honcho-ai>=X.Y.Z,<3" requirement; review the pin')
    if _version(matches[0]) > _version(version):
        raise SystemExit(f"honcho plugin already needs honcho-ai>={matches[0]}, above the shipped {version}")
    return _REQUIREMENT_RE.sub(f'"honcho-ai>={version},<3"', source, count=1)


def main(argv: list[str]) -> int:
    plugin = Path(argv[1] if len(argv) > 1 else "/opt/hermes/plugins/memory/honcho")
    lock = Path(argv[2] if len(argv) > 2 else "/tmp/honcho-sdk-requirements.txt")
    version = reviewed_version(lock.read_text(encoding="utf-8"))
    pyproject = plugin / "pyproject.toml"
    pyproject.write_text(patch_pyproject(pyproject.read_text(encoding="utf-8"), version), encoding="utf-8")
    print(f"patched {pyproject}: honcho-ai>={version},<3")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
