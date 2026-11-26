#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

find_node() {
  for cand in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$cand" ]; then
      ver=$("$cand" -p "process.versions.node" 2>/dev/null || true)
      maj=${ver%%.*}
      if [ -n "$maj" ] && [ "$maj" -ge 18 ] 2>/dev/null; then
        NODE_EXE="$cand"
        USE_ELECTRON=0
        return 0
      fi
    fi
  done
  return 1
}

NODE_EXE=""
USE_ELECTRON=0
if ! find_node; then
  for ag_bin in \
    "/Applications/Antigravity.app/Contents/MacOS/Electron" \
    "$HOME/Applications/Antigravity.app/Contents/MacOS/Electron" \
    "/Applications/Antigravity IDE.app/Contents/MacOS/Electron" \
    "/opt/antigravity/antigravity" \
    "/usr/lib/antigravity/antigravity"; do
    if [ -x "$ag_bin" ]; then
      NODE_EXE="$ag_bin"
      USE_ELECTRON=1
      break
    fi
  done
fi

if [ -z "$NODE_EXE" ]; then
  echo "❌ [缺少依赖] 未检测到 Node.js (>=18) 或 Antigravity 运行时。"
  echo "请先安装 Node.js 22+ (https://nodejs.org/) 后再试。"
  exit 1
fi

run_js() {
  if [ "$USE_ELECTRON" = "1" ]; then
    ELECTRON_RUN_AS_NODE=1 "$NODE_EXE" "$@"
  else
    "$NODE_EXE" "$@"
  fi
}

if [ ! -f "meter-renderer.js" ] && [ -f "scripts/build-renderer.js" ]; then
  run_js scripts/build-renderer.js
fi

if [ "$(uname -s)" = "Darwin" ]; then
  if [ -f "/Applications/Antigravity.app/Contents/Info.plist" ] && grep -q "ElectronAsarIntegrity" "/Applications/Antigravity.app/Contents/Info.plist" 2>/dev/null; then
    echo "⚠️  [macOS 预检] 检测到 Antigravity.app 已启用 ElectronAsarIntegrity (ASAR 完整性与官方签名校验)。"
    echo "    直接修改 app.asar 可能导致客户端无法启动或丢失 Keychain/TCC 授权。"
    echo "    👉 推荐改用免改盘守护模式：node cli.js watch"
    echo "    （若需测试强行写入 ASAR 并在自签环境自行重签，可追加参数 --force-mac-asar）"
  fi
fi

run_js cli.js install "$@"
