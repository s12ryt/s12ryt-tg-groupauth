#!/usr/bin/env bash
# 測試 scripts/sync-worker-secrets.sh 的同步邏輯（用 fake wrangler，不碰真實 Cloudflare）。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC="$SCRIPT_DIR/../scripts/sync-worker-secrets.sh"

PASS=0
FAIL=0
assert_eq() {
  if [ "$1" = "$2" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: 預期 [$2]"
    echo "      實際 [$1]"
  fi
}

TMP="$(mktemp -d)"
FAKE="$TMP/fake-wrangler.sh"
LOG="$TMP/log"
cat > "$FAKE" <<'EOF'
#!/usr/bin/env bash
# 模擬 wrangler：argv = secret put <NAME>；stdin = value
name="$3"
val="$(cat)"
printf '%s=%s\n' "$name" "$val" >> "$FAKE_LOG"
EOF
chmod +x "$FAKE"

# 執行 sync 腳本，以環境變數注入各 secret，wrangler 替換為 fake。
run_sync() {
  rm -f "$LOG"
  FAKE_LOG="$LOG" WRANGLER="$FAKE" env "$@" bash "$SYNC" 2>/dev/null
}

sorted_log() {
  [ -f "$LOG" ] && sort "$LOG" | tr '\n' '|' || echo ""
}

# Case 1：全部有值 → 6 個都同步，值正確
run_sync \
  BOT_TOKEN=tok \
  GROUP_CHAT_ID=-100 \
  WORKER_DOMAIN='https://x.example.com' \
  TURNSTILE_SITE_KEY=sk \
  TURNSTILE_SECRET_KEY=ss \
  SUPER_ADMIN_ID=7
assert_eq "$(sorted_log)" \
  'BOT_TOKEN=tok|GROUP_CHAT_ID=-100|SUPER_ADMIN_ID=7|TURNSTILE_SECRET_KEY=ss|TURNSTILE_SITE_KEY=sk|WORKER_DOMAIN=https://x.example.com|'

# Case 2：部分為空 → 空的跳過，其餘同步
run_sync \
  BOT_TOKEN=tok \
  GROUP_CHAT_ID= \
  WORKER_DOMAIN='https://x.example.com' \
  TURNSTILE_SITE_KEY= \
  TURNSTILE_SECRET_KEY=ss \
  SUPER_ADMIN_ID=
assert_eq "$(sorted_log)" \
  'BOT_TOKEN=tok|TURNSTILE_SECRET_KEY=ss|WORKER_DOMAIN=https://x.example.com|'

# Case 3：全部為空 → 不產生任何 put 記錄
run_sync \
  BOT_TOKEN= \
  GROUP_CHAT_ID= \
  WORKER_DOMAIN= \
  TURNSTILE_SITE_KEY= \
  TURNSTILE_SECRET_KEY= \
  SUPER_ADMIN_ID=
assert_eq "$(sorted_log)" ""

rm -rf "$TMP"

echo "sync-worker-secrets 測試：PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
