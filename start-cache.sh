#!/usr/bin/env bash
# Launch KernelVerse and open the Cache simulator.
set -euo pipefail
cd "$(dirname "$0")"
KV_OPEN_PATH="/simulator/cache" exec ./start.sh
