/**
 * 測試用 FakeKV：實作本專案會用到的 KVNamespace 子集
 * （get / put / delete / list），並模擬 expirationTtl 行為。
 *
 * 用 `as unknown as KVNamespace` 注入受測模組即可。
 */
export interface StoredEntry {
  value: string;
  /** epoch 毫秒；null 表示永不過期。 */
  expireAt: number | null;
  /** 最近一次 put 傳入的 expirationTtl（秒），供測試斷言。 */
  lastTtl: number | undefined;
}

export class FakeKV {
  private store = new Map<string, StoredEntry>();
  private clock: () => number = () => Date.now();

  /** 注入固定時鐘（配合 vitest fake timers 或手動控制）。 */
  setClock(clock: () => number): void {
    this.clock = clock;
  }

  now(): number {
    return this.clock();
  }

  /** 直接窺探內部（測試斷言 TTL 參數用）。 */
  peek(name: string): StoredEntry | undefined {
    return this.store.get(name);
  }

  private live(name: string): StoredEntry | undefined {
    const e = this.store.get(name);
    if (!e) return undefined;
    if (e.expireAt !== null && this.clock() >= e.expireAt) {
      // 模擬 KV TTL 失效後自動移除。
      this.store.delete(name);
      return undefined;
    }
    return e;
  }

  async get(name: string): Promise<string | null> {
    const e = this.live(name);
    return e ? e.value : null;
  }

  async put(
    name: string,
    value: string,
    options?: { expirationTtl?: number; expiration?: number; metadata?: unknown },
  ): Promise<void> {
    const ttl = options?.expirationTtl;
    this.store.set(name, {
      value,
      expireAt: ttl && ttl > 0 ? this.clock() + ttl * 1000 : null,
      lastTtl: ttl,
    });
  }

  async delete(name: string): Promise<void> {
    this.store.delete(name);
  }

  async list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    keys: { name: string; expiration?: number; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? "";
    const names = [...this.store.keys()].filter((k) => k.startsWith(prefix));
    // 回傳前先過濾已過期的（與 KV 一致，過期鍵不出現在 list）。
    const keys = names.filter((n) => this.live(n) !== undefined).map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

/**
 * 測試用 FakeTgApi：實作 TgApi 介面，記錄所有呼叫，
 * 並可預設管理員清單與失敗開關。
 */
import type {
  TgApi,
  ChatPermissions,
  SendMessageExtra,
  SentMessage,
  ChatMember,
} from "../src/types";

export interface RestrictCall {
  chat_id: number;
  user_id: number;
  permissions: ChatPermissions;
  until_date?: number;
}

export class FakeTgApi implements TgApi {
  /** 預設管理員 user_id 清單。 */
  admins: number[] = [];
  /** getChatAdministrators 是否拋錯（模擬網路失敗）。 */
  failAdmins = false;
  /** restrictChatMember 是否拋錯。 */
  failRestrict = false;

  restrictCalls: RestrictCall[] = [];
  banCalls: { chat_id: number; user_id: number; until_date?: number }[] = [];
  deleteCalls: { chat_id: number; message_id: number }[] = [];
  sentMessages: { chat_id: number; text: string; extra?: SendMessageExtra }[] = [];

  private msgSeq = 1000;

  async restrictChatMember(
    chat_id: number,
    user_id: number,
    permissions: ChatPermissions,
    until_date?: number,
  ): Promise<boolean> {
    if (this.failRestrict) throw new Error("restrict failed");
    this.restrictCalls.push({ chat_id, user_id, permissions, until_date });
    return true;
  }

  async banChatMember(
    chat_id: number,
    user_id: number,
    until_date?: number,
  ): Promise<boolean> {
    this.banCalls.push({ chat_id, user_id, until_date });
    return true;
  }

  async deleteMessage(chat_id: number, message_id: number): Promise<boolean> {
    this.deleteCalls.push({ chat_id, message_id });
    return true;
  }

  async sendMessage(
    chat_id: number,
    text: string,
    extra?: SendMessageExtra,
  ): Promise<SentMessage> {
    this.sentMessages.push({ chat_id, text, extra });
    return { message_id: ++this.msgSeq };
  }

  async getChatAdministrators(chat_id: number): Promise<ChatMember[]> {
    void chat_id;
    if (this.failAdmins) throw new Error("getChatAdministrators failed");
    return this.admins.map((id) => ({ user: { id } }));
  }
}
