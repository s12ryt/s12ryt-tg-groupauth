/**
 * Cloudflare Turnstile 後端驗證。
 *
 * 安全要求：Turnstile token 必須在後端 siteverify，
 * 不得只在前端檢查。fetch 可注入以利單元測試。
 */
import type { TurnstileVerifyResponse } from "./types";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** 詳細驗證結果。 */
export interface TurnstileResult {
  ok: boolean;
  errorCodes: string[];
  hostname?: string;
  action?: string;
}

/**
 * 驗證 Turnstile token；回傳是否通過。
 * - 空 token / 空 secret → 直接 false（不發請求）
 * - 網路錯誤 / 非 JSON / 非 2xx → false（保守不放行）
 */
export async function verifyTurnstile(
  token: string,
  secret: string,
  remoteip?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  return (await verifyTurnstileDetailed(token, secret, remoteip, fetchImpl)).ok;
}

/** 驗證 Turnstile token；回傳含錯誤碼的詳細結果。 */
export async function verifyTurnstileDetailed(
  token: string,
  secret: string,
  remoteip?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileResult> {
  if (!token || !secret) {
    return { ok: false, errorCodes: ["missing-input"] };
  }

  const params = new URLSearchParams();
  params.set("secret", secret);
  params.set("response", token);
  if (remoteip) params.set("remoteip", remoteip);

  let resp: Response;
  try {
    resp = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch {
    return { ok: false, errorCodes: ["network-error"] };
  }

  if (!resp.ok) {
    return { ok: false, errorCodes: ["http-error"] };
  }

  let data: TurnstileVerifyResponse;
  try {
    data = (await resp.json()) as TurnstileVerifyResponse;
  } catch {
    return { ok: false, errorCodes: ["bad-response"] };
  }

  return {
    ok: data.success === true,
    errorCodes: data["error-codes"] ?? [],
    hostname: data.hostname,
    action: data.action,
  };
}
