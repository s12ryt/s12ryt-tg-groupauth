/**
 * grammY 機器人整合層。
 *
 * - createGrammyTgApi：把 grammY 的 bot.api 包裝成 TgApi 介面（供 verify/admin 使用）
 * - registerBot：註冊所有指令與事件處理，對應到核心邏輯
 *
 * 單一群組：僅處理 groupChatId 的群組事件；私訊則用於完成 UUID 驗證。
 */
import type { Bot } from "grammy";
import type { KVNamespace } from "@cloudflare/workers-types";
import type { ChatMember, ChatPermissions, SendMessageExtra, TgApi } from "./types";
import { isAdministrator } from "./admin";
import { getConfig, updateConfig, clampTimeout } from "./config";
import { getStat } from "./store";
import { listPending } from "./store";
import {
  onNewMember,
  checkAndVerifyUuid,
  manualVerify,
  isServiceMessage,
  type VerifyDeps,
} from "./verify";
import {
  adminHelpText,
  badArgsText,
  configUpdatedText,
  dmUuidFormatText,
  failText,
  helpText,
  notAdminText,
  okText,
  startText,
  statsText,
} from "./messages";
import { STAT_KEYS } from "./types";

/** 機器人執行所需的環境依賴。 */
export interface BotDeps {
  kv: KVNamespace;
  tg: TgApi;
  groupChatId: number;
  workerDomain: string;
  superAdminId: number;
  /** 機器人 username（用於私訊深層連結；可選）。 */
  botUsername?: string;
}

/** 將 grammY Bot 包裝為本專案的 TgApi 介面。 */
export function createGrammyTgApi(bot: Bot): TgApi {
  return {
    async restrictChatMember(chat_id, user_id, permissions, until_date) {
      await bot.api.restrictChatMember(
        chat_id,
        user_id,
        permissions as never,
        until_date ? { until_date } : {},
      );
      return true;
    },
    async banChatMember(chat_id, user_id, until_date) {
      await bot.api.banChatMember(chat_id, user_id, until_date ? { until_date } : {});
      return true;
    },
    async deleteMessage(chat_id, message_id) {
      await bot.api.deleteMessage(chat_id, message_id);
      return true;
    },
    async sendMessage(chat_id, text, extra) {
      const res = await bot.api.sendMessage(chat_id, text, (extra ?? {}) as never);
      return { message_id: res.message_id };
    },
    async getChatAdministrators(chat_id) {
      const res = await bot.api.getChatAdministrators(chat_id);
      const out: ChatMember[] = res.map((m) => ({
        user: { id: m.user.id, is_bot: m.user.is_bot },
      }));
      return out;
    },
  };
}

function verifyDepsOf(deps: BotDeps): VerifyDeps {
  return {
    kv: deps.kv,
    tg: deps.tg,
    groupChatId: deps.groupChatId,
    workerDomain: deps.workerDomain,
  };
}

/** 建立 BotDeps（正規化 workerDomain 去尾斜線）。 */
export function createBotDeps(input: {
  kv: KVNamespace;
  tg: TgApi;
  groupChatId: number;
  workerDomain: string;
  superAdminId: number;
  botUsername?: string;
}): BotDeps {
  return {
    kv: input.kv,
    tg: input.tg,
    groupChatId: input.groupChatId,
    workerDomain: input.workerDomain.replace(/\/+$/, ""),
    superAdminId: input.superAdminId,
    botUsername: input.botUsername,
  };
}

