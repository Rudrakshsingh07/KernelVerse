#!/usr/bin/env bash
# Launch KernelVerse and open the Paging simulator.
set -euo pipefail
cd "$(dirname "$0")"
KV_OPEN_PATH="/simulator/paging" exec ./start.sh
