/**
 * 驗證流程核心。
 *
 * 職責：
 * - onNewMember：新成員入群 → 限制權限 + 發驗證按鈕 + 寫 pending
 * - issueUuid：Turnstile 通過後產生綁定 user_id 的臨時 UUID（需 pending 存在）
 * - checkAndVerifyUuid：私訊 UUID 核對 → 解除限制 / 刪提示 / 恭喜訊息 / 計數
 * - sweepExpiredPending：掃描逾期 pending 執行 ban（cron + webhook 雙軌）
 * - sweepDelayedDeletes：掃描到期恭喜訊息刪除
 * - manualVerify：管理員手動通過驗證
 */
import type { KVNamespace } from "@cloudflare/workers-types";
import type { ChatPermissions, TgApi } from "./types";
import {
  FULL_PERMISSIONS,
  MUTED_PERMISSIONS,
  STAT_KEYS,
  UuidCheckOutcome,
} from "./types";
import {
  setPending,
  getPending,
  deletePending,
  setUuid,
  getUuid,
  deleteUuid,
  listPending,
  setDelayedDelete,
  listDelayedDeletes,
  deleteDelayedDelete,
  incrStat,
} from "./store";
import { getConfig } from "./config";
import {
  WELCOME_BUTTON_TEXT,
  announceText,
  welcomeText,
  dmUuidInvalidText,
  dmUuidMismatchText,
  dmVerifySuccessText,
} from "./messages";

/** verify 模組依賴。 */
export interface VerifyDeps {
  kv: KVNamespace;
  tg: TgApi;
  /** 目標群組 chat_id。 */
  groupChatId: number;
  /** Worker 公開域名（含協定）。 */
  workerDomain: string;
  /** 可注入時鐘（測試用）。 */
  now?: () => number;
}

/** 驗證結果。 */
export interface VerifyResult {
  outcome: UuidCheckOutcome;
  success: boolean;
  /** 應回覆給使用者的私訊文字。 */
  dmText: string;
}

/** 手動驗證結果。 */
export interface ManualVerifyResult {
  success: boolean;
  text?: string;
}

/** TG 成員（只取需要的欄位）。 */
export interface TgMember {
  id: number;
  first_name?: string;
  is_bot?: boolean;
}

const BUFFER_SEC = 60;

/**
 * Telegram service message 欄位清單（系統產生的提示訊息，如「xxx 加入群組」、
 * 群組名稱變更、置頂訊息等）。任一欄位存在且非 null 即視為 service message。
 */
export const SERVICE_MESSAGE_KEYS = [
  "new_chat_members",
  "left_chat_member",
  "new_chat_title",
  "new_chat_photo",
  "delete_chat_photo",
  "group_chat_created",
  "supergroup_chat_created",
  "channel_chat_created",
  "pinned_message",
  "migrate_to_chat_id",
  "migrate_from_chat_id",
  "proximity_alert_triggered",
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_topic_hidden",
  "general_topic_unhidden",
  "video_chat_scheduled",
  "video_chat_started",
  "video_chat_ended",
  "video_chat_participants_invited",
] as const;

/** 判斷一則訊息是否為 service message（任一 service 欄位存在且非 null）。 */
export function isServiceMessage(msg: Record<string, unknown>): boolean {
  for (const key of SERVICE_MESSAGE_KEYS) {
    const v = msg[key];
    if (v !== undefined && v !== null) return true;
  }
  return false;
}

/** 組裝驗證按鈕 URL：{workerDomain}/captcha?u={userId}。 */
export function captchaButtonUrl(workerDomain: string, userId: number): string {
  const base = workerDomain.replace(/\/+$/, "");
  return `${base}/captcha?u=${userId}`;
}

/**
 * 新成員入群：立即限制權限、發含按鈕的提示訊息、寫 pending 記錄。
 * 回傳發出的提示訊息 id。
 */
export async function onNewMember(deps: VerifyDeps, member: TgMember): Promise<number> {
  const { kv, tg, groupChatId, workerDomain } = deps;
  const now = (deps.now ?? Date.now)();
  const cfg = await getConfig(kv);

  await tg.restrictChatMember(groupChatId, member.id, MUTED_PERMISSIONS);

  const sent = await tg.sendMessage(groupChatId, welcomeText(member.first_name ?? "使用者", cfg.timeout), {
    reply_markup: {
      inline_keyboard: [
        [{ text: WELCOME_BUTTON_TEXT, url: captchaButtonUrl(workerDomain, member.id) }],
      ],
    },
  });

  await setPending(
    kv,
    {
      chat_id: groupChatId,
      user_id: member.id,
      created_at: now,
      warn_message_id: sent.message_id,
    },
    cfg.timeout + BUFFER_SEC,
  );

  return sent.message_id;
}

/**
 * Turnstile 通過後產生臨時 UUID。
 * 安全檢查：僅當該 user 有 pending 記錄才發 UUID，否則拒絕（回 null）。
 */
