/**
 * 動態設定讀取／更新。
 *
 * 基礎設定（secrets）由 Env 提供；此處僅處理可由管理員指令
 * 線上調整的動態設定，讀取時套用預設值與邊界 clamp。
 */
import type { KVNamespace } from "@cloudflare/workers-types";
import { CONFIG_KEYS, DEFAULT_CONFIG, type DynamicConfig } from "./types";

/** 動態設定邊界限制。 */
export const CONFIG_LIMITS = {
  timeoutMin: 30,
  timeoutMax: 3600,
  announceDeleteAfterMin: 0,
  announceDeleteAfterMax: 3600,
} as const;

/** 將超時秒數限制在合法區間。 */
export function clampTimeout(n: number): number {
  return clamp(n, CONFIG_LIMITS.timeoutMin, CONFIG_LIMITS.timeoutMax);
}

/** 將恭喜訊息自動刪除秒數限制在合法區間（0 = 不自動刪）。 */
export function clampAnnounceDeleteAfter(n: number): number {
  return clamp(n, CONFIG_LIMITS.announceDeleteAfterMin, CONFIG_LIMITS.announceDeleteAfterMax);
}

/**
 * 讀取動態設定：逐欄從 KV 讀取，缺失或非法時套用預設值與 clamp。
 */
export async function getConfig(kv: KVNamespace): Promise<DynamicConfig> {
  const timeoutRaw = await kv.get(CONFIG_KEYS.timeout);
  const announceRaw = await kv.get(CONFIG_KEYS.announce_enabled);
  const deleteAfterRaw = await kv.get(CONFIG_KEYS.announce_delete_after);

  return {
    timeout: parseTimeout(timeoutRaw),
    announce_enabled: parseAnnounceEnabled(announceRaw),
    announce_delete_after: parseAnnounceDeleteAfter(deleteAfterRaw),
  };
}

/**
 * 部分更新動態設定：以現值為基準合併 partial，逐欄寫回對應 KV key，
 * 回傳合併後的完整設定（已套用 clamp）。
 */
export async function updateConfig(
  kv: KVNamespace,
  partial: Partial<DynamicConfig>,
): Promise<DynamicConfig> {
  const current = await getConfig(kv);
  const merged: DynamicConfig = {
    timeout: clampTimeout(partial.timeout ?? current.timeout),
    announce_enabled: partial.announce_enabled ?? current.announce_enabled,
    announce_delete_after: clampAnnounceDeleteAfter(
      partial.announce_delete_after ?? current.announce_delete_after,
    ),
  };

  await kv.put(CONFIG_KEYS.timeout, String(merged.timeout));
  await kv.put(CONFIG_KEYS.announce_enabled, String(merged.announce_enabled));
  await kv.put(CONFIG_KEYS.announce_delete_after, String(merged.announce_delete_after));

  return merged;
}

function parseTimeout(raw: string | null): number {
  if (raw === null) return DEFAULT_CONFIG.timeout;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.timeout;
  return clampTimeout(n);
}

function parseAnnounceDeleteAfter(raw: string | null): number {
  if (raw === null) return DEFAULT_CONFIG.announce_delete_after;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.announce_delete_after;
  return clampAnnounceDeleteAfter(n);
}

/**
 * 解析 announce_enabled：
 * - 缺失（null）→ 套用預設值
 * - "true" → true；"false" → false
 * - 其他非法值 → false（保守處理）
 */
function parseAnnounceEnabled(raw: string | null): boolean {
  if (raw === null) return DEFAULT_CONFIG.announce_enabled;
  return raw === "true";
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
