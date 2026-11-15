#!/usr/bin/env python3
"""Setup check: which reviewed defaults are on, and which turned themselves off.

Prints one line per default in contracts/plugins.json:

    <default>: on
    <default>: off: <reason>

and a `warning: <default>: ...` line for a risky per-agent choice that is
allowed (today: an agent that sets
plugins.config.disk-cleanup.allow_manual_delete: true).

A missing credential or sidecar is a degraded default, not a failure: the
exit status stays 0. Exit 1 means a contract problem (for example an
ungranted model provider in the chain, or disk cleanup in a deleting mode);
exit 2 means unreadable input. Variable values, file contents and 1Password
references are never printed, only names and paths.

With --check-files (inside the agent container) it also requires the login
files, the mounted plugins and skill pack, and the 1Password mapping, and
prints one `coding-clis.<cli>` line per coding CLI.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import switchroom_defaults as sd  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", type=Path, required=True, help="rendered agent config YAML")
    parser.add_argument("--env-file", type=Path, help="the agent's runtime env file")
    parser.add_argument("--no-process-env", action="store_true", help="ignore this process's environment")
    parser.add_argument("--check-files", action="store_true",
                        help="also require the login files, mounted plugins, skill pack and 1Password mapping "
                             "(run inside the agent container)")
    parser.add_argument("--granted", help="comma-separated granted model providers to enforce")
    parser.add_argument("--hermes-home", default=None,
                        help="the agent's HERMES_HOME inside the container (default: $HERMES_HOME or /opt/data)")
    parser.add_argument("--root", type=Path, default=Path("/"),
                        help="treat this directory as the container root for --check-files (testing)")
    parser.add_argument("--contract", type=Path, default=sd.CONTRACT)
    args = parser.parse_args(argv)
    try:
        config = sd.load_yaml(args.config, "rendered config")
        environ = sd.environ_from(args.env_file, not args.no_process_env)
        granted = [p.strip() for p in args.granted.split(",") if p.strip()] if args.granted else None
        hermes_home = args.hermes_home or str(environ.get("HERMES_HOME", "")).strip() or "/opt/data"
        paths = sd.ContainerPaths(root=args.root, hermes_home=hermes_home)
        lines, problems = sd.diagnose(config, environ, args.contract, check_files=args.check_files,
                                      granted=granted, paths=paths)
    except (sd.DefaultsError, OSError) as exc:
        print(f"switchroom-doctor: {exc}", file=sys.stderr)
        return 2
    for line in lines:
        print(line)
    for problem in problems:
        print(f"problem: {problem}")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
