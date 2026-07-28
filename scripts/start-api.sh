#!/usr/bin/env bash
set -a
source /home/alexhillman/apps/markdawn-stb/.env
set +a
exec node /home/alexhillman/apps/markdawn-stb/packages/api/dist/index.mjs
