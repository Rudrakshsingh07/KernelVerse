#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH." >&2
  exit 1
fi

echo "Building and starting KernelVerse…"
docker compose up --build -d

echo "Waiting for the API to come up…"
for i in $(seq 1 60); do
  if curl -sf http://localhost:8000/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "Waiting for the frontend…"
for i in $(seq 1 60); do
  if curl -sf http://localhost:3000 >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo ""
echo "KernelVerse is running:"
echo "  App: http://localhost:3000"
echo "  API: http://localhost:8000  (docs at /docs)"
echo ""
echo "Useful commands:"
echo "  docker compose logs -f     # follow logs"
echo "  docker compose down        # stop everything"
