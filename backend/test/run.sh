#!/usr/bin/env bash
# Boots a throwaway server (own DB + storage), waits until it is READY, runs the smoke test.
# Usage: bash test/run.sh local   |   bash test/run.sh ai
MODE=${1:-local}
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
export PORT=4100 DB_PATH="$TMP/test.db" STORAGE_DIR="$TMP/storage"
if [ "$MODE" = "ai" ]; then
  MOCK_PORT=5055 node test/mock-ai.js & MOCK=$!
  export ANTHROPIC_API_KEY=test-key ANTHROPIC_BASE_URL=http://localhost:5055
fi
node server.js > "$TMP/server.log" 2>&1 & SRV=$!
for i in $(seq 1 40); do curl -s localhost:4100/api/health > /dev/null && break; sleep 0.25; done
BASE=http://localhost:4100 MODE=$MODE node test/smoke.js; CODE=$?
kill $SRV $MOCK 2>/dev/null
[ $CODE -ne 0 ] && cat "$TMP/server.log"
rm -rf "$TMP"
exit $CODE
