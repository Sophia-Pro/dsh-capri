#!/bin/sh
# 让「摩羯」跟 DSH 一起起、一起停。
# launchd 每 10 秒跑一次：DSH 在、她不在 → 拉起来；DSH 连着两次不在、她在 → 收掉。
APP="${CAPRI_APP:-/Applications/摩羯.app}"
# 想让它别自动管她：删掉下面这个文件即可
FLAG="$HOME/.capri-follow-dsh"
STATE="$HOME/.capri-dsh-absent"

count() { ps -Ao args | grep "$1" | grep -v grep | wc -l | tr -d ' '; }

dsh=$(count "DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness")
cap=$(count "摩羯.app/Contents/MacOS/Electron")

[ -f "$FLAG" ] || exit 0

if [ "$dsh" -gt 0 ]; then
  rm -f "$STATE"
  [ "$cap" -eq 0 ] && open -g -a "$APP" 2>/dev/null
else
  if [ "$cap" -gt 0 ]; then
    n=$(cat "$STATE" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$STATE"
    if [ "$n" -ge 2 ]; then
      rm -f "$STATE"
      osascript -e 'tell application "摩羯" to quit' >/dev/null 2>&1 || killall -q "Capri" 2>/dev/null
    fi
  fi
fi

exit 0
