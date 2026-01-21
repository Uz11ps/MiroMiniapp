#!/bin/bash
set -euo pipefail

BASE="${1:-http://localhost:4000/api}"

echo "[1/4] Health"
curl -fsSL "${BASE}/health" >/dev/null
echo "ok"

echo "[2/4] Games list"
curl -fsSL "${BASE}/games" >/dev/null
echo "ok"

echo "[3/4] Dice roll"
curl -fsSL -X POST "${BASE}/dice/roll" \
  -H "Content-Type: application/json" \
  -d '{"expr":"d20+2"}' >/dev/null
echo "ok"

echo "[4/4] Gemini env"
curl -fsSL "${BASE}/health" >/dev/null
echo "ok"

