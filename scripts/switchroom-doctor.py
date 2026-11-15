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

With --linear-receiver-config (the overlay's linear-receiver.json) it also
prints `linear-receiver: on` or `linear-receiver: off: <reason>` for the Linear
webhook receiver sidecar, and one `linear-receiver.<agent>: off: ...` line per
agent whose signing secret is not set.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import switchroom_defaults as sd  # noqa: E402

RECEIVER = Path(__file__).resolve().parents[1] / "sidecars" / "linear-receiver" / "receiver.py"


def linear_receiver_lines(config: Path, env_file: Path | None) -> list[str]:
    """`linear-receiver: on` or `linear-receiver: off: <reason>`, plus one line per agent left off.

    Reads the same env file the receiver container gets; a missing file means
    nothing is set. Secret values are never printed.
    """
    import importlib.util

    spec = importlib.util.spec_from_file_location("switchroom_linear_receiver", RECEIVER)
    receiver = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(spec.name, receiver)  # dataclasses resolve their module by name
    spec.loader.exec_module(receiver)
    env_file = env_file or config.parent / "secrets" / "linear-receiver.env"
    environ = sd.read_env_file(env_file) if env_file.exists() else {}
    decision, _agents, notes = receiver.decide(config, environ)
    return [decision.line(), *(f"linear-receiver.{note}" for note in notes)]


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
    parser.add_argument("--linear-receiver-config", type=Path,
                        help="also report the Linear webhook receiver: the overlay's linear-receiver.json")
    parser.add_argument("--linear-receiver-env", type=Path,
                        help="the receiver's env file (default: secrets/linear-receiver.env beside the config)")
    args = parser.parse_args(argv)
    if args.linear_receiver_env and not args.linear_receiver_config:
        parser.error("--linear-receiver-env needs --linear-receiver-config")
    try:
        config = sd.load_yaml(args.config, "rendered config")
        environ = sd.environ_from(args.env_file, not args.no_process_env)
        granted = [p.strip() for p in args.granted.split(",") if p.strip()] if args.granted else None
        hermes_home = args.hermes_home or str(environ.get("HERMES_HOME", "")).strip() or "/opt/data"
        paths = sd.ContainerPaths(root=args.root, hermes_home=hermes_home)
        lines, problems = sd.diagnose(config, environ, args.contract, check_files=args.check_files,
                                      granted=granted, paths=paths)
        if args.linear_receiver_config:
            lines.extend(linear_receiver_lines(args.linear_receiver_config, args.linear_receiver_env))
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
