#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p /tmp/opencode

if [[ ! -x api/.venv/bin/python ]]; then
  echo "Creating Python virtualenv and installing backend deps…"
  python3 -m venv api/.venv
  api/.venv/bin/pip install --quiet -r api/requirements.txt
fi

if [[ ! -d web/node_modules ]]; then
  echo "Installing frontend deps…"
  (cd web && npm install)
fi

echo "Starting API on http://127.0.0.1:8000 …"
(cd api && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload) \
  > /tmp/opencode/api.log 2>&1 &
API_PID=$!

echo "Starting web on http://127.0.0.1:3000 …"
(cd web && npm run dev) > /tmp/opencode/web.log 2>&1 &
WEB_PID=$!

cleanup() {
  echo ""
  echo "Stopping KernelVerse…"
  kill "$API_PID" "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Waiting for the API…"
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1; then break; fi
  sleep 1
done
echo "Waiting for the frontend…"
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:3000 >/dev/null 2>&1; then break; fi
  sleep 1
done

echo ""
echo "KernelVerse is running:"
echo "  App: http://127.0.0.1:3000"
echo "  API: http://127.0.0.1:8000  (docs at /docs)"
echo ""
echo "Logs: /tmp/opencode/api.log  /tmp/opencode/web.log"
echo "Press Ctrl+C to stop."

wait
