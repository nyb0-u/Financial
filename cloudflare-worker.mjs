import { httpServerHandler } from "cloudflare:node";
import serverModule from "./server.js";
import authModule from "./src/auth.js";

const { createServer, handleTelegramUpdate } = serverModule;
const { safeEqual } = authModule;

const server = createServer();
server.listen(8080);
const handleHttp = httpServerHandler({ port: 8080 });
const WORKER_ENVIRONMENT_KEYS = [
  "ADMIN_SETUP_KEY",
  "ADMIN_SETUP_KEY_GENERATED",
  "AUTOCATAT_STORE_LOCAL_FALLBACK",
  "AUTOCATAT_STORE_BACKEND",
  "AUTOCATAT_TELEGRAM_WEBHOOK_ONLY",
  "COOKIE_SECURE",
  "FIREBASE_DATABASE_URL",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
  "GEMINI_API_KEY",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_SHEETS_ID",
  "GOOGLE_SHEETS_TAB",
  "MONTHLY_BUDGET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_USERNAME",
  "TELEGRAM_WEBHOOK_SECRET",
  "TRUST_PROXY",
];

function configureEnvironment(environment) {
  for (const key of WORKER_ENVIRONMENT_KEYS) {
    process.env[key] = typeof environment[key] === "string" ? environment[key] : "";
  }
}

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(request, environment, context) {
    configureEnvironment(environment);
    const url = new URL(request.url);

    if (url.pathname === "/api/telegram/webhook" && request.method === "POST") {
      const expectedSecret = environment.TELEGRAM_WEBHOOK_SECRET;
      const suppliedSecret = request.headers.get("x-telegram-bot-api-secret-token");
      if (!environment.TELEGRAM_BOT_TOKEN || !expectedSecret) {
        return jsonResponse(503, { error: "Webhook Telegram belum dikonfigurasi." });
      }
      if (!safeEqual(suppliedSecret, expectedSecret)) {
        return jsonResponse(403, { error: "Webhook Telegram tidak valid." });
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return jsonResponse(400, { error: "Format update Telegram tidak valid." });
      }

      const processing = handleTelegramUpdate(update).catch((error) => {
        console.error("Telegram webhook failed:", error.message);
      });
      if (context?.waitUntil) context.waitUntil(processing);
      else await processing;
      return jsonResponse(200, { ok: true });
    }

    if (!url.pathname.startsWith("/api/")) {
      return environment.ASSETS.fetch(request);
    }
    return handleHttp.fetch(request, environment, context);
  },
};
