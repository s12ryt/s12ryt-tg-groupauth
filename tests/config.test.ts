import { describe, it, expect, beforeEach } from "vitest";
import { FakeKV } from "./helpers";
import type { KVNamespace } from "@cloudflare/workers-types";
import {
  getConfig,
  updateConfig,
  clampTimeout,
  clampAnnounceDeleteAfter,
} from "../src/config";
import { DEFAULT_CONFIG, CONFIG_KEYS } from "../src/types";

const asKV = (fk: FakeKV): KVNamespace => fk as unknown as KVNamespace;

describe("config — clamp 邊界", () => {
  it("clampTimeout 低於下限回下限", () => {
    expect(clampTimeout(0)).toBe(30);
  });

  it("clampTimeout 高於上限回上限", () => {
    expect(clampTimeout(99999)).toBe(3600);
  });

  it("clampTimeout 在範圍內不變", () => {
    expect(clampTimeout(300)).toBe(300);
  });

  it("clampAnnounceDeleteAfter 低於下限回下限", () => {
    expect(clampAnnounceDeleteAfter(-5)).toBe(0);
  });

  it("clampAnnounceDeleteAfter 高於上限回上限", () => {
    expect(clampAnnounceDeleteAfter(99999)).toBe(3600);
  });

  it("clampAnnounceDeleteAfter 0 代表不自動刪", () => {
    expect(clampAnnounceDeleteAfter(0)).toBe(0);
  });
});

describe("config — getConfig 預設值", () => {
  let kv: KVNamespace;
  beforeEach(() => {
    kv = asKV(new FakeKV());
  });

  it("KV 空白時回傳 DEFAULT_CONFIG", async () => {
    expect(await getConfig(kv)).toEqual(DEFAULT_CONFIG);
  });

  it("timeout 非法時用預設值", async () => {
    await kv.put(CONFIG_KEYS.timeout, "abc", { expirationTtl: 60 });
    const cfg = await getConfig(kv);
    expect(cfg.timeout).toBe(DEFAULT_CONFIG.timeout);
  });

  it("announce_enabled 解析 true/false 字串", async () => {
    await kv.put(CONFIG_KEYS.announce_enabled, "false", { expirationTtl: 60 });
    const cfg = await getConfig(kv);
    expect(cfg.announce_enabled).toBe(false);
  });

  it("announce_enabled 非法值視為 false", async () => {
    await kv.put(CONFIG_KEYS.announce_enabled, "yes", { expirationTtl: 60 });
    const cfg = await getConfig(kv);
    expect(cfg.announce_enabled).toBe(false);
  });

  it("timeout 超過上限被 clamp", async () => {
    await kv.put(CONFIG_KEYS.timeout, "99999", { expirationTtl: 60 });
    const cfg = await getConfig(kv);
    expect(cfg.timeout).toBe(3600);
  });

  it("announce_delete_after 非法時用預設", async () => {
    await kv.put(CONFIG_KEYS.announce_delete_after, "x", { expirationTtl: 60 });
    const cfg = await getConfig(kv);
    expect(cfg.announce_delete_after).toBe(DEFAULT_CONFIG.announce_delete_after);
  });
});

describe("config — updateConfig 部分更新", () => {
  let kv: KVNamespace;
  beforeEach(() => {
    kv = asKV(new FakeKV());
  });

  it("只更新 timeout，其他欄位不變", async () => {
    const cfg = await updateConfig(kv, { timeout: 120 });
    expect(cfg.timeout).toBe(120);
    expect(cfg.announce_enabled).toBe(DEFAULT_CONFIG.announce_enabled);
    expect(cfg.announce_delete_after).toBe(DEFAULT_CONFIG.announce_delete_after);
  });

  it("更新值會被 clamp", async () => {
    const cfg = await updateConfig(kv, { timeout: 1 });
    expect(cfg.timeout).toBe(30);
  });

  it("更新 announce_enabled 為 false", async () => {
    const cfg = await updateConfig(kv, { announce_enabled: false });
    expect(cfg.announce_enabled).toBe(false);
  });

  it("連續更新累積生效", async () => {
    await updateConfig(kv, { timeout: 120 });
    await updateConfig(kv, { announce_enabled: false });
    const cfg = await getConfig(kv);
    expect(cfg).toEqual({
      timeout: 120,
      announce_enabled: false,
      announce_delete_after: DEFAULT_CONFIG.announce_delete_after,
    });
  });
});
