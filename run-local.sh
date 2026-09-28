#!/data/data/com.termux/files/usr/bin/bash
set -e
cd "$(dirname "$0")"

SYNC_SECRET_FILE="${SYNC_SECRET_FILE:-$PWD/.sync-secret}"

if [ -z "${SYNC_SECRET:-}" ] && [ -f "$SYNC_SECRET_FILE" ]; then
  SYNC_SECRET="$(tr -d '\r\n' < "$SYNC_SECRET_FILE")"
fi

if [ -z "${SYNC_SECRET:-}" ]; then
  echo "ERROR: SYNC_SECRET غير مضبوط."
  exit 1
fi

PORT="${LOCAL_PORT:-3001}"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:${PORT}}"
INTERNET_URL="${INTERNET_URL:-http://127.0.0.1:3002}"

SERVER_MODE=local \
ADMIN_USERNAME="${ADMIN_USERNAME:-Asd}" \
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Asd}" \
PORT="$PORT" \
HOST="${HOST:-0.0.0.0}" \
DATA_DIR="${DATA_DIR_LOCAL:-$PWD/data-local}" \
LOCAL_URL="$LOCAL_URL" \
INTERNET_URL="$INTERNET_URL" \
SYNC_SECRET="$SYNC_SECRET" \
node server.js
