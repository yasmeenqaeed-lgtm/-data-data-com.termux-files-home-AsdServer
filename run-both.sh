#!/data/data/com.termux/files/usr/bin/bash
set -e
cd "$(dirname "$0")"

if [ ! -f .sync-secret ]; then
  echo "إنشاء مفتاح المزامنة..."
  openssl rand -hex 32 > .sync-secret
  chmod 600 .sync-secret
fi

chmod +x run-local.sh run-internet.sh

echo "تشغيل السيرفر المحلي على المنفذ 3001..."
./run-local.sh > local-server.log 2>&1 &
LOCAL_PID=$!

echo "تشغيل سيرفر الإنترنت على المنفذ 3002..."
./run-internet.sh > internet-server.log 2>&1 &
INTERNET_PID=$!

echo "$LOCAL_PID" > .local-server.pid
echo "$INTERNET_PID" > .internet-server.pid

echo
echo "======================================"
echo "تم تشغيل السيرفرين"
echo "Local PID:    $LOCAL_PID"
echo "Internet PID: $INTERNET_PID"
echo "Local:        http://127.0.0.1:3001"
echo "Internet:     http://127.0.0.1:3002"
echo "======================================"
echo
echo "لمراقبة السجلات:"
echo "tail -f local-server.log"
echo "tail -f internet-server.log"
