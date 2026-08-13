import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeKV } from "./helpers";
import type { KVNamespace } from "@cloudflare/workers-types";
import {
  pendingKey,
  uuidKey,
  getPending,
  setPending,
  deletePending,
  getUuid,
  setUuid,
  deleteUuid,
  incrStat,
  getStat,
  listPending,
  setDelayedDelete,
  listDelayedDeletes,
  deleteDelayedDelete,
} from "../src/store";
import type { PendingRecord, UuidRecord } from "../src/types";
import { STAT_KEYS } from "../src/types";

const asKV = (fk: FakeKV): KVNamespace => fk as unknown as KVNamespace;

const samplePending: PendingRecord = {
  chat_id: -100123,
  user_id: 555,
  created_at: 1_000_000,
  warn_message_id: 42,
};

const sampleUuid: UuidRecord = {
  user_id: 555,
  chat_id: -100123,
  created_at: 1_000_000,
};

describe("store — 鍵名組裝", () => {
  it("pendingKey 格式為 pending:{chat}:{user}", () => {
    expect(pendingKey(-100123, 555)).toBe("pending:-100123:555");
  });

  it("uuidKey 格式為 uuid:{uuid}", () => {
    expect(uuidKey("abc-123")).toBe("uuid:abc-123");
  });
});

describe("store — pending 記錄", () => {
  let fk: FakeKV;
  let kv: KVNamespace;

  beforeEach(() => {
    fk = new FakeKV();
    kv = asKV(fk);
  });

  it("setPending 後可 getPending 取回相同記錄", async () => {
    await setPending(kv, samplePending, 300);
    const got = await getPending(kv, samplePending.chat_id, samplePending.user_id);
    expect(got).toEqual(samplePending);
  });

  it("不存在時 getPending 回 null", async () => {
    const got = await getPending(kv, 1, 2);
    expect(got).toBeNull();
  });

  it("setPending 以秒為單位寫入 expirationTtl", async () => {
    await setPending(kv, samplePending, 300);
    const entry = fk.peek(pendingKey(samplePending.chat_id, samplePending.user_id));
    expect(entry?.lastTtl).toBe(300);
  });

  it("TTL 到期後 getPending 回 null", async () => {
    vi.useFakeTimers();
    fk.setClock(() => Date.now());
    const base = Date.now();
    vi.setSystemTime(base);
    await setPending(kv, samplePending, 300);
    expect(await getPending(kv, samplePending.chat_id, samplePending.user_id)).not.toBeNull();
    // 推進到過期之後
    vi.setSystemTime(base + 301 * 1000);
    expect(await getPending(kv, samplePending.chat_id, samplePending.user_id)).toBeNull();
    vi.useRealTimers();
  });

  it("deletePending 後 getPending 回 null", async () => {
    await setPending(kv, samplePending, 300);
    await deletePending(kv, samplePending.chat_id, samplePending.user_id);
    expect(await getPending(kv, samplePending.chat_id, samplePending.user_id)).toBeNull();
  });

  it("getPending 對非法 JSON 容錯回 null", async () => {
    await kv.put(pendingKey(1, 2), "{not json", { expirationTtl: 60 });
    expect(await getPending(kv, 1, 2)).toBeNull();
  });
});

describe("store — uuid 記錄", () => {
  let fk: FakeKV;
  let kv: KVNamespace;

  beforeEach(() => {
    fk = new FakeKV();
    kv = asKV(fk);
  });

  it("setUuid 後可 getUuid 取回", async () => {
    await setUuid(kv, "tok-1", sampleUuid, 300);
    expect(await getUuid(kv, "tok-1")).toEqual(sampleUuid);
  });

  it("不存在時 getUuid 回 null", async () => {
    expect(await getUuid(kv, "nope")).toBeNull();
  });

  it("setUuid 以秒為單位寫入 expirationTtl", async () => {
    await setUuid(kv, "tok-1", sampleUuid, 300);
    expect(fk.peek(uuidKey("tok-1"))?.lastTtl).toBe(300);
  });

  it("deleteUuid 後 getUuid 回 null", async () => {
    await setUuid(kv, "tok-1", sampleUuid, 300);
    await deleteUuid(kv, "tok-1");
    expect(await getUuid(kv, "tok-1")).toBeNull();
  });
});

