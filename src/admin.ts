/**
 * 管理員權限判斷。
 *
 * - 超級管理員（SUPER_ADMIN_ID）恆有效，即使 getChatAdministrators 失敗。
 * - 否則動態查詢該群管理員清單；查詢失敗時保守判定為非管理員。
 */
import type { TgApi } from "./types";

export async function isAdministrator(
  userId: number,
  chatId: number,
  superAdminId: number,
  tg: TgApi,
): Promise<boolean> {
  if (userId === superAdminId) return true;

  try {
    const members = await tg.getChatAdministrators(chatId);
    return members.some((m) => m.user.id === userId);
  } catch {
    // 查詢失敗時保守處理：除超級管理員外，其餘不視為管理員。
    return false;
  }
}
