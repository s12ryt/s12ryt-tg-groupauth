/**
 * KV 封裝：待驗證記錄、臨時 UUID、統計計數的讀寫。
 *
 * 所有 TTL 以「秒」為單位（KV expirationTtl 語義）。
 */
import type { KVNamespace } from "@cloudflare/workers-types";
import type { PendingRecord, UuidRecord } from "./types";

/** 組裝 pending 記錄鍵名。 */
export function pendingKey(chatId: number, userId: number): string {
  return `pending:${chatId}:${userId}`;
}

/** 組裝 uuid 記錄鍵名。 */
export function uuidKey(uuid: string): string {
  return `uuid:${uuid}`;
}

/** 寫入待驗證記錄。 */
export async function setPending(
  kv: KVNamespace,
  record: PendingRecord,
  ttlSec: number,
): Promise<void> {
  await kv.put(pendingKey(record.chat_id, record.user_id), JSON.stringify(record), {
    expirationTtl: ttlSec,
  });
}

/** 讀取待驗證記錄；不存在或格式錯誤回 null。 */
export async function getPending(
  kv: KVNamespace,
  chatId: number,
  userId: number,
): Promise<PendingRecord | null> {
  const raw = await kv.get(pendingKey(chatId, userId));
  if (!raw) return null;
  return safeParse<PendingRecord>(raw);
}

/** 刪除待驗證記錄。 */
export async function deletePending(
  kv: KVNamespace,
  chatId: number,
  userId: number,
): Promise<void> {
  await kv.delete(pendingKey(chatId, userId));
}

/** 寫入臨時 UUID 記錄。 */
export async function setUuid(
  kv: KVNamespace,
  uuid: string,
  record: UuidRecord,
  ttlSec: number,
): Promise<void> {
  await kv.put(uuidKey(uuid), JSON.stringify(record), { expirationTtl: ttlSec });
}

/** 讀取臨時 UUID 記錄；不存在或格式錯誤回 null。 */
export async function getUuid(kv: KVNamespace, uuid: string): Promise<UuidRecord | null> {
  const raw = await kv.get(uuidKey(uuid));
  if (!raw) return null;
  return safeParse<UuidRecord>(raw);
}

/** 刪除臨時 UUID 記錄。 */
export async function deleteUuid(kv: KVNamespace, uuid: string): Promise<void> {
  await kv.delete(uuidKey(uuid));
}

/**
 * 列出所有待驗證記錄（供 cron / webhook 連帶掃描逾期成員）。
 * 注意：KV list 有 1000 筆上限；本專案單群組同時待驗證人數有限，暫不分頁。
 */
export async function listPending(kv: KVNamespace): Promise<PendingRecord[]> {
  const out: PendingRecord[] = [];
  let cursor: string | undefined;
  do {
    const res = await kv.list({ prefix: "pending:", cursor });
    for (const { name } of res.keys) {
      const raw = await kv.get(name);
      const rec = raw ? safeParse<PendingRecord>(raw) : null;
      if (rec) out.push(rec);
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return out;
}

/** 待延遲刪除的訊息記錄（用於恭喜訊息自動刪除）。 */
export interface DelayedDeleteRecord {
  chat_id: number;
  message_id: number;
  /** 應刪除時間（epoch 毫秒）。 */
  delete_at: number;
}

/** 組裝 delayed delete 鍵名。 */
export function delMsgKey(chatId: number, messageId: number): string {
  return `delmsg:${chatId}:${messageId}`;
}

/** 寫入待延遲刪除訊息記錄。 */
export async function setDelayedDelete(
  kv: KVNamespace,
  rec: DelayedDeleteRecord,
  ttlSec: number,
): Promise<void> {
  await kv.put(delMsgKey(rec.chat_id, rec.message_id), JSON.stringify(rec), {
    expirationTtl: ttlSec,
  });
}

/** 列出所有待延遲刪除訊息。 */
export async function listDelayedDeletes(kv: KVNamespace): Promise<DelayedDeleteRecord[]> {
  const out: DelayedDeleteRecord[] = [];
  let cursor: string | undefined;
  do {
    const res = await kv.list({ prefix: "delmsg:", cursor });
    for (const { name } of res.keys) {
      const raw = await kv.get(name);
      const rec = raw ? safeParse<DelayedDeleteRecord>(raw) : null;
      if (rec) out.push(rec);
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return out;
}

/** 刪除一筆待延遲刪除記錄。 */
export async function deleteDelayedDelete(
  kv: KVNamespace,
  chatId: number,
  messageId: number,
): Promise<void> {
  await kv.delete(delMsgKey(chatId, messageId));
}

/** 計數器 +1，回傳遞增後的值。 */
export async function incrStat(kv: KVNamespace, key: string): Promise<number> {
  const cur = await getStat(kv, key);
  const next = cur + 1;
  await kv.put(key, String(next));
  return next;
}

/** 讀取計數器；不存在或非法回 0。 */
export async function getStat(kv: KVNamespace, key: string): Promise<number> {
  const raw = await kv.get(key);
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
