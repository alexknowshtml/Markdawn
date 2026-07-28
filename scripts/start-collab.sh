#!/usr/bin/env bash
set -a
source /home/alexhillman/apps/markdawn-stb/.env
set +a
exec node /home/alexhillman/apps/markdawn-stb/packages/collab/dist/index.js
