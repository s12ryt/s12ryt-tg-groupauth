#!/usr/bin/env bash
#
# 同步 GitHub Actions secrets 到 Cloudflare Worker secrets。
#
# 用法（由 GitHub workflow 呼叫）：
#   以環境變數注入 BOT_TOKEN / GROUP_CHAT_ID / ... 等，
#   本腳本逐一檢查：非空則執行 `wrangler secret put <NAME>`（值由 stdin 傳入），
#   空值則跳過並 warning（保留 Worker 端原值，不覆寫為空）。
#
# 任一 put 失敗會讓腳本以非零退出（使 workflow step 失敗）。
#
# 測試：可覆寫 WRANGLER 環境變數為 fake 命令（見 tests/run-sync-test.sh）。
set -uo pipefail

# wrangler 命令；預設 npx wrangler（讀取 wrangler.toml 的 worker 名稱）。
: "${WRANGLER:=npx wrangler}"

# 需同步的 Worker 機密變數清單（與 Env 介面一致）。
vars=(
  BOT_TOKEN
  GROUP_CHAT_ID
  WORKER_DOMAIN
  TURNSTILE_SITE_KEY
  TURNSTILE_SECRET_KEY
  SUPER_ADMIN_ID
)

failed=0
for name in "${vars[@]}"; do
  # 間接取值；未設定或空則預設空字串（配合 set -u）。
  val="${!name:-}"
  if [ -z "$val" ]; then
    echo "::warning::GitHub secret $name 未設定，跳過（Worker 端保留原值）"
    continue
  fi
  # stdin 傳值，避免值出現在命令列參數（避免程序列表洩漏）。
  if printf '%s' "$val" | $WRANGLER secret put "$name"; then
    echo "已同步 secret: $name"
  else
    echo "::error::同步 $name 失敗"
    failed=1
  fi
done

exit "$failed"
