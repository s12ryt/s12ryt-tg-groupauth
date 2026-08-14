import { describe, it, expect, beforeEach } from "vitest";
import { FakeKV, FakeTgApi } from "./helpers";
import type { KVNamespace } from "@cloudflare/workers-types";
import {
  captchaButtonUrl,
  onNewMember,
  issueUuid,
  checkAndVerifyUuid,
  sweepExpiredPending,
  sweepDelayedDeletes,
  manualVerify,
  isServiceMessage,
  SERVICE_MESSAGE_KEYS,
  type VerifyDeps,
} from "../src/verify";
import {
  getPending,
  getUuid,
  listPending,
  listDelayedDeletes,
} from "../src/store";
import { MUTED_PERMISSIONS, FULL_PERMISSIONS, STAT_KEYS } from "../src/types";
import { updateConfig } from "../src/config";

interface Harness {
  deps: VerifyDeps;
  kv: KVNamespace;
  tg: FakeTgApi;
  advance: (ms: number) => void;
}

function buildHarness(): Harness {
  const fk = new FakeKV();
  const tg = new FakeTgApi();
  let t = 1_000_000;
  const now = () => t;
  fk.setClock(now);
  const kv = fk as unknown as KVNamespace;
  const deps: VerifyDeps = {
    kv,
    tg,
    groupChatId: -1001,
    workerDomain: "https://bot.example.com",
    now,
  };
  return { deps, kv, tg, advance: (ms) => { t += ms; } };
}

const member = { id: 555, first_name: "Alice", is_bot: false };

describe("verify — captchaButtonUrl", () => {
  it("正確組裝 URL", () => {
    expect(captchaButtonUrl("https://bot.example.com", 555)).toBe(
      "https://bot.example.com/captcha?u=555",
    );
  });

  it("去除尾斜線", () => {
    expect(captchaButtonUrl("https://bot.example.com/", 555)).toBe(
      "https://bot.example.com/captcha?u=555",
    );
  });
});

describe("verify — onNewMember", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it("立即限制發言權限（MUTED）", async () => {
    await onNewMember(h.deps, member);
    expect(h.tg.restrictCalls).toHaveLength(1);
    expect(h.tg.restrictCalls[0].permissions).toEqual(MUTED_PERMISSIONS);
    expect(h.tg.restrictCalls[0].user_id).toBe(555);
  });

  it("發送含驗證按鈕的訊息", async () => {
    await onNewMember(h.deps, member);
    expect(h.tg.sentMessages).toHaveLength(1);
    const msg = h.tg.sentMessages[0];
    expect(msg.chat_id).toBe(-1001);
    const btn = msg.extra?.reply_markup?.inline_keyboard?.[0]?.[0];
    expect(btn?.url).toBe("https://bot.example.com/captcha?u=555");
  });

  it("寫入 pending 記錄，含 warn_message_id", async () => {
    await onNewMember(h.deps, member);
    const pending = await getPending(h.kv, -1001, 555);
    expect(pending).not.toBeNull();
    expect(pending?.warn_message_id).toBe(h.tg.sentMessages[0] ? 1001 : 1001);
    // message_id 由 FakeTgApi 從 1001 起遞增
  });

  it("按鈕 URL 使用正確 user_id", async () => {
    await onNewMember(h.deps, { id: 999, first_name: "Bob", is_bot: false });
    const btn = h.tg.sentMessages[0].extra?.reply_markup?.inline_keyboard?.[0]?.[0];
    expect(btn?.url).toContain("u=999");
  });
});

describe("verify — issueUuid", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it("有 pending 記錄 → 回傳 UUID 並寫入 KV（綁定 user_id）", async () => {
    await onNewMember(h.deps, member);
    const uuid = await issueUuid(h.deps, 555);
    expect(uuid).toBeTruthy();
    expect(typeof uuid).toBe("string");
    const rec = await getUuid(h.kv, uuid!);
    expect(rec).not.toBeNull();
    expect(rec?.user_id).toBe(555);
    expect(rec?.chat_id).toBe(-1001);
  });

  it("無 pending 記錄 → 拒絕（回 null）", async () => {
    const uuid = await issueUuid(h.deps, 555);
    expect(uuid).toBeNull();
  });

  it("產生不同 UUID（隨機性）", async () => {
    await onNewMember(h.deps, member);
    const a = await issueUuid(h.deps, 555);
    // 重新建立 pending 再產生一次
    await onNewMember(h.deps, member);
    const b = await issueUuid(h.deps, 555);
    expect(a).not.toBe(b);
  });
});

