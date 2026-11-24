#!/usr/bin/env python3
"""Find newer stable releases of the bundled CLIs and rewrite their pins (HF-851).

Channels: Claude Code `stable` dist-tag (never `latest`), claude-agent-acp / codex / grok / opencode `latest`,
GitHub CLI latest release, 1Password CLI the stable (non-beta) tag behind Docker Hub `latest`.

Two groups, one PR each:
  auto    codex, grok, opencode, gh, op      -> the workflow may arm auto-merge (still needs green required checks)
  review  claude-code, claude-agent-acp      -> labelled `needs-native-tool-review`; never auto-merged. The script does
          not touch plugins/model-providers/claude-acp (reviewed version, executable SHA, tool denies), so the
          reviewed-version gate keeps the PR red until a human completes the claude-acp-stack-upgrade review.

Usage: cli-bump.py check [--group auto|review] | apply --group auto|review
Exit codes: 0 changes found/applied (check prints JSON), 3 nothing to do, 1 error.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NPM = "https://registry.npmjs.org/"
VERSION = re.compile(r"\d+\.\d+\.\d+")
TEXT_FILES = ["Dockerfile", ".github/workflows/fleet-image.yml", "README.md", "docs/image-release.md",
              "docs/starter-overlay-acceptance.md", "tests/test_image_release.py", "tests/test_public_fatten_contract.py",
              "tests/test_public_product.py", "tests/test_vex_gate.py"]
NPM_TOOLS = {  # name -> (package, dist-tag, group, test constant prefix)
    "claude-code": ("@anthropic-ai/claude-code", "stable", "review", "CLAUDE_CODE"),
    "claude-agent-acp": ("@agentclientprotocol/claude-agent-acp", "latest", "review", "CLAUDE_AGENT_ACP"),
    "codex": ("@openai/codex", "latest", "auto", "CODEX"),
    "grok": ("@xai-official/grok", "latest", "auto", "GROK"),
    "opencode": ("opencode-ai", "latest", "auto", None),
}


def get_json(url: str, token: str | None = None):
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "switchroom-cli-bump"})
    if token and url.startswith("https://api.github.com/"):
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - fixed https endpoints
        return json.load(response)


def get_text(url: str) -> str:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "switchroom-cli-bump"}), timeout=30) as r:  # noqa: S310
        return r.read().decode()


def semver_key(version: str) -> tuple[int, ...]:
    return tuple(int(p) for p in version.split("."))


def current(root: Path = ROOT) -> dict[str, str]:
    pkg = json.loads((root / "package.json").read_text())["dependencies"]
    dockerfile = (root / "Dockerfile").read_text()
    out = {name: pkg[spec[0]] for name, spec in NPM_TOOLS.items()}
    out["gh"] = re.search(r"^ARG GH_VERSION=(\S+)$", dockerfile, re.M).group(1)
    out["op"] = re.search(r'--version\)" = "(\d+\.\d+\.\d+)"', dockerfile).group(1)
    return out


def npm_latest(package: str, tag: str) -> dict:
    quoted = package.replace("/", "%2f")
    tags = get_json(f"{NPM}{quoted}")["dist-tags"]
    version = tags[tag]
    if not VERSION.fullmatch(version):
        raise SystemExit(f"{package} {tag} is not a plain release: {version}")
    meta = get_json(f"{NPM}{quoted}/{version}")
    info = {"version": version, "integrity": meta["dist"]["integrity"]}
    if package == "@anthropic-ai/claude-code":
        native = get_json(f"{NPM}@anthropic-ai%2fclaude-code-linux-x64/{version}")
        info["native_integrity"] = native["dist"]["integrity"]
    return info


def gh_latest(token: str | None) -> dict:
    release = get_json("https://api.github.com/repos/cli/cli/releases/latest", token)
    if release.get("prerelease") or release.get("draft"):
        raise SystemExit("gh latest release is a prerelease")
    version = release["tag_name"].lstrip("v")
    assets = {a["name"]: a for a in release["assets"]}
    archive = assets[f"gh_{version}_linux_amd64.tar.gz"]
    sums = get_text(assets[f"gh_{version}_checksums.txt"]["browser_download_url"])
    sha = next(line.split()[0] for line in sums.splitlines() if line.endswith(f"gh_{version}_linux_amd64.tar.gz"))
    if not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise SystemExit("gh checksum line malformed")
    return {"version": version, "sha256": sha, "asset_id": str(archive["id"])}


def op_latest() -> dict:
    tags = get_json("https://hub.docker.com/v2/repositories/1password/op/tags/?page_size=100&ordering=last_updated")["results"]
    latest = next(t for t in tags if t["name"] == "latest")["digest"]
    versions = sorted((t["name"] for t in tags if VERSION.fullmatch(t["name"]) and t["digest"] == latest), key=semver_key)
    if not versions:
        raise SystemExit("no stable 1Password CLI tag matches `latest`")
    return {"version": versions[-1], "digest": latest}


def discover(token: str | None = None) -> dict[str, dict]:
    found = {name: npm_latest(spec[0], spec[1]) for name, spec in NPM_TOOLS.items()}
    found["gh"] = gh_latest(token)
    found["op"] = op_latest()
    return found


def group_of(name: str) -> str:
    return NPM_TOOLS[name][2] if name in NPM_TOOLS else "auto"


def plan(have: dict[str, str], found: dict[str, dict], group: str | None = None) -> list[dict]:
    """Upgrades only; a downgrade or equal version is never proposed."""
    changes = []
    for name, info in found.items():
        if group and group_of(name) != group:
            continue
        if semver_key(info["version"]) > semver_key(have[name]):
            changes.append({"tool": name, "from": have[name], "to": info["version"], "group": group_of(name), "info": info})
    return sorted(changes, key=lambda c: c["tool"])


def _sub(text: str, old: str, new: str, *, must: bool = False, label: str = "") -> str:
    pattern = re.compile(rf"(?<![\d.]){re.escape(old)}(?![\d.])")
    if must and not pattern.search(text):
        raise SystemExit(f"pin not found: {label or old}")
    return pattern.sub(new, text)


def apply(root: Path, changes: list[dict], found_old_op_digest: str | None = None) -> list[str]:
    """Rewrite pins in place. Returns touched files. package-lock.json is refreshed by the workflow with npm."""
    files = {rel: (root / rel).read_text() for rel in TEXT_FILES if (root / rel).exists()}
    package = json.loads((root / "package.json").read_text())
    for change in changes:
        name, old, new, info = change["tool"], change["from"], change["to"], change["info"]
        if name in NPM_TOOLS:
            pkg, _tag, _g, prefix = NPM_TOOLS[name]
            package["dependencies"][pkg] = new
            for rel, text in files.items():
                files[rel] = _sub(text, old, new)
            if prefix and "tests/test_image_release.py" in files:
                old_integrity = re.search(rf'^{prefix}_INTEGRITY = "([^"]+)"', files["tests/test_image_release.py"], re.M)
                if not old_integrity:
                    raise SystemExit(f"{prefix}_INTEGRITY not found")
                pairs = [(old_integrity.group(1), info["integrity"])]
                if "native_integrity" in info:
                    native = re.search(r'^CLAUDE_CODE_LINUX_X64_INTEGRITY = "([^"]+)"', files["tests/test_image_release.py"], re.M)
                    pairs.append((native.group(1), info["native_integrity"]))
                for rel in files:  # the integrity is quoted in docs as well as in the test constants
                    for old_value, new_value in pairs:
                        files[rel] = files[rel].replace(old_value, new_value)
        elif name == "gh":
            dockerfile = files["Dockerfile"]
            old_sha = re.search(r"^ARG GH_LINUX_AMD64_SHA256=(\S+)$", dockerfile, re.M).group(1)
            old_id = re.search(r"^ARG GH_LINUX_AMD64_ASSET_ID=(\S+)$", dockerfile, re.M).group(1)
            for rel, text in files.items():
                text = _sub(text, old, new).replace(old_sha, info["sha256"])
                files[rel] = re.sub(rf"(GH_LINUX_AMD64_ASSET_ID=){re.escape(old_id)}\b", rf"\g<1>{info['asset_id']}", text)
        elif name == "op":
            old_digest = re.search(r"1password/op@sha256:([0-9a-f]{64})", files["Dockerfile"]).group(1)
            new_digest = info["digest"].removeprefix("sha256:")
            for rel, text in files.items():
                files[rel] = _sub(text.replace(old_digest, new_digest), old, new)
    touched = []
    for rel, text in files.items():
        if text != (root / rel).read_text():
            (root / rel).write_text(text)
            touched.append(rel)
    (root / "package.json").write_text(json.dumps(package, indent=2) + "\n")
    touched.append("package.json")
    return touched


def verify(root: Path, changes: list[dict]) -> None:
    """After rewriting, every new version is pinned in package.json/Dockerfile/workflow and no old pin survives there."""
    have = current(root)
    for change in changes:
        if have[change["tool"]] != change["to"]:
            raise SystemExit(f"{change['tool']} still pinned at {have[change['tool']]}")
    workflow = (root / ".github/workflows/fleet-image.yml").read_text()
    for change in changes:
        if change["tool"] in {"claude-code", "claude-agent-acp", "codex", "grok"} and f'"{change["to"]}"' not in workflow:
            raise SystemExit(f"{change['tool']} not updated in fleet-image.yml")


def body(changes: list[dict]) -> str:
    review = any(c["group"] == "review" for c in changes)
    lines = ["Automated CLI pin bump (HF-851).", "", "| CLI | from | to | channel |", "|---|---|---|---|"]
    for c in changes:
        channel = {"claude-code": "npm `stable`", "gh": "GitHub latest release", "op": "stable tag behind Docker Hub `latest`"}.get(c["tool"], "npm `latest`")
        lines.append(f"| {c['tool']} | {c['from']} | {c['to']} | {channel} |")
    lines += [""]
    if review:
        lines += ["**Needs human review (`claude-acp-stack-upgrade`).** This PR is labelled `needs-native-tool-review` and is never auto-merged.",
                  "The bot did not touch `plugins/model-providers/claude-acp`: review the new executable's native tool list, add denies,",
                  "refresh the reviewed version / executable SHA256 / SDK tools SHA256, then push to this branch. The reviewed-version gate stays red until then."]
    else:
        lines += ["Non-Claude CLIs only: auto-merge is armed and fires when every required check is green."]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["check", "apply"])
    parser.add_argument("--group", choices=["auto", "review"])
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--body-file", type=Path)
    parser.add_argument("--github-token-env", default="GH_TOKEN")
    args = parser.parse_args(argv)
    if args.command == "apply" and not args.group:
        parser.error("apply needs --group")
    import os
    changes = plan(current(args.root), discover(os.environ.get(args.github_token_env)), args.group)
    if not changes:
        print(json.dumps({"changes": []}))
        return 3
    if args.command == "check":
        print(json.dumps({"changes": [{k: v for k, v in c.items() if k != "info"} for c in changes]}, indent=2))
        return 0
    touched = apply(args.root, changes)
    verify(args.root, changes)
    if args.body_file:
        args.body_file.write_text(body(changes))
    print(json.dumps({"changes": [{k: v for k, v in c.items() if k != "info"} for c in changes], "touched": touched}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (urllib.error.URLError, KeyError, StopIteration) as exc:
        print(f"cli-bump: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
