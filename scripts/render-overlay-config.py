#!/usr/bin/env python3
"""Render one agent's managed Hermes config from an overlay fleet-config/.

Shared defaults, then the reviewed starter defaults, then the agent's own
values. Every leaf must be allowlisted and typed in schema.yaml. A default
whose credential variable is not set is rendered off, never left half on.

An agent's own values may carry ${NAME} secret references (for example an MCP server
header). They pass through unresolved; with --process-env, --env-file or --check-files
each NAME must be set (only the name is ever checked or printed, never a value).

Only the names of set variables are used. Values are never read into the
output; the config refers to them as ${NAME} for Hermes to expand at start.

A default whose credential is a file inside the agent container (a Claude
login, the Linear token file) renders on only when that file was seen: run
with --check-files inside the agent container (or with --root pointing at a
copy of its layout). On the host, without --check-files, those defaults
render off and --report says why. The setup check makes the same decision.

Model roles route each task role (main, coding, fast, approvals, compression)
to a subscription plan (claude, chatgpt, grok) with fallbacks across the other
granted plans; --report prints one model-roles.plan.<plan> and one
model-roles.<role> line. A plan renders on only when its login was seen.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import switchroom_defaults as sd  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fleet-config", type=Path, required=True, help="overlay fleet-config/ directory")
    parser.add_argument("--agent", required=True, help="agent name (agents/<name>.yaml)")
    parser.add_argument("--env-file", type=Path, help="the agent's runtime env file; only names are used")
    parser.add_argument("--process-env", action="store_true", help="also count variables set in this process")
    parser.add_argument("--contract", type=Path, default=sd.CONTRACT)
    parser.add_argument("--output", type=Path, help="write config YAML here instead of stdout")
    parser.add_argument("--report", action="store_true", help="print one line per default to stderr")
    parser.add_argument("--provenance", type=Path, help="write leaf provenance JSON here")
    parser.add_argument("--check-files", action="store_true",
                        help="look at the login files, mounted plugins and skill pack (run inside the agent "
                             "container); without it, login-backed defaults render off")
    parser.add_argument("--hermes-home", default=None,
                        help="the agent's HERMES_HOME inside the container (default: $HERMES_HOME or /opt/data)")
    parser.add_argument("--root", type=Path, default=Path("/"),
                        help="treat this directory as the container root for --check-files (testing)")
    args = parser.parse_args(argv)
    try:
        environ = sd.environ_from(args.env_file, args.process_env)
        names = sd.env_names(environ)
        paths = None
        if args.check_files:
            hermes_home = args.hermes_home or str(environ.get("HERMES_HOME", "")).strip() or "/opt/data"
            paths = sd.ContainerPaths(root=args.root, hermes_home=hermes_home)
        # ${NAME} references in the agent's own values are checked only when the render can see an environment.
        sees_env = bool(args.process_env or args.env_file or args.check_files)
        rendered = sd.render(args.fleet_config, args.agent, names, args.contract, environ=environ, paths=paths,
                             verify_agent_refs=sees_env)
        text = sd.dump_config(rendered)
        if args.output:
            args.output.write_text(text, encoding="utf-8")
        else:
            sys.stdout.write(text)
        if args.provenance:
            args.provenance.write_text(json.dumps({"fields": rendered.provenance}, indent=2, sort_keys=True) + "\n",
                                       encoding="utf-8")
        if args.report:
            for line in rendered.report_lines():
                print(line, file=sys.stderr)
        return 0
    except (sd.DefaultsError, OSError) as exc:
        print(f"render-overlay-config: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