describe("verify — checkAndVerifyUuid", () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  async function setupPendingAndUuid() {
    await onNewMember(h.deps, member);
    return issueUuid(h.deps, 555);
  }

  it("UUID 不存在 → NotFound / false", async () => {
    const res = await checkAndVerifyUuid(h.deps, 555, "non-existent-uuid");
    expect(res.outcome).toBe("not_found");
    expect(res.success).toBe(false);
  });

  it("UUID 綁定 user_id 與私訊者不符 → Mismatch / false", async () => {
    const uuid = await setupPendingAndUuid();
    const res = await checkAndVerifyUuid(h.deps, 666, uuid!);
    expect(res.outcome).toBe("mismatch");
    expect(res.success).toBe(false);
  });

  it("UUID 一致 → Ok / true，解除限制並刪提示訊息", async () => {
    const uuid = await setupPendingAndUuid();
    const res = await checkAndVerifyUuid(h.deps, 555, uuid!);
    expect(res.outcome).toBe("ok");
    expect(res.success).toBe(true);
    // 解除限制用 FULL_PERMISSIONS
    const unrestrict = h.tg.restrictCalls.find(
      (c) => c.user_id === 555 && c.permissions === FULL_PERMISSIONS,
    );
    expect(unrestrict).toBeTruthy();
    // 刪除入群提示訊息
    expect(h.tg.deleteCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("驗證成功後 pending 被刪除", async () => {
    const uuid = await setupPendingAndUuid();
    await checkAndVerifyUuid(h.deps, 555, uuid!);
    expect(await getPending(h.kv, -1001, 555)).toBeNull();
  });

  it("驗證成功後 UUID 一次性（刪除）", async () => {
    const uuid = await setupPendingAndUuid();
    await checkAndVerifyUuid(h.deps, 555, uuid!);
    expect(await getUuid(h.kv, uuid!)).toBeNull();
  });

  it("驗證成功累加 verified 統計", async () => {
    const uuid = await setupPendingAndUuid();
    await checkAndVerifyUuid(h.deps, 555, uuid!);
    const raw = await h.kv.get(STAT_KEYS.verified);
    expect(Number(raw)).toBe(1);
  });

  it("announce 開啟時發恭喜訊息並記錄延遲刪除", async () => {
    const uuid = await setupPendingAndUuid();
    await checkAndVerifyUuid(h.deps, 555, uuid!);
    // 一條入群提示 + 一條恭喜 = 2
    expect(h.tg.sentMessages.length).toBe(2);
    const dels = await listDelayedDeletes(h.kv);
    expect(dels).toHaveLength(1);
  });

  it("announce 關閉時不發恭喜訊息", async () => {
    await updateConfig(h.kv, { announce_enabled: false });
    const uuid = await setupPendingAndUuid();
    await checkAndVerifyUuid(h.deps, 555, uuid!);
    expect(h.tg.sentMessages.length).toBe(1); // 僅入群提示
    expect(await listDelayedDeletes(h.kv)).toHaveLength(0);
  });

  it("私訊文字回饋正確（成功）", async () => {
    const uuid = await setupPendingAndUuid();
    const res = await checkAndVerifyUuid(h.deps, 555, uuid!);
    expect(res.dmText).toContain("驗證成功");
  });

  it("私訊文字回饋正確（不符）", async () => {
    const uuid = await setupPendingAndUuid();
    const res = await checkAndVerifyUuid(h.deps, 666, uuid!);
    expect(res.dmText).toContain("不屬於你");
  });
});

describe("verify — sweepExpiredPending", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it("過期 pending 被 ban 並刪除", async () => {
    await onNewMember(h.deps, member);
    // 預設 timeout=300s，推進 301s
    h.advance(301 * 1000);
    const banned = await sweepExpiredPending(h.deps);
    expect(banned).toBe(1);
    expect(h.tg.banCalls).toHaveLength(1);
    expect(h.tg.banCalls[0].user_id).toBe(555);
    expect(await getPending(h.kv, -1001, 555)).toBeNull();
  });

  it("未過期 pending 不被 ban", async () => {
    await onNewMember(h.deps, member);
    h.advance(100 * 1000);
    const banned = await sweepExpiredPending(h.deps);
    expect(banned).toBe(0);
    expect(h.tg.banCalls).toHaveLength(0);
    expect(await getPending(h.kv, -1001, 555)).not.toBeNull();
  });

  it("ban 累加 banned 統計", async () => {
    await onNewMember(h.deps, member);
    h.advance(301 * 1000);
    await sweepExpiredPending(h.deps);
    const raw = await h.kv.get(STAT_KEYS.banned);
    expect(Number(raw)).toBe(1);
  });

  it("多筆同時掃描", async () => {
    await onNewMember(h.deps, { id: 1, first_name: "A", is_bot: false });
    await onNewMember(h.deps, { id: 2, first_name: "B", is_bot: false });
    h.advance(301 * 1000);
    const banned = await sweepExpiredPending(h.deps);
    expect(banned).toBe(2);
    const remaining = await listPending(h.kv);
    expect(remaining).toHaveLength(0);
  });

  it("尊重自訂 timeout（/settimeout）", async () => {
    await updateConfig(h.kv, { timeout: 60 });
    await onNewMember(h.deps, member);
    h.advance(61 * 1000);
    const banned = await sweepExpiredPending(h.deps);
    expect(banned).toBe(1);
  });
});

describe("verify — sweepDelayedDeletes", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it("到期的恭喜訊息被刪除", async () => {
    const uuid = await (async () => {
      await onNewMember(h.deps, member);
      return issueUuid(h.deps, 555);
    })();
    await checkAndVerifyUuid(h.deps, 555, uuid!);
    expect(await listDelayedDeletes(h.kv)).toHaveLength(1);
    // 預設 announce_delete_after=60s，推進 61s
    h.advance(61 * 1000);
    const deleted = await sweepDelayedDeletes(h.deps);
    expect(deleted).toBe(1);
    expect(h.tg.deleteCalls.length).toBeGreaterThanOrEqual(1);
    expect(await listDelayedDeletes(h.kv)).toHaveLength(0);
  });

  it("未到期不刪除", async () => {
    const uuid = await (async () => {
      await onNewMember(h.deps, member);
      return issueUuid(h.deps, 555);
    })();
    await checkAndVerifyUuid(h.deps, 555, uuid!);
    h.advance(10 * 1000);
    const deleted = await sweepDelayedDeletes(h.deps);
    expect(deleted).toBe(0);
    expect(await listDelayedDeletes(h.kv)).toHaveLength(1);
  });
});

