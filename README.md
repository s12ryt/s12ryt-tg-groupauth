# s12ryt-tg-groupauth

以 **Cloudflare Worker** 託管的 **Telegram 群組驗證機器人**。
採用「點擊按鈕 → Cloudflare Turnstile 人機驗證 → 臨時 UUID → 私訊機器人」的高安全性驗證流程，可有效阻擋一般機器人入群。

- 語言：TypeScript
- 框架：[grammY](https://grammy.dev/)（Cloudflare Workers 一等支援）
- 儲存：Cloudflare KV
- 人機驗證：Cloudflare Turnstile
- 定時：Cloudflare Cron Triggers（每分鐘）

---

## 驗證流程

```
新成員入群
   │
   ▼
① 機器人立即限制該成員發言權限
② 發送含「開始驗證」按鈕的提示訊息（按鈕帶 user_id）
   │
   ▼  使用者點按鈕
③ 開啟 {Worker域名}/captcha?u={user_id} 頁面
④ 完成 Cloudflare Turnstile 人機驗證
   │
   ▼
⑤ 後端 siteverify 通過 → 簽發綁定 user_id 的臨時 UUID
⑥ 頁面顯示 UUID，提示「私訊機器人發送此 UUID」
   │
   ▼  使用者私訊機器人發送 UUID
⑦ 機器人核對：UUID 存在 / 未過期 / user_id 一致
   │
   ├─ 一致 → 解除限制 + 刪除提示訊息 +（可選）恭喜訊息
   └─ 不符 → 拒絕並提示
   │
   ▼  5 分鐘內未完成
⑧ Cron + Webhook 雙軌掃描 → 執行 ban
```

---

## 前置準備

### 1. 建立 Telegram 機器人
向 [@BotFather](https://t.me/BotFather) 建立機器人，取得 **Bot Token**。

### 2. 取得目標群組 chat_id
將機器人加入群組後，可透過任何 getUpdates 工具或 [@userinfobot](https://t.me/userinfobot) 取得群組 `chat_id`（負數，如 `-1001234567890`）。

### 3. 建立 Cloudflare Turnstile
至 Cloudflare Dashboard → **Turnstile** → 新增站點：
- **Widget Mode**：Managed（建議）
- **Domain**：填入你的 Worker 域名（如 `xxx.workers.dev` 或自訂網域）
- 建立後取得 **Site Key**（前端）與 **Secret Key**（後端）

### 4. 取得自己的 user_id（作為超級管理員）
透過 [@userinfobot](https://t.me/userinfobot) 取得你的數字 user_id。

---

## 部署步驟

### ① 安裝相依
```bash
npm install
```

### ② 登入 Cloudflare
```bash
npx wrangler login
```

### ③ 建立 KV namespace
```bash
npx wrangler kv namespace create KV
```
將輸出的 `id` 填入 `wrangler.toml`：
```toml
[[kv_namespaces]]
binding = "KV"
id = "貼上這裡的 namespace id"
```

### ④ 設定 Secrets
> 若使用 GitHub Actions 部署，這些 secrets 改放 repo 的 Actions secrets 即可，部署時會自動同步（見下方「透過 GitHub Actions 部署」）。以下為**本機部署**的設定方式。

逐一設定（**不要**寫進 wrangler.toml）：
```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put GROUP_CHAT_ID
npx wrangler secret put WORKER_DOMAIN
npx wrangler secret put TURNSTILE_SITE_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put SUPER_ADMIN_ID
```

對應數值：

| Secret | 值 |
|--------|----|
| `BOT_TOKEN` | 機器人 Token |
| `GROUP_CHAT_ID` | 目標群組 chat_id（如 `-1001234567890`） |
| `WORKER_DOMAIN` | Worker 公開域名，含 `https://`（如 `https://tg-groupauth.xxx.workers.dev`） |
| `TURNSTILE_SITE_KEY` | Turnstile Site Key |
| `TURNSTILE_SECRET_KEY` | Turnstile Secret Key |
| `SUPER_ADMIN_ID` | 你的 user_id |

### ⑤ 部署
```bash
npm run deploy
```
部署後記下輸出的 Worker URL（即 `WORKER_DOMAIN`）。

### ⑥ 設定 Telegram Webhook
將 webhook 指向 Worker 的 `/tg` 路徑：
```bash
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_DOMAIN>/tg"
```
例如：
```bash
curl -s "https://api.telegram.org/bot123:ABC/setWebhook?url=https://tg-groupauth.xxx.workers.dev/tg"
```

### ⑦ 將機器人設為群組管理員
在目標群組中將機器人 **設為管理員**，並開啟以下權限：
- ❌ 刪除訊息
- ❌ 封禁使用者（Ban users）
- ❌ 限制使用者（Restrict users）

> 未具備這些權限時，限制發言 / ban / 刪訊息會失敗。

---

## 透過 GitHub Actions 部署（可選）

專案內附 `.github/workflows/deploy.yml`，支援**手動觸發**部署（從 GitHub Actions 頁面點 Run workflow）。

### 設定 GitHub Secrets
至 repo 的 `Settings → Secrets and variables → Actions` 新增以下全部變數：

| Secret | 說明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（需 `Workers Scripts:Edit` 權限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `BOT_TOKEN` | TG 機器人 Token |
| `GROUP_CHAT_ID` | 目標群組 chat_id（如 `-1001234567890`） |
| `WORKER_DOMAIN` | Worker 公開域名，含 `https://` |
| `TURNSTILE_SITE_KEY` | Turnstile Site Key |
| `TURNSTILE_SECRET_KEY` | Turnstile Secret Key |
| `SUPER_ADMIN_ID` | 超級管理員 user_id |

> 建立 API Token：Cloudflare Dashboard → My Profile → API Tokens → 建立自訂權杖，加入「Edit Cloudflare Workers」範本。

### 部署前注意
- `wrangler.toml` 的 KV namespace `id` 必須先填入真實值（workflow 會檢查佔位符並阻擋部署）。
- **應用層 secrets 也在上表中**：部署時 workflow 會自動用 `wrangler secret put` 把它們同步到 Cloudflare Worker，**無需再本機設定**（空值的會自動跳過、保留原值）。

### 流程
workflow 會依序執行：checkout → secrets 預檢 → KV id 檢查 → `npm ci` → 型別檢查 → 單元測試 → `wrangler deploy` → **同步 Worker Secrets**。
另有 `skip_tests` 輸入可在緊急時跳過測試（不建議）。

> 同步邏輯可獨立測試：`npm run test:sync`

---

## 機器人指令

| 指令 | 對象 | 說明 |
|------|------|------|
| `/start` | 私訊 | 歡迎與流程引導 |
| `/help` | 所有人 | 使用說明（管理員會額外看到管理指令） |
| `/stats` | 管理員 | 驗證統計（已驗證 / 已封禁 / 待驗證） |
| `/unban <user_id>` | 管理員 | 解除封禁 |
| `/manualverify <user_id>` | 管理員 | 手動通過某人驗證 |
| `/settimeout <秒>` | 管理員 | 設定超時時長（30–3600） |
| `/toggle_announce` | 管理員 | 開／關「恭喜入群」訊息 |
| （私訊發送 UUID） | 所有人 | 完成驗證的核心互動 |

> 管理員資格：該群管理員（`getChatAdministrators` 動態判斷）或 `SUPER_ADMIN_ID`（跨群恆有效）。

---

## 動態設定預設值

以下設定存於 KV，可由指令即時調整，預設值如下：

| 設定 | 預設 | 說明 |
|------|------|------|
| `config:timeout` | `300`（秒） | 超時未驗證即 ban |
| `config:announce_enabled` | `true` | 是否發恭喜入群訊息 |
| `config:announce_delete_after` | `60`（秒） | 恭喜訊息發出後自動刪除的秒數 |

> ⚠️ **自動刪除精確度限制**：Worker 無內建定時器，恭喜訊息的自動刪除由 **Cron Trigger（每分鐘）** 掃描執行。因此實際刪除時間為 `設定秒數` ～ `設定秒數 + 60秒` 之間。若需精確計時需改用 Durable Objects Alarms（需付費方案）。

---

## 本地開發與測試

### 單元測試
```bash
npm test          # 執行一次
npm run test:watch
```

### 型別檢查
```bash
npm run typecheck
```

### 本地預覽
```bash
npm run dev       # wrangler dev
```
> 本地預覽無法接收真實 Telegram webhook（需公網域名），建議先以單元測試驗證邏輯，再部署至上線環境手動驗收。

---

## 專案結構

```
src/
├── index.ts       Worker 入口（webhook / cron / captcha 頁面 / API 路由）
├── bot.ts         grammY 機器人（指令、事件處理、TgApi adapter）
├── verify.ts      驗證流程核心
├── turnstile.ts   Turnstile 後端 siteverify
├── store.ts       KV 封裝
├── admin.ts       管理員權限判斷
├── config.ts      動態設定讀取（含預設值 / clamp）
├── messages.ts    繁中訊息文字
└── types.ts       型別定義
tests/             單元測試（vitest + FakeKV / FakeTgApi）
```

---

## 安全性要點

- ✅ Turnstile token 於**後端** siteverify，不只前端檢查
- ✅ UUID **綁定 user_id**，私訊核對一致性，防冒領
- ✅ UUID **一次性**，使用後立即刪除
- ✅ 管理指令嚴格權限檢查
- ✅ 入群立即限制發言權限，未驗證者無法在群內發訊
