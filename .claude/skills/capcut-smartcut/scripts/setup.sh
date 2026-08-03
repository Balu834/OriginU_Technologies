#!/bin/bash
# One-time setup: create a venv next to this script and install dependencies.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ ! -x "$DIR/.venv/bin/python" ]; then
    python3 -m venv "$DIR/.venv"
fi
"$DIR/.venv/bin/pip" install --quiet "pydantic>=2.0.0" "pydantic-settings>=2.0.0"
# Optional: OpenAI-enhanced duplicate detection
if [ "$1" = "--with-openai" ]; then
    "$DIR/.venv/bin/pip" install --quiet "openai>=1.0.0"
fi
echo "SmartCut setup complete: $DIR/.venv"
