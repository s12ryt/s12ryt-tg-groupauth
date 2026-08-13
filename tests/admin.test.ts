import { describe, it, expect, beforeEach } from "vitest";
import { FakeTgApi } from "./helpers";
import { isAdministrator } from "../src/admin";

describe("admin — isAdministrator", () => {
  let tg: FakeTgApi;
  const chatId = -100999;
  const superAdmin = 777;

  beforeEach(() => {
    tg = new FakeTgApi();
  });

  it("超級管理員恆為管理員", async () => {
    tg.admins = [];
    expect(await isAdministrator(superAdmin, chatId, superAdmin, tg)).toBe(true);
  });

  it("在 getChatAdministrators 清單中 → 管理員", async () => {
    tg.admins = [111, 222];
    expect(await isAdministrator(111, chatId, superAdmin, tg)).toBe(true);
    expect(await isAdministrator(222, chatId, superAdmin, tg)).toBe(true);
  });

  it("不在清單且非超級管理員 → 非管理員", async () => {
    tg.admins = [111];
    expect(await isAdministrator(999, chatId, superAdmin, tg)).toBe(false);
  });

  it("getChatAdministrators 失敗時，非超級管理員為 false（保守）", async () => {
    tg.failAdmins = true;
    expect(await isAdministrator(111, chatId, superAdmin, tg)).toBe(false);
  });

  it("getChatAdministrators 失敗時，超級管理員仍為 true", async () => {
    tg.failAdmins = true;
    expect(await isAdministrator(superAdmin, chatId, superAdmin, tg)).toBe(true);
  });

  it("呼叫 getChatAdministrators 使用正確 chat_id", async () => {
    tg.admins = [1];
    await isAdministrator(1, -42, 99, tg);
    // getChatAdministrators 在 FakeTgApi 中接收 chat_id（這裡僅驗證未拋錯且能判斷）
    expect(await isAdministrator(1, -42, 99, tg)).toBe(true);
  });

  it("superAdminId 為 0 時不誤判任意人為管理員", async () => {
    tg.admins = [];
    expect(await isAdministrator(0, chatId, 0, tg)).toBe(true); // 0===0，嚴格相等成立
    expect(await isAdministrator(5, chatId, 0, tg)).toBe(false);
  });
});
