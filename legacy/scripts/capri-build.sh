#!/bin/sh
# 重新打包「摩羯」：拷源码 → 用固定证书签名（授权不会因重打包失效）
# 用法：./scripts/capri-build.sh [源码目录] [目标 .app 路径] [签名身份]
# 重新打包「摩羯」：拷源码 → 用固定证书签名（这样系统给的辅助功能授权不会因为重打包而失效）
set -e
SRC="${1:-$HOME/Applications/Capri-src}"
APP="${2:-/Applications/摩羯.app}"
R="$APP/Contents/Resources"
IDENT="${3:-MoJie Local Signer}"

PID=$(curl -s --max-time 2 http://127.0.0.1:47823/health 2>/dev/null | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')
[ -n "$PID" ] && kill -9 "$PID" 2>/dev/null || true
pkill -9 -f "摩羯.app/Contents/MacOS/Electron" 2>/dev/null || true
sleep 2

rm -rf "$R/app"
mkdir -p "$R/app/node_modules/@fontsource"
for f in package.json src assets hooks scripts LICENSE; do cp -R "$SRC/$f" "$R/app/"; done
cp -R "$SRC/node_modules/@fontsource/chakra-petch" "$SRC/node_modules/@fontsource/jetbrains-mono" "$R/app/node_modules/@fontsource/"

codesign --force --deep --sign "$IDENT" "$APP"
env -u ELECTRON_RUN_AS_NODE open -g "$APP"
echo "built + launched"