describe("store — 統計計數", () => {
  let kv: KVNamespace;
  beforeEach(() => {
    kv = asKV(new FakeKV());
  });

  it("首次 incrStat 從 1 開始", async () => {
    expect(await incrStat(kv, STAT_KEYS.verified)).toBe(1);
  });

  it("連續 incrStat 正確遞增", async () => {
    await incrStat(kv, STAT_KEYS.verified);
    await incrStat(kv, STAT_KEYS.verified);
    expect(await incrStat(kv, STAT_KEYS.verified)).toBe(3);
  });

  it("不同 key 互不影響", async () => {
    await incrStat(kv, STAT_KEYS.verified);
    expect(await incrStat(kv, STAT_KEYS.banned)).toBe(1);
  });

  it("getStat 不存在時回 0", async () => {
    expect(await getStat(kv, STAT_KEYS.verified)).toBe(0);
  });

  it("getStat 回傳目前值", async () => {
    await incrStat(kv, STAT_KEYS.banned);
    await incrStat(kv, STAT_KEYS.banned);
    expect(await getStat(kv, STAT_KEYS.banned)).toBe(2);
  });

  it("計數值為非法時 getStat 回 0", async () => {
    await kv.put(STAT_KEYS.verified, "NaN", { expirationTtl: 60 });
    expect(await getStat(kv, STAT_KEYS.verified)).toBe(0);
  });
});

describe("store — listPending", () => {
  let fk: FakeKV;
  let kv: KVNamespace;

  beforeEach(() => {
    fk = new FakeKV();
    kv = asKV(fk);
  });

  it("列出所有 pending 記錄", async () => {
    await setPending(kv, { ...samplePending, user_id: 1 }, 300);
    await setPending(kv, { ...samplePending, user_id: 2 }, 300);
    const list = await listPending(kv);
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.user_id).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("無記錄時回空陣列", async () => {
    expect(await listPending(kv)).toEqual([]);
  });

  it("不混入 uuid 記錄", async () => {
    await setPending(kv, samplePending, 300);
    await setUuid(kv, "u1", sampleUuid, 300);
    const list = await listPending(kv);
    expect(list).toHaveLength(1);
  });
});

describe("store — delayed delete（恭喜訊息延遲刪除）", () => {
  let kv: KVNamespace;
  beforeEach(() => {
    kv = asKV(new FakeKV());
  });

  it("setDelayedDelete 後 listDelayedDeletes 可列出", async () => {
    await setDelayedDelete(kv, { chat_id: -1, message_id: 10, delete_at: 12345 }, 120);
    const list = await listDelayedDeletes(kv);
    expect(list).toEqual([{ chat_id: -1, message_id: 10, delete_at: 12345 }]);
  });

  it("deleteDelayedDelete 後不再列出", async () => {
    await setDelayedDelete(kv, { chat_id: -1, message_id: 10, delete_at: 1 }, 120);
    await deleteDelayedDelete(kv, -1, 10);
    expect(await listDelayedDeletes(kv)).toEqual([]);
  });

  it("無記錄時 listDelayedDeletes 回空陣列", async () => {
    expect(await listDelayedDeletes(kv)).toEqual([]);
  });

  it("不混入 pending 記錄", async () => {
    await setPending(kv, samplePending, 300);
    await setDelayedDelete(kv, { chat_id: -1, message_id: 9, delete_at: 1 }, 60);
    const list = await listDelayedDeletes(kv);
    expect(list).toHaveLength(1);
  });
});
