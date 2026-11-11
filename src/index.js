// perchlight-guard: warns you before you hit a Cloudflare (or GitHub
// Actions) usage limit.
import { runCheck, lastCheck } from "./lib/check.js";
import { readConfig } from "./lib/config.js";
import { deliver } from "./lib/channels.js";
import { statusPage } from "./lib/status-page.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

/** Basic auth (any user name) or a Bearer token, both STATUS_PASSWORD. */
async function authorised(request, env) {
  const header = request.headers.get("Authorization") ?? "";
  let given = null;
  const basic = /^Basic\s+(.+)$/i.exec(header);
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (basic) {
    try {
      // Basic credentials are UTF-8 (the realm says so), not Latin-1.
      const decoded = new TextDecoder().decode(Uint8Array.from(atob(basic[1].trim()), (c) => c.charCodeAt(0)));
      given = decoded.slice(decoded.indexOf(":") + 1);
    } catch {
      given = null;
    }
  } else if (bearer) {
    given = bearer[1];
  }
  return given !== null && (await safeEqual(given, env.STATUS_PASSWORD));
}

function needAuth() {
  return new Response("Sign in with any user name and your STATUS_PASSWORD.\n", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="perchlight-guard", charset="UTF-8"', "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return new Response("ok\n", { headers: { "Cache-Control": "no-store" } });

    if (!env.STATUS_PASSWORD || String(env.STATUS_PASSWORD).length < 12) {
      return new Response("Set STATUS_PASSWORD (12+ characters): npx wrangler secret put STATUS_PASSWORD\n", { status: 503 });
    }
    if (!(await authorised(request, env))) return needAuth();
    // Browsers resend Basic auth automatically, so another site could make a
    // signed-in browser POST here. Refuse cross-site POSTs.
    const site = request.headers.get("Sec-Fetch-Site");
    if (request.method === "POST" && site && site !== "same-origin" && site !== "none") {
      return json({ ok: false, error: "Cross-site requests aren't allowed." }, 403);
    }

    try {
      if (pathname === "/" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT limit_id, kind, sent_at, error FROM alerts ORDER BY sent_at DESC LIMIT 20",
        ).all();
        return new Response(statusPage(await lastCheck(env), results), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      if (pathname === "/api/status" && request.method === "GET") return json((await lastCheck(env)) ?? { checkedAt: null });
      if (pathname === "/api/check" && request.method === "POST") return json(await runCheck(env, { manual: true }));
      if (pathname === "/api/test-alert" && request.method === "POST") {
        const config = readConfig(env);
        if (!config.email && !config.webhook) return json({ ok: false, problems: config.problems }, 400);
        const results = await deliver(env, config, {
          subject: "Test alert from perchlight-guard",
          text: "This is a test. If you can read it, your usage warnings will reach you here.",
        });
        return json({ ok: results.every((r) => r.ok), results }, results.every((r) => r.ok) ? 200 : 502);
      }
      return json({ ok: false, error: "Not found" }, 404);
    } catch (err) {
      console.error(`${request.method} ${pathname}: ${err instanceof Error ? err.stack : String(err)}`);
      return json({ ok: false, error: "Something went wrong. Check the Worker's logs." }, 500);
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runCheck(env).catch((err) => console.error(`check: ${err instanceof Error ? err.stack : String(err)}`)),
    );
  },
};