describe("verify — manualVerify", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it("pending 存在 → 解除限制、刪提示、刪 pending、計數", async () => {
    await onNewMember(h.deps, member);
    const res = await manualVerify(h.deps, 555);
    expect(res.success).toBe(true);
    expect(h.tg.restrictCalls.some((c) => c.permissions === FULL_PERMISSIONS)).toBe(true);
    expect(await getPending(h.kv, -1001, 555)).toBeNull();
    const raw = await h.kv.get(STAT_KEYS.verified);
    expect(Number(raw)).toBe(1);
  });

  it("pending 不存在 → 仍回 success=false", async () => {
    const res = await manualVerify(h.deps, 555);
    expect(res.success).toBe(false);
  });

  it("announce 開啟時發恭喜訊息", async () => {
    await onNewMember(h.deps, member);
    await manualVerify(h.deps, 555);
    expect(h.tg.sentMessages.some((m) => m.text.includes("加入群組"))).toBe(true);
  });
});

describe("verify — isServiceMessage", () => {
  it("new_chat_members 存在 → true", () => {
    expect(isServiceMessage({ message_id: 1, new_chat_members: [] })).toBe(true);
  });

  it("left_chat_member 存在 → true", () => {
    expect(isServiceMessage({ message_id: 1, left_chat_member: { id: 1 } })).toBe(true);
  });

  it("new_chat_title 存在 → true", () => {
    expect(isServiceMessage({ message_id: 1, new_chat_title: "x" })).toBe(true);
  });

  it("new_chat_photo 存在 → true", () => {
    expect(isServiceMessage({ message_id: 1, new_chat_photo: [] })).toBe(true);
  });

  it("delete_chat_photo 存在 → true", () => {
    expect(isServiceMessage({ message_id: 1, delete_chat_photo: true })).toBe(true);
  });

  it("group_chat_created 存在 → true", () => {
    expect(isServiceMessage({ message_id: 1, group_chat_created: true })).toBe(true);
  });

  it("pinned_message 存在 → true", () => {
    expect(isServiceMessage({ message_id: 1, pinned_message: { message_id: 9 } })).toBe(true);
  });

  it("forum_topic_created 存在 → true", () => {
    expect(isServiceMessage({ message_id: 1, forum_topic_created: {} })).toBe(true);
  });

  it("video_chat_started 存在 → true", () => {
    expect(isServiceMessage({ message_id: 1, video_chat_started: {} })).toBe(true);
  });

  it("migrate_to_chat_id 存在 → true", () => {
    expect(isServiceMessage({ message_id: 1, migrate_to_chat_id: -100 })).toBe(true);
  });

  it("一般文字訊息 → false", () => {
    expect(isServiceMessage({ message_id: 1, text: "hello", chat: { id: -1 } })).toBe(false);
  });

  it("空物件 → false", () => {
    expect(isServiceMessage({})).toBe(false);
  });

  it("欄位為 null → false（不算 service）", () => {
    expect(isServiceMessage({ message_id: 1, new_chat_members: null })).toBe(false);
  });

  it("SERVICE_MESSAGE_KEYS 涵蓋主要類型且為唯讀常數", () => {
    expect(Array.isArray(SERVICE_MESSAGE_KEYS)).toBe(true);
    expect(SERVICE_MESSAGE_KEYS).toContain("new_chat_members");
    expect(SERVICE_MESSAGE_KEYS).toContain("left_chat_member");
    expect(SERVICE_MESSAGE_KEYS).toContain("pinned_message");
  });
});
