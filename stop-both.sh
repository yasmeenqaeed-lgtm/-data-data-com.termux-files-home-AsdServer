#!/data/data/com.termux/files/usr/bin/bash

cd "$(dirname "$0")"

for f in .local-server.pid .internet-server.pid; do
  if [ -f "$f" ]; then
    PID="$(cat "$f")"
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null || true
      echo "تم إيقاف PID $PID"
    fi
    rm -f "$f"
  fi
done

echo "تم إيقاف السيرفرين."
