#!/usr/bin/env python3
"""SmartCut CLI — thin command-line wrapper around the bundled smartcut package.

Usage:
    python cli.py <command> [--args '<json object of keyword arguments>']

Commands map 1:1 to the smartcut tool functions. All output is JSON on stdout.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from smartcut.tools.capcut_projects import (  # noqa: E402
    batch_edit_subtitles,
    cut_time_ranges,
    edit_subtitle,
    fix_word_timing,
    list_capcut_projects,
    merge_subtitles,
    open_capcut_project,
    smart_cut_project,
    split_subtitle,
)

COMMANDS = {
    "list": list_capcut_projects,
    "open": open_capcut_project,
    "smart-cut": smart_cut_project,
    "cut-ranges": cut_time_ranges,
    "edit-subtitle": edit_subtitle,
    "split-subtitle": split_subtitle,
    "merge-subtitles": merge_subtitles,
    "fix-word-timing": fix_word_timing,
    "batch-edit": batch_edit_subtitles,
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=sorted(COMMANDS))
    parser.add_argument(
        "--args",
        default="{}",
        help="JSON object of keyword arguments for the command",
    )
    ns = parser.parse_args()

    try:
        kwargs = json.loads(ns.args)
        if not isinstance(kwargs, dict):
            raise ValueError("--args must be a JSON object")
        result = asyncio.run(COMMANDS[ns.command](**kwargs))
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as e:  # surface a clean error for the caller
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
