/**
 * 繁體中文訊息文字產生（純函式，不含副作用）。
 */

/** HTML 跳脫，避免使用者名稱含 HTML 特殊字造成顯示異常或注入。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 以 <a href="tg://user?id=..."> 標記使用者，便於點擊。 */
export function mentionUser(userId: number, name: string): string {
  return `<a href="tg://user?id=${userId}">${escapeHtml(name)}</a>`;
}

/** 入群驗證提示訊息（群組）。 */
export function welcomeText(userName: string, timeoutSec: number): string {
  const mins = Math.max(1, Math.round(timeoutSec / 60));
  return (
    `👋 歡迎 ${escapeHtml(userName)}！\n\n` +
    `為了確認你不是機器人，請點擊下方「開始驗證」按鈕完成驗證。\n` +
    `⏰ 請於 ${mins} 分鐘內完成，逾期將被封禁。`
  );
}

/** 驗證按鈕顯示文字。 */
export const WELCOME_BUTTON_TEXT = "✅ 開始驗證";

/** 驗證通過後在群組發送的恭喜訊息。 */
export function announceText(userName: string, userId: number): string {
  return `🎉 歡迎 ${mentionUser(userId, userName)} 加入群組，已通過驗證！`;
}

/** 私訊：驗證成功。 */
export function dmVerifySuccessText(): string {
  return "✅ 驗證成功！你現在可以在群組發言了。";
}

/** 私訊：驗證碼無效或已過期。 */
export function dmUuidInvalidText(): string {
  return "❌ 驗證碼無效或已過期，請回到群組重新點擊驗證按鈕。";
}

/** 私訊：驗證碼不屬於該使用者（冒領）。 */
export function dmUuidMismatchText(): string {
  return "❌ 這個驗證碼不屬於你，請使用你自己從驗證按鈕取得的驗證碼。";
}

/** 私訊：格式錯誤（不是 UUID）。 */
export function dmUuidFormatText(): string {
  return "📝 請直接傳送你從驗證頁面取得的驗證碼（一串 UUID）。";
}

/** 私訊：/start 歡迎。 */
export function startText(groupName?: string): string {
  const where = groupName ? `「${escapeHtml(groupName)}」` : "群組";
  return (
    "👋 你好！\n\n" +
    `我是 ${where} 的驗證機器人。\n` +
    "若你剛加入群組，請點擊群組中的「開始驗證」按鈕，" +
    "完成人機驗證後會取得一組驗證碼，再回到這裡把驗證碼傳給我即可完成驗證。"
  );
}

/** /help 說明（一般成員）。 */
export function helpText(): string {
  return (
    "ℹ️ 使用說明\n\n" +
    "1. 在群組點擊「開始驗證」按鈕\n" +
    "2. 通過人機驗證後取得驗證碼\n" +
    "3. 私訊本機器人並發送驗證碼\n" +
    "4. 完成驗證即可在群組發言"
  );
}

/** 管理員指令說明。 */
export function adminHelpText(): string {
  return (
    "🛠 管理員指令\n\n" +
    "/stats — 查看驗證統計\n" +
    "/unban <user_id> — 解除封禁\n" +
    "/manualverify <user_id> — 手動通過某人驗證\n" +
    "/settimeout <秒> — 設定超時時長（30–3600）\n" +
    "/toggle_announce — 開／關恭喜入群訊息\n" +
    "/help — 顯示本說明"
  );
}

/** 非管理員使用管理指令時的提示。 */
export function notAdminText(): string {
  return "⛔ 此指令僅限管理員使用。";
}

/** /stats 回報。 */
export function statsText(verified: number, banned: number, pending: number): string {
  return (
    "📊 驗證統計\n\n" +
    `✅ 已驗證：${verified}\n` +
    `🚫 已封禁：${banned}\n` +
    `⏳ 待驗證：${pending}`
  );
}

/** 指令參數錯誤。 */
export function badArgsText(hint: string): string {
  return `⚠️ 參數錯誤：${hint}`;
}

/** 操作成功。 */
export function okText(detail: string): string {
  return `✅ ${detail}`;
}

/** 操作失敗。 */
export function failText(detail: string): string {
  return `❌ ${detail}`;
}

/** 設定已更新回報。 */
export function configUpdatedText(summary: string): string {
  return `✅ 設定已更新\n${summary}`;
}
