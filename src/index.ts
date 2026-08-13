/**
 * Cloudflare Worker 入口。
 *
 * 路由：
 *   GET  /                    健康檢查
 *   POST /tg                  Telegram webhook（grammY webhookCallback）
 *   GET  /captcha?u=<user_id> Turnstile 人機驗證頁面
 *   POST /api/verify-captcha  後端驗證 Turnstile token 並簽發 UUID
 *
 * scheduled（cron 每分鐘）：掃描逾期 pending 執行 ban + 刪除到期恭喜訊息。
 */
import { Bot, webhookCallback } from "grammy";
import type { Env } from "./types";
import {
  createBotDeps,
  createGrammyTgApi,
  registerBot,
} from "./bot";
import { issueUuid, sweepDelayedDeletes, sweepExpiredPending, type VerifyDeps } from "./verify";
import { verifyTurnstile } from "./turnstile";

// 模組層級快取（isolate 內重用，避免每次請求重新建構 Bot + 註冊 handlers）。
let cachedBot: Bot | null = null;
let cachedDeps: ReturnType<typeof createBotDeps> | null = null;
let cachedVerifyDeps: VerifyDeps | null = null;

function parseIds(env: Env): { groupChatId: number; superAdminId: number } {
  return {
    groupChatId: Number(env.GROUP_CHAT_ID),
    superAdminId: Number(env.SUPER_ADMIN_ID),
  };
}

function ensureBot(env: Env): { bot: Bot; deps: ReturnType<typeof createBotDeps>; verifyDeps: VerifyDeps } {
  if (cachedBot && cachedDeps && cachedVerifyDeps) {
    return { bot: cachedBot, deps: cachedDeps, verifyDeps: cachedVerifyDeps };
  }
  const bot = new Bot(env.BOT_TOKEN);
  const tg = createGrammyTgApi(bot);
  const { groupChatId, superAdminId } = parseIds(env);
  const deps = createBotDeps({
    kv: env.KV,
    tg,
    groupChatId,
    workerDomain: env.WORKER_DOMAIN,
    superAdminId,
  });
  registerBot(bot, deps);
  cachedBot = bot;
  cachedDeps = deps;
  cachedVerifyDeps = {
    kv: env.KV,
    tg,
    groupChatId,
    workerDomain: env.WORKER_DOMAIN.replace(/\/+$/, ""),
  };
  return { bot, deps, verifyDeps: cachedVerifyDeps };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // 健康檢查
      if (pathname === "/" && request.method === "GET") {
        return json({ ok: true, service: "tg-groupauth" });
      }

      // Telegram webhook
      if (pathname === "/tg" && request.method === "POST") {
        const { bot } = ensureBot(env);
        const cb = webhookCallback(bot, "cloudflare-mod");
        return await cb(request);
      }

      // captcha 頁面
      if (pathname === "/captcha" && request.method === "GET") {
        const userId = url.searchParams.get("u");
        if (!userId || !/^\d+$/.test(userId)) {
          return new Response("缺少使用者參數", { status: 400 });
        }
        return new Response(captchaPageHtml(env.TURNSTILE_SITE_KEY, userId, env.WORKER_DOMAIN), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // Turnstile 後端驗證 + 簽發 UUID
      if (pathname === "/api/verify-captcha" && request.method === "POST") {
        return await handleVerifyCaptcha(request, env);
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: "internal", detail: msg }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const { verifyDeps } = ensureBot(env);
    // 雙軌掃描：webhook 進來時也會連帶掃描，這裡是 cron 的定時掃描。
    await sweepExpiredPending(verifyDeps);
    await sweepDelayedDeletes(verifyDeps);
  },
};

async function handleVerifyCaptcha(request: Request, env: Env): Promise<Response> {
  let body: { token?: string; user_id?: string | number };
  try {
    body = (await request.json()) as { token?: string; user_id?: string | number };
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }

  const token = typeof body.token === "string" ? body.token : "";
  const userIdNum = Number(body.user_id);
  if (!token || !Number.isFinite(userIdNum)) {
    return json({ ok: false, error: "bad_args" }, 400);
  }

  const remoteip = request.headers.get("CF-Connecting-IP") ?? undefined;
  const passed = await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, remoteip);
  if (!passed) {
    return json({ ok: false, error: "captcha_failed" });
  }

  const { verifyDeps } = ensureBot(env);
  const uuid = await issueUuid(verifyDeps, userIdNum);
  if (!uuid) {
    return json({ ok: false, error: "no_pending" });
  }

  return json({ ok: true, uuid });
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** captcha 頁面 HTML：內嵌 Turnstile widget，通過後 POST 取得 UUID 並顯示私訊引導。 */
function captchaPageHtml(siteKey: string, userId: string, workerDomain: string): string {
  const apiBase = workerDomain.replace(/\/+$/, "");
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>群組驗證</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, "Segoe UI", "Microsoft JhengHei", sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; text-align: center; }
  .box { border:1px solid #8884; border-radius:12px; padding:24px; margin-top:16px; }
  .uuid { font-family: monospace; font-size: 1.2em; word-break: break-all; padding:12px; border-radius:8px; background:#0002; user-select: all; }
  .ok { color:#2a8; } .err { color:#c33; }
  button { margin-top:12px; padding:10px 16px; font-size:1em; border:none; border-radius:8px; background:#2a7; color:#fff; cursor:pointer; }
  .hint { color:#888; font-size:.9em; margin-top:8px; }
</style>
</head>
<body>
  <h2>🔒 群組身分驗證</h2>
  <p>請先完成下方人機驗證，取得驗證碼後再回到機器人私聊發送。</p>
  <div class="box">
    <div class="cf-turnstile" data-sitekey="${siteKey}" data-callback="onTurnstileOk"></div>
    <div id="status" class="hint">等待驗證中…</div>
  </div>
  <div id="result" hidden>
    <p>✅ 驗證碼已產生，請點擊複製後到機器人私聊發送：</p>
    <div id="uuid" class="uuid"></div>
    <button onclick="copyUuid()">複製驗證碼</button>
    <p class="hint">驗證碼有時效，請盡快完成。</p>
  </div>
<script>
  async function onTurnstileOk(token) {
    const st = document.getElementById('status');
    st.textContent = '驗證中…';
    st.className = 'hint';
    try {
      const res = await fetch('${apiBase}/api/verify-captcha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token, user_id: ${JSON.stringify(userId)} })
      });
      const data = await res.json();
      if (data.ok) {
        document.querySelector('.cf-turnstile').style.display = 'none';
        document.getElementById('result').hidden = false;
        document.getElementById('uuid').textContent = data.uuid;
        st.textContent = '';
      } else {
        st.textContent = '驗證失敗：' + (data.error || '未知錯誤') + '，請重新嘗試。';
        st.className = 'err';
        if (window.turnstile) { try { window.turnstile.reset(); } catch(e){} }
      }
    } catch (e) {
      st.textContent = '網路錯誤，請重試。';
      st.className = 'err';
    }
  }
  function copyUuid() {
    const t = document.getElementById('uuid').textContent;
    navigator.clipboard.writeText(t).then(() => {
      const b = document.querySelector('button'); if (b) b.textContent = '已複製 ✓';
    }).catch(() => {});
  }
</script>
</body>
</html>`;
}
