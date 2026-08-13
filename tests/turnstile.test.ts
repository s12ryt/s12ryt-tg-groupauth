import { describe, it, expect } from "vitest";
import { verifyTurnstile, verifyTurnstileDetailed } from "../src/turnstile";
import type { TurnstileVerifyResponse } from "../src/types";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** 製作 fetch mock：記錄呼叫，並依 token 回傳指定回應。 */
function buildFetch(
  outcome: TurnstileVerifyResponse | ((token: string) => TurnstileVerifyResponse),
): { fn: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const body = init?.body;
    let token = "";
    if (typeof body === "string") {
      for (const part of body.split("&")) {
        const [k, v] = part.split("=");
        if (k === "response") token = decodeURIComponent(v ?? "");
      }
    }
    const resp = typeof outcome === "function" ? outcome(token) : outcome;
    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("turnstile — verifyTurnstile", () => {
  it("siteverify 回 success:true → 回 true", async () => {
    const { fn } = buildFetch({ success: true });
    expect(await verifyTurnstile("tok", "secret", undefined, fn)).toBe(true);
  });

  it("siteverify 回 success:false → 回 false", async () => {
    const { fn } = buildFetch({ success: false, "error-codes": ["invalid-input-response"] });
    expect(await verifyTurnstile("tok", "secret", undefined, fn)).toBe(false);
  });

  it("空白 token 直接回 false（不發請求）", async () => {
    const { fn, calls } = buildFetch({ success: true });
    expect(await verifyTurnstile("", "secret", undefined, fn)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("空白 secret 直接回 false（不發請求）", async () => {
    const { fn, calls } = buildFetch({ success: true });
    expect(await verifyTurnstile("tok", "", undefined, fn)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("正確呼叫 siteverify：POST + form body 含 secret/response", async () => {
    const { fn, calls } = buildFetch({ success: true });
    await verifyTurnstile("tok-1", "secret-1", undefined, fn);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(SITEVERIFY_URL);
    expect(calls[0].init?.method).toBe("POST");
    const body = String(calls[0].init?.body);
    expect(body).toContain("secret=secret-1");
    expect(body).toContain("response=tok-1");
  });

  it("提供 remoteip 時 body 含 remoteip", async () => {
    const { fn, calls } = buildFetch({ success: true });
    await verifyTurnstile("tok", "secret", "1.2.3.4", fn);
    const body = String(calls[0].init?.body);
    expect(body).toContain("remoteip=1.2.3.4");
  });

  it("網路錯誤時回 false（保守不放行）", async () => {
    const fn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await verifyTurnstile("tok", "secret", undefined, fn)).toBe(false);
  });

  it("回應非 JSON 時回 false", async () => {
    const fn = (async () =>
      new Response("not json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;
    expect(await verifyTurnstile("tok", "secret", undefined, fn)).toBe(false);
  });

  it("HTTP 5xx 時回 false", async () => {
    const fn = (async () =>
      new Response("server error", { status: 500 })) as unknown as typeof fetch;
    expect(await verifyTurnstile("tok", "secret", undefined, fn)).toBe(false);
  });
});

describe("turnstile — verifyTurnstileDetailed", () => {
  it("回傳完整結果含 success 與錯誤碼", async () => {
    const { fn } = buildFetch({
      success: false,
      "error-codes": ["invalid-input-response"],
      hostname: "x",
    });
    const res = await verifyTurnstileDetailed("tok", "secret", undefined, fn);
    expect(res.ok).toBe(false);
    expect(res.errorCodes).toEqual(["invalid-input-response"]);
    expect(res.hostname).toBe("x");
  });

  it("成功時 ok=true 且無錯誤碼", async () => {
    const { fn } = buildFetch({ success: true });
    const res = await verifyTurnstileDetailed("tok", "secret", undefined, fn);
    expect(res.ok).toBe(true);
    expect(res.errorCodes).toEqual([]);
  });
});
