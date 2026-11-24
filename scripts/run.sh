#!/usr/bin/env bash
# Chạy hệ thống trên macOS / Linux:  ./scripts/run.sh [--reload] [--port 8000] [--lan]
# --lan: mở cho máy khác cùng Wi-Fi (app điện thoại mobile/ cần cái này).
# Tự build lại frontend/dist nếu frontend/src mới hơn và máy có Node.js.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
port=8000; reload=(); host=127.0.0.1
while [ $# -gt 0 ]; do
  case "$1" in
    --reload) reload=(--reload --reload-dir app) ;;
    --port) port="$2"; shift ;;
    --lan) host=0.0.0.0 ;;
  esac
  shift
done
cd "$root"
src=$(git log -1 --format=%ct -- frontend/src 2>/dev/null || echo 0)
dist=$(git log -1 --format=%ct -- frontend/dist 2>/dev/null || echo 0)
if [ "${src:-0}" -gt "${dist:-0}" ] || [ -n "$(git status --porcelain -- frontend/src 2>/dev/null)" ]; then
  if command -v npm >/dev/null; then
    echo "Giao diện có thay đổi chưa build, đang build lại frontend/dist..."
    (cd frontend && { [ -d node_modules ] || npm install --no-audit --no-fund; } && npm run build)
  else
    echo "frontend/src mới hơn frontend/dist nhưng máy chưa có Node.js: giao diện có thể là bản cũ."
  fi
fi
cd ai-backend
for v in .venv venv; do [ -f "$v/bin/activate" ] && . "$v/bin/activate" && break; done
echo "Mở http://localhost:$port (Ctrl+C để dừng)"
[ "$host" = 0.0.0.0 ] && echo "Điện thoại cùng Wi-Fi nhập địa chỉ máy chủ: <IP máy này>:$port"
exec python -m uvicorn app.main:app --host "$host" --port "$port" ${reload[@]+"${reload[@]}"}
