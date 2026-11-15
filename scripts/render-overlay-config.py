#!/usr/bin/env python3
"""Render one agent's managed Hermes config from an overlay fleet-config/.

Shared defaults, then the reviewed starter defaults, then the agent's own
values. Every leaf must be allowlisted and typed in schema.yaml. A default
whose credential variable is not set is rendered off, never left half on.

Only the names of set variables are used. Values are never read into the
output; the config refers to them as ${NAME} for Hermes to expand at start.
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
    args = parser.parse_args(argv)
    try:
        names = sd.env_names(sd.environ_from(args.env_file, args.process_env))
        rendered = sd.render(args.fleet_config, args.agent, names, args.contract)
        text = sd.dump_config(rendered)
        if args.output:
            args.output.write_text(text, encoding="utf-8")
        else:
            sys.stdout.write(text)
        if args.provenance:
            args.provenance.write_text(json.dumps({"fields": rendered.provenance}, indent=2, sort_keys=True) + "\n",
                                       encoding="utf-8")
        if args.report:
            for default_id, decision in rendered.decisions.items():
                print(decision.line(default_id), file=sys.stderr)
        return 0
    except (sd.DefaultsError, OSError) as exc:
        print(f"render-overlay-config: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
