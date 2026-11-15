import serverless from "serverless-http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createServer, handleTelegramUpdate } = require("../../server.js");
const { safeEqual } = require("../../src/auth.js");

process.env.AUTOCATAT_REALTIME = "false";

const handleHttp = serverless(createServer());
const FUNCTION_PATH = "/.netlify/functions/api";

function apiPath(pathname) {
  if (pathname === FUNCTION_PATH) return "/api";
  if (pathname.startsWith(`${FUNCTION_PATH}/`)) {
    return `/api${pathname.slice(FUNCTION_PATH.length)}`;
  }
  return pathname;
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

async function handleTelegramWebhook(request) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const suppliedSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!process.env.TELEGRAM_BOT_TOKEN || !expectedSecret) {
    return jsonResponse(503, { error: "Webhook Telegram belum dikonfigurasi." });
  }
  if (!safeEqual(suppliedSecret, expectedSecret)) {
    return jsonResponse(403, { error: "Webhook Telegram tidak valid." });
  }

  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > 1_000_000) {
    return jsonResponse(413, { error: "Ukuran permintaan terlalu besar." });
  }

  let update;
  try {
    update = JSON.parse(body);
  } catch {
    return jsonResponse(400, { error: "Format update Telegram tidak valid." });
  }

  try {
    await handleTelegramUpdate(update);
    return jsonResponse(200, { ok: true });
  } catch (error) {
    console.error("Telegram webhook failed:", error.message);
    return jsonResponse(500, { error: "Update Telegram gagal diproses." });
  }
}

function responseFromLambda(result) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(result.headers || {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, String(item));
    } else {
      headers.set(name, String(value));
    }
  }
  for (const [name, values] of Object.entries(result.multiValueHeaders || {})) {
    headers.delete(name);
    for (const value of values) headers.append(name, String(value));
  }
  for (const cookie of result.cookies || []) headers.append("Set-Cookie", cookie);

  const body = result.body
    ? result.isBase64Encoded
      ? Buffer.from(result.body, "base64")
      : result.body
    : null;
  return new Response(body, {
    status: result.statusCode || 200,
    headers,
  });
}

export default async function handler(request, context) {
  const url = new URL(request.url);
  const pathname = apiPath(url.pathname);

  if (pathname === "/api/telegram/webhook" && request.method === "POST") {
    return handleTelegramWebhook(request);
  }
  if (pathname === "/api/events" && request.method === "GET") {
    return jsonResponse(501, { error: "Realtime stream tidak tersedia di Netlify." });
  }

  const headers = Object.fromEntries(request.headers.entries());
  headers.host = url.host;
  headers["x-forwarded-proto"] ||= url.protocol.slice(0, -1);
  const body = request.method === "GET" || request.method === "HEAD"
    ? null
    : await request.text();
  const queryStringParameters = Object.fromEntries(url.searchParams.entries());
  const result = await handleHttp({
    httpMethod: request.method,
    path: pathname,
    headers,
    queryStringParameters,
    body,
    isBase64Encoded: false,
    requestContext: {
      identity: {
        sourceIp: context.ip || headers["x-forwarded-for"]?.split(",")[0] || "127.0.0.1",
      },
    },
  }, context);

  return responseFromLambda(result);
}

export const config = {
  path: ["/api", "/api/*"],
};
