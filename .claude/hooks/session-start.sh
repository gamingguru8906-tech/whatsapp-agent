#!/bin/bash
set -euo pipefail

# Only run in Claude Code cloud sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Node dependencies for the WhatsApp agent and its tests.
npm install --no-audit --no-fund

# Python dependencies for the onetake skill (.claude/skills/onetake).
# playwright is pinned to the release that matches the Chromium build
# preinstalled in cloud sessions (/opt/pw-browsers), so no browser download.
pip install --quiet --disable-pip-version-check --root-user-action=ignore \
  "playwright==1.56.0" numpy scipy Pillow matplotlib opencv-python-headless fonttools brotli