/** 註冊所有機器人指令與事件處理。 */
export function registerBot(bot: Bot, deps: BotDeps): void {
  const { kv, groupChatId, superAdminId, botUsername } = deps;

  // /start：私訊歡迎
  bot.command("start", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    await ctx.reply(startText());
    void botUsername;
  });

  // /help：一般說明；管理員附加管理指令說明
  bot.command("help", async (ctx) => {
    const isAdmin = ctx.from
      ? await isAdministrator(ctx.from.id, groupChatId, superAdminId, deps.tg)
      : false;
    const text = isAdmin ? `${helpText()}\n\n${adminHelpText()}` : helpText();
    await ctx.reply(text);
  });

  // /stats：驗證統計（管理員）
  bot.command("stats", async (ctx) => {
    if (!(await ensureAdmin(ctx, deps))) return;
    const verified = await getStat(kv, STAT_KEYS.verified);
    const banned = await getStat(kv, STAT_KEYS.banned);
    const pending = (await listPending(kv)).length;
    await ctx.reply(statsText(verified, banned, pending));
  });

  // /settimeout <秒>：調整超時（管理員）
  bot.command("settimeout", async (ctx) => {
    if (!(await ensureAdmin(ctx, deps))) return;
    const n = parseNumberArg(ctx.match?.toString());
    if (n === null) {
      await ctx.reply(badArgsText("用法 /settimeout <秒>（30–3600）"));
      return;
    }
    const cfg = await updateConfig(kv, { timeout: clampTimeout(n) });
    await ctx.reply(configUpdatedText(`超時時長 = ${cfg.timeout} 秒`));
  });

  // /toggle_announce：開／關恭喜訊息（管理員）
  bot.command("toggle_announce", async (ctx) => {
    if (!(await ensureAdmin(ctx, deps))) return;
    const cur = await getConfig(kv);
    const cfg = await updateConfig(kv, { announce_enabled: !cur.announce_enabled });
    await ctx.reply(configUpdatedText(`恭喜入群訊息 = ${cfg.announce_enabled ? "開啟" : "關閉"}`));
  });

  // /unban <user_id>：解除封禁（管理員）
  bot.command("unban", async (ctx) => {
    if (!(await ensureAdmin(ctx, deps))) return;
    const n = parseNumberArg(ctx.match?.toString());
    if (n === null) {
      await ctx.reply(badArgsText("用法 /unban <user_id>"));
      return;
    }
    try {
      await bot.api.unbanChatMember(groupChatId, n, { only_if_banned: true });
      await ctx.reply(okText(`已解除 ${n} 的封禁`));
    } catch {
      await ctx.reply(failText(`解除 ${n} 封禁失敗`));
    }
  });

  // /manualverify <user_id>：手動通過驗證（管理員）
  bot.command("manualverify", async (ctx) => {
    if (!(await ensureAdmin(ctx, deps))) return;
    const n = parseNumberArg(ctx.match?.toString());
    if (n === null) {
      await ctx.reply(badArgsText("用法 /manualverify <user_id>"));
      return;
    }
    const res = await manualVerify(verifyDepsOf(deps), n);
    await ctx.reply(res.success ? okText(`已手動通過 ${n} 的驗證`) : failText(`${n} 沒有待驗證記錄`));
  });

  // 新成員入群：僅處理目標群組
  bot.on("message:new_chat_members", async (ctx) => {
    if (ctx.chat?.id !== groupChatId) return;
    const members = ctx.message?.new_chat_members ?? [];
    for (const m of members) {
      if (m.is_bot) continue;
      await onNewMember(verifyDepsOf(deps), {
        id: m.id,
        first_name: m.first_name,
        is_bot: m.is_bot,
      });
    }
    // 刪除「xxx 加入群組」這則 service message（由機器人發自己的驗證提示取代）
    await deleteServiceMessage(deps, ctx.chat?.id, ctx.message?.message_id);
  });

  // 自動刪除其他 service message（離開／標題變更／頭像變更／置頂等），僅目標群組。
  // 非 service message 則交給後續 handler（如私訊 UUID）。
  bot.on("message", async (ctx, next) => {
    const msg = ctx.message;
    if (
      msg &&
      ctx.chat?.id === groupChatId &&
      isServiceMessage(msg as unknown as Record<string, unknown>)
    ) {
      await deleteServiceMessage(deps, ctx.chat.id, msg.message_id);
      return;
    }
    await next();
  });

  // 私訊文字（非指令）：當作 UUID 驗證
  bot.on("message:text", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    const text = ctx.message?.text ?? "";
    if (text.startsWith("/")) return; // 指令由 command handler 處理
    if (!ctx.from) return;
    const res = await checkAndVerifyUuid(verifyDepsOf(deps), ctx.from.id, text);
    await ctx.reply(res.dmText);
    if (!res.success && res.outcome === "not_found") {
      // 不合法輸入時額外提示格式
      if (!looksLikeUuid(text)) await ctx.reply(dmUuidFormatText());
    }
  });
}

/** 刪除目標群組內的 service message；失敗（無權限／已不存在）則靜默忽略。 */
async function deleteServiceMessage(
  deps: BotDeps,
  chatId: number | undefined,
  messageId: number | undefined,
): Promise<void> {
  if (chatId === undefined || messageId === undefined) return;
  if (chatId !== deps.groupChatId) return;
  try {
    await deps.tg.deleteMessage(chatId, messageId);
  } catch {
    // 忽略：機器人可能無刪除權限，或訊息已不存在。
  }
}

async function ensureAdmin(ctx: { from?: { id: number } | undefined; reply: (t: string) => Promise<unknown> }, deps: BotDeps): Promise<boolean> {
  if (!ctx.from) {
    await ctx.reply(notAdminText());
    return false;
  }
  const ok = await isAdministrator(ctx.from.id, deps.groupChatId, deps.superAdminId, deps.tg);
  if (!ok) await ctx.reply(notAdminText());
  return ok;
}

function parseNumberArg(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
}

function looksLikeUuid(text: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text.trim());
}

// 標記未直接使用的型別，避免因型別推導移除而影響 adapter 簽名。
export type { ChatPermissions, SendMessageExtra };