export async function issueUuid(deps: VerifyDeps, userId: number): Promise<string | null> {
  const { kv, groupChatId } = deps;
  const now = (deps.now ?? Date.now)();

  const pending = await getPending(kv, groupChatId, userId);
  if (!pending) return null;

  const cfg = await getConfig(kv);
  const uuid = crypto.randomUUID();
  await setUuid(
    kv,
    uuid,
    { user_id: userId, chat_id: groupChatId, created_at: now },
    cfg.timeout,
  );
  return uuid;
}

/**
 * 私訊 UUID 核對：檢查存在性、user_id 一致性，成功則解除限制等後續動作。
 */
export async function checkAndVerifyUuid(
  deps: VerifyDeps,
  userId: number,
  uuidText: string,
): Promise<VerifyResult> {
  const { kv } = deps;

  const uuid = uuidText.trim();
  const rec = await getUuid(kv, uuid);
  if (!rec) {
    return { outcome: UuidCheckOutcome.NotFound, success: false, dmText: dmUuidInvalidText() };
  }
  if (rec.user_id !== userId) {
    return { outcome: UuidCheckOutcome.Mismatch, success: false, dmText: dmUuidMismatchText() };
  }

  // 一致：通過。UUID 立即註銷（一次性）。
  await deleteUuid(kv, uuid);
  await applyVerified(deps, userId, rec.user_id === userId ? rec.user_id : userId);

  return { outcome: UuidCheckOutcome.Ok, success: true, dmText: dmVerifySuccessText() };
}

/**
 * 驗證通過後的副作用：解除限制、刪提示訊息、刪 pending、計數、恭喜訊息。
 */
async function applyVerified(deps: VerifyDeps, userId: number, _bound: number): Promise<void> {
  const { kv, tg, groupChatId } = deps;
  const now = (deps.now ?? Date.now)();

  const pending = await getPending(kv, groupChatId, userId);
  // 解除限制（冪等）。
  await restrictSafe(tg, groupChatId, userId, FULL_PERMISSIONS);

  if (pending) {
    await deleteMessageSafe(tg, groupChatId, pending.warn_message_id);
    await deletePending(kv, groupChatId, userId);
  }

  await incrStat(kv, STAT_KEYS.verified);

  // 恭喜訊息（可由設定關閉）。
  const cfg = await getConfig(kv);
  if (cfg.announce_enabled) {
    try {
      const sent = await tg.sendMessage(groupChatId, announceText("使用者", userId), {
        parse_mode: "HTML",
      });
      if (cfg.announce_delete_after > 0) {
        await setDelayedDelete(
          kv,
          {
            chat_id: groupChatId,
            message_id: sent.message_id,
            delete_at: now + cfg.announce_delete_after * 1000,
          },
          cfg.announce_delete_after + BUFFER_SEC,
        );
      }
    } catch {
      // 恭喜訊息失敗不影響驗證結果。
    }
  }
}

/**
 * 管理員手動通過驗證。
 * 僅當 pending 存在才算成功。
 */
export async function manualVerify(
  deps: VerifyDeps,
  targetUserId: number,
): Promise<ManualVerifyResult> {
  const { kv, groupChatId } = deps;

  const pending = await getPending(kv, groupChatId, targetUserId);
  if (!pending) {
    return { success: false };
  }

  await applyVerified(deps, targetUserId, targetUserId);
  return { success: true };
}

/**
 * 掃描逾期 pending 執行 ban。回傳 ban 數。
 * 供 cron 與 webhook 連帶掃描共用。
 */
export async function sweepExpiredPending(deps: VerifyDeps): Promise<number> {
  const { kv, tg } = deps;
  const now = (deps.now ?? Date.now)();
  const cfg = await getConfig(kv);
  const deadline = cfg.timeout * 1000;

  const all = await listPending(kv);
  let count = 0;
  for (const p of all) {
    if (now - p.created_at >= deadline) {
      try {
        await tg.banChatMember(p.chat_id, p.user_id);
      } catch {
        // ban 失敗仍刪記錄避免重複嘗試？保守起見跳過此筆保留記錄。
        continue;
      }
      await deletePending(kv, p.chat_id, p.user_id);
      await incrStat(kv, STAT_KEYS.banned);
      count++;
    }
  }
  return count;
}

/**
 * 掃描到期恭喜訊息刪除。回傳刪除數。
 */
export async function sweepDelayedDeletes(deps: VerifyDeps): Promise<number> {
  const { kv, tg } = deps;
  const now = (deps.now ?? Date.now)();

  const all = await listDelayedDeletes(kv);
  let count = 0;
  for (const d of all) {
    if (now >= d.delete_at) {
      await deleteMessageSafe(tg, d.chat_id, d.message_id);
      await deleteDelayedDelete(kv, d.chat_id, d.message_id);
      count++;
    }
  }
  return count;
}

async function restrictSafe(
  tg: TgApi,
  chatId: number,
  userId: number,
  permissions: ChatPermissions,
): Promise<void> {
  try {
    await tg.restrictChatMember(chatId, userId, permissions);
  } catch {
    // 忽略：可能成員已離開。
  }
}

async function deleteMessageSafe(
  tg: TgApi,
  chatId: number,
  messageId: number,
): Promise<void> {
  try {
    await tg.deleteMessage(chatId, messageId);
  } catch {
    // 忽略：訊息可能已被刪。
  }
}
