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
  exit 1
fi

if [ "$USE_ELECTRON" = "1" ]; then
  ELECTRON_RUN_AS_NODE=1 "$NODE_EXE" cli.js restore "$@"
else
  "$NODE_EXE" cli.js restore "$@"
fi
