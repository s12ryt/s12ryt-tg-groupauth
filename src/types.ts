/**
 * 全專案共用型別定義。
 *
 * 設計原則：核心邏輯模組（store / config / turnstile / admin / verify）
 * 不直接依賴 grammY，而是依賴此處定義的抽象介面（依賴反轉），
 * 使單元測試可注入 fake 實作，不需啟動 Workers 執行階段。
 */

/** Cloudflare Worker 環境綁定：secrets + KV namespace。 */
export interface Env {
  /** TG 機器人 Token。 */
  BOT_TOKEN: string;
  /** 目標群組 chat_id（單一群組，寫死；數字字串）。 */
  GROUP_CHAT_ID: string;
  /** Worker 公開域名，含協定，如 `https://xxx.workers.dev`。 */
  WORKER_DOMAIN: string;
  /** Cloudflare Turnstile 站點 key（前端 widget）。 */
  TURNSTILE_SITE_KEY: string;
  /** Cloudflare Turnstile 密鑰（後端 siteverify）。 */
  TURNSTILE_SECRET_KEY: string;
  /** 超級管理員 user_id（數字字串）。 */
  SUPER_ADMIN_ID: string;
  /** KV namespace 綁定。 */
  KV: KVNamespace;
}

/** 入群待驗證記錄。 */
export interface PendingRecord {
  chat_id: number;
  user_id: number;
  /** 建立時間（epoch 毫秒）。 */
  created_at: number;
  /** 入群時機器人發出的驗證提示訊息 id（驗證成功後刪除）。 */
  warn_message_id: number;
}

/** Turnstile 通過後產生的臨時 UUID 記錄。 */
export interface UuidRecord {
  /** UUID 綁定的使用者 user_id（防止冒領）。 */
  user_id: number;
  chat_id: number;
  /** 建立時間（epoch 毫秒）。 */
  created_at: number;
}

/** 可由管理員指令線上調整的動態設定。 */
export interface DynamicConfig {
  /** 超時秒數（入群起算，逾期即 ban）。 */
  timeout: number;
  /** 是否在群組發送「恭喜入群」訊息。 */
  announce_enabled: boolean;
  /** 恭喜訊息發送後自動刪除的秒數。 */
  announce_delete_after: number;
}

/** 動態設定預設值。 */
export const DEFAULT_CONFIG: DynamicConfig = {
  timeout: 300,
  announce_enabled: true,
  announce_delete_after: 60,
};

/** KV 中動態設定各欄位的鍵名。 */
export const CONFIG_KEYS = {
  timeout: "config:timeout",
  announce_enabled: "config:announce_enabled",
  announce_delete_after: "config:announce_delete_after",
} as const;

/** 統計計數器鍵名。 */
export const STAT_KEYS = {
  verified: "stats:verified",
  banned: "stats:banned",
} as const;

/** Cloudflare Turnstile siteverify 回應。 */
export interface TurnstileVerifyResponse {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
}

/** 私訊 UUID 比對結果。 */
export enum UuidCheckOutcome {
  /** 通過：UUID 存在、未過期、user_id 一致。 */
  Ok = "ok",
  /** UUID 不存在（從未產生或已被刪除）。 */
  NotFound = "not_found",
  /** UUID 已過期（KV TTL 自動失效的語義保險）。 */
  Expired = "expired",
  /** UUID 綁定的 user_id 與私訊者不符（冒領）。 */
  Mismatch = "mismatch",
}

/**
 * TG 發訊息時可附帶的選項（只保留本專案會用到的子集）。
 * 結構與 Telegram Bot API 對齊。
 */
export interface SendMessageExtra {
  /** inline 鍵盤按鈕。 */
  reply_markup?: {
    inline_keyboard: {
      text: string;
      url?: string;
      callback_data?: string;
    }[][];
  };
  /** 回覆指定訊息 id。 */
  reply_to_message_id?: number;
  /** 解析模式。 */
  parse_mode?: "HTML" | "MarkdownV2";
  /** 發送後自動刪除的秒數（TG 原生不支援，此欄由本專案排程刪除模擬，這裡僅作標記）。 */
  disable_notification?: boolean;
}

/** TG sendMessage 回傳值（只取需要的欄位）。 */
export interface SentMessage {
  message_id: number;
}

/** 與 Telegram Bot API `ChatPermissions` 一致的權限結構。 */
export interface ChatPermissions {
  can_send_messages?: boolean;
  can_send_audios?: boolean;
  can_send_documents?: boolean;
  can_send_photos?: boolean;
  can_send_videos?: boolean;
  can_send_video_notes?: boolean;
  can_send_voice_notes?: boolean;
  can_send_polls?: boolean;
  can_send_other_messages?: boolean;
  can_add_web_page_previews?: boolean;
  can_change_info?: boolean;
  can_invite_users?: boolean;
  can_pin_messages?: boolean;
  can_manage_topics?: boolean;
}

/** getChatAdministrators 回傳成員（只取 user.id）。 */
export interface ChatMember {
  user: { id: number; is_bot?: boolean };
}

/**
 * 本專案用到的 Telegram 能力抽象。
 * 核心邏輯模組依賴此介面；grammY 端提供實作，測試端提供 fake。
 */
export interface TgApi {
  restrictChatMember(
    chat_id: number,
    user_id: number,
    permissions: ChatPermissions,
    until_date?: number,
  ): Promise<boolean>;

  banChatMember(chat_id: number, user_id: number, until_date?: number): Promise<boolean>;

  deleteMessage(chat_id: number, message_id: number): Promise<boolean>;

  sendMessage(
    chat_id: number,
    text: string,
    extra?: SendMessageExtra,
  ): Promise<SentMessage>;

  getChatAdministrators(chat_id: number): Promise<ChatMember[]>;
}

/** 完全限制發言的權限（入群時套用）。 */
export const MUTED_PERMISSIONS: ChatPermissions = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
};

/** 完全開放發言的權限（驗證通過後還原）。 */
export const FULL_PERMISSIONS: ChatPermissions = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_change_info: true,
  can_invite_users: true,
  can_pin_messages: true,
  can_manage_topics: true,
};
