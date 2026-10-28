#!/usr/bin/env bash
# 小电拼网页版 · macOS / Linux 启动脚本
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 Node.js。"
  echo "装一个 18 或更新的版本：https://nodejs.org"
  exit 1
fi

MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 18 ]; then
  echo "Node.js 版本太低（当前 $(node -v)），需要 18 以上。"
  exit 1
fi

PORT="${PORT:-7788}"

# 起来之后自动开浏览器。失败了也无所谓，手动打开一样。
(
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.4
    if curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:${PORT}/"; then
      if command -v open >/dev/null 2>&1; then
        open "http://127.0.0.1:${PORT}/"
      elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "http://127.0.0.1:${PORT}/" >/dev/null 2>&1
      fi
      exit 0
    fi
  done
) &

exec node server.mjs "$@"
