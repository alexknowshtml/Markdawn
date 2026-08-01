#!/usr/bin/env bash
# Setup a new STB client org + workspace.
# Must run from packages/api to resolve pg module.
#
# Usage: bash scripts/setup-stb-client.sh <config.json>
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$(realpath "${1:?Usage: bash scripts/setup-stb-client.sh <config.json>}")"
cd "$SCRIPT_DIR/../packages/api"
exec node scripts/setup-stb-client.js "$CONFIG"
